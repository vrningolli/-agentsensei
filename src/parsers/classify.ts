import type { ToolKind } from '../types.js';

const KINDS: Record<string, ToolKind> = {
  // Claude Code
  bash: 'shell',
  powershell: 'shell',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  read: 'read',
  grep: 'search',
  glob: 'search',
  websearch: 'search',
  webfetch: 'search',
  // Codex
  shell: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  container_exec: 'shell',
  apply_patch: 'edit',
  read_file: 'read',
  view_image: 'read',
  web_search: 'search',
};

export function classifyTool(name: string): ToolKind {
  return KINDS[name.toLowerCase().replace(/[.\s-]/g, '_')] ?? 'other';
}
