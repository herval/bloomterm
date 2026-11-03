import { createHash } from 'node:crypto';
import { headlineWords, parseSecurity, similarity, tagText, type Company, type Security } from '@bloomterm/core';
import type { Logger } from '@bloomterm/browser';
import type { NewsData, NewsProvider } from '@bloomterm/integrations';
import type { Store } from '@bloomterm/store';
import type { EnrichInput, EnrichOutput } from './enrich.ts';

// News (SPEC §10.4). bloomd polls every integration with a news feed, stores what's new,
// tags it with securities (the source's own tags, then rules), and groups it into stories
// by headline similarity. Every so often the agent, when there is one, regroups the latest
// batch, titles stories in English and corrects the tags.

const HOUR = 3_600_000;
/** How far back a new item may join a story. */
const STORY_WINDOW_MS = 36 * HOUR;
/** Items older than this aren't stored at all; stored ones are pruned after KEEP_DAYS. */
const MAX_AGE_MS = 14 * 24 * HOUR;
const KEEP_DAYS = 45;

export interface FeedStatus {
  id: string;
  name: string;
  everyMs: number;
  lastTry: string | null;
  lastOk: string | null;
  error: string | null;
  /** Items stored from its last successful poll. */
  added: number;
}

export interface NewsDeps {
  store: Store;
  providers: NewsProvider[];
  /** What you hold and watch. */
  securities: () => Security[];
  /** Names of what you follow that the built-in list lacks. */
  names?: () => Company[];
  /** The agent pass; null when there's no agent or it's turned off. */
  enrich?: ((input: EnrichInput) => Promise<EnrichOutput>) | null;
  /** How often the agent pass may run. */
  enrichEveryMs?: number;
  log: Logger;
  emit: (ev: { type: 'news'; added: number; sources: string[] }) => void;
  now?: () => Date;
}

export class NewsService {
  private readonly now: () => Date;
  private readonly status = new Map<string, FeedStatus>();
  private readonly polling = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private enriching: Promise<unknown> | null = null;
  private lastEnrich = 0;
  private lastPrune = 0;

  constructor(private readonly d: NewsDeps) {
    this.now = d.now ?? (() => new Date());
    for (const p of d.providers) this.status.set(p.id, { id: p.id, name: p.name, everyMs: p.everyMs, lastTry: null, lastOk: null, error: null, added: 0 });
  }

