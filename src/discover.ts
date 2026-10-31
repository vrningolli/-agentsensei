import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseClaudeSession } from './parsers/claude.js';
import { parseCodexSession } from './parsers/codex.js';
import type { AgentTool, Session } from './types.js';

export interface SessionRef {
  file: string;
  tool: AgentTool;
  mtimeMs: number;
}

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

export function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
}

/** All known session files, newest first. */
export function findSessions(): SessionRef[] {
  const refs: SessionRef[] = [];
  const claude = claudeProjectsDir();
  if (existsSync(claude)) {
    // Only <project>/<session>.jsonl; deeper files are subagent transcripts.
    for (const project of safeReaddir(claude)) {
      const dir = join(claude, project);
      for (const f of safeReaddir(dir)) {
        if (f.endsWith('.jsonl')) refs.push(ref(join(dir, f), 'claude-code'));
      }
    }
  }
  const codex = codexSessionsDir();
  if (existsSync(codex)) {
    for (const file of walk(codex)) {
      if (file.endsWith('.jsonl')) refs.push(ref(file, 'codex'));
    }
  }
  return refs.filter((r) => r.mtimeMs > 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function loadSession(r: SessionRef): Session {
  return r.tool === 'codex' ? parseCodexSession(r.file) : parseClaudeSession(r.file);
}

export function sameDir(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function ref(file: string, tool: AgentTool): SessionRef {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // unreadable file, filtered out by the caller
  }
  return { file, tool, mtimeMs };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of safeReaddir(dir)) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    } catch {
      // skip entries we cannot stat
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
