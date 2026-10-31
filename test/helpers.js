// Builders for small synthetic transcripts, so tests never depend on real sessions.

let n = 0;
const ts = () => new Date(Date.UTC(2026, 9, 1, 10, 0, n++)).toISOString();

export function claude(events) {
  const lines = [];
  for (const e of events) {
    if (e.prompt !== undefined) {
      lines.push({ type: 'user', origin: { kind: 'human' }, timestamp: ts(), cwd: '/work/app', message: { role: 'user', content: e.prompt } });
    } else if (e.tool) {
      const id = `toolu_${n}`;
      lines.push({
        type: 'assistant',
        timestamp: ts(),
        cwd: '/work/app',
        message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: e.tool, input: e.input ?? {} }] },
      });
      lines.push({
        type: 'user',
        timestamp: ts(),
        toolUseResult: {},
        permissionDecision: e.approved ? { decision: 'accept', source: 'user_temporary' } : { decision: 'accept', source: 'config' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!e.error, content: e.output ?? 'ok' }] },
      });
    } else if (e.interrupt) {
      lines.push({ type: 'user', origin: { kind: 'human' }, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

export const read = (file) => ({ tool: 'Read', input: { file_path: file } });
export const edit = (file) => ({ tool: 'Edit', input: { file_path: file } });
export const bash = (command, error = false) => ({ tool: 'Bash', input: { command }, error });
