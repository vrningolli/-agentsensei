import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeSession } from '../dist/parsers/claude.js';
import { parseCodexSession } from '../dist/parsers/codex.js';
import { computeMetrics } from '../dist/metrics.js';
import { reviewSession } from '../dist/review.js';
import { findRepeatedInstructions } from '../dist/report.js';
import { redact } from '../dist/redact.js';
import { bash, claude, edit, read } from './helpers.js';

const vagueSession = () =>
  parseClaudeSession(
    'bad.jsonl',
    claude([
      { prompt: 'login is broken fix it' },
      ...Array.from({ length: 9 }, (_, i) => read(`src/file${i}.ts`)),
      edit('src/auth.ts'),
      { prompt: 'no, not that file' },
      edit('src/login.ts'),
      { prompt: 'still broken' },
      bash('curl localhost:3000/login', true),
      bash('curl localhost:3000/login', true),
      bash('curl localhost:3000/login', true),
      bash('curl localhost:3000/login', true),
    ]),
  );

const goodSession = () =>
  parseClaudeSession(
    'good.jsonl',
    claude([
      { prompt: 'Login returns 401 after the session expires. The refresh logic is in src/auth/refresh.ts. Fix it; done when `npm test auth` passes.' },
      read('src/auth/refresh.ts'),
      edit('src/auth/refresh.ts'),
      bash('npm test auth'),
    ]),
  );

test('parses prompts, tool calls and results from a Claude Code transcript', () => {
  const s = vagueSession();
  const prompts = s.timeline.filter((e) => e.type === 'prompt').map((e) => e.text);
  assert.deepEqual(prompts, ['login is broken fix it', 'no, not that file', 'still broken']);
  const calls = s.timeline.filter((e) => e.type === 'tool').map((e) => e.call);
  assert.equal(calls.length, 15);
  assert.equal(calls.filter((c) => c.isError).length, 4);
  assert.equal(s.model, 'claude-opus-5-5');
});

test('ignores subagent turns, injected text and maps interrupts and slash commands', () => {
  const text = [
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: '<command-name>/review</command-name><command-args>pr 12</command-args>' } }),
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'Caveat: the messages below were generated' } }),
    JSON.stringify({ type: 'user', isSidechain: true, origin: { kind: 'human' }, message: { content: 'subagent prompt' } }),
    claude([{ interrupt: true }]),
  ].join('\n');
  const s = parseClaudeSession('x.jsonl', text);
  assert.deepEqual(
    s.timeline.map((e) => (e.type === 'prompt' ? e.text : e.type)),
    ['/review pr 12', 'interrupt'],
  );
});

test('metrics: exploration, corrections, retry loops and missing verification', () => {
  const m = computeMetrics(vagueSession());
  assert.equal(m.exploreBeforeFirstEdit, 9);
  assert.equal(m.corrections.length, 2);
  assert.deepEqual(m.retryLoops, [{ command: 'curl localhost:3000/login', times: 4 }]);
  assert.equal(m.checks, 0);
  assert.equal(m.verifiedAfterLastEdit, false);
  assert.equal(m.firstPrompt.hasLocation, false);
});

test('a vague, unverified session scores low with the right top tips', () => {
  const r = reviewSession(vagueSession());
  assert.ok(r.score < 50, `score was ${r.score}`);
  assert.deepEqual(
    r.tips.map((t) => t.id),
    ['unverified', 'vague-start'],
  );
  assert.ok(r.betterPrompt.suggestion.includes('Done when:'));
  assert.equal(r.tips.length, 2);
});

test('a specific, verified session scores high and gets praised', () => {
  const r = reviewSession(goodSession());
  assert.equal(r.score, 100);
  assert.equal(r.findings.length, 0);
  assert.ok(r.strengths.some((s) => s.startsWith('Verified')));
  assert.equal(r.betterPrompt, undefined);
});

test('reading a test file is not counted as running tests', () => {
  const s = parseClaudeSession('x.jsonl', claude([{ prompt: 'update the readme please' }, edit('README.md'), bash('cat test/a.test.js')]));
  assert.equal(computeMetrics(s).checks, 0);
});

