---
name: agentsensei
description: Review the current or a recent AI coding session and coach the user on how they could have prompted and used the agent better. Use when the user asks to review their session, asks how they could have prompted better, asks for feedback on how they use AI, or types /agentsensei.
---

# agentsensei: session coach

1. Run `npx -y agentsensei review --json` (append a session id if the user names one; add `--here` to stay in the current project).
   The JSON holds measured facts: `score`, `sevenDayAverage`, `strengths`, `tips`, `findings`, `betterPrompt`, `focus`, `metrics`.
2. Coach the user in this order, briefly:
   - The score, the trend against `sevenDayAverage` when present, and one line on what went well (`strengths`).
   - At most two tips from `tips`. For each, quote its `evidence` and give one concrete fix.
   - If `betterPrompt` is present, rewrite their original first prompt into a better one. Keep their intent and use
     `<placeholders>` for details you do not know.
   - Close with the `focus` line for their next session.
3. Rules:
   - Only use numbers that appear in the JSON. Never estimate or invent metrics.
   - Be specific to this session, not generic prompting advice. Be encouraging: the goal is that they improve over time.
   - If the command fails because no sessions are found, say so plainly.
