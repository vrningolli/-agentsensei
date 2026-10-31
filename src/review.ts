import { basename } from 'node:path';
import { computeMetrics, type Metrics } from './metrics.js';
import { clip, redact } from './redact.js';
import type { Session } from './types.js';

export type Area = 'clarity' | 'verification' | 'steering' | 'efficiency' | 'scope';

export interface Finding {
  id: string;
  area: Area;
  /** Points deducted from 100. */
  points: number;
  title: string;
  evidence: string;
  tip: string;
}

export interface Review {
  session: {
    id: string;
    tool: Session['tool'];
    title: string;
    project?: string;
    model?: string;
    endedAt?: string;
    durationMin: number | null;
    costUSD?: number;
  };
  score: number;
  strengths: string[];
  findings: Finding[];
  /** The top findings, at most two: more than that is noise. */
  tips: Finding[];
  betterPrompt?: { original: string; suggestion: string };
  focus: string;
  metrics: Metrics;
}

const FOCUS: Record<Area, string> = {
  clarity: 'Start every task with: what is wrong, where it lives, and how you will know it is done.',
  verification: 'Never accept "done" without a check: end prompts with the command that proves it works.',
  steering: 'For multi-step changes, ask for a short plan first and approve it before any edits.',
  efficiency: 'When the AI is stuck, stop it and give it the missing fact instead of letting it retry.',
  scope: 'One task per session. Start a fresh session with a 3-line summary for the next task.',
};

