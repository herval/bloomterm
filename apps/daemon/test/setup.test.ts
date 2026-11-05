import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCli } from '@bloomterm/agent';
import { consoleLogger } from '@bloomterm/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, Daemon, memoryStore, type SetupProbes } from '../src/index.ts';
import { fakeMarket } from './fakes.ts';

// Setup (SPEC §8.8): bloomd starts without an agent CLI, says what's missing, and restarts to
// use one once it's installed. The probes are fakes: no real agent, Chrome or Spotlight.

const claude: AgentCli = { kind: 'claude', path: '/fake/claude', version: '2.1.0 (Claude Code)' };

/** What the fake Mac has; tests change it as if you installed or signed in to something. */
function fakeMac() {
  const mac = { agents: [] as AgentCli[], signedIn: true as boolean | null, chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' as string | null };
  const probes: SetupProbes = {
    agents: async () => mac.agents,
    signedIn: async () => mac.signedIn,
    chrome: async () => (mac.chrome ? { app: null, executable: mac.chrome, how: 'applications' as const } : null),
  };
  return { mac, probes };
}

const daemons: { daemon: Daemon; home: string }[] = [];

async function start(o: { agent?: AgentCli | null; probes: SetupProbes; restart?: () => void; shutdown?: () => void; config?: object }) {
  const home = await mkdtemp(join(tmpdir(), 'bt-setup-'));
  const daemon = new Daemon({
    home,
    port: 0,
    integrations: [fakeMarket],
    config: Config.parse(o.config ?? {}),
    host: { profiles: {} },
    secrets: memoryStore(),
    agent: o.agent ?? null,
    setup: o.probes,
    restart: o.restart,
    shutdown: o.shutdown,
    notify: false,
    newsTickMs: 0,
    briefTickMs: 0,
    log: consoleLogger('silent'),
  });
  await daemon.start();
  daemons.push({ daemon, home });
  const token = (await readFile(join(home, 'token'), 'utf8')).trim();
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { daemon, call };
}

afterEach(async () => {
  for (const { daemon, home } of daemons.splice(0)) {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
});

describe('setup', () => {
  it('starts bloomd without an agent CLI, and says what to install', async () => {
    const { probes } = fakeMac();
    const { call } = await start({ probes });
    const { status, body } = await call('GET', '/api/setup');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: false, agent: { installed: [], found: null, inUse: null, signedIn: null, signIn: null, restartNeeded: false }, chrome: { configured: null } });
    expect(body.chrome.path).toMatch(/Google Chrome$/);
    // Market data works; Ask waits for an agent.
    expect((await call('GET', '/api/status')).body.agent).toBeNull();
    expect((await call('POST', '/api/chats', { message: 'hi' })).status).toBe(503);
  });

  it('restarts to use an agent installed after it started, when something will start it again', async () => {
    const { mac, probes } = fakeMac();
    const restart = vi.fn();
    const { call } = await start({ probes, restart });
    expect((await call('GET', '/api/setup')).body.agent.found).toBeNull();

    mac.agents = [claude];
    // GET keeps the last check; checking again finds it.
    expect((await call('GET', '/api/setup')).body.agent.found).toBeNull();
    const { body } = await call('POST', '/api/setup/check');
    expect(body).toMatchObject({ ready: false, restarting: true, agent: { found: { kind: 'claude', path: '/fake/claude' }, inUse: null, restartNeeded: true, signIn: 'claude auth login' } });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  });

  it('stops when the desktop app asks, with the token', async () => {
    const { probes } = fakeMac();
    const shutdown = vi.fn();
    const { call, daemon } = await start({ probes, shutdown });
    const port = daemon.port;
    expect((await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' })).status).toBe(401);
    expect(shutdown).not.toHaveBeenCalled();
    expect((await call('POST', '/api/shutdown')).status).toBe(202);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it('says to restart bloomd by hand when it runs in a terminal', async () => {
    const { mac, probes } = fakeMac();
    const { call } = await start({ probes });
    mac.agents = [claude];
    expect((await call('POST', '/api/setup/check')).body).toMatchObject({ restarting: false, agent: { restartNeeded: true } });
  });

  it('isn’t ready while the agent is signed out, or there’s no Chrome', async () => {
    const { mac, probes } = fakeMac();
    mac.agents = [claude];
    mac.signedIn = false;
    mac.chrome = null;
    const { call } = await start({ agent: claude, probes, config: { browser: { chrome: '/Volumes/Apps/Chrome.app' } } });
    expect((await call('GET', '/api/setup')).body).toMatchObject({
      ready: false,
      agent: { inUse: { kind: 'claude' }, signedIn: false, signIn: expect.stringContaining('auth login'), restartNeeded: false },
      chrome: { path: null, configured: '/Volumes/Apps/Chrome.app' },
    });

    mac.signedIn = true;
    expect((await call('POST', '/api/setup/check')).body).toMatchObject({ ready: false, agent: { signedIn: true } });
    mac.chrome = '/Volumes/Apps/Chrome.app/Contents/MacOS/Google Chrome';
    expect((await call('POST', '/api/setup/check')).body).toMatchObject({ ready: true, restarting: false });
  });

  it('can’t tell whether an older CLI is signed in, and doesn’t hold that against it', async () => {
    const { mac, probes } = fakeMac();
    mac.agents = [claude];
    mac.signedIn = null;
    const { call } = await start({ agent: claude, probes });
    expect((await call('GET', '/api/setup')).body).toMatchObject({ ready: true, agent: { signedIn: null } });
  });
});
