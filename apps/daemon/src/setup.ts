import { findAgents, pickAgent, SIGN_IN_HINT, signedIn, type AgentCli } from '@bloomterm/agent';
import { findChrome, type ChromeLocation, type Logger } from '@bloomterm/browser';
import type { Config } from './config.ts';

// Setup (SPEC §8.8): what bloomterm needs on this Mac, which bloomd checks when it starts and
// again when you ask, and the web app's Setup page shows until it's all there.
//   - your agent CLI (Claude Code or Codex), installed and signed in: Ask, the brief, news and
//     EVOLVE run on it. bloomd starts without one, so the page can say so; when one is installed
//     later, bloomd restarts to use it.
//   - Google Chrome: your accounts are signed in to in it. Market data and news work without it.

/** How bloomd looks; tests swap these out. */
export interface SetupProbes {
  agents(): Promise<AgentCli[]>;
  signedIn(cli: AgentCli): Promise<boolean | null>;
  chrome(configured?: string): Promise<ChromeLocation | null>;
}

export const systemProbes: SetupProbes = {
  agents: () => findAgents(),
  signedIn,
  chrome: (configured) => findChrome({ configured }),
};

type Agent = { kind: AgentCli['kind']; version: string };

export interface SetupState {
  checkedAt: string;
  /** Everything's there, and bloomd uses it. */
  ready: boolean;
  agent: {
    /** [agent] cli in config.toml. */
    wanted: Config['agent']['cli'];
    /** Every agent CLI installed. */
    installed: Agent[];
    /** The one bloomd uses, or would after a restart. */
    found: (Agent & { path: string }) | null;
    /** null: it couldn't say. */
    signedIn: boolean | null;
    /** What to run to sign in. */
    signIn: string | null;
    /** The one bloomd is running with: none when it started before one was installed. */
    inUse: Agent | null;
    /** An agent is installed now, and bloomd has to restart to use it. */
    restartNeeded: boolean;
  };
  chrome: {
    /** What bloomterm launches, or null when there's no Chrome. */
    path: string | null;
    /** [browser] chrome in config.toml. */
    configured: string | null;
  };
}

export class Setup {
  private state: SetupState | null = null;
  private checking: Promise<SetupState> | null = null;

  constructor(
    private readonly o: {
      probes: SetupProbes;
      config: Config;
      /** The agent bloomd runs with. */
      inUse: AgentCli | null;
      log: Logger;
    },
  ) {}

  /** The last check, or a first one. */
  get(): Promise<SetupState> {
    return this.state ? Promise.resolve(this.state) : this.check();
  }

  /** Checks again: after you install or sign in to something. */
  check(): Promise<SetupState> {
    this.checking ??= this.run().finally(() => (this.checking = null));
    return this.checking;
  }

  private async run(): Promise<SetupState> {
    const { probes, config, inUse } = this.o;
    const [installed, chrome] = await Promise.all([probes.agents().catch(() => []), probes.chrome(config.browser.chrome).catch(() => null)]);
    const found = pickAgent(installed, config.agent.cli);
    // Signed in or not is the one bloomd uses' business; another one installed beside it isn't.
    const agent = inUse ?? found;
    const signedIn = agent ? await probes.signedIn(agent).catch(() => null) : null;
    const restartNeeded = !inUse && !!found;
    const state: SetupState = {
      checkedAt: new Date().toISOString(),
      ready: !!inUse && signedIn !== false && !!chrome,
      agent: {
        wanted: config.agent.cli,
        installed: installed.map(({ kind, version }) => ({ kind, version })),
        found: agent && { kind: agent.kind, version: agent.version, path: agent.path },
        signedIn,
        signIn: agent ? SIGN_IN_HINT[agent.kind] : null,
        inUse: inUse && { kind: inUse.kind, version: inUse.version },
        restartNeeded,
      },
      chrome: { path: chrome?.executable ?? null, configured: config.browser.chrome ?? null },
    };
    if (!state.ready) {
      this.o.log.warn('setup is not finished', {
        agent: inUse ? `${inUse.kind}${signedIn === false ? ', signed out' : ''}` : found ? `${found.kind}, restart to use it` : 'none',
        chrome: chrome?.executable ?? 'none',
      });
    }
    this.state = state;
    return state;
  }
}
