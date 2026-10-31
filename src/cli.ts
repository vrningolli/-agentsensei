#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { claudeProjectsDir, codexSessionsDir, findSessions, loadSession, sameDir, type SessionRef } from './discover.js';
import { createInterface } from 'node:readline/promises';
import { applyProposals, buildProposals, planChanges, undoLastFix, type Proposal } from './fix.js';
import { renderAllFindings, renderHistory, renderProposal, renderReport, renderReview, renderSessions } from './format.js';
import { loadHistory, recentAverage, saveReview, sortedEntries } from './history.js';
import { DEFAULT_LLM, rewritePrompt } from './llm.js';
import { buildReport } from './report.js';
import { reviewSession } from './review.js';
import type { Session } from './types.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `agentsensei: your AI coding sensei. Reviews your Claude Code and Codex sessions
and shows how you could have prompted and used the agent better. Runs 100% locally.

Usage:
  agentsensei review [session-id]   Review the latest session (or a given one)
  agentsensei report                Patterns across many sessions
  agentsensei fix                   Turn those patterns into CLAUDE.md / AGENTS.md rules
                                    and allow-list entries (asks before every change)
  agentsensei fix --undo            Restore the files from the last fix
  agentsensei history               Your score over time
  agentsensei sessions              List recent sessions
  agentsensei install-skill         Add the /agentsensei skill to Claude Code

