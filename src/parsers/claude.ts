import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Session, ToolCall } from '../types.js';
import { classifyTool } from './classify.js';

const REJECTED = /doesn't want to proceed|tool use was rejected|user denied/i;
const INTERRUPTED = /^\[Request interrupted by user/;
// Injected by the CLI rather than typed by the person.
const NOT_TYPED = /^(<local-command-|<system-reminder>|Caveat: )/;

/** Parses a Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl). */
export function parseClaudeSession(file: string, text = readFileSync(file, 'utf8')): Session {
  const session: Session = { id: basename(file, '.jsonl'), tool: 'claude-code', file, timeline: [] };
  const pending = new Map<string, ToolCall>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Subagent turns are the agent talking to itself, not the person prompting.
    if (rec.isSidechain) continue;
    if (typeof rec.timestamp === 'string') {
      session.startedAt ??= rec.timestamp;
      session.endedAt = rec.timestamp;
    }

    switch (rec.type) {
      case 'ai-title':
        session.title = rec.aiTitle;
        break;
      case 'cost-state':
        if (typeof rec.totalCostUSD === 'number') session.costUSD = rec.totalCostUSD;
        break;
      case 'assistant': {
        session.cwd ??= rec.cwd;
        const msg = rec.message ?? {};
        if (typeof msg.model === 'string' && !msg.model.startsWith('<')) session.model = msg.model;
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block?.type !== 'tool_use') continue;
          const call = toToolCall(block, rec.timestamp);
          pending.set(call.id, call);
          session.timeline.push({ type: 'tool', call });
        }
        break;
      }
      case 'user': {
        session.cwd ??= rec.cwd;
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== 'tool_result') continue;
            const call = pending.get(block.tool_use_id);
            if (!call) continue;
            call.isError = Boolean(block.is_error);
            call.rejected = call.isError && REJECTED.test(blockText(block.content));
            const decision = rec.permissionDecision;
            if (decision?.decision === 'accept' && /^user/.test(decision.source ?? '')) call.approvedByUser = true;
            if (decision?.decision === 'reject' && /^user/.test(decision.source ?? '')) call.rejected = true;
          }
        }
        if (!isHumanTurn(rec)) break;
        const prompt = blockText(content).trim();
        if (INTERRUPTED.test(prompt)) session.timeline.push({ type: 'interrupt', ts: rec.timestamp });
        else if (prompt && !NOT_TYPED.test(prompt)) {
          session.timeline.push({ type: 'prompt', text: slashCommand(prompt), ts: rec.timestamp });
        }
        break;
      }
    }
  }
  return session;
}

function isHumanTurn(rec: any): boolean {
  if (rec.isMeta || rec.toolUseResult !== undefined) return false;
  if (rec.origin?.kind) return rec.origin.kind === 'human';
  // Older transcripts have no origin field: a human turn is one without tool results.
  const content = rec.message?.content;
  return typeof content === 'string' || (Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result'));
}

function toToolCall(block: any, ts?: string): ToolCall {
  const input = block.input ?? {};
  return {
    id: String(block.id),
    name: String(block.name),
    kind: classifyTool(String(block.name)),
    command: typeof input.command === 'string' ? input.command : undefined,
    filePath: input.file_path ?? input.notebook_path ?? input.path,
    isError: false,
    rejected: false,
    ts,
  };
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** "<command-name>/review</command-name><command-args>x</command-args>" becomes "/review x". */
function slashCommand(text: string): string {
  const name = text.match(/<command-name>(.*?)<\/command-name>/s)?.[1];
  if (!name) return text;
  const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1] ?? '';
  return `${name} ${args}`.trim();
}
