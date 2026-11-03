import type { DB } from './db.ts';

/** Last schedule slot handled for each (source, dataset). */
export class ScheduleRepo {
  constructor(private readonly db: DB) {}

  lastSlot(source: string, dataset: string): string | null {
    const row = this.db.prepare('SELECT last_slot FROM schedule_state WHERE source = ? AND dataset = ?').get(source, dataset) as
      | { last_slot: string }
      | undefined;
    return row?.last_slot ?? null;
  }

  setLastSlot(source: string, dataset: string, slot: string): void {
    this.db
      .prepare(
        `INSERT INTO schedule_state (source, dataset, last_slot) VALUES (?, ?, ?)
         ON CONFLICT (source, dataset) DO UPDATE SET last_slot = excluded.last_slot`,
      )
      .run(source, dataset, slot);
  }

  clear(source: string, dataset: string): void {
    this.db.prepare('DELETE FROM schedule_state WHERE source = ? AND dataset = ?').run(source, dataset);
  }
}
