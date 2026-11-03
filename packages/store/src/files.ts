import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

export interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
  truncated?: boolean;
}

export interface ChatFile {
  id: string;
  chatId: string | null;
  seq: number | null;
  origin: 'upload' | 'agent';
  name: string;
  mime: string;
  size: number;
  sheets: SheetInfo[];
  error: string | null;
  createdAt: string;
}

export type ActionKind = 'import' | 'connect';
export type ActionStatus = 'pending' | 'done' | 'dismissed' | 'failed';

export interface ChatAction {
  id: string;
  chatId: string;
  seq: number;
  kind: ActionKind;
  status: ActionStatus;
  data: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Files in ASK (SPEC §10.5): what you attach, and what the agent writes back. The bytes live on disk. */
export class FileRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { origin: ChatFile['origin']; name: string; mime: string; size: number; sheets?: SheetInfo[]; error?: string; chatId?: string; seq?: number }): ChatFile {
    const id = `f_${randomBytes(6).toString('hex')}`;
    this.db
      .prepare('INSERT INTO chat_file (id, chat_id, seq, origin, name, mime, size, sheets, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.chatId ?? null, input.seq ?? null, input.origin, input.name, input.mime, input.size, JSON.stringify(input.sheets ?? []), input.error ?? null, this.now().toISOString());
    return this.get(id)!;
  }

  get(id: string): ChatFile | null {
    const r = this.db.prepare('SELECT * FROM chat_file WHERE id = ?').get(id);
    return r ? toFile(r) : null;
  }

  /** Links uploads to the question they were sent with. Each must be unsent; returns them in order. */
  attach(ids: string[], chatId: string, seq: number): ChatFile[] {
    return this.db.transaction(() => {
      const files = ids.map((id) => {
        const f = this.get(id);
        if (!f || f.origin !== 'upload') throw new Error(`no upload ${id}`);
        if (f.chatId) throw new Error(`${f.name} was sent already; attach it again`);
        return f;
      });
      const up = this.db.prepare('UPDATE chat_file SET chat_id = ?, seq = ? WHERE id = ?');
      for (const f of files) up.run(chatId, seq, f.id);
      return files.map((f) => ({ ...f, chatId, seq }));
    })();
  }

  list(chatId: string): ChatFile[] {
    return (this.db.prepare('SELECT * FROM chat_file WHERE chat_id = ? ORDER BY seq, created_at').all(chatId) as any[]).map(toFile);
  }

  /** Uploads never sent with a question, older than `before`. */
  unsent(before: string): ChatFile[] {
    return (this.db.prepare('SELECT * FROM chat_file WHERE chat_id IS NULL AND created_at < ?').all(before) as any[]).map(toFile);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_file WHERE id = ?').run(id);
  }
}

/** What the agent proposes in a conversation and only you can carry out: an import, connecting an account. */
export class ActionRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { chatId: string; seq: number; kind: ActionKind; data: Record<string, unknown> }): ChatAction {
    const id = `a_${randomBytes(6).toString('hex')}`;
    const t = this.now().toISOString();
    this.db
      .prepare(`INSERT INTO chat_action (id, chat_id, seq, kind, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, input.chatId, input.seq, input.kind, JSON.stringify(input.data), t, t);
    return this.get(id)!;
  }

  get(id: string): ChatAction | null {
    const r = this.db.prepare('SELECT * FROM chat_action WHERE id = ?').get(id);
    return r ? toAction(r) : null;
  }

  list(chatId: string): ChatAction[] {
    return (this.db.prepare('SELECT * FROM chat_action WHERE chat_id = ? ORDER BY seq, created_at').all(chatId) as any[]).map(toAction);
  }

  /** Sets the status and merges `result` into what's there. */
  update(id: string, patch: { status?: ActionStatus; result?: Record<string, unknown>; error?: string | null }): ChatAction {
    const a = this.get(id);
    if (!a) throw new Error(`no action ${id}`);
    const result = { ...a.result, ...patch.result };
    this.db
      .prepare('UPDATE chat_action SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? a.status, JSON.stringify(result), patch.error === undefined ? a.error : patch.error, this.now().toISOString(), id);
    return this.get(id)!;
  }
}

function toFile(r: any): ChatFile {
  return {
    id: r.id,
    chatId: r.chat_id,
    seq: r.seq,
    origin: r.origin,
    name: r.name,
    mime: r.mime,
    size: r.size,
    sheets: JSON.parse(r.sheets),
    error: r.error,
    createdAt: r.created_at,
  };
}

function toAction(r: any): ChatAction {
  return {
    id: r.id,
    chatId: r.chat_id,
    seq: r.seq,
    kind: r.kind,
    status: r.status,
    data: JSON.parse(r.data),
    result: JSON.parse(r.result),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
