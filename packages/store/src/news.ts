import type { NewsItem, NewsKind, NewsStory, TagOrigin } from '@bloomterm/core';
import type { DB } from './db.ts';

/** An item as an integration delivered it, before tagging and grouping. */
export interface NewNews {
  source: string;
  /** The source's own id; stored as `<source>:<id>`. */
  id: string;
  ts: string;
  headline: string;
  outlet: string;
  url: string;
  kind: NewsKind;
  lang?: string | null;
  summary?: string | null;
}

export interface NewsQuery {
  /** Items tagged with any of these. */
  securities?: string[];
  story?: string;
  /** Words in the headline. */
  q?: string;
  kind?: NewsKind;
  /** ISO bounds on `ts`. */
  since?: string;
  before?: string;
  limit?: number;
}

interface Row {
  id: string;
  source: string;
  ts: string;
  headline: string;
  outlet: string;
  url: string;
  kind: NewsKind;
  lang: string | null;
  summary: string | null;
  story_id: string | null;
}

/** News items, their security tags and the stories they belong to (SPEC §10.4, §11). */
export class NewsRepo {
  constructor(private readonly db: DB) {}

  /** Stores what's new; returns the ids it hadn't seen. */
  insert(items: NewNews[], fetchedAt: string): string[] {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO news_item (id, source, ts, headline, outlet, url, kind, lang, summary, fetched_at)
       VALUES (@id, @source, @ts, @headline, @outlet, @url, @kind, @lang, @summary, @fetchedAt)`,
    );
    const added: string[] = [];
    this.db.transaction(() => {
      for (const i of items) {
        const id = `${i.source}:${i.id}`.slice(0, 300);
        const r = stmt.run({ ...i, id, lang: i.lang ?? null, summary: i.summary ?? null, fetchedAt });
        if (r.changes) added.push(id);
      }
    })();
    return added;
  }

  /** Adds tags; a security already tagged keeps its first origin. */
  tag(newsId: string, securities: string[], by: TagOrigin): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO news_tag (news_id, security, by) VALUES (?, ?, ?)');
    for (const s of new Set(securities)) stmt.run(newsId, s, by);
  }

  /** The agent's tags replace its earlier ones and the rules' (the source's own stay). */
  retag(newsId: string, securities: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM news_tag WHERE news_id = ? AND by IN ('rule', 'agent')").run(newsId);
      this.tag(newsId, securities, 'agent');
    })();
  }

  get(id: string): NewsItem | null {
    const row = this.db.prepare('SELECT * FROM news_item WHERE id = ?').get(id) as Row | undefined;
    return row ? this.withTags([row])[0]! : null;
  }

  list(q: NewsQuery = {}): NewsItem[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.securities?.length) {
      where.push(`id IN (SELECT news_id FROM news_tag WHERE security IN (${q.securities.map(() => '?').join(',')}))`);
      args.push(...q.securities);
    }
    if (q.story) (where.push('story_id = ?'), args.push(q.story));
    if (q.kind) (where.push('kind = ?'), args.push(q.kind));
    if (q.since) (where.push('ts >= ?'), args.push(q.since));
    if (q.before) (where.push('ts < ?'), args.push(q.before));
    for (const word of (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push("headline LIKE ? ESCAPE '\\'");
      args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = this.db
      .prepare(`SELECT * FROM news_item ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`)
      .all(...args, Math.min(q.limit ?? 50, 500)) as Row[];
    return this.withTags(rows);
  }

  /** What the rules compare new items against: recent headlines, their stories and tags. */
  recent(since: string): { id: string; headline: string; storyId: string | null; tags: string[] }[] {
    const rows = this.db.prepare('SELECT id, headline, story_id FROM news_item WHERE ts >= ? ORDER BY ts DESC LIMIT 2000').all(since) as Row[];
    const tags = this.tagsOf(rows.map((r) => r.id));
    return rows.map((r) => ({ id: r.id, headline: r.headline, storyId: r.story_id, tags: (tags.get(r.id) ?? []).map((t) => t.security) }));
  }

  createStory(s: { id: string; title: string; summary?: string | null; by: 'rule' | 'agent' }, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO news_story (id, title, summary, by, updated_at) VALUES (?, ?, ?, ?, ?)').run(s.id, s.title.slice(0, 300), s.summary ?? null, s.by, at);
  }

  updateStory(id: string, s: { title: string; summary?: string | null }, at: string): void {
    this.db.prepare("UPDATE news_story SET title = ?, summary = ?, by = 'agent', updated_at = ? WHERE id = ?").run(s.title.slice(0, 300), s.summary ?? null, at, id);
  }

  assign(newsId: string, storyId: string): void {
    this.db.prepare('UPDATE news_item SET story_id = ? WHERE id = ?').run(storyId, newsId);
  }

  /**
   * Stories with an item since `since`, newest first, or by how many outlets carry them
   * (`rank: 'top'`). With `securities`, only stories that mention one of them.
   */
  stories(q: { since: string; securities?: string[]; rank?: 'latest' | 'top'; limit?: number }): NewsStory[] {
    const args: unknown[] = [q.since];
    let filter = '';
    if (q.securities?.length) {
      filter = `AND s.id IN (SELECT i2.story_id FROM news_item i2 JOIN news_tag t ON t.news_id = i2.id WHERE t.security IN (${q.securities.map(() => '?').join(',')}))`;
      args.push(...q.securities);
    }
    const order = q.rank === 'top' ? 'outlets DESC, last_ts DESC' : 'last_ts DESC';
    const heads = this.db
      .prepare(
        `SELECT s.id, s.title, s.summary, s.by, MIN(i.ts) AS first_ts, MAX(i.ts) AS last_ts, COUNT(DISTINCT i.outlet) AS outlets
         FROM news_story s JOIN news_item i ON i.story_id = s.id
         GROUP BY s.id HAVING MAX(i.ts) >= ? ${filter}
         ORDER BY ${order} LIMIT ?`,
      )
      .all(...args, Math.min(q.limit ?? 30, 200)) as { id: string; title: string; summary: string | null; by: 'rule' | 'agent'; first_ts: string; last_ts: string }[];
    if (!heads.length) return [];
    const items = this.withTags(this.db.prepare(`SELECT * FROM news_item WHERE story_id IN (${heads.map(() => '?').join(',')}) ORDER BY ts DESC`).all(...heads.map((h) => h.id)) as Row[]);
    return heads.map((h) => {
      const own = items.filter((i) => i.storyId === h.id);
      return {
        id: h.id,
        title: h.title,
        summary: h.summary,
        by: h.by,
        firstTs: h.first_ts,
        lastTs: h.last_ts,
        outlets: [...new Set(own.map((i) => i.outlet))],
        tags: [...new Set(own.flatMap((i) => i.tags.map((t) => t.security)))],
        items: own,
      };
    });
  }

  /** Items the agent hasn't grouped and tagged yet, newest first. */
  pendingAi(limit: number, since: string): NewsItem[] {
    return this.withTags(this.db.prepare('SELECT * FROM news_item WHERE ai_at IS NULL AND ts >= ? ORDER BY ts DESC LIMIT ?').all(since, limit) as Row[]);
  }

  markAi(ids: string[], at: string): void {
    const stmt = this.db.prepare('UPDATE news_item SET ai_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(at, id)))();
  }

  /** Drops items older than `before`, and stories left empty. */
  prune(before: string): number {
    const n = this.db.prepare('DELETE FROM news_item WHERE ts < ?').run(before).changes;
    this.db.prepare('DELETE FROM news_story WHERE id NOT IN (SELECT story_id FROM news_item WHERE story_id IS NOT NULL)').run();
    return n;
  }

  /** Per source: how many items, and the newest. */
  counts(): { source: string; items: number; latest: string | null }[] {
    return this.db.prepare('SELECT source, COUNT(*) AS items, MAX(ts) AS latest FROM news_item GROUP BY source').all() as { source: string; items: number; latest: string | null }[];
  }

  private tagsOf(ids: string[]): Map<string, { security: string; by: TagOrigin }[]> {
    const out = new Map<string, { security: string; by: TagOrigin }[]>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT news_id, security, by FROM news_tag WHERE news_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { news_id: string; security: string; by: TagOrigin }[];
      for (const r of rows) {
        const list = out.get(r.news_id) ?? [];
        list.push({ security: r.security, by: r.by });
        out.set(r.news_id, list);
      }
    }
    return out;
  }

  private withTags(rows: Row[]): NewsItem[] {
    const tags = this.tagsOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      ts: r.ts,
      headline: r.headline,
      outlet: r.outlet,
      url: r.url,
      kind: r.kind,
      lang: r.lang,
      summary: r.summary,
      storyId: r.story_id,
      tags: tags.get(r.id) ?? [],
    }));
  }
}
