import { createHash } from 'node:crypto';
import { Cron } from 'croner';
import type { Logger, SessionState } from '@bloomterm/browser';
import type { EnqueueInput, Job } from '@bloomterm/store';

// Scheduler (SPEC §8.3, §6.9). Every tick it works out, for each scheduled dataset,
// whether a slot has come due since the last one it handled:
// - slots are jittered ±jitterMs, deterministically per slot, so restarts don't reshuffle;
// - slots missed while the Mac slept collapse into one catch-up run;
// - nothing is queued while a source is signed out or blocked, and the slot stays
//   pending, so the catch-up runs as soon as you sign back in;
// - the first time a dataset is scheduled, it's fetched once right away.

export const PRIORITY = { login: 100, manual: 50, probe: 20, catchup: 10, schedule: 0 } as const;

const PROBE = '__probe';
const LOOKBACK_MS = 7 * 24 * 3_600_000;
const CATCHUP_AFTER_MS = 15 * 60_000;
const PAUSED_STATES: SessionState[] = ['needs_login', 'challenge', 'blocked'];

export interface ScheduleEntry {
  source: string;
  dataset: string;
  cron: string;
  tz?: string;
}

export interface SchedulerDeps {
  entries: () => ScheduleEntry[];
  /** Signed-in sources to probe, and how often. */
  probes: () => { source: string; everyMinutes: number }[];
  state: (source: string) => SessionState;
  schedules: {
    lastSlot(source: string, dataset: string): string | null;
    setLastSlot(source: string, dataset: string, slot: string): void;
  };
  jobs: {
    enqueue(input: EnqueueInput): { job: Job; created: boolean };
    lastOk(source: string, dataset: string): string | null;
  };
  now?: () => Date;
  jitterMs?: number;
  log: Logger;
  onEnqueued?: (job: Job) => void;
}

export class Scheduler {
  private readonly now: () => Date;
  private readonly jitterMs: number;
  private readonly crons = new Map<string, Cron>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.jitterMs = deps.jitterMs ?? 10 * 60_000;
  }

  start(intervalMs = 30_000): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Job[] {
    const now = this.now();
    if (this.lastTick && now.getTime() - this.lastTick > 5 * 60_000) {
      this.deps.log.info('clock jumped (machine slept?); catching up on missed schedules', { gapMin: Math.round((now.getTime() - this.lastTick) / 60_000) });
    }
    this.lastTick = now.getTime();
    const queued: Job[] = [];
    for (const e of this.deps.entries()) {
      try {
        const job = this.considerEntry(e, now);
        if (job) queued.push(job);
      } catch (err) {
        this.deps.log.error('schedule failed', { source: e.source, dataset: e.dataset, error: String(err) });
      }
    }
    for (const p of this.deps.probes()) {
      const job = this.considerProbe(p.source, p.everyMinutes, now);
      if (job) queued.push(job);
    }
    for (const j of queued) this.deps.onEnqueued?.(j);
    return queued;
  }

  /** The next time each entry will run (for `bt sources`). */
  upcoming(): (ScheduleEntry & { next: string | null })[] {
    const now = this.now();
    return this.deps.entries().map((e) => {
      const next = this.cron(e).nextRun(now);
      return { ...e, next: next ? new Date(next.getTime() + this.jitter(e, next)).toISOString() : null };
    });
  }

  private considerEntry(e: ScheduleEntry, now: Date): Job | null {
    if (PAUSED_STATES.includes(this.deps.state(e.source))) return null;
    const last = this.deps.schedules.lastSlot(e.source, e.dataset);

    if (last === null) {
      // Never scheduled before. If it has never been fetched either, fetch it now.
      const latest = this.latestSlotBefore(e, now);
      this.deps.schedules.setLastSlot(e.source, e.dataset, (latest ?? now).toISOString());
      if (this.deps.jobs.lastOk(e.source, e.dataset)) return null;
      return this.enqueue(e, 'catchup', undefined);
    }

    const due = this.dueSlot(e, new Date(last), now);
    if (!due) return null;
    this.deps.schedules.setLastSlot(e.source, e.dataset, due.toISOString());
    const late = now.getTime() - (due.getTime() + this.jitter(e, due)) > CATCHUP_AFTER_MS;
    return this.enqueue(e, late ? 'catchup' : 'schedule', due.toISOString());
  }

  private considerProbe(source: string, everyMinutes: number, now: Date): Job | null {
    if (this.deps.state(source) !== 'ok') return null;
    const last = this.deps.schedules.lastSlot(source, PROBE);
    if (last && now.getTime() - Date.parse(last) < everyMinutes * 60_000) return null;
    this.deps.schedules.setLastSlot(source, PROBE, now.toISOString());
    if (!last) return null; // just started tracking; jobs check the session anyway
    const { job, created } = this.deps.jobs.enqueue({ kind: 'probe', source, trigger: 'schedule', priority: PRIORITY.probe });
    return created ? job : null;
  }

  private enqueue(e: ScheduleEntry, trigger: 'schedule' | 'catchup', slot: string | undefined): Job | null {
    const { job, created } = this.deps.jobs.enqueue({
      kind: 'run',
      source: e.source,
      dataset: e.dataset,
      trigger,
      slot,
      priority: PRIORITY[trigger],
    });
    if (created) this.deps.log.info('scheduled', { source: e.source, dataset: e.dataset, trigger, slot });
    return created ? job : null;
  }

  /** The latest slot after `last` whose jittered time has passed. Missed slots collapse into it. */
  private dueSlot(e: ScheduleEntry, last: Date, now: Date): Date | null {
    const cron = this.cron(e);
    let cursor = new Date(Math.max(last.getTime(), now.getTime() - LOOKBACK_MS));
    let due: Date | null = null;
    for (let i = 0; i < 10_000; i++) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > now.getTime() + this.jitterMs) break;
      if (next.getTime() + this.jitter(e, next) <= now.getTime()) due = next;
      cursor = next;
    }
    return due;
  }

  private latestSlotBefore(e: ScheduleEntry, now: Date): Date | null {
    return this.cron(e).previousRuns(1, now)[0] ?? null;
  }

  /** A stable offset in [-jitterMs, +jitterMs] for one slot. */
  jitter(e: ScheduleEntry, slot: Date): number {
    if (this.jitterMs === 0) return 0;
    const h = createHash('sha256').update(`${e.source}|${e.dataset}|${slot.toISOString()}`).digest();
    return Math.round((h.readUInt32BE(0) / 0xffffffff) * 2 * this.jitterMs - this.jitterMs);
  }

  private cron(e: ScheduleEntry): Cron {
    const key = `${e.cron}|${e.tz ?? ''}`;
    let c = this.crons.get(key);
    if (!c) {
      c = new Cron(e.cron, { timezone: e.tz, paused: true });
      this.crons.set(key, c);
    }
    return c;
  }
}

/** Throws a readable error for a bad cron or time zone. */
export function validateSchedule(e: ScheduleEntry): void {
  try {
    new Cron(e.cron, { timezone: e.tz, paused: true }).nextRun();
  } catch (err) {
    throw new Error(`${e.source}.${e.dataset}: bad schedule "${e.cron}"${e.tz ? ` (${e.tz})` : ''}: ${(err as Error).message}`);
  }
}
