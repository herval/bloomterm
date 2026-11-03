import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCli, AgentKind } from './types.ts';

const run = promisify(execFile);

// bloomd may run under launchd, whose PATH is just /usr/bin:/bin, so also look where the
// installers put these.
const KNOWN_DIRS = () => [join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.npm-global/bin'), join(homedir(), '.bun/bin')];

/** The directories to search, PATH first. */
export function searchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), ...KNOWN_DIRS()])];
}

async function find(name: string, dirs: string[]): Promise<string | null> {
  for (const d of dirs) {
    const p = join(d, name);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** Every agent CLI installed, Claude Code first. */
export async function findAgents(dirs = searchPath()): Promise<AgentCli[]> {
  const out: AgentCli[] = [];
  for (const kind of ['claude', 'codex'] as const) {
    const path = await find(kind, dirs);
    if (!path) continue;
    try {
      const { stdout } = await run(path, ['--version'], { timeout: 15_000 });
      out.push({ kind, path, version: stdout.trim().split('\n')[0]! });
    } catch {
      // there, but doesn't run
    }
  }
  return out;
}

export function pickAgent(found: AgentCli[], prefer: AgentKind | 'auto' = 'auto'): AgentCli | null {
  if (prefer !== 'auto') return found.find((a) => a.kind === prefer) ?? null;
  return found[0] ?? null;
}

export const INSTALL_HINT =
  'bloomterm needs Claude Code or Codex installed and signed in: `npm i -g @anthropic-ai/claude-code` then `claude` (or `npm i -g @openai/codex` then `codex login`).';
