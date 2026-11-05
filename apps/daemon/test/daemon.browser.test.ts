import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleLogger, defineBrowserAdapter, z } from '@bloomterm/browser';
import { defineIntegration } from '@bloomterm/integrations';
import { Position } from '@bloomterm/core';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { POSITIONS, startFakeBank, type FakeBank } from '../../../packages/browser/test/fake-bank.ts';
import { Config } from '../src/config.ts';
import { Daemon, stateFile, type DaemonEvent } from '../src/daemon.ts';

// bloomd end to end: real Chrome (headless) against the fake bank, through the HTTP API.

let bank: FakeBank;
let home: string;
let daemon: Daemon;
let token: string;
const events: DaemonEvent[] = [];
let ws: WebSocket;

function adapter(base: string) {
  return defineBrowserAdapter({
    id: 'fakebank',
    name: 'Fake Bank',
    profile: 'finance',
    origins: [base],
    minIntervalMs: 0,
    maxJobsPerHour: 1_000,
    login: { url: `${base}/login`, successUrl: /\/summary$/, check: async ({ request }) => (await request.get(`${base}/api/me`)).ok() },
    datasets: {
      positions: {
        schema: z.array(Position),
        persist: 'positions',
        schedule: { cron: '0 9 * * 1-5', tz: 'America/New_York' },
        strategies: [{ kind: 'request', run: (ctx) => ctx.fetchJson(`${base}/api/positions`) }],
      },
      me: { schema: z.object({ user: z.string() }), strategies: [{ kind: 'request', run: (ctx) => ctx.fetchJson(`${base}/api/me`) }] },
    },
  });
}

function newDaemon() {
  return new Daemon({
    home,
    port: 0,
    integrations: [defineIntegration({ id: 'fakebank', name: 'Fake Bank', covers: 'a fake bank', access: 'browser', status: 'ready', browser: adapter(bank.url) })],
    config: Config.parse({}),
    host: { profiles: { finance: { mode: 'headless', useSystemKeychain: false, cdpUrl: inject('chromeCdpUrl') } }, interactiveHeadless: true },
    notify: false,
    schedulerIntervalMs: 3_600_000,
    jitterMs: 0,
    log: consoleLogger('silent'),
  });
}

async function api<T = any>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const waitJob = (id: string) =>
  waitFor(async () => {
    const { body } = await api('GET', `/api/jobs/${id}`);
    return ['ok', 'failed', 'cancelled'].includes(body.status) ? body : null;
  });

