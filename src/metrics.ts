import type { Session, ToolCall } from './types.js';

// A shell command that checks the work: tests, type checks, lint, build.
const CHECK = /\b(test|tests|jest|vitest|mocha|pytest|playwright|cypress|tsc|eslint|lint|typecheck|build|cargo (?:test|check|build)|go (?:test|vet|build))\b/i;
// Running a source file directly also exercises the code.
const RUN_SCRIPT = /^\s*(?:node|python3?|py|tsx|ts-node|deno(?: run)?|bun(?: run)?|ruby|php|go run|npx tsx)\s+(?:-\S+\s+)*["']?[\w./\\-]+\.(?:m?[jt]s|cjs|py|rb|php|go)\b/i;
// Commands that merely mention "test" (reading a test file, searching, creating folders) are not checks.
const NOT_A_CHECK = /^\s*(cat|ls|dir|grep|rg|find|head|tail|type|less|more|echo|git|mkdir|touch|cp|mv|rm|Get-Content|Select-String|Get-ChildItem|New-Item)\b/i;
// `cd "some dir" && npm test` should be judged by `npm test`.
const LEADING_CD = /^\s*(?:cd|Set-Location|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i;
const CORRECTION =
  /^(no\b|nope|wrong|not (?:that|this|what)|that'?s not|this is not|it'?s not|don'?t\b|stop\b|undo|revert|actually\b|instead\b|you (?:broke|missed|forgot)|still (?:not|broken|failing|doesn'?t|the same))/i;
const LOCATION =
  /[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|css|scss|html|vue|svelte|json|ya?ml|toml|md|sql|sh|ps1)\b|[\w.-]+[\\/][\w.-]+|`[^`]+`|\b\w+\(\)/;
// Real error details, not just "it's broken".
const ERROR_TEXT =
  /\b(error|exception|fail(?:s|ed|ing|ure)?|traceback|stack ?trace|undefined|null|[45]\d\d|TypeError|ReferenceError|ENOENT|panic)\b/i;
const DONE_CRITERIA =
  /\b(done when|so that|should (?:return|show|pass|work|be)|expected|acceptance|make sure|until|verify|confirm|tests? (?:pass|passes|green))\b/i;

// Source files where a change should be checked. Docs, markup and data are left out.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|vue|svelte|dart|lua|sh|ps1)$/i;
// Throwaway files the agent writes for itself (scratchpads, temp dirs).
const SCRATCH_PATH = /[\\/](?:scratchpad|tmp|temp)[\\/]|[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i;
// Gaps longer than this count as the person being away.
const IDLE_GAP_MS = 10 * 60_000;

export function isCodeEdit(call: ToolCall): boolean {
  return call.kind === 'edit' && !call.rejected && !!call.filePath && CODE_FILE.test(call.filePath) && !SCRATCH_PATH.test(call.filePath);
}

export interface Metrics {
  prompts: number;
  toolCalls: number;
  /** Active minutes: idle gaps over 10 minutes are not counted. */
  durationMin: number | null;
  edits: number;
  /** Edits to source files outside scratch dirs; only these need verifying. */
  codeEdits: number;
  filesEdited: number;
  checks: number;
  failedChecks: number;
  /** null when no code was edited, so verification does not apply. */
  verifiedAfterLastEdit: boolean | null;
  lastCheckFailed: boolean;
  toolErrors: number;
  rejections: number;
  interrupts: number;
  corrections: string[];
  retryLoops: { command: string; times: number }[];
  exploreBeforeFirstEdit: number;
  firstPrompt: {
    text: string;
    words: number;
    hasLocation: boolean;
    hasError: boolean;
    hasDoneCriteria: boolean;
  };
}

export function stripCd(command: string): string {
  return command.replace(LEADING_CD, '');
}

export function isCheck(call: ToolCall): boolean {
  if (call.kind !== 'shell' || call.rejected || !call.command) return false;
  const cmd = stripCd(call.command);
  return RUN_SCRIPT.test(cmd) || (CHECK.test(cmd) && !NOT_A_CHECK.test(cmd));
}

export function computeMetrics(session: Session): Metrics {
  const prompts = session.timeline.flatMap((e) => (e.type === 'prompt' ? [e.text] : []));
  const calls = session.timeline.flatMap((e) => (e.type === 'tool' ? [e.call] : []));

  let lastEdit = -1;
  let lastCheck = -1;
  let lastCheckFailed = false;
  let firstEdit = -1;
  let exploreBeforeFirstEdit = 0;
  const files = new Set<string>();
  const retryLoops: Metrics['retryLoops'] = [];
  let streakCmd = '';
  let streak = 0;

  calls.forEach((call, i) => {
    if (call.kind === 'edit' && !call.rejected) {
      if (firstEdit < 0) firstEdit = i;
      if (call.filePath) files.add(call.filePath);
    }
    if (isCodeEdit(call)) lastEdit = i;
    if ((call.kind === 'read' || call.kind === 'search') && firstEdit < 0) exploreBeforeFirstEdit++;
    if (isCheck(call)) {
      lastCheck = i;
      lastCheckFailed = call.isError;
    }
    if (call.kind === 'shell' && call.command) {
      const cmd = call.command.trim().replace(/\s+/g, ' ');
      if (call.isError && !call.rejected && cmd === streakCmd) streak++;
      else {
        streakCmd = call.isError && !call.rejected ? cmd : '';
        streak = streakCmd ? 1 : 0;
      }
      if (streak === 3) retryLoops.push({ command: cmd, times: 3 });
      else if (streak > 3) retryLoops[retryLoops.length - 1].times = streak;
    }
  });

  const first = prompts[0] ?? '';

  return {
    prompts: prompts.length,
    toolCalls: calls.length,
    durationMin: activeMinutes(session),
    edits: calls.filter((c) => c.kind === 'edit' && !c.rejected).length,
    codeEdits: calls.filter(isCodeEdit).length,
    filesEdited: files.size,
    checks: calls.filter(isCheck).length,
    failedChecks: calls.filter((c) => isCheck(c) && c.isError).length,
    verifiedAfterLastEdit: lastEdit < 0 ? null : lastCheck > lastEdit,
    lastCheckFailed,
    toolErrors: calls.filter((c) => c.isError && !c.rejected).length,
    rejections: calls.filter((c) => c.rejected).length,
    interrupts: session.timeline.filter((e) => e.type === 'interrupt').length,
    corrections: prompts.slice(1).filter((p) => CORRECTION.test(p.trim())),
    retryLoops,
    exploreBeforeFirstEdit: firstEdit < 0 ? 0 : exploreBeforeFirstEdit,
    firstPrompt: {
      text: first,
      words: first.split(/\s+/).filter(Boolean).length,
      hasLocation: LOCATION.test(first),
      hasError: ERROR_TEXT.test(first),
      hasDoneCriteria: DONE_CRITERIA.test(first),
    },
  };
}

function activeMinutes(session: Session): number | null {
  const times = session.timeline
    .map((e) => (e.type === 'tool' ? e.call.ts : e.ts))
    .concat(session.startedAt, session.endedAt)
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  let ms = 0;
  for (let i = 1; i < times.length; i++) ms += Math.min(times[i] - times[i - 1], IDLE_GAP_MS);
  return Math.round(ms / 60_000);
}
