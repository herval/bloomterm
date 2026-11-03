import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionState } from './types.ts';

// Session state machine (SPEC §6.3), persisted per source.

export type SessionEvent =
  | { type: 'probe_ok' }
  | { type: 'probe_logged_out' }
  | { type: 'login_ok' }
  | { type: 'login_failed' }
  | { type: 'job_ok' }
  | { type: 'job_error'; error: string }
  | { type: 'needs_login'; error?: string }
  | { type: 'challenge'; error?: string }
  | { type: 'challenge_resolved' }
  | { type: 'blocked'; error?: string }
  | { type: 'retry' };

export interface SessionRecord {
  source: string;
  state: SessionState;
  since: string;
  lastOk?: string;
  lastError?: string;
  errorStreak: number;
}

export function transition(rec: SessionRecord, ev: SessionEvent, now: Date): SessionRecord {
  const at = now.toISOString();
  const to = (state: SessionState, patch: Partial<SessionRecord> = {}): SessionRecord => ({
    ...rec,
    ...patch,
    state,
    since: state === rec.state ? rec.since : at,
  });
  switch (ev.type) {
    case 'probe_ok':
    case 'login_ok':
    case 'challenge_resolved':
      return to('ok', { errorStreak: 0, lastError: undefined });
    case 'job_ok':
      return to('ok', { errorStreak: 0, lastError: undefined, lastOk: at });
    case 'probe_logged_out':
      return to('needs_login');
    case 'login_failed':
      return to('needs_login');
    case 'needs_login':
      return to('needs_login', { lastError: ev.error });
    case 'challenge':
      return to('challenge', { lastError: ev.error });
    case 'blocked':
      return to('blocked', { lastError: ev.error, errorStreak: rec.errorStreak + 1 });
    case 'job_error':
      // A parse or network error doesn't say anything about the session itself.
      return { ...rec, lastError: ev.error, errorStreak: rec.errorStreak + 1 };
    case 'retry':
      return to('unknown', { errorStreak: 0 });
  }
}

/** Where session records live. The JSON file below is for standalone use; bloomd uses SQLite. */
export interface SessionStoreLike {
  get(source: string): Promise<SessionRecord>;
  all(): Promise<SessionRecord[]>;
  apply(source: string, ev: SessionEvent, now?: Date): Promise<SessionRecord>;
}

export function emptySession(source: string): SessionRecord {
  return { source, state: 'unknown', since: new Date(0).toISOString(), errorStreak: 0 };
}

export class SessionStore implements SessionStoreLike {
  private cache: Record<string, SessionRecord> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, SessionRecord>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      this.cache = {};
    }
    return this.cache!;
  }

  async get(source: string): Promise<SessionRecord> {
    const all = await this.load();
    return all[source] ?? emptySession(source);
  }

  async all(): Promise<SessionRecord[]> {
    return Object.values(await this.load());
  }

  async apply(source: string, ev: SessionEvent, now = new Date()): Promise<SessionRecord> {
    const next = transition(await this.get(source), ev, now);
    (await this.load())[source] = next;
    await this.flush();
    return next;
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.cache, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
