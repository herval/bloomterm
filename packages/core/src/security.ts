// Security keys, `ticker [exchange] sector` (SPEC §4.2): `AAPL US Equity`, `PETR4 BZ Equity`, `USDBRL Curncy`,
// `BTCUSD Crypto`, `SPX Index`. You can type as little as resolves: `aapl`, `petr4`, `usdbrl`, `btc`.
// Browser-safe: the UI and bloomd share it.

export type Sector = 'Equity' | 'Index' | 'Curncy' | 'Crypto' | 'Comdty' | 'Govt';
export type Market = 'US' | 'BZ';

export interface Security {
  /** Canonical key, e.g. `PETR4 BZ Equity`. */
  key: string;
  ticker: string;
  sector: Sector;
  /** Equities only. */
  market?: Market;
}

const SECTORS: Record<string, Sector> = {
  equity: 'Equity',
  index: 'Index',
  curncy: 'Curncy',
  crypto: 'Crypto',
  comdty: 'Comdty',
  govt: 'Govt',
};

const CURRENCIES = new Set(
  'USD BRL EUR GBP JPY CHF CAD AUD NZD CNY HKD MXN ARS CLP COP PEN SEK NOK DKK ZAR INR KRW SGD TRY'.split(' '),
);
const CRYPTO = new Set('BTC ETH SOL XRP ADA DOGE LTC AVAX DOT LINK USDC USDT BCH XLM UNI ATOM'.split(' '));
const INDICES = new Set('SPX NDX INDU RUT VIX COMP IBOV IFIX SMLL IBXX UKX DAX NKY SX5E'.split(' '));
/** B3 tickers end in a digit: PETR4, HGLG11, AAPL34. */
const B3_TICKER = /^[A-Z]{4}\d{1,2}$/;
const US_TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;

function make(ticker: string, sector: Sector, market?: Market): Security {
  return { key: market ? `${ticker} ${market} ${sector}` : `${ticker} ${sector}`, ticker, sector, market };
}

/** Resolves a full key or a shorthand. Returns null when it can't tell what you meant. */
export function parseSecurity(input: string): Security | null {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const ticker = parts[0]?.toUpperCase();
  if (!ticker || parts.length > 3) return null;

  if (parts.length === 3) {
    const market = parts[1]!.toUpperCase();
    const sector = SECTORS[parts[2]!.toLowerCase()];
    if ((market === 'US' || market === 'BZ') && sector === 'Equity') return make(ticker, 'Equity', market);
    return null;
  }
  if (parts.length === 2) {
    const second = parts[1]!.toUpperCase();
    // `aapl us`, `petr4 bz`
    if (second === 'US' || second === 'BZ') return make(ticker, 'Equity', second);
    const sector = SECTORS[parts[1]!.toLowerCase()];
    if (!sector) return null;
    if (sector === 'Equity') {
      const s = shorthand(ticker);
      return s?.sector === 'Equity' ? s : null;
    }
    return make(ticker, sector);
  }
  return shorthand(ticker);
}

function shorthand(t: string): Security | null {
  if (CRYPTO.has(t)) return make(`${t}USD`, 'Crypto');
  if (t.endsWith('USD') && CRYPTO.has(t.slice(0, -3))) return make(t, 'Crypto');
  if (t.length === 6 && CURRENCIES.has(t.slice(0, 3)) && CURRENCIES.has(t.slice(3))) return make(t, 'Curncy');
  if (INDICES.has(t)) return make(t, 'Index');
  if (B3_TICKER.test(t)) return make(t, 'Equity', 'BZ');
  if (US_TICKER.test(t)) return make(t, 'Equity', 'US');
  return null;
}
