import { parseSecurity, rangeStart, type BarSeries, type Quote, type Range, type Security } from '@bloomterm/core';
import type { Logger } from '@bloomterm/browser';
import { ProviderError, type MarketProvider } from '@bloomterm/integrations';

export type QuoteResult = Quote | { key: string; error: string };

export class NoSourceError extends Error {}

const NO_SOURCE_HINT: Partial<Record<Security['sector'], string>> = {
  Index: 'no index source yet (IBOV works with a brapi token)',
  Curncy: 'only USDBRL (BCB PTAX) so far',
  Comdty: 'no commodities source yet',
  Govt: 'no rates source yet',
};

/**
 * Quotes, daily bars and the 1D chart's intraday bars (SPEC §7.4, the router's first cut). Cache-first: a fresh cached
 * value is served without a fetch, and when a source fails, the last good value comes
 * back marked `stale` with the reason rather than an error.
 */
export class MarketService {
  private quotes = new Map<string, Quote>();
  private series = new Map<string, BarSeries>();
  private inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(
    private readonly providers: MarketProvider[],
    private readonly opts: { now?: () => Date; barsTtlMs?: number; log?: Logger } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  resolve(key: string): { sec: Security; provider: MarketProvider } {
    const sec = parseSecurity(key);
    if (!sec) throw new NoSourceError(`"${key}" isn't a security key`);
    const provider = this.providers.find((p) => p.supports(sec));
    if (!provider) throw new NoSourceError(`no source for ${sec.key}: ${NO_SOURCE_HINT[sec.sector] ?? 'none configured'}`);
    return { sec, provider };
  }

  async quote(key: string): Promise<Quote> {
    const { sec, provider } = this.resolve(key);
    const cached = this.quotes.get(sec.key);
    if (cached && !cached.stale && this.age(cached.fetchedAt) < provider.quoteTtlMs) return cached;
    return this.once(`q:${sec.key}`, async () => {
      try {
        const data = await provider.quote(sec);
        const q: Quote = { ...data, key: sec.key, source: provider.id, method: provider.method, fetchedAt: this.now().toISOString() };
        this.quotes.set(sec.key, q);
        return q;
      } catch (err) {
        const error = message(err);
        this.opts.log?.warn('quote failed', { key: sec.key, source: provider.id, error });
        if (cached) return { ...cached, stale: true, error };
        throw err;
      }
    });
  }

  async quoteMany(keys: string[]): Promise<QuoteResult[]> {
    const settled = await Promise.allSettled(keys.map((k) => this.quote(k)));
    return settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { key: parseSecurity(keys[i]!)?.key ?? keys[i]!, error: message(r.reason) }));
  }

  async bars(key: string, range: Range): Promise<BarSeries> {
    const { sec, provider } = this.resolve(key);
    const intraday = range === '1D';
    if (intraday && !provider.intraday) throw new NoSourceError(`no intraday bars for ${sec.key}: ${provider.id} has daily bars only`);
    const id = `${sec.key}|${range}`;
    const cached = this.series.get(id);
    // Today's bars go stale in minutes; daily ones in an hour.
    const ttl = intraday ? Math.max(60_000, provider.quoteTtlMs) : (this.opts.barsTtlMs ?? 60 * 60_000);
    if (cached && !cached.stale && this.age(cached.fetchedAt) < ttl) return cached;
    return this.once(`b:${id}`, async () => {
      try {
        const { bars, currency } = range === '1D' ? await provider.intraday!(sec) : await provider.bars(sec, range, rangeStart(range, this.now()));
        const s: BarSeries = { key: sec.key, range, interval: intraday ? '5m' : '1d', bars, currency, source: provider.id, method: provider.method, fetchedAt: this.now().toISOString() };
        this.series.set(id, s);
        return s;
      } catch (err) {
        const error = message(err);
        this.opts.log?.warn('bars failed', { key: sec.key, range, source: provider.id, error });
        if (cached) return { ...cached, stale: true, error };
        throw err;
      }
    });
  }

  private age(iso: string): number {
    return this.now().getTime() - Date.parse(iso);
  }

  /** Concurrent callers for the same thing share one fetch. */
  private once<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(id);
    if (running) return running as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }
}

const message = (err: unknown) => (err instanceof ProviderError || err instanceof NoSourceError ? err.message : String((err as Error)?.message ?? err));
