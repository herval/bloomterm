import { z } from 'zod';
import { Method } from './schemas.ts';

// Market data as bloomd serves it. Every value carries where it came from and when (SPEC §3.3).

export const Quote = z.object({
  key: z.string(),
  symbol: z.string(),
  name: z.string().optional(),
  currency: z.string().optional(),
  last: z.number(),
  change: z.number().optional(),
  changePct: z.number().optional(),
  /** What `change` is measured against: the previous close, or 24h ago for crypto. */
  changeBasis: z.enum(['prev_close', '24h', 'prev_fixing']).optional(),
  prevClose: z.number().optional(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  volume: z.number().optional(),
  /** When the price was set at the source (last trade, fixing time). */
  asOf: z.string(),
  /** 0 = real time. */
  delayMinutes: z.number().optional(),
  source: z.string(),
  method: Method,
  fetchedAt: z.string(),
  /** Served from cache because the source failed; `error` says why. */
  stale: z.boolean().optional(),
  error: z.string().optional(),
});
export type Quote = z.infer<typeof Quote>;

export const Bar = z.object({
  /** Start of the bar, epoch seconds (UTC midnight for daily bars). */
  t: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().optional(),
});
export type Bar = z.infer<typeof Bar>;

export const BarSeries = z.object({
  key: z.string(),
  range: z.string(),
  /** `1d` bars, or `5m` for 1D (the latest session). */
  interval: z.enum(['1d', '5m']),
  bars: z.array(Bar),
  currency: z.string().optional(),
  source: z.string(),
  method: Method,
  fetchedAt: z.string(),
  stale: z.boolean().optional(),
  error: z.string().optional(),
});
export type BarSeries = z.infer<typeof BarSeries>;

/** Chart ranges. 1D is the latest session in 5-minute bars; the rest are daily bars. */
export const RANGES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'] as const;
export type Range = (typeof RANGES)[number];
/** The ranges a feed's `bars()` serves. 1D comes from its `intraday()`. */
export type DailyRange = Exclude<Range, '1D'>;

export function rangeStart(range: Range, now: Date): Date {
  const d = new Date(now);
  switch (range) {
    case '1D':
      d.setUTCDate(d.getUTCDate() - 1);
      return d;
    case '5D':
      d.setUTCDate(d.getUTCDate() - 7);
      return d;
    case '1M':
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d;
    case '3M':
      d.setUTCMonth(d.getUTCMonth() - 3);
      return d;
    case '6M':
      d.setUTCMonth(d.getUTCMonth() - 6);
      return d;
    case 'YTD':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case '1Y':
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      return d;
    case '5Y':
      d.setUTCFullYear(d.getUTCFullYear() - 5);
      return d;
    case 'MAX':
      return new Date(Date.UTC(1990, 0, 1));
  }
}

/**
 * The bars of the latest session: those on the same calendar day, in the market's time zone,
 * as the last bar. Feeds ask for a few days of intraday bars (weekends, holidays) and keep these.
 */
export function lastSession(bars: Bar[], timeZone: string): Bar[] {
  if (!bars.length) return [];
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const last = date.format(bars.at(-1)!.t * 1000);
  return bars.filter((b) => date.format(b.t * 1000) === last);
}
