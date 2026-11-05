import { runCli } from './launch.ts';
import { agentEnv } from './run.ts';
import type { AgentCli } from './types.ts';

/**
 * Whether the agent CLI is signed in, by asking it, in the environment its runs get. null when
 * it can't say (a version without the command). Only the yes or no is kept: `claude auth
 * status` also prints your email and organization, which bloomterm doesn't need.
 *   claude auth status --json   { "loggedIn": true, … }; exits 1 when signed out
 *   codex login status          exits 0 when signed in
 */
export async function signedIn(cli: AgentCli): Promise<boolean | null> {
  const opts = { timeout: 15_000, env: agentEnv() };
  if (cli.kind === 'claude') {
    const out = await runCli(cli.path, ['auth', 'status', '--json'], opts).then(
      (r) => r.stdout,
      (err) => String(err?.stdout ?? ''),
    );
    try {
      const loggedIn = JSON.parse(out).loggedIn;
      return typeof loggedIn === 'boolean' ? loggedIn : null;
    } catch {
      return null;
    }
  }
  try {
    await runCli(cli.path, ['login', 'status'], opts);
    return true;
  } catch (err: any) {
    return /not logged in/i.test(`${err?.stdout ?? ''}\n${err?.stderr ?? ''}`) ? false : null;
  }
}

const SIGN_IN_ARGS: Record<AgentCli['kind'], string> = { claude: 'auth login', codex: 'login' };

/**
 * How to sign in, for the setup page. On Windows it's the CLI's whole path, for PowerShell: Claude
 * Code's installer leaves it off PATH, a window opened before Codex's install doesn't have it, and a
 * stock PowerShell refuses the `.ps1` launcher npm leaves.
 */
export function signInHint({ kind, path }: AgentCli, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `& "${path}" ${SIGN_IN_ARGS[kind]}` : `${kind} ${SIGN_IN_ARGS[kind]}`;
}
