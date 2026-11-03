import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/command.ts';
import { lastSession, rangeStart } from '../src/market.ts';
import { parseSecurity } from '../src/security.ts';

const FNS = new Set(['OV', 'GP', 'W', 'SRC', 'JOBS', 'PORT', 'LOGIN', 'HELP']);
const key = (s: string) => parseSecurity(s)?.key ?? null;

describe('parseSecurity', () => {
  it('resolves shorthands by shape', () => {
    expect(key('aapl')).toBe('AAPL US Equity');
    expect(key('brk.b')).toBe('BRK.B US Equity');
    expect(key('petr4')).toBe('PETR4 BZ Equity');
    expect(key('hglg11')).toBe('HGLG11 BZ Equity');
    expect(key('aapl34')).toBe('AAPL34 BZ Equity');
    expect(key('usdbrl')).toBe('USDBRL Curncy');
    expect(key('btc')).toBe('BTCUSD Crypto');
    expect(key('ethusd')).toBe('ETHUSD Crypto');
    expect(key('spx')).toBe('SPX Index');
    expect(key('ibov')).toBe('IBOV Index');
  });

  it('takes full keys in any case', () => {
    expect(key('aapl us equity')).toBe('AAPL US Equity');
    expect(key('PETR4 BZ Equity')).toBe('PETR4 BZ Equity');
    expect(key('eurusd curncy')).toBe('EURUSD Curncy');
    expect(key('cl1 comdty')).toBe('CL1 Comdty');
    expect(key('petr4 bz')).toBe('PETR4 BZ Equity');
    expect(parseSecurity('PETR4 BZ Equity')).toEqual({ key: 'PETR4 BZ Equity', ticker: 'PETR4', sector: 'Equity', market: 'BZ' });
  });

  it("returns null when it can't tell", () => {
    expect(key('petrobras')).toBeNull();
    expect(key('aapl xx equity')).toBeNull();
    expect(key('')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('parses security, function and args', () => {
    expect(parseCommand('AAPL GP 1Y <GO>', FNS)).toMatchObject({ kind: 'go', security: { key: 'AAPL US Equity' }, fn: 'GP', args: ['1Y'] });
    expect(parseCommand('petr4 bz equity gp', FNS)).toMatchObject({ kind: 'go', security: { key: 'PETR4 BZ Equity' }, fn: 'GP' });
    expect(parseCommand('btc', FNS)).toEqual({ kind: 'go', security: expect.objectContaining({ key: 'BTCUSD Crypto' }), args: [] });
  });

  it('lets a mnemonic win over a ticker of the same name', () => {
    expect(parseCommand('w', FNS)).toEqual({ kind: 'go', fn: 'W', args: [] });
    expect(parseCommand('W ADD petr4', FNS)).toEqual({ kind: 'go', fn: 'W', args: ['ADD', 'petr4'] });
    expect(parseCommand('w us equity', FNS)).toMatchObject({ kind: 'go', security: { key: 'W US Equity' } });
    expect(parseCommand('login b3', FNS)).toEqual({ kind: 'go', fn: 'LOGIN', args: ['b3'] });
  });

  it('drills into numbered rows', () => {
    expect(parseCommand('3', FNS)).toEqual({ kind: 'drill', row: 3 });
    expect(parseCommand(' 12 <GO>', FNS)).toEqual({ kind: 'drill', row: 12 });
  });

  it('sends sentences to ASK', () => {
    expect(parseCommand('why is nvda down today', FNS)).toEqual({ kind: 'ask', text: 'why is nvda down today' });
    expect(parseCommand('petrobras', FNS)).toEqual({ kind: 'unknown', text: 'petrobras' });
    expect(parseCommand('   ', FNS)).toEqual({ kind: 'empty' });
  });
});

describe('rangeStart', () => {
  const now = new Date('2026-10-28T14:00:00Z');
  it('counts back from now', () => {
    expect(rangeStart('1Y', now).toISOString()).toBe('2025-10-28T14:00:00.000Z');
    expect(rangeStart('YTD', now).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rangeStart('1M', now).toISOString()).toBe('2026-09-28T14:00:00.000Z');
  });
});

describe('lastSession', () => {
  const at = (iso: string) => ({ t: Date.parse(iso) / 1000, o: 1, h: 1, l: 1, c: 1 });
  it("keeps the bars on the last bar's day, in the market's time zone", () => {
    // Friday's after-hours run past midnight UTC; it's still Friday in New York.
    const bars = [at('2026-10-29T19:55:00Z'), at('2026-10-30T13:30:00Z'), at('2026-10-30T23:55:00Z'), at('2026-10-31T00:30:00Z')];
    expect(lastSession(bars, 'America/New_York')).toEqual(bars.slice(1));
    expect(lastSession(bars, 'UTC')).toEqual(bars.slice(3));
    expect(lastSession([], 'America/Sao_Paulo')).toEqual([]);
  });
});
