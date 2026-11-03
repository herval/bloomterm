import { lastSession, parseSecurity, type Bar, type DailyRange, type Security } from '@bloomterm/core';
import { getJson, ProviderError } from '../http.ts';
import { plain } from '../text.ts';
import { defineIntegration, type MarketFeed, type NewsData, type NewsFeed, type QuoteData, type SecretLookup } from '../sdk.ts';

// Alpaca market data (SPEC §7.2, P0): US stocks and ETFs. The free plan gives real-time
// IEX prices, and SIP history older than 15 minutes.
// Keys: SET in the UI, or security add-generic-password -s bloomterm -a alpaca-key-id -w … (and -a alpaca-secret)

const BASE = 'https://data.alpaca.markets/v2/stocks';

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface Snapshot {
  latestTrade?: { t: string; p: number };
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

const keys = (secrets: SecretLookup, what: string) => async () => {
  const [id, secret] = await Promise.all([secrets('alpaca-key-id'), secrets('alpaca-secret')]);
  if (!id || !secret) {
    throw new ProviderError('alpaca', `${what} need Alpaca keys: add them in SET (free at alpaca.markets)`);
  }
  return { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret };
};

function feed(secrets: SecretLookup): MarketFeed {
  const headers = keys(secrets, 'US quotes');
  const toBar = (b: AlpacaBar): Bar => ({ t: Math.floor(Date.parse(b.t) / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });

  async function history(sec: Security, timeframe: '1Day' | '5Min', from: Date): Promise<Bar[]> {
    const h = await headers();
    // SIP (all venues) is free once it's 15 minutes old.
    const end = new Date(Date.now() - 16 * 60_000).toISOString();
    const bars: Bar[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ timeframe, start: from.toISOString(), end, limit: '10000', adjustment: 'split', feed: 'sip' });
      if (page) q.set('page_token', page);
      const res = await getJson<{ bars: AlpacaBar[] | null; next_page_token?: string | null }>('alpaca', `${BASE}/${encodeURIComponent(sec.ticker)}/bars?${q}`, h);
      bars.push(...(res.bars ?? []).map(toBar));
      page = res.next_page_token ?? undefined;
    } while (page);
    return bars;
  }

  return {
    quoteTtlMs: 15_000,
    supports: (sec) => sec.sector === 'Equity' && sec.market === 'US',

    async quote(sec: Security): Promise<QuoteData> {
      const s = await getJson<Snapshot>('alpaca', `${BASE}/${encodeURIComponent(sec.ticker)}/snapshot?feed=iex`, await headers());
      const last = s.latestTrade?.p ?? s.dailyBar?.c;
      if (last === undefined) throw new ProviderError('alpaca', `alpaca has no trades for ${sec.ticker}`);
      const prev = s.prevDailyBar?.c;
      return {
        symbol: sec.ticker,
        currency: 'USD',
        last,
        prevClose: prev,
        change: prev !== undefined ? last - prev : undefined,
        changePct: prev ? ((last - prev) / prev) * 100 : undefined,
        changeBasis: 'prev_close',
        open: s.dailyBar?.o,
        high: s.dailyBar?.h,
        low: s.dailyBar?.l,
        // IEX volume is a small slice of the market's; leave it out rather than mislead.
        asOf: s.latestTrade?.t ?? s.dailyBar?.t ?? new Date().toISOString(),
        delayMinutes: 0,
      };
    },

    async bars(sec: Security, _range: DailyRange, from: Date) {
      return { bars: await history(sec, '1Day', from), currency: 'USD' };
    },

    // 5-minute SIP bars, pre- and after-market included, 16 minutes behind (see history).
    // Five days back covers a long weekend; only the latest session is kept.
    async intraday(sec: Security) {
      const bars = await history(sec, '5Min', new Date(Date.now() - 5 * 86_400_000));
      return { bars: lastSession(bars, 'America/New_York'), currency: 'USD' };
    },
  };
}

interface AlpacaNews {
  id: number;
  headline: string;
  author?: string;
  created_at: string;
  summary?: string;
  url?: string;
  symbols?: string[];
  source?: string;
}

/** Alpaca's news (Benzinga's wire), tagged with its own symbols. */
export function fromAlpacaNews(n: AlpacaNews): NewsData | null {
  if (!n.url || !n.headline) return null;
  const source = n.source ? n.source.charAt(0).toUpperCase() + n.source.slice(1) : 'Alpaca';
  return {
    id: String(n.id),
    headline: n.headline,
    url: n.url,
    outlet: source,
    ts: new Date(n.created_at).toISOString(),
    summary: plain(n.summary ?? '') || undefined,
    lang: 'en',
    kind: 'news',
    tickers: (n.symbols ?? []).flatMap((s) => {
      const sec = parseSecurity(s);
      return sec && (sec.sector === 'Crypto' || sec.market === 'US') ? [sec.key] : [];
    }),
  };
}

function newsFeed(secrets: SecretLookup): NewsFeed {
  const headers = keys(secrets, 'US company news');
  return {
    everyMs: 5 * 60_000,
    async latest({ securities, since }) {
      const symbols = securities.filter((s: Security) => s.sector === 'Equity' && s.market === 'US').map((s) => s.ticker).slice(0, 50);
      const q = new URLSearchParams({ limit: '50', sort: 'desc' });
      // Your tickers when you have some; otherwise the whole wire's latest.
      if (symbols.length) q.set('symbols', symbols.join(','));
      if (since) q.set('start', new Date(since.getTime() - 3_600_000).toISOString());
      const res = await getJson<{ news?: AlpacaNews[] }>('alpaca', `https://data.alpaca.markets/v1beta1/news?${q}`, await headers());
      return (res.news ?? []).flatMap((n) => fromAlpacaNews(n) ?? []);
    },
  };
}

export default defineIntegration({
  id: 'alpaca',
  name: 'Alpaca market data',
  covers: 'US stocks and ETFs: real-time IEX quotes, SIP daily history, and company news',
  access: 'api',
  status: 'ready',
  docs: 'https://docs.alpaca.markets/docs/about-market-data-api',
  secrets: [
    { name: 'alpaca-key-id', label: 'Alpaca key ID', covers: 'US stocks and ETFs (real-time IEX)', signup: 'https://alpaca.markets' },
    { name: 'alpaca-secret', label: 'Alpaca secret key', covers: 'US stocks and ETFs (real-time IEX)', signup: 'https://alpaca.markets' },
  ],
  market: ({ secret }) => feed(secret),
  news: ({ secret }) => newsFeed(secret),
});
