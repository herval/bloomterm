import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runCli } from './launch.ts';
import type { AgentCli, AgentKind } from './types.ts';

// bloomd may run under launchd, whose PATH is just /usr/bin:/bin, or start before an install changed
// PATH, so also look where the installers put these.
function knownDirs(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? join(home, 'AppData/Roaming');
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
    return [join(home, '.local/bin'), join(roaming, 'npm'), join(local, 'Programs/OpenAI/Codex/bin'), join(local, 'pnpm'), join(local, 'Microsoft/WinGet/Links'), join(home, '.bun/bin')];
  }
  return [join(home, '.local/bin'), join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin'), join(home, '.bun/bin')];
}

/** The directories to search, PATH first. */
export function searchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), ...knownDirs()])];
}

/** What a CLI's file is called. npm also leaves a shell script with no extension on Windows, which nothing there can start. */
const fileNames = (name: string) => (process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name]);

async function find(name: string, dirs: string[]): Promise<string | null> {
  for (const d of dirs) {
    for (const file of fileNames(name)) {
      const p = join(d, file);
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
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
      const { stdout } = await runCli(path, ['--version'], { timeout: 15_000 });
      out.push({ kind, path, version: stdout.trim().split('\n')[0]!.trim() });
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

/** What installs each agent here, for the setup page and errors. On Windows, their own installers, for PowerShell: a new PC has no Node. */
export function installCommands(platform: NodeJS.Platform = process.platform): Record<AgentKind, string> {
  return platform === 'win32'
    ? {
        claude: 'irm https://claude.ai/install.ps1 | iex',
        codex: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      }
    : { claude: 'npm i -g @anthropic-ai/claude-code && claude', codex: 'npm i -g @openai/codex && codex login' };
}

const { claude, codex } = installCommands();
export const INSTALL_HINT = `bloomterm needs Claude Code or Codex installed and signed in: \`${claude}\` (or \`${codex}\`).`;
