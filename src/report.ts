import { clip, redact } from './redact.js';
import { reviewSession, type Review } from './review.js';
import type { Session } from './types.js';

export interface RepeatedInstruction {
  text: string;
  sessions: number;
}

export interface Report {
  sessions: number;
  averageScore: number | null;
  findingCounts: { id: string; title: string; sessions: number }[];
  unverifiedSessions: number;
  retryLoops: number;
  repeatedInstructions: RepeatedInstruction[];
  reviews: Review[];
}

export function buildReport(sessions: Session[]): Report {
  const reviews = sessions.map(reviewSession).filter((r) => r.metrics.prompts > 0);
  const counts = new Map<string, { title: string; sessions: number }>();
  for (const r of reviews) {
    for (const f of r.findings) {
      const c = counts.get(f.id) ?? { title: f.title, sessions: 0 };
      c.sessions++;
      counts.set(f.id, c);
    }
  }
  return {
    sessions: reviews.length,
    averageScore: reviews.length ? Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length) : null,
    findingCounts: [...counts].map(([id, c]) => ({ id, ...c })).sort((a, b) => b.sessions - a.sessions),
    unverifiedSessions: reviews.filter((r) => r.findings.some((f) => f.id === 'unverified')).length,
    retryLoops: reviews.reduce((s, r) => s + r.metrics.retryLoops.length, 0),
    repeatedInstructions: findRepeatedInstructions(sessions),
    reviews,
  };
}

const FILLER = /^(please|pls|also|and|but|so|ok|okay|now|then|again|remember( that| to)?|make sure( that| to)?)\s+/;

/**
 * Sentences the person typed in 3+ different sessions. These are habits the
 * agent should already know, so they belong in CLAUDE.md / AGENTS.md.
 */
export function findRepeatedInstructions(sessions: Session[], minSessions = 3): RepeatedInstruction[] {
  const seen = new Map<string, { variants: Map<string, number>; sessions: Set<string> }>();
  for (const s of sessions) {
    for (const e of s.timeline) {
      if (e.type !== 'prompt') continue;
      for (const raw of e.text.split(/[.!?;\n]+/)) {
        let key = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        while (FILLER.test(key)) key = key.replace(FILLER, '');
        const words = key.split(' ').length;
        if (words < 3 || words > 16) continue;
        const entry = seen.get(key) ?? { variants: new Map<string, number>(), sessions: new Set<string>() };
        entry.variants.set(raw.trim(), (entry.variants.get(raw.trim()) ?? 0) + 1);
        entry.sessions.add(s.id);
        seen.set(key, entry);
      }
    }
  }
  return [...seen.values()]
    .filter((e) => e.sessions.size >= minSessions)
    .map((e) => ({ text: clip(redact(mostCommon(e.variants)), 100), sessions: e.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
}

/** The wording typed most often; ties go to the capitalised one. */
function mostCommon(variants: Map<string, number>): string {
  return [...variants].sort((a, b) => b[1] - a[1] || Number(/^[A-Z]/.test(b[0])) - Number(/^[A-Z]/.test(a[0])))[0][0];
}
