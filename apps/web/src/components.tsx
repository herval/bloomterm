import type { Bar } from '@bloomterm/core/web';
import { AreaSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineSeries, LineStyle, type IChartApi, type LogicalRange, type SeriesMarker, type Time } from 'lightweight-charts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { age } from './format.ts';
import { alpha, token, useTheme } from './theme.ts';

/** A value that flashes green or red for 300ms when it changes (SPEC §4.4). */
export function Tick({ value, children, title, className = '' }: { value: number | undefined; children: ReactNode; title?: string; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (prev.current !== undefined && value !== undefined && value !== prev.current) {
      setFlash(value > prev.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setFlash(''), 300);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return (
    <span className={`${className} ${flash}`} title={title}>
      {children}
    </span>
  );
}

/** Re-renders every `ms` so ages and clocks move. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function AgeChip({ iso, stale }: { iso: string | null | undefined; stale?: boolean }) {
  const now = useNow(10_000);
  return <span className={`chip ${stale ? 'chip-stale' : ''}`}>{age(iso, now)}</span>;
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** The chart's colors, from the theme's tokens in styles.css. */
function chartColors() {
  return {
    up: token('--up'),
    down: token('--down'),
    line: token('--text'),
    grid: token('--line-2'),
    border: token('--line'),
    text: token('--muted'),
    cross: token('--line-strong'),
    crossLabel: token('--text-2'),
    sma50: token('--link'),
    sma200: token('--violet'),
    news: token('--link'),
    filing: token('--violet'),
  };
}

/** A news item or filing pinned to its bar on the chart. */
export interface ChartMarker {
  id: string;
  /** Unix seconds; snapped to its day (intraday, to its 5-minute bar). */
  t: number;
  kind: 'news' | 'filing';
  label: string;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10) as Time;
// lightweight-charts shows timestamps in UTC; shifted by the local offset, they read as local time.
const local = (t: number) => {
  const d = new Date(t * 1000);
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 1000) as Time;
};
const INTRADAY_BAR = 300;

function sma(bars: Bar[], n: number, time: (t: number) => Time) {
  const out: { time: Time; value: number }[] = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.c;
    if (i >= n) sum -= bars[i - n]!.c;
    if (i >= n - 1) out.push({ time: time(b.t), value: sum / n });
  });
  return out;
}

/**
 * Price chart. `candles` with volume and SMAs for GP; `area` for the small chart in OV.
 * Series where open = high = low = close (a daily fixing) draw as a line. `intraday` bars
 * (5-minute) show local times and no SMAs.
 *
 * It keeps to the data: no scrolling past the first or last bar into empty space. Scrolled,
 * dragged or zoomed out to the first bar, it calls `onOlder`; bars that then arrive in front
 * keep the same ones in view. It refits when `viewKey` changes (another security or range).
 */