export function reviewSession(session: Session): Review {
  const m = computeMetrics(session);
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const coding = m.codeEdits > 0;
  const fp = m.firstPrompt;

  if (fp.words > 0 && fp.words < 12 && !fp.hasLocation && !fp.hasError) {
    add({
      id: 'vague-start',
      area: 'clarity',
      points: 15,
      title: 'Vague first prompt',
      evidence: `First prompt was ${fp.words} words with no clear goal, context or expected result: "${clip(redact(fp.text), 80)}"`,
      tip: coding
        ? 'Say what is wrong, where (file or folder), and what "done" looks like. The AI then starts working instead of guessing.'
        : 'Say what you want to get out of it, why, and in what form (list, table, summary). The AI then answers your question instead of guessing it.',
    });
  } else if (coding && !fp.hasLocation && !fp.hasDoneCriteria) {
    add({
      id: 'no-target',
      area: 'clarity',
      points: 8,
      title: 'No location or "done when" in the first prompt',
      evidence: 'The task needed code changes, but the first prompt named no file and no success condition.',
      tip: 'Add one line like "Done when `npm test auth` passes" so the AI knows when to stop.',
    });
  }

  if (coding && m.exploreBeforeFirstEdit >= 8) {
    add({
      id: 'long-search',
      area: 'efficiency',
      points: 10,
      title: 'The AI spent a long time searching',
      evidence: `${m.exploreBeforeFirstEdit} read/search calls before the first edit.`,
      tip: 'Point it at the file or paste the stack trace; that replaces most of the searching.',
    });
  }

  if (coding && m.checks === 0) {
    add({
      id: 'unverified',
      area: 'verification',
      points: 20,
      title: 'Changes were never verified',
      evidence: `${m.codeEdits} code edit(s), but no test, type check, lint or build was run.`,
      tip: 'Finish the prompt with "run the tests and show me they pass". Unverified "done" is the most common source of AI bugs.',
    });
  } else if (m.verifiedAfterLastEdit === false) {
    add({
      id: 'edited-after-check',
      area: 'verification',
      points: 12,
      title: 'Code changed after the last check',
      evidence: 'The last test/build ran before the final edit, so the final version was never checked.',
      tip: 'Ask for one final check after the last change, e.g. "re-run the tests before you finish".',
    });
  } else if (m.verifiedAfterLastEdit && m.lastCheckFailed) {
    add({
      id: 'ended-failing',
      area: 'verification',
      points: 10,
      title: 'Session ended with a failing check',
      evidence: 'The last test/build after the final edit failed.',
      tip: 'Don\'t end on red: ask the AI to explain the remaining failure, or note it as known before moving on.',
    });
  }

  if (m.corrections.length >= 2) {
    add({
      id: 'corrections',
      area: 'steering',
      points: Math.min(5 * m.corrections.length, 20),
      title: 'You had to correct the direction several times',
      evidence: `${m.corrections.length} corrections, e.g. "${clip(redact(m.corrections[0]), 70)}"`,
      tip: 'State constraints up front (what not to touch, which approach) or ask for a plan first and approve it.',
    });
  }

  if (m.interrupts >= 2) {
    add({
      id: 'interrupts',
      area: 'steering',
      points: Math.min(4 * m.interrupts, 10),
      title: 'You interrupted the AI several times',
      evidence: `${m.interrupts} interruptions.`,
      tip: 'Interrupting means it went the wrong way: give the direction before it starts, not after.',
    });
  }

  if (m.retryLoops.length > 0) {
    const worst = m.retryLoops.reduce((a, b) => (b.times > a.times ? b : a));
    add({
      id: 'retry-loop',
      area: 'efficiency',
      points: Math.min(8 * m.retryLoops.length, 16),
      title: 'The AI got stuck retrying a failing command',
      evidence: `\`${clip(redact(worst.command), 60)}\` failed ${worst.times} times in a row.`,
      tip: 'After 2 identical failures, stop it: "explain why this fails before trying again", or give it the missing fact.',
    });
  }

  if (m.toolCalls >= 10 && m.toolErrors / m.toolCalls > 0.25) {
    add({
      id: 'tool-errors',
      area: 'efficiency',
      points: 6,
      title: 'Many tool calls failed',
      evidence: `${m.toolErrors} of ${m.toolCalls} tool calls errored.`,
      tip: 'Repeated failures often mean the AI lacks environment facts (shell, OS, package manager). Put those in CLAUDE.md / AGENTS.md once.',
    });
  }

  if (m.rejections >= 3) {
    add({
      id: 'rejections',
      area: 'efficiency',
      points: 6,
      title: 'You rejected several actions',
      evidence: `${m.rejections} tool calls declined.`,
      tip: 'Tell the AI up front what it may and may not do, or allow-list the safe commands you always approve.',
    });
  }

  if (m.prompts >= 25) {
    add({
      id: 'long-session',
      area: 'scope',
      points: 8,
      title: 'Very long session',
      evidence: `${m.prompts} prompts in one session.`,
      tip: 'Long sessions mix tasks and the AI loses track. Split them: one task, one session.',
    });
  }

  const strengths: string[] = [];
  if (coding && m.verifiedAfterLastEdit && !m.lastCheckFailed) strengths.push('Verified the work: checks ran after the last edit and passed');
  if (fp.words >= 12 && (fp.hasLocation || fp.hasError)) strengths.push('Specific first prompt with a location or error to start from');
  if (m.prompts >= 2 && m.corrections.length === 0 && m.interrupts === 0) strengths.push('No course corrections needed');
  if (m.toolCalls >= 10 && m.retryLoops.length === 0) strengths.push('No retry loops');

  findings.sort((a, b) => b.points - a.points);
  const tips = findings.slice(0, 2);
  const score = Math.max(0, 100 - findings.reduce((sum, f) => sum + f.points, 0));
  const clarityIssue = findings.some((f) => ['vague-start', 'no-target', 'long-search'].includes(f.id));

  return {
    session: {
      id: session.id,
      tool: session.tool,
      title: session.title ?? clip(fp.text || '(no prompt)', 60),
      project: session.cwd ? basename(session.cwd) : undefined,
      model: session.model,
      endedAt: session.endedAt,
      durationMin: m.durationMin,
      costUSD: session.costUSD,
    },
    score,
    strengths: strengths.slice(0, 3),
    findings,
    tips,
    betterPrompt: clarityIssue && fp.text ? { original: redact(fp.text), suggestion: templatePrompt(m, coding) } : undefined,
    focus: !tips[0]
      ? 'Clean session. Keep these habits and try them on a harder task.'
      : tips[0].area === 'clarity' && !coding
        ? 'Start every request with: the goal, the context, and the shape of answer you want.'
        : FOCUS[tips[0].area],
    metrics: m,
  };
}

/** Rule-based rewrite: keeps the person's words and adds the missing pieces as placeholders. */
function templatePrompt(m: Metrics, coding: boolean): string {
  const lines = [clip(redact(m.firstPrompt.text), 200)];
  if (!coding) {
    lines.push('Goal: <what you want to find out or produce>');
    lines.push('Context: <why you need it, what you already know>');
    lines.push('Answer as: <a short summary / comparison table / step-by-step list>');
    return lines.join('\n');
  }
  if (!m.firstPrompt.hasLocation) lines.push('Where: <file or folder, e.g. src/auth/login.ts>');
  if (!m.firstPrompt.hasError) lines.push('What I see: <exact error message or wrong behaviour>');
  if (!m.firstPrompt.hasDoneCriteria) lines.push('Done when: <test or command that should pass>');
  return lines.join('\n');
}
