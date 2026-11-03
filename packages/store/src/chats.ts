import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

export interface ChatTool {
  name: string;
  input?: unknown;
  ok?: boolean;
}

export interface ChatMessage {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  tools: ChatTool[];
  status: 'running' | 'done' | 'error';
  error: string | null;
  costUsd: number | null;
  createdAt: string;
}

export type ChatKind = 'ask' | 'evolve';

export interface Chat {
  id: string;
  title: string;
  agent: string;
  kind: ChatKind;
  meta: Record<string, unknown>;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * ASK conversations (SPEC §10.2) and EVOLVE runs (§6.11). The agent CLI keeps its own
 * transcript; this is what the UI shows.
 */
export class ChatRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { title: string; agent: string; kind?: ChatKind; meta?: Record<string, unknown> }): Chat {
    const t = this.now().toISOString();
    const chat: Chat = {
      id: `c_${randomBytes(6).toString('hex')}`,
      title: input.title.slice(0, 120),
      agent: input.agent,
      kind: input.kind ?? 'ask',
      meta: input.meta ?? {},
      sessionId: null,
      createdAt: t,
      updatedAt: t,
    };
    this.db
      .prepare('INSERT INTO chat (id, title, agent, kind, meta, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(chat.id, chat.title, chat.agent, chat.kind, JSON.stringify(chat.meta), t, t);
    return chat;
  }

  /** Merges `patch` into the chat's meta. */
  setMeta(id: string, patch: Record<string, unknown>): Chat | null {
    const chat = this.get(id);
    if (!chat) return null;
    const meta = { ...chat.meta, ...patch };
    this.db.prepare('UPDATE chat SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
    return { ...chat, meta };
  }

  get(id: string): Chat | null {
    const r = this.db.prepare('SELECT * FROM chat WHERE id = ?').get(id) as any;
    return r ? toChat(r) : null;
  }

  list(limit = 50, kind?: ChatKind): Chat[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM chat WHERE kind = ? ORDER BY updated_at DESC LIMIT ?').all(kind, limit)
      : this.db.prepare('SELECT * FROM chat ORDER BY updated_at DESC LIMIT ?').all(limit);
    return (rows as any[]).map(toChat);
  }

  messages(id: string): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM chat_message WHERE chat_id = ? ORDER BY seq').all(id) as any[]).map((r) => ({
      seq: r.seq,
      role: r.role,
      text: r.text,
      tools: JSON.parse(r.tools),
      status: r.status,
      error: r.error,
      costUsd: r.cost_usd,
      createdAt: r.created_at,
    }));
  }

  add(id: string, m: { role: ChatMessage['role']; text: string; status: ChatMessage['status'] }): number {
    const t = this.now().toISOString();
    return this.db.transaction(() => {
      const seq = ((this.db.prepare('SELECT MAX(seq) AS s FROM chat_message WHERE chat_id = ?').get(id) as { s: number | null }).s ?? 0) + 1;
      this.db.prepare('INSERT INTO chat_message (chat_id, seq, role, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, seq, m.role, m.text, m.status, t);
      this.db.prepare('UPDATE chat SET updated_at = ? WHERE id = ?').run(t, id);
      return seq;
    })();
  }

  finish(id: string, seq: number, m: { text: string; tools: ChatTool[]; status: 'done' | 'error'; error?: string; costUsd?: number; sessionId?: string | null }): void {
    const t = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE chat_message SET text = ?, tools = ?, status = ?, error = ?, cost_usd = ? WHERE chat_id = ? AND seq = ?')
        .run(m.text, JSON.stringify(m.tools), m.status, m.error ?? null, m.costUsd ?? null, id, seq);
      if (m.sessionId) this.db.prepare('UPDATE chat SET session_id = ?, updated_at = ? WHERE id = ?').run(m.sessionId, t, id);
      else this.db.prepare('UPDATE chat SET updated_at = ? WHERE id = ?').run(t, id);
    })();
  }

  /** bloomd stopped mid-answer: those answers will never finish. */
  recover(): number {
    return this.db.prepare("UPDATE chat_message SET status = 'error', error = 'bloomd restarted during this answer' WHERE status = 'running'").run().changes;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat WHERE id = ?').run(id);
  }
}

const toChat = (r: any): Chat => ({
  id: r.id,
  title: r.title,
  agent: r.agent,
  kind: r.kind,
  meta: JSON.parse(r.meta),
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
