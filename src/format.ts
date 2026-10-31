import type { PlannedChange, Proposal } from './fix.js';
import type { HistoryEntry } from './history.js';
import type { Report } from './report.js';
import type { Review } from './review.js';
import type { SessionRef } from './discover.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function scoreColor(score: number): (s: string) => string {
  return score >= 80 ? green : score >= 60 ? yellow : red;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export function renderReview(r: Review, avg7d: number | null): string {
  const s = r.session;
  const m = r.metrics;
  const out: string[] = [];
  const meta = [s.tool, s.durationMin !== null ? `${s.durationMin} min` : null, `${m.prompts} prompts`, `${m.toolCalls} tool calls`]
    .filter(Boolean)
    .join(', ');
  out.push(`${bold('🥋 Session review')}: "${s.title}" ${dim(`(${meta})`)}`);
  if (s.project) out.push(dim(`   project: ${s.project}   id: ${s.id}`));
  out.push('');

  let trend = '';
  if (avg7d !== null) {
    const arrow = r.score > avg7d ? green('↑') : r.score < avg7d ? red('↓') : '→';
    trend = dim(`   (your 7-day average: ${avg7d}) `) + arrow;
  }
  out.push(`${bold('Score:')} ${scoreColor(r.score)(bold(`${r.score}/100`))}${trend}`);
  out.push('');

  if (r.strengths.length) {
    out.push(green('✅ What went well'));
    for (const st of r.strengths) out.push(`  • ${st}`);
    out.push('');
  }

  if (r.tips.length) {
    out.push(yellow('⚠️  What cost you time'));
    r.tips.forEach((t, i) => {
      out.push(`  ${i + 1}. ${bold(t.title)} ${dim(`(-${t.points})`)}`);
      out.push(`     ${dim(t.evidence)}`);
      out.push(`     ${cyan('Tip:')} ${t.tip}`);
    });
    const more = r.findings.length - r.tips.length;
    if (more > 0) out.push(dim(`  (+${more} smaller issue${more > 1 ? 's' : ''}; use --all to see them)`));
    out.push('');
  }

  if (r.betterPrompt) {
    out.push(cyan('✍️  A better first prompt'));
    out.push(dim('  You wrote:'));
    out.push(indent(r.betterPrompt.original.split('\n').slice(0, 4).join('\n'), '    '));
    out.push(dim('  Better:'));
    out.push(indent(r.betterPrompt.suggestion, '    '));
    out.push('');
  }

  out.push(`${bold('🎯 Focus for next session:')} ${r.focus}`);
  return out.join('\n');
}

export function renderAllFindings(r: Review): string {
  if (!r.findings.length) return '';
  return [
    '',
    bold('All findings'),
    ...r.findings.map((f) => `  • [${f.area}] ${f.title} ${dim(`(-${f.points})`)}\n    ${dim(f.evidence)}`),
  ].join('\n');
}

export function renderReport(rep: Report, days: number): string {
  const out: string[] = [];
  out.push(bold(`🥋 agentsensei report: last ${days} days`));
  out.push('');
  if (!rep.sessions) {
    out.push('No sessions with prompts found in this period.');
    return out.join('\n');
  }
  out.push(`Sessions reviewed: ${rep.sessions}`);
  out.push(`Average score:     ${scoreColor(rep.averageScore ?? 0)(bold(String(rep.averageScore)))}/100`);
  out.push(`Unverified edits:  ${rep.unverifiedSessions} session(s) changed code without any test/build`);
  out.push(`Retry loops:       ${rep.retryLoops}`);
  out.push('');

  if (rep.findingCounts.length) {
    out.push(yellow('Most common issues'));
    for (const f of rep.findingCounts.slice(0, 5)) out.push(`  ${String(f.sessions).padStart(3)} × ${f.title}`);
    out.push('');
  }

  if (rep.repeatedInstructions.length) {
    out.push(cyan('🔁 Instructions you keep repeating'));
    out.push(dim('   Put these in CLAUDE.md / AGENTS.md once instead of typing them every session:'));
    for (const r of rep.repeatedInstructions) out.push(`  ${String(r.sessions).padStart(3)} sessions: "${r.text}"`);
    out.push('');
  }

  const worst = [...rep.reviews].sort((a, b) => a.score - b.score).slice(0, 3);
  out.push(dim('Lowest-scoring sessions (run `agentsensei review <id>` for details):'));
  for (const w of worst) out.push(dim(`  ${String(w.score).padStart(3)}  ${w.session.id.slice(0, 8)}  ${w.session.title}`));
  return out.join('\n');
}

export function renderSessions(rows: { ref: SessionRef; title: string; prompts: number }[]): string {
  return rows
    .map(
      (r) =>
        `${new Date(r.ref.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}  ${r.ref.tool.padEnd(11)}  ` +
        `${dim(r.ref.file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '').slice(0, 8))}  ${String(r.prompts).padStart(3)} prompts  ${r.title}`,
    )
    .join('\n');
}

export function renderProposal(p: Proposal, changes: PlannedChange[], index: number, total: number): string {
  const out = [`${bold(`[${index}/${total}]`)} ${bold(p.title)}`, `      ${dim(p.reason)}`];
  for (const c of changes) {
    out.push(`      ${cyan(c.before === undefined ? 'new file' : 'edit')} ${c.file}`);
    const added = p.kind === 'memory' ? p.lines.map((l) => `- ${l}`) : p.rules.map((r) => `permissions.allow += "${r}"`);
    for (const line of added) out.push(green(`      + ${line}`));
  }
  return out.join('\n');
}

const BARS = '▁▂▃▄▅▆▇█';

export function renderHistory(entries: HistoryEntry[]): string {
  if (!entries.length) return 'No reviews yet. Run `agentsensei review` after a session.';
  const spark = entries.map((e) => BARS[Math.min(7, Math.floor(e.score / 12.5))]).join('');
  const first = entries.slice(0, 5);
  const last = entries.slice(-5);
  const avg = (xs: HistoryEntry[]) => Math.round(xs.reduce((s, e) => s + e.score, 0) / xs.length);
  return [
    bold('🥋 Your progress'),
    '',
    `  ${spark}`,
    '',
    `  Reviews: ${entries.length}`,
    `  First 5 average: ${avg(first)}   Latest 5 average: ${scoreColor(avg(last))(String(avg(last)))}`,
    '',
    ...entries.slice(-8).map((e) => dim(`  ${e.endedAt.slice(0, 10)}  ${String(e.score).padStart(3)}  ${e.title}`)),
  ].join('\n');
}
