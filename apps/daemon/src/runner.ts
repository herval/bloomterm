import { BlockedError, ChallengeError, NeedsLoginError, type BrowserHost, type Logger } from '@bloomterm/browser';
import type { Job, Store } from '@bloomterm/store';

export interface RunnerOptions {
  store: Store;
  host: BrowserHost;
  log: Logger;
  concurrency: number;
  onUpdate: (job: Job) => void;
}

const sessionError = (err: unknown) => err instanceof NeedsLoginError || err instanceof ChallengeError || err instanceof BlockedError;

/**
 * Pulls jobs from the SQLite queue and runs them through the browser host. The host
 * already serializes per site and per profile; this only caps how many are in flight.
 */
export class JobRunner {
  private active = new Map<string, Job>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly o: RunnerOptions) {}

  start(pollMs = 1_000): void {
    this.stopping = false;
    this.timer = setInterval(() => this.kick(), pollMs);
    this.timer.unref();
    this.kick();
  }

  /**
   * Stops taking jobs. Jobs still in flight are left `running` in the DB, so the next
   * start puts them back in the queue (see JobRepo.recover).
   */
  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(): Job[] {
    return [...this.active.values()];
  }

  kick(): void {
    while (!this.stopping && this.active.size < this.o.concurrency) {
      const job = this.o.store.jobs.claimNext((j) => this.accept(j));
      if (!job) return;
      this.active.set(job.id, job);
      this.o.onUpdate(job);
      void this.execute(job).finally(() => {
        this.active.delete(job.id);
        this.kick();
      });
    }
  }

  /** One sign-in window at a time, and nothing else for a source while you're signing in to it. */
  private accept(job: Job): boolean {
    for (const a of this.active.values()) {
      if (job.kind === 'login' && a.kind === 'login') return false;
      if (a.kind === 'login' && a.source === job.source) return false;
    }
    return true;
  }

  private async execute(job: Job): Promise<void> {
    const { store, host, log } = this.o;
    try {
      if (job.kind === 'run') {
        const dataset = job.dataset!;
        const res = await host.run(job.source, dataset, { force: job.force, jobId: job.id });
        const persist = host.adapter(job.source).datasets[dataset]?.persist;
        let result: unknown = res.data;
        if (persist) {
          const rows = store.holdings.save(persist, {
            jobId: job.id,
            source: job.source,
            dataset,
            method: res.method,
            confidence: res.confidence,
            fetchedAt: res.fetchedAt,
            rawRef: res.rawDir,
          }, res.data);
          result = { persisted: persist, rows };
        }
        this.finish(job, { status: 'ok', method: res.method, attempts: res.attempts, rawDir: res.rawDir, result });
      } else if (job.kind === 'probe') {
        const rec = await host.probe(job.source);
        this.finish(job, { status: 'ok', result: { state: rec.state } });
      } else {
        const rec = await host.login(job.source);
        this.finish(job, rec.state === 'ok' ? { status: 'ok', result: { state: rec.state } } : { status: 'failed', error: `sign-in not completed (${rec.state})`, result: { state: rec.state } });
      }
    } catch (err) {
      if (this.stopping) return; // leave it `running`; recovered on the next start
      const message = err instanceof Error ? err.message : String(err);
      log.warn('job failed', { id: job.id, kind: job.kind, source: job.source, dataset: job.dataset, error: message });
      // A scheduled run that failed only because of the session gets its slot back,
      // so it runs again once you've signed in.
      if (job.kind === 'run' && job.trigger !== 'manual' && sessionError(err)) {
        if (job.slot) store.schedules.setLastSlot(job.source, job.dataset!, new Date(Date.parse(job.slot) - 1).toISOString());
        else store.schedules.clear(job.source, job.dataset!);
      }
      this.finish(job, { status: 'failed', error: message, attempts: (err as any)?.attempts });
    }
  }

  private finish(job: Job, f: Parameters<Store['jobs']['finish']>[1]): void {
    try {
      this.o.onUpdate(this.o.store.jobs.finish(job.id, f));
    } catch (err) {
      this.o.log.error('could not record job result', { id: job.id, error: String(err) });
    }
  }
}
