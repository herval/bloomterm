import type { DB } from './db.ts';

/** Small JSON documents the UI keeps: the panel layout and watchlists (SPEC §11 `layout`, `watchlist`). */
export class UiStateRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get<T = unknown>(key: string): { value: T; updatedAt: string } | null {
    const row = this.db.prepare('SELECT value, updated_at FROM ui_state WHERE key = ?').get(key) as { value: string; updated_at: string } | undefined;
    return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
  }

  set(key: string, value: unknown): { updatedAt: string } {
    const updatedAt = this.now().toISOString();
    this.db
      .prepare('INSERT INTO ui_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), updatedAt);
    return { updatedAt };
  }
}
