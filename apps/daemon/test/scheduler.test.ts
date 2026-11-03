import type { SessionState } from '@bloomterm/browser';
import { consoleLogger } from '@bloomterm/browser';
import { openStore, type Store } from '@bloomterm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIORITY, Scheduler, type ScheduleEntry } from '../src/scheduler.ts';

// Weekdays 07:00, 13:00, 19:00 New York.
const entry: ScheduleEntry = { source: 'chase', dataset: 'balances', cron: '0 7,13,19 * * 1-5', tz: 'America/New_York' };

let store: Store;
let now: Date;
let state: SessionState;
let jitterMs: number;

function scheduler(entries = [entry], probes: { source: string; everyMinutes: number }[] = []) {
  return new Scheduler({
    entries: () => entries,
    probes: () => probes,
    state: () => state,
    schedules: store.schedules,
    jobs: store.jobs,
    now: () => now,
    jitterMs,
    log: consoleLogger('silent'),
  });
}

/** Simulates the job finishing so the next slot can queue (enqueue dedupes in-flight jobs). */
function finishAll(status: 'ok' | 'failed' = 'ok') {
  for (let j = store.jobs.claimNext(); j; j = store.jobs.claimNext()) store.jobs.finish(j.id, { status });
}

beforeEach(() => {
  store = openStore(':memory:', { now: () => now });
  now = new Date('2026-10-27T15:00:00Z'); // Tue 11:00 New York
  state = 'ok';
  jitterMs = 0;
});

afterEach(() => store.close());

describe('Scheduler', () => {
  it('fetches a never-fetched dataset once right away, then follows the schedule', () => {
    const s = scheduler();
    const [first] = s.tick();
    expect(first).toMatchObject({ kind: 'run', source: 'chase', dataset: 'balances', trigger: 'catchup', slot: null, priority: PRIORITY.catchup });
    finishAll();
    expect(s.tick()).toEqual([]);

    now = new Date('2026-10-27T17:00:30Z'); // just past 13:00 New York
    const [next] = s.tick();
    expect(next).toMatchObject({ trigger: 'schedule', slot: '2026-10-27T17:00:00.000Z', priority: PRIORITY.schedule });
  });

  it('does not refetch on first schedule if the dataset was fetched before', () => {
    const j = store.jobs.enqueue({ kind: 'run', source: 'chase', dataset: 'balances' }).job;
    store.jobs.claimNext();
    store.jobs.finish(j.id, { status: 'ok' });
    expect(scheduler().tick()).toEqual([]);
  });

  it('collapses slots missed during sleep into one catch-up run', () => {
    const s = scheduler();
    s.tick();
    finishAll();
    // Asleep from Tue 11:00 until Thu 09:00 New York: 4 slots missed.
    now = new Date('2026-10-29T13:00:00Z');
    const queued = s.tick();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ trigger: 'catchup', slot: '2026-10-29T11:00:00.000Z', priority: PRIORITY.catchup });
    finishAll();
    expect(s.tick()).toEqual([]);
  });

  it('skips weekends', () => {
    const s = scheduler();
    s.tick();
    finishAll();
    now = new Date('2026-10-30T23:30:00Z'); // Fri 19:30
    expect(s.tick()[0]?.slot).toBe('2026-10-30T23:00:00.000Z');
    finishAll();
    now = new Date('2026-11-02T03:00:00Z'); // Sun night
    expect(s.tick()).toEqual([]);
  });

  it('waits while signed out, then catches up after sign-in', () => {
    const s = scheduler();
    s.tick();
    finishAll();
    state = 'needs_login';
    now = new Date('2026-10-27T23:30:00Z');
    expect(s.tick()).toEqual([]);
    state = 'ok';
    expect(s.tick()[0]).toMatchObject({ slot: '2026-10-27T23:00:00.000Z', trigger: 'catchup' });
  });

  it('does not queue a second run while one is in flight', () => {
    const s = scheduler();
    s.tick();
    store.jobs.claimNext(); // running, never finishes
    now = new Date('2026-10-27T23:30:00Z');
    expect(s.tick()).toEqual([]);
  });

  it('jitters each slot by a stable amount within ±jitterMs', () => {
    jitterMs = 10 * 60_000;
    const s = scheduler();
    const offsets = Array.from({ length: 50 }, (_, i) => s.jitter(entry, new Date(Date.UTC(2026, 9, 1 + i, 11))));
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(jitterMs);
    expect(new Set(offsets).size).toBeGreaterThan(40);
    expect(s.jitter(entry, new Date('2026-10-27T17:00:00Z'))).toBe(s.jitter(entry, new Date('2026-10-27T17:00:00Z')));

    s.tick();
    finishAll();
    const slot = new Date('2026-10-27T17:00:00Z');
    const runAt = slot.getTime() + s.jitter(entry, slot);
    now = new Date(runAt - 1_000);
    expect(s.tick()).toEqual([]);
    now = new Date(runAt + 1_000);
    expect(s.tick()[0]?.slot).toBe(slot.toISOString());
  });

  it('probes signed-in sources on their interval', () => {
    const s = scheduler([], [{ source: 'chase', everyMinutes: 60 }]);
    expect(s.tick()).toEqual([]); // starts tracking
    now = new Date(now.getTime() + 30 * 60_000);
    expect(s.tick()).toEqual([]);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(s.tick()[0]).toMatchObject({ kind: 'probe', source: 'chase', priority: PRIORITY.probe });
    finishAll();
    state = 'needs_login';
    now = new Date(now.getTime() + 120 * 60_000);
    expect(s.tick()).toEqual([]);
  });

  it('reports the next run', () => {
    expect(scheduler().upcoming()).toEqual([{ ...entry, next: '2026-10-27T17:00:00.000Z' }]);
  });
});
