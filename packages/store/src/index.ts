import { openDatabase, type DB } from './db.ts';
import { HoldingsRepo } from './holdings.ts';
import { InsightRepo } from './insights.ts';
import { JobRepo } from './jobs.ts';
import { NewsRepo } from './news.ts';
import { ScheduleRepo } from './schedules.ts';
import { SqliteSessionStore } from './sessions.ts';
import { ChatRepo } from './chats.ts';
import { ActionRepo, FileRepo } from './files.ts';
import { UiStateRepo } from './ui.ts';

export { migrate, openDatabase, type DB } from './db.ts';
export { HoldingsRepo, type CurrentBalance, type CurrentPosition, type PersistKind, type SnapshotMeta } from './holdings.ts';
export { JobRepo, newJobId, type EnqueueInput, type FinishInput, type Job, type JobKind, type JobStatus, type JobTrigger } from './jobs.ts';
export { MIGRATIONS } from './migrations.ts';
export { NewsRepo, type NewNews, type NewsQuery } from './news.ts';
export { InsightRepo, type Insight, type InsightKind } from './insights.ts';
export { ScheduleRepo } from './schedules.ts';
export { SqliteSessionStore } from './sessions.ts';
export { UiStateRepo } from './ui.ts';
export { ChatRepo, type Chat, type ChatKind, type ChatMessage, type ChatTool } from './chats.ts';
export { ActionRepo, FileRepo, type ActionKind, type ActionStatus, type ChatAction, type ChatFile, type SheetInfo } from './files.ts';

export interface Store {
  db: DB;
  sessions: SqliteSessionStore;
  jobs: JobRepo;
  schedules: ScheduleRepo;
  holdings: HoldingsRepo;
  ui: UiStateRepo;
  chats: ChatRepo;
  files: FileRepo;
  actions: ActionRepo;
  news: NewsRepo;
  insights: InsightRepo;
  close(): void;
}

export function openStore(file: string, opts: { now?: () => Date } = {}): Store {
  const db = openDatabase(file);
  return {
    db,
    sessions: new SqliteSessionStore(db),
    jobs: new JobRepo(db, opts.now),
    schedules: new ScheduleRepo(db),
    holdings: new HoldingsRepo(db),
    ui: new UiStateRepo(db, opts.now),
    chats: new ChatRepo(db, opts.now),
    files: new FileRepo(db, opts.now),
    actions: new ActionRepo(db, opts.now),
    news: new NewsRepo(db),
    insights: new InsightRepo(db, opts.now),
    close: () => db.close(),
  };
}
