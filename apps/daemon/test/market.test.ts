import { ProviderError, type MarketProvider } from '@bloomterm/integrations';
import { describe, expect, it } from 'vitest';
import { MarketService } from '../src/market/service.ts';

function fakeProvider(over: Partial<MarketProvider> = {}) {
  const calls = { quote: 0, bars: 0 };
  let fail: string | null = null;
  const p: MarketProvider = {
    id: 'fake',
    method: 'api',
    quoteTtlMs: 15_000,
    supports: (sec) => sec.sector === 'Equity',
    async quote(sec) {
      calls.quote++;
      if (fail) throw new ProviderError('fake', fail);
      return { symbol: sec.ticker, last: 100 + calls.quote, prevClose: 100, change: calls.quote, asOf: '2026-10-28T14:00:00Z' };
    },
    async bars(_sec, _range, from) {
      calls.bars++;
      return { bars: [{ t: Math.floor(from.getTime() / 1000), o: 1, h: 2, l: 0.5, c: 1.5 }] };
    },
    ...over,
  };
  return { p, calls, setFail: (m: string | null) => (fail = m) };
}

describe('MarketService', () => {
  it('serves fresh quotes from cache and refetches after the TTL', async () => {
    let now = new Date('2026-10-28T14:00:00Z');
    const { p, calls } = fakeProvider();
    const m = new MarketService([p], { now: () => now });
    const a = await m.quote('aapl');
    expect(a).toMatchObject({ key: 'AAPL US Equity', last: 101, source: 'fake', method: 'api', fetchedAt: '2026-10-28T14:00:00.000Z' });
    expect((await m.quote('AAPL US Equity')).last).toBe(101);
    expect(calls.quote).toBe(1);
    now = new Date(now.getTime() + 16_000);
    expect((await m.quote('aapl')).last).toBe(102);
  });

  it('shares one fetch between concurrent callers', async () => {
    const { p, calls } = fakeProvider();
    const m = new MarketService([p]);
    await Promise.all([m.quote('aapl'), m.quote('aapl'), m.quote('AAPL US Equity')]);
    expect(calls.quote).toBe(1);
  });

  it('falls back to the last good quote, marked stale, when the source fails', async () => {
    let now = new Date('2026-10-28T14:00:00Z');
    const { p, setFail } = fakeProvider();
    const m = new MarketService([p], { now: () => now });
    await m.quote('aapl');
    setFail('fake answered 503');
    now = new Date(now.getTime() + 60_000);
    expect(await m.quote('aapl')).toMatchObject({ last: 101, stale: true, error: 'fake answered 503' });
    // Never fetched: the error comes through.
    await expect(m.quote('msft')).rejects.toThrow('fake answered 503');
  });

  it('reports per-key errors in a batch, including keys nothing serves', async () => {
    const { p } = fakeProvider();
    const m = new MarketService([p]);
    const out = await m.quoteMany(['aapl', 'spx', 'petrobras']);
    expect(out[0]).toMatchObject({ key: 'AAPL US Equity', last: 101 });
    expect(out[1]).toEqual({ key: 'SPX Index', error: expect.stringMatching(/no source for SPX Index/) });
    expect(out[2]).toEqual({ key: 'petrobras', error: '"petrobras" isn\'t a security key' });
  });

  it('caches bars per range', async () => {
    const { p, calls } = fakeProvider();
    const m = new MarketService([p], { now: () => new Date('2026-10-28T14:00:00Z') });
    const s = await m.bars('aapl', '1Y');
    expect(s).toMatchObject({ key: 'AAPL US Equity', range: '1Y', interval: '1d', source: 'fake' });
    expect(s.bars[0]!.t).toBe(Date.parse('2025-10-28T14:00:00Z') / 1000);
    await m.bars('aapl', '1Y');
    await m.bars('aapl', '1M');
    expect(calls.bars).toBe(2);
  });

  it('serves 1D from the feed\'s intraday bars, fresh for a minute, and says when a feed has none', async () => {
    let now = new Date('2026-10-28T14:00:00Z');
    let intraday = 0;
    const { p, calls } = fakeProvider({
      async intraday() {
        intraday++;
        return { bars: [{ t: 1_793_000_000, o: 1, h: 2, l: 0.5, c: 1.5 }], currency: 'USD' };
      },
    });
    const m = new MarketService([p], { now: () => now });
    expect(await m.bars('aapl', '1D')).toMatchObject({ range: '1D', interval: '5m', currency: 'USD', bars: [{ t: 1_793_000_000 }] });
    await m.bars('aapl', '1D');
    expect(intraday).toBe(1);
    now = new Date(now.getTime() + 61_000);
    await m.bars('aapl', '1D');
    expect(intraday).toBe(2);
    expect(calls.bars).toBe(0);

    const daily = new MarketService([fakeProvider().p]);
    await expect(daily.bars('aapl', '1D')).rejects.toThrow('no intraday bars for AAPL US Equity: fake has daily bars only');
  });
});