Options:
  --here          Only sessions started in the current directory
                  (fix then writes ./CLAUDE.md instead of ~/.claude/CLAUDE.md)
  --days <n>      Period for report and fix (default 30)
  -y, --yes       fix: apply every change without asking
  --dry-run       fix: only show what would change
  --all           Show every finding, not just the top 2
  --llm           Rewrite your prompt with a local LLM (Ollama by default)
  --llm-url <u>   OpenAI-compatible endpoint (default ${DEFAULT_LLM.url})
  --model <m>     Model for --llm (default ${DEFAULT_LLM.model})
  --json          Machine-readable output (used by the skill)
  --no-save       Don't record this review in your history
  -h, --help      Show help
  -v, --version   Show version`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      here: { type: 'boolean' },
      days: { type: 'string' },
      all: { type: 'boolean' },
      llm: { type: 'boolean' },
      'llm-url': { type: 'string' },
      model: { type: 'string' },
      json: { type: 'boolean' },
      'no-save': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      undo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  const [command = 'review', arg] = positionals;
  if (values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version);
    return 0;
  }

  const inScope = (s: Session) => !values.here || sameDir(s.cwd, process.cwd());
  const recentSessions = () => {
    const since = Date.now() - Number(values.days ?? 30) * 86_400_000;
    return findSessions()
      .filter((r) => r.mtimeMs >= since)
      .map(loadSession)
      .filter(inScope);
  };

  switch (command) {
    case 'review': {
      const session = pickSession(findSessions(), arg, inScope);
      if (!session) {
        console.error(arg ? `No session matching "${arg}".` : 'No sessions found. Use Claude Code or Codex first, then run this again.');
        return 1;
      }
      const review = reviewSession(session);
      if (values.llm && review.betterPrompt) {
        const rewritten = await rewritePrompt(review, {
          url: values['llm-url'] ?? DEFAULT_LLM.url,
          model: values.model ?? DEFAULT_LLM.model,
        });
        if (rewritten) review.betterPrompt.suggestion = rewritten;
        else if (!values.json) console.error(`(LLM at ${values['llm-url'] ?? DEFAULT_LLM.url} not reachable; showing the rule-based rewrite)\n`);
      }
      const avg = recentAverage(loadHistory(), 7, review.session.id);
      if (!values['no-save']) saveReview(review);
      if (values.json) console.log(JSON.stringify({ ...review, sevenDayAverage: avg }, null, 2));
      else console.log(renderReview(review, avg) + (values.all ? renderAllFindings(review) : ''));
      return 0;
    }
    case 'report': {
      const report = buildReport(recentSessions());
      if (values.json) console.log(JSON.stringify({ ...report, reviews: report.reviews.map((r) => ({ ...r.session, score: r.score })) }, null, 2));
      else console.log(renderReport(report, Number(values.days ?? 30)));
      return 0;
    }
    case 'fix':
      return values.undo ? undo() : fix(recentSessions(), values);
    case 'history': {
      const entries = sortedEntries(loadHistory());
      console.log(values.json ? JSON.stringify(entries, null, 2) : renderHistory(entries));
      return 0;
    }
    case 'sessions': {
      const rows = findSessions()
        .slice(0, 50)
        .map((ref) => ({ ref, session: loadSession(ref) }))
        .filter((r) => inScope(r.session))
        .slice(0, 15)
        .map(({ ref, session }) => ({
          ref,
          title: session.title ?? '',
          prompts: session.timeline.filter((e) => e.type === 'prompt').length,
        }));
      console.log(rows.length ? renderSessions(rows) : 'No sessions found.');
      return 0;
    }
    case 'install-skill': {
      const target = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills', 'agentsensei', 'SKILL.md');
      if (existsSync(target)) {
        console.log(`Skill already installed at ${target}`);
        return 0;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(PKG_ROOT, 'skills', 'agentsensei', 'SKILL.md'), target);
      console.log(`Installed the agentsensei skill at ${target}\nIn Claude Code, ask "review my session" or run /agentsensei.`);
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

async function fix(sessions: Session[], opts: { here?: boolean; yes?: boolean; 'dry-run'?: boolean; json?: boolean }): Promise<number> {
  const proposals = buildProposals(sessions, {
    scope: opts.here ? 'project' : 'user',
    cwd: process.cwd(),
    claudeDir: dirname(claudeProjectsDir()),
    codexDir: dirname(codexSessionsDir()),
  })
    .map((p) => ({ p, changes: planChanges(p) }))
    .filter((x) => x.changes.length > 0);

  if (opts.json) {
    console.log(JSON.stringify(proposals.map(({ p, changes }) => ({ ...p, files: changes.map((c) => c.file) })), null, 2));
    return 0;
  }
  if (!proposals.length) {
    console.log(`Nothing to fix: no repeated patterns in ${sessions.length} session(s), or the rules are already in place.`);
    return 0;
  }

  console.log(`🥋 ${proposals.length} improvement${proposals.length > 1 ? 's' : ''} from ${sessions.length} session(s):\n`);
  const interactive = !opts.yes && !opts['dry-run'] && process.stdin.isTTY;
  if (!opts.yes && !interactive) {
    proposals.forEach(({ p, changes }, i) => console.log(renderProposal(p, changes, i + 1, proposals.length) + '\n'));
    console.log(opts['dry-run'] ? 'Dry run: nothing was written.' : 'Not a terminal, so nothing was written. Re-run with --yes to apply.');
    return 0;
  }

  const chosen: Proposal[] = [];
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    for (const [i, { p, changes }] of proposals.entries()) {
      console.log(renderProposal(p, changes, i + 1, proposals.length));
      if (!rl || /^y/i.test((await rl.question('      Apply? [y/N] ')).trim())) chosen.push(p);
      console.log('');
    }
  } finally {
    rl?.close();
  }

  if (!chosen.length) {
    console.log('Nothing applied.');
    return 0;
  }
  const files = applyProposals(chosen);
  console.log(`Applied ${chosen.length} change${chosen.length > 1 ? 's' : ''} to:`);
  for (const f of files) console.log(`  ${f}`);
  console.log('\nUndo with: agentsensei fix --undo');
  return 0;
}

function undo(): number {
  const files = undoLastFix();
  if (!files.length) {
    console.log('Nothing to undo.');
    return 0;
  }
  console.log('Restored:');
  for (const f of files) console.log(`  ${f}`);
  return 0;
}

/** Latest session with at least one prompt, or the one whose id starts with `id`. */
function pickSession(refs: SessionRef[], id: string | undefined, inScope: (s: Session) => boolean): Session | undefined {
  for (const ref of refs) {
    // Both agents put the session id in the file name.
    if (id && !basename(ref.file).includes(id)) continue;
    const session = loadSession(ref);
    if (!inScope(session)) continue;
    if (session.timeline.some((e) => e.type === 'prompt')) return session;
  }
  return undefined;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