  start(tickMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  feeds(): FeedStatus[] {
    return [...this.status.values()];
  }

  /** Polls every feed that's due; a failing feed waits twice as long, up to an hour. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    const due = this.d.providers.filter((p) => {
      if (p.status === 'draft') return false;
      const s = this.status.get(p.id)!;
      if (!s.lastTry) return true;
      const wait = s.error ? Math.min(p.everyMs * 2, HOUR) : p.everyMs;
      return now - Date.parse(s.lastTry) >= wait;
    });
    if (due.length) await this.poll(due.map((p) => p.id));
    if (now - this.lastPrune > 24 * HOUR) {
      this.lastPrune = now;
      const n = this.d.store.news.prune(new Date(now - KEEP_DAYS * 24 * HOUR).toISOString());
      if (n) this.d.log.info('pruned old news', { items: n });
    }
  }

  /** Polls the given feeds (all by default) now. */
  async poll(ids?: string[]): Promise<FeedStatus[]> {
    const list = this.d.providers.filter((p) => (ids ? ids.includes(p.id) : p.status !== 'draft') && !this.polling.has(p.id));
    const securities = this.d.securities();
    const results = await Promise.all(list.map((p) => this.pollOne(p, securities)));
    const added = results.reduce((a, b) => a + b, 0);
    if (added) {
      this.d.emit({ type: 'news', added, sources: list.map((p) => p.id) });
      if (this.d.enrich && this.now().getTime() - this.lastEnrich >= (this.d.enrichEveryMs ?? 15 * 60_000)) void this.enrich();
    }
    return list.map((p) => this.status.get(p.id)!);
  }

  private async pollOne(p: NewsProvider, securities: Security[]): Promise<number> {
    const s = this.status.get(p.id)!;
    this.polling.add(p.id);
    s.lastTry = this.now().toISOString();
    try {
      const items = await p.latest({ securities, since: s.lastOk ? new Date(s.lastOk) : null });
      const ids = this.store(p.id, items);
      s.lastOk = this.now().toISOString();
      s.error = null;
      s.added = ids.length;
      return ids.length;
    } catch (err) {
      s.error = (err as Error).message ?? String(err);
      this.d.log.warn('news feed failed', { source: p.id, error: s.error });
      return 0;
    } finally {
      this.polling.delete(p.id);
    }
  }

  /** Stores, tags and groups a feed's items; returns the ids that were new. */
  store(source: string, items: NewsData[]): string[] {
    const { news } = this.d.store;
    const nowMs = this.now().getTime();
    const now = new Date(nowMs).toISOString();
    const ok = items.filter((i) => i.headline?.trim() && /^https?:\/\//i.test(i.url ?? '') && i.id);
    const rows = ok.flatMap((i) => {
      const t = i.ts ? Date.parse(i.ts) : nowMs;
      if (!Number.isFinite(t) || nowMs - t > MAX_AGE_MS) return [];
      return [
        {
          source,
          id: i.id,
          // A date in the future is a feed's mistake: it would pin the item to the top.
          ts: new Date(Math.min(t, nowMs)).toISOString(),
          headline: i.headline.trim().slice(0, 400),
          outlet: (i.outlet || source).slice(0, 80),
          url: i.url,
          kind: i.kind ?? ('news' as const),
          lang: i.lang ?? null,
          summary: i.summary?.slice(0, 600) ?? null,
        },
      ];
    });
    const added = news.insert(rows, now);
    if (!added.length) return [];
    const extra = this.d.names?.() ?? [];
    const byId = new Map(ok.map((i) => [`${source}:${i.id}`.slice(0, 300), i]));
    for (const id of added) {
      const i = byId.get(id)!;
      const own = (i.tickers ?? []).flatMap((k) => parseSecurity(k)?.key ?? []);
      if (own.length) news.tag(id, own, 'source');
      news.tag(id, [...tagText(i.headline, extra), ...tagText(i.summary ?? '', extra, { names: false })], 'rule');
    }
    this.group(added);
    return added;
  }

  /** Puts each new item in the most similar recent story, or a story of its own. */
  private group(ids: string[]): void {
    const { news } = this.d.store;
    const now = this.now();
    const recent = news.recent(new Date(now.getTime() - STORY_WINDOW_MS).toISOString());
    const pool = recent.filter((r) => r.storyId).map((r) => ({ ...r, words: headlineWords(r.headline) }));
    const fresh = new Set(ids);
    // Oldest first, so a story is named after whoever broke it.
    for (const r of recent.filter((x) => fresh.has(x.id)).reverse()) {
      const words = headlineWords(r.headline);
      let best: { storyId: string; score: number } | null = null;
      for (const p of pool) {
        const score = similarity(words, p.words);
        const shared = r.tags.some((t) => p.tags.includes(t));
        if (score >= (shared ? 0.3 : 0.5) && score > (best?.score ?? 0)) best = { storyId: p.storyId!, score };
      }
      const storyId = best?.storyId ?? `s_${createHash('sha1').update(r.id).digest('hex').slice(0, 12)}`;
      if (!best) news.createStory({ id: storyId, title: r.headline, by: 'rule' }, now.toISOString());
      news.assign(r.id, storyId);
      pool.push({ ...r, storyId, words });
    }
  }

  /** The agent pass over the latest items it hasn't seen. Resolves with what it changed, or null. */
  enrich(): Promise<{ items: number; stories: number } | null> {
    if (!this.d.enrich) return Promise.resolve(null);
    if (this.enriching) return this.enriching as Promise<null>;
    const run = this.enrichOnce().finally(() => (this.enriching = null));
    this.enriching = run;
    return run;
  }

  private async enrichOnce(): Promise<{ items: number; stories: number } | null> {
    const { news } = this.d.store;
    const now = this.now();
    this.lastEnrich = now.getTime();
    const batch = news.pendingAi(60, new Date(now.getTime() - 24 * HOUR).toISOString());
    if (!batch.length) return null;
    const known = news.stories({ since: new Date(now.getTime() - STORY_WINDOW_MS).toISOString(), rank: 'top', limit: 40 });
    const input: EnrichInput = {
      items: batch.map((n, i) => ({
        ref: `n${i + 1}`,
        headline: n.headline,
        outlet: n.outlet,
        ts: n.ts,
        lang: n.lang,
        summary: n.summary?.slice(0, 200) || undefined,
        tags: n.tags.map((t) => t.security),
      })),
      stories: known.map((s, i) => ({ ref: `s${i + 1}`, title: s.title })),
    };
    let out: EnrichOutput;
    try {
      out = await this.d.enrich!(input);
    } catch (err) {
      this.d.log.warn('news: the agent pass failed', { items: batch.length, error: String((err as Error).message ?? err) });
      // Marked anyway: a batch the agent can't handle shouldn't be retried forever.
      news.markAi(batch.map((n) => n.id), now.toISOString());
      return null;
    }
    const itemId = (ref: string) => batch[Number(ref.slice(1)) - 1]!.id;
    const at = now.toISOString();
    for (const s of out.stories) {
      const existing = s.ref ? known[Number(s.ref.slice(1)) - 1] : undefined;
      const ids = s.items.map(itemId);
      const storyId = existing?.id ?? `s_${createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 12)}`;
      if (existing) news.updateStory(storyId, { title: existing.by === 'agent' ? existing.title : s.title, summary: existing.summary ?? s.summary }, at);
      else {
        news.createStory({ id: storyId, title: s.title, summary: s.summary, by: 'agent' }, at);
        news.updateStory(storyId, { title: s.title, summary: s.summary }, at);
      }
      for (const id of ids) news.assign(id, storyId);
    }
    for (const [ref, keys] of Object.entries(out.tags)) news.retag(itemId(ref), keys);
    news.markAi(batch.map((n) => n.id), at);
    this.d.emit({ type: 'news', added: 0, sources: [] });
    return { items: batch.length, stories: out.stories.length };
  }
}
