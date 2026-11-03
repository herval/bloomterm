// Watchlists (SPEC §11 `watchlist`): the UI edits them; bloomd reads them to know what you
// follow (news, the brief). Kept in ui_state under `watchlists`. Browser-safe.

export interface Watchlists {
  current: string;
  lists: Record<string, string[]>;
}

export const DEFAULT_WATCHLISTS: Watchlists = {
  current: 'Core',
  lists: {
    Core: [
      'AAPL US Equity',
      'NVDA US Equity',
      'SPY US Equity',
      'PETR4 BZ Equity',
      'VALE3 BZ Equity',
      'ITUB4 BZ Equity',
      'BBAS3 BZ Equity',
      'IBOV Index',
      'USDBRL Curncy',
      'BTCUSD Crypto',
      'ETHUSD Crypto',
    ],
  },
};

/** Every security on any list, once. */
export const watchedKeys = (w: Watchlists | null | undefined): string[] => [...new Set(Object.values((w ?? DEFAULT_WATCHLISTS).lists).flat())];

/** The markets strip on Today, and what the brief opens with. */
export const MARKET_STRIP = ['IBOV Index', 'SPY US Equity', 'QQQ US Equity', 'USDBRL Curncy', 'BTCUSD Crypto'];

/** Where a security's moves are measured against. */
export function benchmarkOf(key: string): string | null {
  if (key.endsWith(' BZ Equity')) return 'IBOV Index';
  if (key.endsWith(' US Equity')) return key === 'SPY US Equity' ? null : 'SPY US Equity';
  if (key.endsWith(' Crypto')) return key === 'BTCUSD Crypto' ? null : 'BTCUSD Crypto';
  return null;
}