test('running a script counts as a check; cd-prefixed mkdir does not', () => {
  const s = parseClaudeSession(
    'x.jsonl',
    claude([
      { prompt: 'Add DP solutions under dynamic-programming/, done when run-all.js prints all passing' },
      bash('cd "/c/my dir/js" && mkdir -p dynamic-programming/test'),
      edit('dynamic-programming/0070.js'),
      bash('cd "/c/my dir/js" && node dynamic-programming/run-all.js'),
    ]),
  );
  const m = computeMetrics(s);
  assert.equal(m.checks, 1);
  assert.equal(m.verifiedAfterLastEdit, true);
});

test('docs and scratchpad files do not need verifying', () => {
  const s = parseClaudeSession(
    'x.jsonl',
    claude([
      { prompt: 'Update my resume skills section in resume.html' },
      edit('C:/Resumes/resume.html'),
      edit('notes/plan.md'),
      edit('C:/Users/me/AppData/Local/Temp/claude/x/scratchpad/viz.js'),
    ]),
  );
  const r = reviewSession(s);
  assert.equal(r.metrics.codeEdits, 0);
  assert.ok(!r.findings.some((f) => f.area === 'verification'));
});

test('duration counts active time only', () => {
  const s = parseClaudeSession('x.jsonl', claude([{ prompt: 'hello there friend' }]));
  s.timeline = [
    { type: 'prompt', text: 'a', ts: '2026-10-01T10:00:00Z' },
    { type: 'prompt', text: 'b', ts: '2026-10-01T10:04:00Z' },
    { type: 'prompt', text: 'c', ts: '2026-10-02T09:00:00Z' },
  ];
  s.startedAt = '2026-10-01T10:00:00Z';
  s.endedAt = '2026-10-02T09:01:00Z';
  // 4 min + 10 min cap for the overnight gap + 1 min
  assert.equal(computeMetrics(s).durationMin, 15);
});

test('edits after the last check are flagged', () => {
  const s = parseClaudeSession(
    'x.jsonl',
    claude([{ prompt: 'Fix the rounding bug in src/money.ts, done when tests pass' }, edit('src/money.ts'), bash('npm test'), edit('src/money.ts')]),
  );
  assert.ok(reviewSession(s).findings.some((f) => f.id === 'edited-after-check'));
});

test('parses a Codex rollout and prefers event_msg prompts over duplicates', () => {
  const lines = [
    { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id: 'abc-123', cwd: '/work/app' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'fail', metadata: { exit_code: 1 } }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n' } },
    { type: 'event_msg', timestamp: '2026-10-01T10:05:00Z', payload: { type: 'turn_aborted' } },
  ];
  const s = parseCodexSession('rollout-x.jsonl', lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(s.id, 'abc-123');
  assert.equal(s.cwd, '/work/app');
  assert.deepEqual(
    s.timeline.map((e) => (e.type === 'prompt' ? e.text : e.type === 'tool' ? `${e.call.kind}:${e.call.isError}` : e.type)),
    ['fix the bug', 'shell:true', 'edit:false', 'interrupt'],
  );
  const m = computeMetrics(s);
  assert.equal(m.failedChecks, 1);
  assert.equal(m.filesEdited, 1);
  assert.equal(m.durationMin, 5);
});

test('finds instructions repeated across 3+ sessions', () => {
  const mk = (id, prompt) => ({ id, tool: 'claude-code', file: id, timeline: [{ type: 'prompt', text: prompt }] });
  const found = findRepeatedInstructions([
    mk('a', 'Add a login page. Please use pnpm, not npm.'),
    mk('b', 'use pnpm not npm! then fix the tests'),
    mk('c', 'Also use pnpm, not npm'),
    mk('d', 'something else entirely here'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].sessions, 3);
});

test('redacts secrets and emails', () => {
  const out = redact('key sk-ant-abcdefghijklmnop1234 mail me@x.com password=hunter2 ghp_abcdefghijklmnopqrstuv');
  assert.ok(!/abcdefghijklmnop1234|me@x\.com|hunter2|ghp_/.test(out), out);
});
