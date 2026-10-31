import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BLOCK_END,
  BLOCK_START,
  allowRules,
  applyProposals,
  buildProposals,
  mergeAllow,
  mergeMemory,
  planChanges,
  undoLastFix,
} from '../dist/fix.js';
import { parseClaudeSession } from '../dist/parsers/claude.js';
import { bash, claude, edit } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'agentsensei-'));

test('mergeMemory creates a managed block in a new file', () => {
  const out = mergeMemory(undefined, ['Use pnpm, not npm.']);
  assert.ok(out.startsWith(BLOCK_START));
  assert.ok(out.includes('- Use pnpm, not npm.'));
  assert.ok(out.trim().endsWith(BLOCK_END));
});

test('mergeMemory appends inside an existing block and keeps the rest of the file', () => {
  const first = mergeMemory('# My project\n\nSome notes.\n', ['Use pnpm, not npm.']);
  const second = mergeMemory(first, ['Run the tests.']);
  assert.ok(second.startsWith('# My project\n\nSome notes.\n'));
  assert.equal(second.split(BLOCK_START).length, 2, 'only one block');
  assert.ok(second.indexOf('- Run the tests.') < second.indexOf(BLOCK_END));
  assert.ok(second.indexOf('- Use pnpm') < second.indexOf('- Run the tests.'));
});

test('mergeMemory skips lines already in the file and keeps CRLF', () => {
  assert.equal(mergeMemory('Always USE PNPM, NOT NPM.\r\n', ['use pnpm, not npm.']), null);
  const out = mergeMemory('# Notes\r\n', ['New rule.']);
  assert.ok(out.includes('\r\n- New rule.\r\n'));
});

test('mergeAllow adds rules once and keeps other settings', () => {
  const out = mergeAllow(JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } }), [
    'Bash(ls:*)',
    'Bash(git status:*)',
  ]);
  const json = JSON.parse(out);
  assert.equal(json.model, 'x');
  assert.deepEqual(json.permissions.deny, ['Bash(rm:*)']);
  assert.deepEqual(json.permissions.allow, ['Bash(ls:*)', 'Bash(git status:*)']);
  assert.equal(mergeAllow(out, ['Bash(git status:*)']), null);
  assert.throws(() => mergeAllow('{ not json', ['Bash(ls:*)']));
});

const approved = (command) => ({ ...bash(command), approved: true });

test('allowRules only suggests safe commands approved by hand twice', () => {
  const s = parseClaudeSession(
    'a.jsonl',
    claude([
      { prompt: 'hi there' },
      approved('git status'),
      approved('cd /repo && git status --short'),
      approved('rm -rf build'),
      approved('rm -rf build'),
      approved('npm test && rm -rf /'),
      approved('npm test -- auth'),
      bash('npm test'), // auto-approved, not a prompt
    ]),
  );
  assert.deepEqual(allowRules([s]), [{ rule: 'Bash(git status:*)', times: 2 }]);
});

test('buildProposals turns real patterns into rules, project scope uses the test script', () => {
  const cwd = tmp();
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), '');
  const mk = (id, prompt) => parseClaudeSession(`${id}.jsonl`, claude([{ prompt }, edit('src/a.ts')]));
  const sessions = [
    mk('s1', 'Update the parser in src/parse.ts so dates work. Use pnpm, not npm.'),
    mk('s2', 'Add a CSV export to src/export.ts. Use pnpm, not npm.'),
    mk('s3', 'Rename the user model in src/user.ts. use pnpm not npm'),
  ];
  const proposals = buildProposals(sessions, { scope: 'project', cwd, claudeDir: join(cwd, 'home'), codexDir: join(cwd, 'codex') });
  const ids = proposals.map((p) => p.id);
  assert.ok(ids.includes('verify'));
  assert.ok(ids.some((id) => id.startsWith('repeat:')));
  const verify = proposals.find((p) => p.id === 'verify');
  assert.match(verify.lines[0], /`pnpm test`/);
  assert.deepEqual(verify.files, [join(cwd, 'CLAUDE.md')]);
});

test('apply backs up, writes, and undo restores both edited and new files', () => {
  const home = tmp();
  process.env.AGENTSENSEI_HOME = join(home, '.agentsensei');
  const existing = join(home, 'CLAUDE.md');
  const created = join(home, 'sub', 'settings.json');
  writeFileSync(existing, '# Mine\n');
  const proposals = [
    { id: 'a', kind: 'memory', title: 'a', reason: '', files: [existing], lines: ['Rule one.'] },
    { id: 'b', kind: 'memory', title: 'b', reason: '', files: [existing], lines: ['Rule two.'] },
    { id: 'c', kind: 'allow', title: 'c', reason: '', files: [created], rules: ['Bash(ls:*)'] },
  ];
  const files = applyProposals(proposals);
  assert.deepEqual(files, [existing, created]);
  assert.ok(readFileSync(existing, 'utf8').includes('- Rule two.'));
  assert.equal(planChanges(proposals[0]).length, 0, 'already applied');

  assert.deepEqual(undoLastFix(), [existing, created]);
  assert.equal(readFileSync(existing, 'utf8'), '# Mine\n');
  assert.equal(existsSync(created), false);
  assert.deepEqual(undoLastFix(), []);
  delete process.env.AGENTSENSEI_HOME;
});
