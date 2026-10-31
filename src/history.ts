import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Review } from './review.js';

export interface HistoryEntry {
  score: number;
  tool: string;
  title: string;
  endedAt: string;
  topFinding?: string;
}

export interface History {
  version: 1;
  reviews: Record<string, HistoryEntry>;
}

export function agentHome(): string {
  return process.env.AGENTSENSEI_HOME ?? join(homedir(), '.agentsensei');
}

function historyFile(): string {
  return join(agentHome(), 'history.json');
}

export function loadHistory(): History {
  try {
    const h = JSON.parse(readFileSync(historyFile(), 'utf8'));
    if (h?.version === 1 && h.reviews) return h;
  } catch {
    // first run or unreadable file: start fresh
  }
  return { version: 1, reviews: {} };
}

/** Stores the score only (never prompt text), keyed by session so re-reviews overwrite. */
export function saveReview(review: Review): void {
  const history = loadHistory();
  history.reviews[review.session.id] = {
    score: review.score,
    tool: review.session.tool,
    title: review.session.title,
    endedAt: review.session.endedAt ?? new Date().toISOString(),
    topFinding: review.tips[0]?.id,
  };
  const file = historyFile();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(history, null, 2));
}

export function sortedEntries(history: History): HistoryEntry[] {
  return Object.values(history.reviews).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

/** Average score of reviews in the last `days` days, excluding one session id. */
export function recentAverage(history: History, days: number, excludeId?: string): number | null {
  const since = Date.now() - days * 86_400_000;
  const scores = Object.entries(history.reviews)
    .filter(([id, e]) => id !== excludeId && Date.parse(e.endedAt) >= since)
    .map(([, e]) => e.score);
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}
