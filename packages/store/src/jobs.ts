import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

export type JobKind = 'run' | 'probe' | 'login';
export type JobTrigger = 'manual' | 'schedule' | 'catchup';
export type JobStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  source: string;
  dataset: string | null;
  trigger: JobTrigger;
  slot: string | null;
  status: JobStatus;
  priority: number;
  force: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  method: string | null;
  error: string | null;
  attempts: unknown[] | null;
  rawDir: string | null;
  result?: unknown;
}

export interface EnqueueInput {
  kind: JobKind;
  source: string;
  dataset?: string;
  trigger?: JobTrigger;
  priority?: number;
  force?: boolean;
  slot?: string;
}

export interface FinishInput {
  status: 'ok' | 'failed' | 'cancelled';
  method?: string;
  error?: string;
  attempts?: unknown[];
  rawDir?: string;
  result?: unknown;
}

const COLUMNS = `id, kind, source, dataset, trigger, slot, status, priority, force, created_at, started_at, finished_at,
  duration_ms, method, error, attempts, raw_dir`;

function toJob(r: any, withResult = false): Job {
  const job: Job = {
    id: r.id,
    kind: r.kind,
    source: r.source,
    dataset: r.dataset,
    trigger: r.trigger,
    slot: r.slot,
    status: r.status,
    priority: r.priority,
    force: !!r.force,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    method: r.method,
    error: r.error,
    attempts: r.attempts ? JSON.parse(r.attempts) : null,
    rawDir: r.raw_dir,
  };
  if (withResult) job.result = r.result ? JSON.parse(r.result) : null;
  return job;
}

export function newJobId(now = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** The durable job queue (SPEC §8.3). Jobs survive restarts; see `recover`. */
export class JobRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Queues a job, unless the same kind/source/dataset is already queued or running;
   * then that job is returned with `created: false`.
   */
  enqueue(input: EnqueueInput): { job: Job; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM job WHERE kind = ? AND source = ? AND dataset IS ? AND status IN ('queued','running')
           ORDER BY created_at LIMIT 1`,
        )
        .get(input.kind, input.source, input.dataset ?? null);
      if (existing) return { job: toJob(existing), created: false };
      const now = this.now();
      const id = newJobId(now);
      this.db
        .prepare(
          `INSERT INTO job (id, kind, source, dataset, trigger, slot, status, priority, force, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, input.kind, input.source, input.dataset ?? null, input.trigger ?? 'manual', input.slot ?? null, input.priority ?? 0, input.force ? 1 : 0, now.toISOString());
      return { job: this.get(id)!, created: true };
    })();
  }

  /** A job that already happened outside the queue (an import you confirmed): stored as finished. */
  record(input: { source: string; dataset: string; method: string; result?: unknown }): Job {
    const now = this.now();
    const id = newJobId(now);
    const t = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO job (id, kind, source, dataset, trigger, status, created_at, started_at, finished_at, duration_ms, method, result)
         VALUES (?, 'run', ?, ?, 'manual', 'ok', ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.source, input.dataset, t, t, t, input.method, input.result === undefined ? null : JSON.stringify(input.result));
    return this.get(id)!;
  }

  /** Takes the next queued job that `accept` agrees to run, and marks it running. */
  claimNext(accept: (job: Job) => boolean = () => true): Job | null {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT ${COLUMNS} FROM job WHERE status = 'queued' ORDER BY priority DESC, created_at`).all();
      for (const row of rows) {
        const job = toJob(row);
        if (!accept(job)) continue;
        const startedAt = this.now().toISOString();
        this.db.prepare(`UPDATE job SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`).run(startedAt, job.id);
        return { ...job, status: 'running' as const, startedAt };
      }
      return null;
    })();
  }

  finish(id: string, f: FinishInput): Job {
    const now = this.now();
    const started = this.db.prepare('SELECT started_at FROM job WHERE id = ?').get(id) as { started_at: string | null } | undefined;
    const durationMs = started?.started_at ? now.getTime() - Date.parse(started.started_at) : null;
    this.db
      .prepare(
        `UPDATE job SET status = ?, finished_at = ?, duration_ms = ?, method = ?, error = ?, attempts = ?, raw_dir = ?, result = ?
         WHERE id = ?`,
      )
      .run(
        f.status,
        now.toISOString(),
        durationMs,
        f.method ?? null,
        f.error ?? null,
        f.attempts ? JSON.stringify(f.attempts) : null,
        f.rawDir ?? null,
        f.result === undefined ? null : JSON.stringify(f.result),
        id,
      );
    return this.get(id)!;
  }

  get(id: string, opts: { withResult?: boolean } = {}): Job | null {
    const row = this.db.prepare(`SELECT ${COLUMNS}${opts.withResult ? ', result' : ''} FROM job WHERE id = ?`).get(id);
    return row ? toJob(row, opts.withResult) : null;
  }

  list(filter: { status?: JobStatus; source?: string; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.source) {
      where.push('source = ?');
      args.push(filter.source);
    }
    const sql = `SELECT ${COLUMNS} FROM job ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...args, filter.limit ?? 50)
      .map((r) => toJob(r));
  }

  /** The last time a run of this dataset succeeded. */
  lastOk(source: string, dataset: string): string | null {
    const row = this.db
      .prepare(`SELECT MAX(finished_at) AS t FROM job WHERE kind = 'run' AND source = ? AND dataset = ? AND status = 'ok'`)
      .get(source, dataset) as { t: string | null };
    return row.t;
  }

  /**
   * After a restart: fetches and probes that were running go back in the queue. An
   * interrupted sign-in fails instead, so no window opens unless you ask again.
   */
  recover(): { requeued: number; failed: number } {
    return this.db.transaction(() => {
      const failed = this.db
        .prepare(`UPDATE job SET status = 'failed', error = 'bloomd restarted during the sign-in', finished_at = ? WHERE status = 'running' AND kind = 'login'`)
        .run(this.now().toISOString()).changes;
      const requeued = this.db.prepare(`UPDATE job SET status = 'queued', started_at = NULL WHERE status = 'running'`).run().changes;
      return { requeued, failed };
    })();
  }

  cancelQueued(source: string, reason: string): number {
    return this.db
      .prepare(`UPDATE job SET status = 'cancelled', error = ?, finished_at = ? WHERE status = 'queued' AND source = ? AND kind = 'run'`)
      .run(reason, this.now().toISOString(), source).changes;
  }
}
