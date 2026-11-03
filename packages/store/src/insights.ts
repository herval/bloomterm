import type { DB } from './db.ts';

export type InsightKind = 'brief' | 'why';

/** Something the agent wrote from bloomterm's data: the day's brief, or why a security moved. */
export interface Insight {
  kind: InsightKind;
  /** brief: the day (YYYY-MM-DD); why: `<day>|<security key>`. */
  key: string;
  status: 'running' | 'done' | 'error';
  text: string;
  /** What it was written from, and the news it cites. */
  data: Record<string, unknown>;
  error: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  kind: InsightKind;
  key: string;
  status: Insight['status'];
  text: string;
  data: string;
  error: string | null;
  agent: string | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): Insight => ({
  kind: r.kind,
  key: r.key,
  status: r.status,
  text: r.text,
  data: JSON.parse(r.data) as Record<string, unknown>,
  error: r.error,
  agent: r.agent,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class InsightRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(kind: InsightKind, key: string): Insight | null {
    const row = this.db.prepare('SELECT * FROM insight WHERE kind = ? AND key = ?').get(kind, key) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The newest of a kind, optionally only finished ones. */
  latest(kind: InsightKind, o: { done?: boolean } = {}): Insight | null {
    const row = this.db.prepare(`SELECT * FROM insight WHERE kind = ? ${o.done ? "AND status = 'done'" : ''} ORDER BY updated_at DESC LIMIT 1`).get(kind) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Marks one as being written (again): the old text stays until the new one is done. */
  start(kind: InsightKind, key: string, agent: string): Insight {
    const t = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO insight (kind, key, status, agent, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET status = 'running', error = NULL, agent = excluded.agent, updated_at = excluded.updated_at`,
      )
      .run(kind, key, agent, t, t);
    return this.get(kind, key)!;
  }

  finish(kind: InsightKind, key: string, r: { status: 'done' | 'error'; text?: string; data?: Record<string, unknown>; error?: string }): Insight {
    const t = this.now().toISOString();
    if (r.status === 'done') {
      this.db.prepare("UPDATE insight SET status = 'done', text = ?, data = ?, error = NULL, updated_at = ? WHERE kind = ? AND key = ?").run(r.text ?? '', JSON.stringify(r.data ?? {}), t, kind, key);
    } else {
      this.db.prepare("UPDATE insight SET status = 'error', error = ?, updated_at = ? WHERE kind = ? AND key = ?").run(r.error ?? 'failed', t, kind, key);
    }
    return this.get(kind, key)!;
  }

  /** A run bloomd didn't see finish (it stopped) failed. */
  recover(): number {
    return this.db.prepare("UPDATE insight SET status = 'error', error = 'bloomd stopped while this was being written' WHERE status = 'running'").run().changes;
  }
}
