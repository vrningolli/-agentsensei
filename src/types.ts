export type AgentTool = 'claude-code' | 'codex';

export type ToolKind = 'shell' | 'edit' | 'read' | 'search' | 'other';

export interface ToolCall {
  id: string;
  name: string;
  kind: ToolKind;
  command?: string;
  filePath?: string;
  isError: boolean;
  /** The user declined the tool call. */
  rejected: boolean;
  /** The user approved it by hand at a permission prompt (not via config or mode). */
  approvedByUser?: boolean;
  ts?: string;
}

export type TimelineEvent =
  | { type: 'prompt'; text: string; ts?: string }
  | { type: 'interrupt'; ts?: string }
  | { type: 'tool'; call: ToolCall };

/** One agent session, normalised so every agent looks the same to the metrics. */
export interface Session {
  id: string;
  tool: AgentTool;
  file: string;
  cwd?: string;
  title?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  costUSD?: number;
  timeline: TimelineEvent[];
}
