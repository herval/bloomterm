import type { Quote } from '@bloomterm/core/web';

export function decimalsFor(key: string, value: number): number {
  if (key.endsWith('Curncy')) return 4;
  if (Math.abs(value) >= 1000) return 2;
  if (Math.abs(value) < 1) return 4;
  return 2;
}

export function price(value: number | undefined, key = ''): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const d = decimalsFor(key, value);
  return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function signed(value: number | undefined, decimals = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const s = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${s}`;
}

export function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${signed(value)}%`;
}

export function compact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  if (a >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(a < 10 ? 2 : 0);
}

export function money(value: number | undefined, currency?: string): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
}

export const tone = (v: number | undefined) => (v === undefined || v === 0 ? '' : v > 0 ? 'up' : 'down');

/** `42s`, `5m`, `3h`, `2d`. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400 * 2) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function clock(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function delayLabel(q: Pick<Quote, 'delayMinutes' | 'source'>): string {
  if (q.delayMinutes === 0) return `RT·${q.source}`;
  if (q.delayMinutes) return `${q.delayMinutes}m·${q.source}`;
  return q.source;
}

/** What hovering a value shows (SPEC §3.3). */
export function provenance(q: Pick<Quote, 'source' | 'method' | 'asOf' | 'fetchedAt' | 'delayMinutes' | 'stale' | 'error'>): string {
  const lines = [
    `source: ${q.source} (${q.method})`,
    `as of: ${new Date(q.asOf).toLocaleString()}`,
    `fetched: ${new Date(q.fetchedAt).toLocaleString()}`,
  ];
  if (q.delayMinutes) lines.push(`delayed ~${q.delayMinutes} min`);
  if (q.stale) lines.push(`STALE: ${q.error ?? 'last fetch failed'}`);
  return lines.join('\n');
}
