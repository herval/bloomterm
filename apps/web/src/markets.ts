import type { Quote, Security } from '@bloomterm/core/web';

// World clocks and session state for the status bar (SPEC §4.1). Regular hours only:
// there's no holiday calendar yet, so a holiday shows as "open".

export const CLOCKS = [
  { label: 'NY', tz: 'America/New_York' },
  { label: 'SP', tz: 'America/Sao_Paulo' },
  { label: 'LDN', tz: 'Europe/London' },
  { label: 'TKY', tz: 'Asia/Tokyo' },
] as const;

function partsIn(tz: string, d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { weekday: p.weekday as string, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function clockTime(tz: string, d = new Date()): string {
  return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/** Is New York on daylight time? B3 moves its close with it. */
function usDst(d: Date): boolean {
  const jan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const off = (x: Date) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(x);
    return p.find((q) => q.type === 'timeZoneName')?.value ?? '';
  };
  return off(d) !== off(jan);
}

export interface Session {
  label: string;
  open: boolean;
  /** Minutes until it closes (open) or next opens (closed). */
  minutes: number;
}

function session(label: string, tz: string, openMin: number, closeMin: number, d: Date): Session {
  const { weekday, minutes } = partsIn(tz, d);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = days.indexOf(weekday);
  const weekday_ = dow >= 1 && dow <= 5;
  if (weekday_ && minutes >= openMin && minutes < closeMin) return { label, open: true, minutes: closeMin - minutes };
  // Minutes to the next weekday open.
  let wait = weekday_ && minutes < openMin ? openMin - minutes : 24 * 60 - minutes + openMin;
  let next = weekday_ && minutes < openMin ? dow : (dow + 1) % 7;
  while (next === 0 || next === 6) {
    wait += 24 * 60;
    next = (next + 1) % 7;
  }
  return { label, open: false, minutes: wait };
}

export function sessions(d = new Date()): Session[] {
  return [
    session('US', 'America/New_York', 9 * 60 + 30, 16 * 60, d),
    // B3 equities: 10:00–17:00 while the US is on daylight time, 10:00–18:00 otherwise.
    session('B3', 'America/Sao_Paulo', 10 * 60, (usDst(d) ? 17 : 18) * 60, d),
  ];
}

export function marketOpen(sec: Security, d = new Date()): boolean {
  if (sec.sector === 'Crypto') return true;
  const [us, b3] = sessions(d);
  return sec.market === 'BZ' || sec.ticker === 'IBOV' ? b3!.open : us!.open;
}

export const duration = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`);

/**
 * Should a quote be dimmed with an age chip? A daily fixing (PTAX) is current for a day or
 * more; crypto trades all the time; equities only age while their market is open.
 */
export function isOld(q: Pick<Quote, 'asOf' | 'delayMinutes' | 'changeBasis' | 'stale'>, sec: Security | null, now = Date.now()): boolean {
  if (q.stale) return true;
  const ageMin = (now - Date.parse(q.asOf)) / 60_000;
  if (q.changeBasis === 'prev_fixing') return ageMin > 72 * 60;
  if (sec?.sector === 'Crypto') return ageMin > 10;
  return !!sec && marketOpen(sec, new Date(now)) && ageMin > (q.delayMinutes ?? 0) + 20;
}
