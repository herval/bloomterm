import { defineIntegration, type MarketFeed } from '@bloomterm/integrations';

// Made-up market data for tests: deterministic, no network.
export const fakeFeed: MarketFeed = {
  quoteTtlMs: 1_000,
  supports: (sec) => sec.sector === 'Equity' || sec.sector === 'Crypto',
  async quote(sec) {
    const last = sec.ticker.length * 10 + 0.5;
    return { symbol: sec.ticker, name: `${sec.ticker} Inc`, currency: 'USD', last, prevClose: last - 1, change: 1, changePct: 2, changeBasis: 'prev_close', asOf: new Date().toISOString(), delayMinutes: 0 };
  },
  async bars(_sec, _range, from) {
    const start = Math.floor(from.getTime() / 86_400_000) * 86_400;
    return { bars: Array.from({ length: 260 }, (_, i) => ({ t: start + i * 86_400, o: 100 + i, h: 103 + i, l: 99 + i, c: 101 + i, v: 1_000 + i })) };
  },
};

export const fakeMarket = defineIntegration({
  id: 'fake',
  name: 'Fake market',
  covers: 'everything, made up',
  access: 'api',
  status: 'ready',
  secrets: [{ name: 'fake-token', label: 'Fake token', covers: 'more made-up data', signup: 'https://example.com' }],
  market: () => fakeFeed,
});
