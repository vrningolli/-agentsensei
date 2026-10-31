# 🥋 agentsensei

**Your AI coding sensei.** It reviews your Claude Code and Codex sessions and tells you how you could have prompted and used the agent better. Fail, get feedback, improve, one session at a time.

```bash
npx agentsensei review
```

```
🥋 Session review: "fix login bug" (claude-code, 23 min, 12 prompts, 41 tool calls)

Score: 62/100   (your 7-day average: 58) ↑

✅ What went well
  • No retry loops

⚠️  What cost you time
  1. Changes were never verified (-20)
     6 code edit(s), but no test, type check, lint or build was run.
     Tip: Finish the prompt with "run the tests and show me they pass".
  2. Vague first prompt (-15)
     First prompt was 5 words with no clear goal, context or expected result: "login is broken fix it"
     Tip: Say what is wrong, where (file or folder), and what "done" looks like.

✍️  A better first prompt
  You wrote:
    login is broken fix it
  Better:
    login is broken fix it
    Where: <file or folder, e.g. src/auth/login.ts>
    What I see: <exact error message or wrong behaviour>
    Done when: <test or command that should pass>

🎯 Focus for next session: Never accept "done" without a check: end prompts with the command that proves it works.
```

## Why not just ask the AI to review itself?

You can, but an AI reviewing its own transcript estimates and guesses, and gives a different score every time. agentsensei **measures** what happened, from the session files your agent already writes:

- prompts, corrections ("no, not that file") and interruptions
- every tool call: reads, searches, edits, shell commands, failures, rejections
- whether code was **checked** (tests, type check, lint, build, running the script) **after the last edit**
- retry loops: the same failing command run again and again
- active time, ignoring breaks

The same session always gets the same score, so your progress over weeks is real.

## Commands

| Command | What it does |
|---|---|
| `agentsensei review [id]` | Review your latest session, or a given one (id prefix is enough) |
| `agentsensei report [--days 30]` | Patterns across sessions, including **instructions you keep repeating** (put them in CLAUDE.md / AGENTS.md) |
| `agentsensei fix` | Turn your patterns into rules for the agent (asks before every change) |
| `agentsensei fix --undo` | Restore the files from the last `fix` |
| `agentsensei history` | Your score over time |
| `agentsensei sessions` | List recent sessions with ids |
| `agentsensei install-skill` | Add a `/agentsensei` skill to Claude Code so you can say "review my session" |

Options: `--here` (only sessions from the current directory), `--all` (every finding), `--json`, `--no-save`, `--llm`.

After `npm i -g agentsensei` you can also use the short alias `sensei`.

## What it checks

| Area | Finding |
|---|---|
| Clarity | Vague first prompt; no location or "done when" for a coding task; the AI searched for a long time before its first edit |
| Verification | Code never checked; code changed after the last check; session ended on a failing check |
| Steering | Repeated corrections; repeated interruptions |
| Efficiency | Retry loops; many failing tool calls (missing environment facts); many rejected actions |
| Scope | Very long sessions that mix tasks |

You see at most **two** tips per session. More than that is noise.

## Fix: teach the agent once instead of repeating yourself

`agentsensei fix` looks at your last 30 days and proposes changes only where your sessions show a pattern:

| When your sessions show… | It adds |
|---|---|
| The same instruction typed in 3+ sessions | That instruction, to CLAUDE.md (and AGENTS.md if you use Codex) |
| Code left unchecked after the last change in 2+ sessions | "After changing code, run `pnpm test` and confirm it passes…" (uses your project's real test command with `--here`) |
| Retry loops in 2+ sessions | "If the same command fails twice, stop and explain the cause…" |
| Vague first prompts in 3+ sessions | "If my request is missing the goal, location or done condition, ask me one question first" |
| A safe command you approved by hand 2+ times | An allow-list entry such as `Bash(git status:*)`. Only read-only and test commands, never compound commands. |

```
[1/3] Remember: "Use pnpm, not npm"
      You typed this in 3 different sessions.
      edit ~/.claude/CLAUDE.md
      + - Use pnpm, not npm.
      Apply? [y/N]
```

- By default it writes your global files (`~/.claude/CLAUDE.md`, `~/.claude/settings.json`). With `--here` it writes the project's `./CLAUDE.md` and `./.claude/settings.local.json`.
- Rules go inside a marked `<!-- agentsensei:start -->` block; the rest of your file is never touched. Rules already present anywhere in the file are skipped.
- Every run is backed up to `~/.agentsensei/backups/`; `agentsensei fix --undo` restores it.
- `--dry-run` only shows the changes. `--yes` applies all without asking.

## Better prompt rewrites with a local LLM (optional)

By default the "better prompt" is rule-based. With `--llm` it is rewritten by any OpenAI-compatible model, by default a local [Ollama](https://ollama.com):

```bash
ollama pull qwen2.5:7b
agentsensei review --llm
agentsensei review --llm --llm-url http://localhost:1234/v1 --model my-model
```

You can also set `AGENTSENSEI_LLM_URL`, `AGENTSENSEI_LLM_MODEL` and `AGENTSENSEI_LLM_KEY`. Only your redacted first prompt and the findings are sent.

## Privacy

- Everything runs on your machine. Nothing is uploaded unless you pass `--llm` with a remote URL.
- Secrets (API keys, tokens, passwords) and emails are masked before anything is printed or sent.
- History (`~/.agentsensei/history.json`) stores scores and titles only, never your prompts.

## Supported agents

- **Claude Code**: `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`)
- **Codex CLI**: `~/.codex/sessions/` (or `CODEX_HOME`) *(experimental)*
- Cursor and Gemini CLI: planned

## License

MIT
