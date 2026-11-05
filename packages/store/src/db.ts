import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export type DB = Database.Database;

/**
 * Opens (or creates) the bloomterm database: WAL, foreign keys, migrations applied.
 * The file holds account data, so it and its WAL/SHM siblings are 0600 in a 0700 dir.
 */
export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    migrate(db);
  } catch (err) {
    // Windows locks an open file: left open, this one couldn't be replaced or deleted.
    db.close();
    throw err;
  }
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        chmodSync(f, 0o600);
      } catch {
        // WAL/SHM may not exist yet
      }
    }
  }
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`database is at schema ${current}, newer than this build (${MIGRATIONS.length}); update bloomterm`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
