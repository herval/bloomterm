import { emptySession, transition, type SessionEvent, type SessionRecord, type SessionStoreLike } from '@bloomterm/browser';
import type { DB } from './db.ts';

interface Row {
  source: string;
  state: SessionRecord['state'];
  since: string;
  last_ok: string | null;
  last_error: string | null;
  error_streak: number;
}

const toRecord = (r: Row): SessionRecord => ({
  source: r.source,
  state: r.state,
  since: r.since,
  lastOk: r.last_ok ?? undefined,
  lastError: r.last_error ?? undefined,
  errorStreak: r.error_streak,
});

/** Session state machine records in `source_state`. */
export class SqliteSessionStore implements SessionStoreLike {
  constructor(private readonly db: DB) {}

  getSync(source: string): SessionRecord {
    const row = this.db.prepare('SELECT * FROM source_state WHERE source = ?').get(source) as Row | undefined;
    return row ? toRecord(row) : emptySession(source);
  }

  async get(source: string): Promise<SessionRecord> {
    return this.getSync(source);
  }

  async all(): Promise<SessionRecord[]> {
    return (this.db.prepare('SELECT * FROM source_state ORDER BY source').all() as Row[]).map(toRecord);
  }

  async apply(source: string, ev: SessionEvent, now = new Date()): Promise<SessionRecord> {
    return this.db.transaction(() => {
      const next = transition(this.getSync(source), ev, now);
      this.db
        .prepare(
          `INSERT INTO source_state (source, state, since, last_ok, last_error, error_streak)
           VALUES (@source, @state, @since, @lastOk, @lastError, @errorStreak)
           ON CONFLICT (source) DO UPDATE SET state = excluded.state, since = excluded.since,
             last_ok = excluded.last_ok, last_error = excluded.last_error, error_streak = excluded.error_streak`,
        )
        .run({ ...next, lastOk: next.lastOk ?? null, lastError: next.lastError ?? null });
      return next;
    })();
  }
}
