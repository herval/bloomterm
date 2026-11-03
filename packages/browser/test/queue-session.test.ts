import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitedError } from '../src/errors.ts';
import { PauseGate, Semaphore, SiteGate } from '../src/queue.ts';
import { SessionStore, transition, type SessionRecord } from '../src/session.ts';

describe('SiteGate', () => {
  it('runs one job at a time with a jittered pause in between', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const gate = new SiteGate({
      minIntervalMs: 5_000,
      jitter: 0.3,
      maxJobsPerHour: 10,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 1, // +30%
    });
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(`start ${name}`);
      now += 1_000;
      order.push(`end ${name}`);
    };
    await Promise.all([gate.run(job('a')), gate.run(job('b'))]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(sleeps).toEqual([6_500]);
  });

  it('refuses jobs over the hourly cap instead of queueing them', async () => {
    let now = 0;
    const gate = new SiteGate({ minIntervalMs: 0, jitter: 0, maxJobsPerHour: 2, now: () => now, sleep: async () => {} });
    await gate.run(async () => 1);
    await gate.run(async () => 2);
    await expect(gate.run(async () => 3)).rejects.toBeInstanceOf(RateLimitedError);
    now += 3_600_001;
    await expect(gate.run(async () => 4)).resolves.toBe(4);
  });
});

describe('Semaphore and PauseGate', () => {
  it('caps concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const release = await sem.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      }),
    );
    expect(peak).toBe(2);
  });

  it('holds jobs while paused', async () => {
    const gate = new PauseGate();
    const resume = gate.pause();
    let passed = false;
    const waiting = gate.wait().then(() => (passed = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(passed).toBe(false);
    resume();
    await waiting;
    expect(passed).toBe(true);
  });
});

describe('session state machine', () => {
  const base: SessionRecord = { source: 's', state: 'unknown', since: '1970-01-01T00:00:00.000Z', errorStreak: 0 };
  const at = new Date('2026-10-26T12:00:00Z');

  it('follows SPEC §6.3', () => {
    const loggedOut = transition(base, { type: 'probe_logged_out' }, at);
    expect(loggedOut).toMatchObject({ state: 'needs_login', since: at.toISOString() });
    const ok = transition(loggedOut, { type: 'login_ok' }, at);
    expect(ok.state).toBe('ok');
    const parseError = transition(ok, { type: 'job_error', error: 'bad csv' }, at);
    expect(parseError).toMatchObject({ state: 'ok', errorStreak: 1, lastError: 'bad csv' });
    const challenged = transition(parseError, { type: 'challenge' }, at);
    expect(transition(challenged, { type: 'challenge_resolved' }, at)).toMatchObject({ state: 'ok', errorStreak: 0 });
    const blocked = transition(ok, { type: 'blocked', error: '403' }, at);
    expect(blocked.state).toBe('blocked');
    expect(transition(blocked, { type: 'retry' }, at).state).toBe('unknown');
    expect(transition(ok, { type: 'job_ok' }, at).lastOk).toBe(at.toISOString());
  });
});

describe('SessionStore', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('persists records to a 0600 file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bt-session-'));
    const file = join(dir, 'state', 'sessions.json');
    const store = new SessionStore(file);
    await store.apply('b3', { type: 'login_ok' });
    const reloaded = new SessionStore(file);
    expect((await reloaded.get('b3')).state).toBe('ok');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).b3.state).toBe('ok');
  });
});
