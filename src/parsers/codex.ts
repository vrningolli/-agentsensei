import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Session, TimelineEvent, ToolCall } from '../types.js';
import { classifyTool } from './classify.js';

// Context Codex injects as "user" messages; the person never typed these.
const INJECTED = /^\s*(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md|<turn_aborted>)/;
const REJECTED = /rejected|declined|not approved|aborted by user/i;

/** Parses a Codex CLI rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
export function parseCodexSession(file: string, text = readFileSync(file, 'utf8')): Session {
  const session: Session = {
    id: basename(file, '.jsonl').replace(/^rollout-/, ''),
    tool: 'codex',
    file,
    timeline: [],
  };
  const pending = new Map<string, ToolCall>();
  // Newer Codex versions log each typed prompt twice (event_msg and response_item);
  // keep the event_msg copies when they exist.
  const itemPrompts = new Set<TimelineEvent>();
  let eventPrompts = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string | undefined = rec.timestamp;
    if (ts) {
      session.startedAt ??= ts;
      session.endedAt = ts;
    }
    const p = rec.payload ?? {};

    if (rec.type === 'session_meta') {
      if (p.id) session.id = String(p.id);
      session.cwd ??= p.cwd;
    } else if (rec.type === 'turn_context') {
      session.cwd ??= p.cwd;
      if (p.model) session.model = p.model;
    } else if (rec.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim() && !INJECTED.test(p.message)) {
        eventPrompts++;
        session.timeline.push({ type: 'prompt', text: p.message.trim(), ts });
      } else if (p.type === 'turn_aborted') {
        session.timeline.push({ type: 'interrupt', ts });
      }
    } else if (rec.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        const textOut = (Array.isArray(p.content) ? p.content : [])
          .filter((c: any) => typeof c?.text === 'string')
          .map((c: any) => c.text)
          .join('\n')
          .trim();
        if (textOut && !INJECTED.test(textOut)) {
          const event: TimelineEvent = { type: 'prompt', text: textOut, ts };
          itemPrompts.add(event);
          session.timeline.push(event);
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const call = toToolCall(p, ts);
        pending.set(call.id, call);
        session.timeline.push({ type: 'tool', call });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const call = pending.get(String(p.call_id));
        if (call) applyOutput(call, p.output);
      }
    }
  }

  if (eventPrompts > 0) session.timeline = session.timeline.filter((e) => !itemPrompts.has(e));
  return session;
}

function toToolCall(p: any, ts?: string): ToolCall {
  const name = String(p.name ?? (p.type === 'local_shell_call' ? 'local_shell' : 'unknown'));
  const call: ToolCall = {
    id: String(p.call_id ?? p.id ?? Math.random()),
    name,
    kind: classifyTool(name),
    isError: false,
    rejected: false,
    ts,
  };
  const args = parseJson(p.arguments) ?? p.action ?? {};
  const cmd = args.command ?? args.cmd;
  if (Array.isArray(cmd)) call.command = cmd.join(' ');
  else if (typeof cmd === 'string') call.command = cmd;
  const patch = typeof p.input === 'string' ? p.input : typeof args.input === 'string' ? args.input : '';
  call.filePath = patch.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1]?.trim() ?? args.path;
  if (patch && call.kind === 'other') call.kind = 'edit';
  return call;
}

function applyOutput(call: ToolCall, output: unknown): void {
  const parsed = typeof output === 'string' ? parseJson(output) : output;
  const exitCode = parsed?.metadata?.exit_code ?? parsed?.exit_code;
  const textOut = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  call.isError =
    (typeof exitCode === 'number' && exitCode !== 0) ||
    /^(Exit code: [1-9]|Process exited with code [1-9])/m.test(textOut);
  call.rejected = REJECTED.test(textOut.slice(0, 200));
  if (call.rejected) call.isError = true;
}

function parseJson(value: unknown): any {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
