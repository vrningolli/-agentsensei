import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentHome } from './history.js';
import { stripCd } from './metrics.js';
import { findRepeatedInstructions } from './report.js';
import { reviewSession } from './review.js';
import type { Session } from './types.js';

export type Scope = 'user' | 'project';

export type Proposal =
  | { id: string; kind: 'memory'; title: string; reason: string; files: string[]; lines: string[] }
  | { id: string; kind: 'allow'; title: string; reason: string; files: string[]; rules: string[] };

export interface FixContext {
  /** 'project' writes into the current directory, 'user' into the agents' global config. */
  scope: Scope;
  cwd: string;
  claudeDir: string;
  codexDir: string;
}

export const BLOCK_START = '<!-- agentsensei:start -->';
export const BLOCK_END = '<!-- agentsensei:end -->';
const HEADING = '## Habits learned from your sessions (agentsensei)';

// Read-only or test commands that are safe to allow without a prompt.
const SAFE_PREFIX =
  /^((?:git (?:status|diff|log|show|branch))|ls|pwd|(?:(?:npm|pnpm|yarn|bun) (?:test|run (?:test|lint|build|typecheck|check)))|npx tsc|tsc|pytest|go (?:test|vet)|cargo (?:test|check))(?=\s|$)/;
const SHELL_OPERATOR = /[;&|<>`$]/;

/** Turns patterns found in the sessions into concrete config changes. */
export function buildProposals(sessions: Session[], ctx: FixContext): Proposal[] {
  const reviews = sessions.map(reviewSession).filter((r) => r.metrics.prompts > 0);
  const sessionsWith = (ids: string[]) => reviews.filter((r) => r.findings.some((f) => ids.includes(f.id))).length;
  const memoryFiles = memoryTargets(sessions, ctx);
  const proposals: Proposal[] = [];
  const memory = (id: string, title: string, reason: string, line: string) =>
    proposals.push({ id, kind: 'memory', title, reason, files: memoryFiles, lines: [line] });

  for (const r of findRepeatedInstructions(sessions).slice(0, 5)) {
    memory(`repeat:${r.text}`, `Remember: "${r.text}"`, `You typed this in ${r.sessions} different sessions.`, sentence(r.text));
  }

  const unverified = sessionsWith(['unverified', 'edited-after-check', 'ended-failing']);
  if (unverified >= 2) {
    const cmd = ctx.scope === 'project' ? testCommand(ctx.cwd) : undefined;
    memory(
      'verify',
      'Always verify before saying done',
      `${unverified} sessions ended with code that was not checked after the last change.`,
      `After changing code, run ${cmd ? `\`${cmd}\`` : 'the tests (or a build/type check)'} and confirm it passes before saying the task is done.`,
    );
  }

  const loops = sessionsWith(['retry-loop']);
  if (loops >= 2) {
    memory(
      'retry',
      'Stop retry loops early',
      `The agent retried the same failing command 3+ times in ${loops} sessions.`,
      'If the same command fails twice, stop and explain the cause before trying again.',
    );
  }

  const vague = sessionsWith(['vague-start', 'no-target']);
  if (vague >= 3) {
    memory(
      'clarify',
      'Ask when a request is vague',
      `${vague} sessions started with a prompt that had no clear goal, location or success condition.`,
      'If my request is missing the goal, the location or how to know it is done, ask me one short question before starting.',
    );
  }

  const allow = allowRules(sessions);
  if (allow.length) {
    proposals.push({
      id: 'allow',
      kind: 'allow',
      title: `Stop asking for ${allow.length} safe command${allow.length > 1 ? 's' : ''}`,
      reason: allow.map((a) => `${a.rule} (you approved it ${a.times}×)`).join(', '),
      files: [ctx.scope === 'project' ? join(ctx.cwd, '.claude', 'settings.local.json') : join(ctx.claudeDir, 'settings.json')],
      rules: allow.map((a) => a.rule),
    });
  }
  return proposals;
}

function memoryTargets(sessions: Session[], ctx: FixContext): string[] {
  const usesCodex = sessions.some((s) => s.tool === 'codex');
  if (ctx.scope === 'project') {
    const files = [join(ctx.cwd, 'CLAUDE.md')];
    if (usesCodex || existsSync(join(ctx.cwd, 'AGENTS.md'))) files.push(join(ctx.cwd, 'AGENTS.md'));
    return files;
  }
  const files = [join(ctx.claudeDir, 'CLAUDE.md')];
  if (usesCodex) files.push(join(ctx.codexDir, 'AGENTS.md'));
  return files;
}

/** Safe Bash commands the person approved by hand at least twice. */
export function allowRules(sessions: Session[], minTimes = 2): { rule: string; times: number }[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const e of s.timeline) {
      if (e.type !== 'tool' || e.call.name !== 'Bash' || !e.call.approvedByUser || !e.call.command) continue;
      const cmd = stripCd(e.call.command).trim();
      if (cmd.includes('\n') || SHELL_OPERATOR.test(cmd)) continue;
      const prefix = cmd.match(SAFE_PREFIX)?.[1];
      if (!prefix) continue;
      const rule = `Bash(${prefix}:*)`;
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, n]) => n >= minTimes)
    .map(([rule, times]) => ({ rule, times }))
    .sort((a, b) => b.times - a.times);
}

function testCommand(cwd: string): string | undefined {
  const has = (f: string) => existsSync(join(cwd, f));
  const pkg = readJson(join(cwd, 'package.json'));
  const test = pkg?.scripts?.test;
  if (typeof test === 'string' && !/no test specified/.test(test)) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
    return `${pm} test`;
  }
  if (has('pytest.ini') || has('pyproject.toml')) return 'pytest';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  return undefined;
}

function sentence(text: string): string {
  const t = text.replace(/…$/, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

/** New file content, or null when the lines are already there. */
export function mergeMemory(text: string | undefined, lines: string[]): string | null {
  const body = text ?? '';
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lower = body.toLowerCase();
  const fresh = lines.filter((l) => !lower.includes(l.toLowerCase()));
  if (!fresh.length) return null;
  const bullets = fresh.map((l) => `- ${l}`);
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    return body.slice(0, end).replace(/\s*$/, '') + eol + bullets.join(eol) + eol + body.slice(end);
  }
  const block = [BLOCK_START, HEADING, '', ...bullets, BLOCK_END].join(eol);
  return body.trim() ? body.replace(/\s*$/, '') + eol + eol + block + eol : block + eol;
}

/** New settings JSON, or null when every rule is already allowed. Throws on invalid JSON. */
export function mergeAllow(text: string | undefined, rules: string[]): string | null {
  let json: any = {};
  if (text?.trim()) json = JSON.parse(text);
  const allow: string[] = Array.isArray(json.permissions?.allow) ? json.permissions.allow : [];
  const fresh = rules.filter((r) => !allow.includes(r));
  if (!fresh.length) return null;
  json.permissions = { ...json.permissions, allow: [...allow, ...fresh] };
  return JSON.stringify(json, null, 2) + '\n';
}

export interface PlannedChange {
  file: string;
  before?: string;
  after: string;
}

/** What applying the proposal would write; files that would not change are left out. */
export function planChanges(p: Proposal): PlannedChange[] {
  const out: PlannedChange[] = [];
  for (const file of p.files) {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    let after: string | null;
    try {
      after = p.kind === 'memory' ? mergeMemory(before, p.lines) : mergeAllow(before, p.rules);
    } catch {
      continue; // unparseable settings: never overwrite what we cannot read
    }
    if (after !== null) out.push({ file, before, after });
  }
  return out;
}

interface BackupEntry {
  file: string;
  existed: boolean;
  backup?: string;
}

/** Applies proposals in order, backing up every file first. Returns the changed files. */
export function applyProposals(proposals: Proposal[]): string[] {
  const dir = join(agentHome(), 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const manifest: BackupEntry[] = [];
  for (const p of proposals) {
    for (const change of planChanges(p)) {
      if (!manifest.some((m) => m.file === change.file)) {
        mkdirSync(dir, { recursive: true });
        const entry: BackupEntry = { file: change.file, existed: change.before !== undefined };
        if (entry.existed) {
          entry.backup = join(dir, `${manifest.length}.bak`);
          copyFileSync(change.file, entry.backup);
        }
        manifest.push(entry);
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      }
      mkdirSync(dirname(change.file), { recursive: true });
      writeFileSync(change.file, change.after);
    }
  }
  return manifest.map((m) => m.file);
}

/** Restores the files from the most recent `fix` run. Returns the restored files. */
export function undoLastFix(): string[] {
  const root = join(agentHome(), 'backups');
  const runs = existsSync(root) ? readdirSync(root).sort() : [];
  const last = runs.at(-1);
  if (!last) return [];
  const dir = join(root, last);
  const manifest: BackupEntry[] = readJson(join(dir, 'manifest.json')) ?? [];
  for (const m of manifest) {
    if (m.existed && m.backup) copyFileSync(m.backup, m.file);
    else rmSync(m.file, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
  return manifest.map((m) => m.file);
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