beforeAll(async () => {
  bank = await startFakeBank();
  home = await mkdtemp(join(tmpdir(), 'bt-daemon-'));
  daemon = newDaemon();
  await daemon.start();
  token = (await readFile(join(home, 'token'), 'utf8')).trim();
  ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/api/events?token=${token}`);
  ws.on('message', (m) => events.push(JSON.parse(String(m))));
  await new Promise((r) => ws.once('open', r));
});

afterAll(async () => {
  ws?.close();
  await daemon?.stop();
  await bank?.close();
  await rm(home, { recursive: true, force: true });
});

describe('bloomd', () => {
  it('writes a private token and a state file', async () => {
    if (process.platform !== 'win32') expect((await stat(join(home, 'token'))).mode & 0o777).toBe(0o600); // Windows has no such modes
    expect(JSON.parse(await readFile(stateFile(home), 'utf8'))).toMatchObject({ pid: process.pid, port: daemon.port });
  });

  it('requires the token everywhere but /api/health', async () => {
    expect((await api('GET', '/api/health', undefined, false)).status).toBe(200);
    expect((await api('GET', '/api/sources', undefined, false)).status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${daemon.port}/api/sources`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('rejects requests whose Host header is not this machine (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: daemon.port, path: '/api/sources', headers: { host: 'evil.example', authorization: `Bearer ${token}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('tries the first fetch on its own, finds you signed out, and says so', async () => {
    const failed = await waitFor(async () => (await api<any[]>('GET', '/api/jobs?status=failed')).body[0]);
    expect(failed).toMatchObject({ kind: 'run', source: 'fakebank', dataset: 'positions', trigger: 'catchup' });
    expect(failed.error).toMatch(/needs a sign-in/);
    const { body: sources } = await api<any[]>('GET', '/api/sources');
    expect(sources[0]).toMatchObject({ id: 'fakebank', session: { state: 'needs_login' } });
    expect(sources[0].datasets.find((d: any) => d.name === 'positions').next).toBeTruthy();
    expect(events.some((e) => e.type === 'attention' && e.reason === 'needs_login')).toBe(true);
  });

  it('signs in through a login job, then runs the missed fetch and stores positions', async () => {
    const { status, body: job } = await api('POST', '/api/sources/fakebank/login');
    expect(status).toBe(202);
    const page = await waitFor(async () =>
      daemon.host
        .runtime('finance')
        .anchor()
        ?.context()
        .pages()
        .find((p) => p.url().endsWith('/login')),
    );
    await page.getByLabel('Username').fill('herval');
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect(await waitJob(job.id)).toMatchObject({ status: 'ok', result: { state: 'ok' } });

    const positions = await waitFor(async () => {
      const { body } = await api<any[]>('GET', '/api/positions');
      return body.length ? body : null;
    });
    expect(positions).toHaveLength(POSITIONS.length);
    expect(positions[0]).toMatchObject({ source: 'fakebank', method: 'request', confidence: 'high' });
    expect(positions.map((p) => p.rawSymbol).sort()).toEqual(POSITIONS.map((p) => p.rawSymbol).sort());
  });

  it('runs a dataset on request and reports the result', async () => {
    const { body: job } = await api('POST', '/api/sources/fakebank/datasets/positions/run', {});
    const done = await waitJob(job.id);
    expect(done).toMatchObject({ status: 'ok', method: 'request', trigger: 'manual', result: { persisted: 'positions', rows: 2 } });
    expect(done.rawDir).toContain(job.id);

    const { body: me } = await api('POST', '/api/sources/fakebank/datasets/me/run');
    expect((await waitJob(me.id)).result).toEqual({ user: 'h' });
  });

  it('EVOLVE: captures a page and fetches as the signed-in profile, guard on', async () => {
    const page = (await api('POST', '/api/evolve/capture', { integration: 'fakebank', url: `${bank.url}/summary`, waitMs: 3_000 })).body;
    expect(page.title).toMatch(/^loaded \d+/);
    const positions = page.requests.find((r: any) => r.url === `${bank.url}/api/positions`);
    expect(positions).toMatchObject({ type: 'fetch', method: 'GET', status: 200 });
    expect(positions.body).toHaveLength(POSITIONS.length);
    expect(page.text).toContain('Buy');

    const me = (await api('POST', '/api/evolve/fetch', { integration: 'fakebank', url: `${bank.url}/api/me` })).body;
    expect(me).toMatchObject({ status: 200, body: { user: expect.any(String) } });
    expect((await api('POST', '/api/evolve/fetch', { integration: 'fakebank', url: 'file:///etc/passwd' })).status).toBe(400);
  });

  it("EVOLVE: try_dataset runs the branch's code against the live site and saves nothing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'bt-run-'));
    const dir = join(runDir, 'fakebank');
    await mkdir(dir, { recursive: true });
    // The run's copy, as EVOLVE writes it: everything from @bloomterm/sdk.
    await writeFile(
      join(dir, 'index.ts'),
      `import { defineBrowserAdapter, defineIntegration, z } from '@bloomterm/sdk';
const base = ${JSON.stringify(bank.url)};
const fetchMe = { kind: 'request' as const, run: (ctx: any) => ctx.fetchJson(base + '/api/me') };
export default defineIntegration({
  id: 'fakebank', name: 'Fake Bank (run)', covers: 'a test', access: 'browser', status: 'ready',
  browser: defineBrowserAdapter({
    id: 'fakebank', name: 'Fake Bank (run)', profile: 'finance', origins: [base], minIntervalMs: 0, maxJobsPerHour: 1000,
    login: { url: base + '/login', check: async ({ request }: any) => (await request.get(base + '/api/me')).ok() },
    datasets: {
      me: { schema: z.object({ user: z.string() }), strategies: [fetchMe] },
      wrong: { schema: z.array(z.unknown()), strategies: [fetchMe] },
    },
  }),
});
`,
    );
    const run = daemon.store.chats.create({ title: 'EVOLVE fakebank: test', agent: 'claude', kind: 'evolve', meta: { integration: 'fakebank', dir: runDir, from: 'new' } });
    const jobsBefore = (await api<any[]>('GET', '/api/jobs?limit=500')).body.length;

    const good = (await api('POST', '/api/evolve/try', { run: run.id, dataset: 'me' })).body;
    expect(good).toMatchObject({ ok: true, method: 'request', data: { user: expect.any(String) } });
    const bad = (await api('POST', '/api/evolve/try', { run: run.id, dataset: 'wrong' })).body;
    expect(bad).toMatchObject({ ok: false, stage: 'run', error: expect.stringContaining('expected array') });
    const missing = (await api('POST', '/api/evolve/try', { run: run.id, dataset: 'nope' })).body;
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('no dataset "nope"') });

    // Edits show up on the next try: every load is fresh.
    await writeFile(join(dir, 'index.ts'), (await readFile(join(dir, 'index.ts'), 'utf8')).replace("me: {", "me2: {"));
    expect((await api('POST', '/api/evolve/try', { run: run.id, dataset: 'me2' })).body).toMatchObject({ ok: true });

    expect((await api<any[]>('GET', '/api/jobs?limit=500')).body).toHaveLength(jobsBefore);
    expect((await api<any[]>('GET', '/api/sources')).body[0].session.state).toBe('ok');
    expect((await api('POST', '/api/evolve/try', { run: 'c_nope', dataset: 'me' })).status).toBe(404);
    await rm(runDir, { recursive: true, force: true });
  });

  it('answers 404 for unknown sources and datasets, 400 for bad bodies', async () => {
    expect((await api('POST', '/api/sources/nope/probe')).status).toBe(404);
    expect((await api('POST', '/api/sources/fakebank/datasets/nope/run')).status).toBe(404);
    expect((await api('POST', '/api/profiles/finance/wipe', { confirm: false })).status).toBe(400);
    expect((await api('GET', '/api/jobs/nope')).status).toBe(404);
  });

  it('streams job and session events over the WebSocket', () => {
    expect(events[0]).toMatchObject({ type: 'hello' });
    const updates = events.filter((e): e is Extract<DaemonEvent, { type: 'job_update' }> => e.type === 'job_update');
    expect(updates.some((e) => e.job.status === 'running')).toBe(true);
    expect(updates.some((e) => e.job.status === 'ok' && e.job.kind === 'login')).toBe(true);
    expect(events.some((e) => e.type === 'session' && e.record.state === 'ok')).toBe(true);
  });

  it('keeps sessions and data across a restart', async () => {
    ws.close();
    await daemon.stop();
    await expect(stat(stateFile(home))).rejects.toThrow();
    daemon = newDaemon();
    await daemon.start();
    const { body: sources } = await api<any[]>('GET', '/api/sources');
    expect(sources[0].session.state).toBe('ok');
    expect((await api<any[]>('GET', '/api/positions')).body).toHaveLength(POSITIONS.length);
    const { body: probe } = await api('POST', '/api/sources/fakebank/probe');
    expect((await waitJob(probe.id)).result).toEqual({ state: 'ok' });
  });
});
