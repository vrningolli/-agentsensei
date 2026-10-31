import type { Review } from './review.js';

export interface LlmOptions {
  /** Any OpenAI-compatible endpoint. Defaults to a local Ollama. */
  url: string;
  model: string;
}

export const DEFAULT_LLM: LlmOptions = {
  url: process.env.AGENTSENSEI_LLM_URL ?? 'http://localhost:11434/v1',
  model: process.env.AGENTSENSEI_LLM_MODEL ?? 'qwen2.5:7b',
};

const SYSTEM = `You coach developers on prompting AI coding agents.
Rewrite the developer's first prompt so the agent could have finished faster with fewer corrections.
Keep their intent and wording where possible. Never invent facts: use <placeholders> for anything you do not know
(file, error message, expected result). Reply with only the rewritten prompt, at most 5 lines.`;

/** Asks the LLM for a better version of the first prompt. Returns null if the LLM is unreachable. */
export async function rewritePrompt(review: Review, opts: LlmOptions): Promise<string | null> {
  if (!review.betterPrompt) return null;
  const evidence = review.findings.map((f) => `- ${f.title}: ${f.evidence}`).join('\n');
  try {
    const res = await fetch(`${opts.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.AGENTSENSEI_LLM_KEY ? { authorization: `Bearer ${process.env.AGENTSENSEI_LLM_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `First prompt:\n${review.betterPrompt.original}\n\nWhat went wrong in the session:\n${evidence}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