export function PriceChart({
  bars,
  mode,
  smas = [],
  markers = [],
  onMarker,
  intraday = false,
  onOlder,
  viewKey = '',
}: {
  bars: Bar[];
  mode: 'candles' | 'area' | 'line';
  smas?: number[];
  markers?: ChartMarker[];
  onMarker?: (id: string) => void;
  intraday?: boolean;
  onOlder?: () => void;
  viewKey?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const markerClick = useRef(onMarker);
  markerClick.current = onMarker;
  const older = useRef(onOlder);
  older.current = onOlder;
  // Where the view was when the data was last swapped out, to put it back.
  const view = useRef<{ key: string; first: number; count: number; range: LogicalRange } | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const c = createChart(node, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: "'Geist Mono Variable', ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false },
      // Keep the same dates in view when the panel is resized, instead of the same bar width,
      // and stop at the first and last bars.
      timeScale: { lockVisibleTimeRangeOnResize: true, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: CrosshairMode.Normal },
    });
    c.subscribeClick((p) => {
      const id = p.hoveredObjectId;
      if (typeof id === 'string' && id) markerClick.current?.(id);
    });
    // Only what you do asks for older bars, not the chart fitting itself to new data.
    const check = () =>
      requestAnimationFrame(() => {
        const r = chart.current?.timeScale().getVisibleLogicalRange();
        if (r && r.from < 3) older.current?.();
      });
    const drag = (e: PointerEvent) => e.buttons && check();
    node.addEventListener('wheel', check, { passive: true });
    node.addEventListener('pointermove', drag);
    chart.current = c;
    return () => {
      node.removeEventListener('wheel', check);
      node.removeEventListener('pointermove', drag);
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const COLORS = chartColors();
    const cross = { color: COLORS.cross, labelBackgroundColor: COLORS.crossLabel };
    c.applyOptions({
      layout: { textColor: COLORS.text },
      grid: { horzLines: { color: COLORS.grid } },
      timeScale: { borderColor: COLORS.border, timeVisible: intraday, secondsVisible: false },
      crosshair: { vertLine: cross, horzLine: cross },
    });
    const time = intraday ? local : day;
    const series: ReturnType<IChartApi['addSeries']>[] = [];
    const flat = bars.every((b) => b.o === b.c && b.h === b.l);
    const rising = bars.length > 1 && bars.at(-1)!.c >= bars[0]!.c;
    let main: ReturnType<IChartApi['addSeries']>;
    if (mode !== 'candles' || flat) {
      const color = mode === 'area' ? (rising ? COLORS.up : COLORS.down) : COLORS.line;
      const s =
        mode === 'area'
          ? c.addSeries(AreaSeries, { lineColor: color, topColor: alpha(color, 0.16), bottomColor: alpha(color, 0), lineWidth: 2, priceLineVisible: false })
          : c.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false });
      s.setData(bars.map((b) => ({ time: time(b.t), value: b.c })));
      series.push(s);
      main = s;
    } else {
      const s = c.addSeries(CandlestickSeries, {
        upColor: COLORS.up,
        downColor: COLORS.down,
        borderUpColor: COLORS.up,
        borderDownColor: COLORS.down,
        wickUpColor: COLORS.up,
        wickDownColor: COLORS.down,
      });
      s.setData(bars.map((b) => ({ time: time(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
      series.push(s);
      main = s;
    }
    if (markers.length && bars.length) {
      // One marker per bar and kind: on the bar for that day (or the next one, over a weekend),
      // or intraday, on the 5-minute bar it falls in.
      const days = bars.map((b) => day(b.t) as string);
      const at = (t: number) => {
        if (!intraday) return days.findIndex((x) => x >= (day(t) as string));
        if (t < bars[0]!.t || t >= bars.at(-1)!.t + INTRADAY_BAR) return -1;
        return bars.findLastIndex((b) => b.t <= t);
      };
      const seen = new Map<string, { i: number; m: SeriesMarker<Time> }>();
      for (const m of [...markers].sort((a, b) => a.t - b.t)) {
        const i = at(m.t);
        if (i < 0) continue;
        const k = `${i}|${m.kind}`;
        if (seen.has(k)) continue;
        seen.set(k, { i, m: { time: time(bars[i]!.t), position: m.kind === 'filing' ? 'belowBar' : 'aboveBar', shape: m.kind === 'filing' ? 'square' : 'circle', color: m.kind === 'filing' ? COLORS.filing : COLORS.news, size: 0.7, id: m.id } });
      }
      createSeriesMarkers(main, [...seen.values()].sort((a, b) => a.i - b.i).map((x) => x.m));
    }
    if (mode === 'candles' && bars.some((b) => b.v)) {
      const v = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(bars.map((b) => ({ time: time(b.t), value: b.v ?? 0, color: alpha(b.c >= b.o ? COLORS.up : COLORS.down, 0.28) })));
      series.push(v);
    }
    for (const n of intraday ? [] : smas) {
      if (bars.length < n) continue;
      const s = c.addSeries(LineSeries, {
        color: n >= 200 ? COLORS.sma200 : COLORS.sma50,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(sma(bars, n, time));
      series.push(s);
    }
    // Same security and range: keep the same bars in view, moved over by any bars put in front
    // (older ones) and, if you were at the end, by any new ones after it. Otherwise fit it all.
    const ts = c.timeScale();
    const v = view.current;
    const shift = v && v.key === viewKey ? bars.findIndex((b) => b.t === v.first) : -1;
    if (v && shift >= 0) {
      const atEnd = v.range.to >= v.count - 1.5;
      const added = atEnd ? Math.max(0, bars.length - shift - v.count) : 0;
      ts.setVisibleLogicalRange({ from: v.range.from + shift + added, to: v.range.to + shift + added });
    } else {
      ts.fitContent();
    }
    return () => {
      // The chart may be gone already (unmount runs its cleanup first).
      if (chart.current !== c) return;
      const r = ts.getVisibleLogicalRange();
      view.current = r && bars.length ? { key: viewKey, first: bars[0]!.t, count: bars.length, range: r } : null;
      for (const s of series) c.removeSeries(s);
    };
  }, [bars, mode, smas.join(','), markers.map((m) => m.id).join(','), theme, intraday, viewKey]);

  return <div className="chart" ref={el} />;
}
