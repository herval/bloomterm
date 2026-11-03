import { lastSession, type Bar, type DailyRange, type Security } from '@bloomterm/core';
import { getJson, num, ProviderError } from '../http.ts';
import { defineIntegration, type MarketFeed, type QuoteData, type SecretLookup } from '../sdk.ts';

// brapi.dev (SPEC §7.3): B3 stocks, FIIs, ETFs, BDRs and IBOV. Free plan: ~30 min delay,
// 15k requests a month, one ticker per call. Without a token only its test tickers answer.
// Token: SET in the UI, or security add-generic-password -s bloomterm -a brapi -w <token>

const BASE = 'https://brapi.dev/api/quote';
const RANGE: Record<DailyRange, string> = { '5D': '5d', '1M': '1mo', '3M': '3mo', '6M': '6mo', YTD: 'ytd', '1Y': '1y', '5Y': '5y', MAX: 'max' };
const INDEX: Record<string, string> = { IBOV: '^BVSP' };

interface Result {
  symbol: string;
  longName?: string;
  shortName?: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: string | number;
  historicalDataPrice?: Array<{ date: number; open: number; high: number; low: number; close: number; volume?: number }>;
}

const toBars = (r: Result, since: number): Bar[] =>
  (r.historicalDataPrice ?? [])
    .filter((b) => b.date >= since && Number.isFinite(b.close))
    .map((b) => ({ t: b.date, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));

export function brapiFeed(secrets: SecretLookup): MarketFeed {
  const symbol = (sec: Security) => INDEX[sec.ticker] ?? sec.ticker;
  // Without a token brapi allows one request in flight (more get 429), so queue them.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const fetchResult = (sec: Security, query = '') => serial(() => fetchOnce(sec, query).catch(async (err) => {
    if (!(err instanceof ProviderError && err.status === 429)) throw err;
    await new Promise((r) => setTimeout(r, 1_500));
    return fetchOnce(sec, query);
  }));

  async function fetchOnce(sec: Security, query: string): Promise<Result> {
    const token = await secrets('brapi');
    try {
      const res = await getJson<{ results?: Result[] }>(
        'brapi',
        `${BASE}/${encodeURIComponent(symbol(sec))}${query}`,
        token ? { authorization: `Bearer ${token}` } : {},
      );
      const r = res.results?.[0];
      if (!r) throw new ProviderError('brapi', `brapi has nothing for ${sec.ticker}`);
      return r;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && !token) {
        throw new ProviderError('brapi', `${sec.ticker} needs a brapi token: add one in SET (free at brapi.dev)`, 401);
      }
      if (err instanceof ProviderError && err.status === 404) throw new ProviderError('brapi', `brapi doesn't know ${sec.ticker}`, 404);
      throw err;
    }
  }

  return {
    // The data is ~30 min behind and the free plan allows ~500 calls a day.
    quoteTtlMs: 5 * 60_000,
    supports: (sec) => (sec.sector === 'Equity' && sec.market === 'BZ') || (sec.sector === 'Index' && sec.ticker in INDEX),

    async quote(sec: Security): Promise<QuoteData> {
      const r = await fetchResult(sec);
      const last = num(r.regularMarketPrice);
      if (last === undefined) throw new ProviderError('brapi', `brapi has no price for ${sec.ticker}`);
      const t = r.regularMarketTime;
      return {
        symbol: r.symbol,
        name: r.longName ?? r.shortName,
        currency: r.currency ?? 'BRL',
        last,
        change: num(r.regularMarketChange),
        changePct: num(r.regularMarketChangePercent),
        changeBasis: 'prev_close',
        prevClose: num(r.regularMarketPreviousClose),
        open: num(r.regularMarketOpen),
        high: num(r.regularMarketDayHigh),
        low: num(r.regularMarketDayLow),
        volume: num(r.regularMarketVolume),
        asOf: typeof t === 'number' ? new Date(t * 1000).toISOString() : t ? new Date(t).toISOString() : new Date().toISOString(),
        delayMinutes: 30,
      };
    },

    async bars(sec: Security, range: DailyRange, from: Date) {
      const r = await fetchResult(sec, `?range=${RANGE[range]}&interval=1d`);
      return { bars: toBars(r, from.getTime() / 1000), currency: r.currency ?? 'BRL' };
    },

    // brapi's `range=1d` can come back empty, so ask for five days and keep the latest session.
    async intraday(sec: Security) {
      const r = await fetchResult(sec, '?range=5d&interval=5m');
      return { bars: lastSession(toBars(r, 0), 'America/Sao_Paulo'), currency: r.currency ?? 'BRL' };
    },
  };
}

export default defineIntegration({
  id: 'brapi',
  name: 'brapi.dev',
  covers: 'B3 stocks, FIIs, ETFs, BDRs and IBOV (~30 min delay)',
  access: 'api',
  status: 'ready',
  docs: 'https://brapi.dev/docs',
  secrets: [{ name: 'brapi', label: 'brapi token', covers: 'every B3 ticker and IBOV (~30 min delay)', signup: 'https://brapi.dev' }],
  market: ({ secret }) => brapiFeed(secret),
});
