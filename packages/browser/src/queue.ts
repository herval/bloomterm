import { RateLimitedError } from './errors.ts';

export class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;

  constructor(private readonly size: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

/** A gate jobs wait on while you have the window (LOGIN, challenges). */
export class PauseGate {
  private holders = 0;
  private waiters: (() => void)[] = [];

  pause(): () => void {
    this.holders++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.holders--;
      if (this.holders === 0) for (const w of this.waiters.splice(0)) w();
    };
  }

  get paused(): boolean {
    return this.holders > 0;
  }

  async wait(): Promise<void> {
    while (this.holders > 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

export interface SiteGateOptions {
  minIntervalMs: number;
  /** ± fraction applied to the interval, e.g. 0.3 for ±30%. */
  jitter: number;
  maxJobsPerHour: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Politeness for one site (SPEC §6.9): one job at a time, a jittered pause between
 * jobs, and an hourly cap. Over the cap, `run` throws RateLimitedError rather than waiting.
 */
export class SiteGate {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnd = 0;
  private starts: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: SiteGateOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const t = this.now();
      this.starts = this.starts.filter((s) => t - s < 3_600_000);
      if (this.starts.length >= this.opts.maxJobsPerHour) {
        throw new RateLimitedError(`more than ${this.opts.maxJobsPerHour} jobs in the last hour`);
      }
      if (this.lastEnd > 0) {
        const factor = 1 + (this.random() * 2 - 1) * this.opts.jitter;
        const wait = this.lastEnd + this.opts.minIntervalMs * factor - t;
        if (wait > 0) await this.sleep(wait);
      }
      this.starts.push(this.now());
      try {
        return await fn();
      } finally {
        this.lastEnd = this.now();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
