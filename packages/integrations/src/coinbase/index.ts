import type { Bar, DailyRange, Security } from '@bloomterm/core';
import { getJson, num, ProviderError } from '../http.ts';
import { defineIntegration, type MarketFeed, type QuoteData } from '../sdk.ts';

// Coinbase Exchange public API (SPEC §7.2): crypto quotes and daily candles, no key needed.

const BASE = 'https://api.exchange.coinbase.com/products';
const DAY = 86_400;

function feed(): MarketFeed {
  const product = (sec: Security) => `${sec.ticker.slice(0, -3)}-USD`;

  return {
    quoteTtlMs: 15_000,
    supports: (sec) => sec.sector === 'Crypto' && sec.ticker.endsWith('USD'),

    async quote(sec: Security): Promise<QuoteData> {
      const id = product(sec);
      const [ticker, stats] = await Promise.all([
        getJson<{ price: string; time: string; volume: string }>('coinbase', `${BASE}/${id}/ticker`),
        getJson<{ open: string; high: string; low: string }>('coinbase', `${BASE}/${id}/stats`),
      ]);
      const last = num(ticker.price);
      if (last === undefined) throw new ProviderError('coinbase', `coinbase has no price for ${id}`);
      const open = num(stats.open);
      return {
        symbol: id,
        currency: 'USD',
        last,
        // Crypto never closes: change is against the price 24 hours ago.
        prevClose: open,
        change: open !== undefined ? last - open : undefined,
        changePct: open ? ((last - open) / open) * 100 : undefined,
        changeBasis: '24h',
        open,
        high: num(stats.high),
        low: num(stats.low),
        volume: num(ticker.volume),
        asOf: ticker.time,
        delayMinutes: 0,
      };
    },

    async bars(sec: Security, _range: DailyRange, from: Date) {
      const id = product(sec);
      const end = Math.floor(Date.now() / 1000);
      const out = new Map<number, Bar>();
      // 300 candles per request; walk forward in windows. Nothing trades here before 2015.
      const first = Math.max(Math.floor(from.getTime() / 1000), Date.UTC(2015, 0, 1) / 1000);
      for (let start = first; start < end; start += 300 * DAY) {
        const stop = Math.min(start + 300 * DAY, end);
        const q = new URLSearchParams({ granularity: String(DAY), start: new Date(start * 1000).toISOString(), end: new Date(stop * 1000).toISOString() });
        const rows = await getJson<number[][]>('coinbase', `${BASE}/${id}/candles?${q}`);
        // [time, low, high, open, close, volume]
        for (const [t, l, h, o, c, v] of rows) out.set(t!, { t: t!, o: o!, h: h!, l: l!, c: c!, v });
      }
      return { bars: [...out.values()].sort((a, b) => a.t - b.t), currency: 'USD' };
    },

    // Crypto never closes: the latest session is the last 24 hours, 288 five-minute candles.
    async intraday(sec: Security) {
      const end = Math.floor(Date.now() / 1000);
      const q = new URLSearchParams({ granularity: '300', start: new Date((end - DAY) * 1000).toISOString(), end: new Date(end * 1000).toISOString() });
      const rows = await getJson<number[][]>('coinbase', `${BASE}/${product(sec)}/candles?${q}`);
      const bars = rows.map(([t, l, h, o, c, v]): Bar => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v }));
      return { bars: bars.sort((a, b) => a.t - b.t), currency: 'USD' };
    },
  };
}

export default defineIntegration({
  id: 'coinbase',
  name: 'Coinbase Exchange',
  covers: 'crypto quotes and daily candles, real-time, no key',
  access: 'api',
  status: 'ready',
  docs: 'https://docs.cdp.coinbase.com/exchange/reference',
  market: () => feed(),
});
