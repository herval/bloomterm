import type { Bar, BarSeries, Quote, Range } from '@bloomterm/core/web';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, connectEvents, get } from './api.ts';

export type QuoteResult = Quote | { key: string; error: string };
export const isQuote = (q: QuoteResult | undefined): q is Quote => !!q && 'last' in q;

/**
 * One polling loop for every quote on screen. bloomd caches per source (brapi for minutes,
 * crypto for seconds), so polling it every 15s costs the sources nothing extra.
 */
class QuoteFeed {
  private refs = new Map<string, number>();
  private data = new Map<string, QuoteResult>();
  private listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, QuoteResult> = new Map();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  watch(keys: string[]): () => void {
    let added = false;
    for (const k of keys) {
      this.refs.set(k, (this.refs.get(k) ?? 0) + 1);
      if (!this.data.has(k)) added = true;
    }
    if (added) this.soon();
    this.timer ??= setInterval(() => void this.poll(), 15_000);
    return () => {
      for (const k of keys) {
        const n = (this.refs.get(k) ?? 1) - 1;
        if (n <= 0) this.refs.delete(k);
        else this.refs.set(k, n);
      }
    };
  }

  private soon() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.poll(), 30);
  }

  private async poll() {
    const keys = [...this.refs.keys()];
    if (keys.length === 0) return;
    try {
      for (let i = 0; i < keys.length; i += 60) {
        const batch = keys.slice(i, i + 60);
        const out = await get<QuoteResult[]>(`/api/market/quotes?keys=${encodeURIComponent(batch.join(','))}`);
        out.forEach((q, j) => this.data.set(batch[j]!, q));
      }
    } catch (err) {
      for (const k of keys) if (!this.data.has(k)) this.data.set(k, { key: k, error: (err as Error).message });
    }
    this.snapshot = new Map(this.data);
    for (const fn of this.listeners) fn();
  }
}

const feed = new QuoteFeed();

export function useQuotes(keys: string[]): ReadonlyMap<string, QuoteResult> {
  const joined = keys.join('\n');
  useEffect(() => (joined ? feed.watch(joined.split('\n')) : undefined), [joined]);
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}

export function useBars(key: string | undefined, range: Range): { series?: BarSeries; error?: string; loading: boolean } {
  const [state, setState] = useState<{ series?: BarSeries; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!key) return;
    let live = true;
    const load = () =>
      get<BarSeries>(`/api/market/bars?key=${encodeURIComponent(key)}&range=${range}`).then(
        (series) => live && setState({ series, loading: false }),
        (err) => live && setState((s) => ({ series: s.series?.key === key && s.series.range === range ? s.series : undefined, error: (err as Error).message, loading: false })),
      );
    setState((s) => ({ ...s, loading: true, error: undefined }));
    void load();
    // Today's bars move by the minute; daily ones barely do.
    const t = setInterval(load, range === '1D' ? 60_000 : 10 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key, range]);
  return state;
}

/** What to fetch next when the chart is scrolled back past what it has: a wider range of daily bars. */
const WIDER: Partial<Record<Range, Range>> = { '5D': '1Y', '1M': '1Y', '3M': '1Y', '6M': '1Y', YTD: '1Y', '1Y': '5Y', '5Y': 'MAX' };

/**
 * A range's bars for a chart, plus older ones: `older()` fetches the next wider range (1Y, then
 * 5Y, then MAX) and puts the bars from before the first one in front, so scrolling the chart back
 * keeps showing the past. It stops once a wider range has nothing older. 1D doesn't go back.
 */
export function useChartBars(key: string | undefined, range: Range) {
  const { series, error, loading } = useBars(key, range);
  const id = series && series.range === range ? `${series.key}|${range}` : '';
  const [past, setPast] = useState<{ id: string; bars: Bar[]; next?: Range }>({ id: '', bars: [] });
  const own = past.id === id ? past : { id, bars: [], next: WIDER[range] };
  const busy = useRef(false);
  const bars = useMemo(() => (series ? (own.bars.length ? [...own.bars, ...series.bars] : series.bars) : []), [series, own.bars]);

  const older = useCallback(() => {
    const want = own.next;
    const first = bars[0]?.t;
    if (!id || !want || first === undefined || busy.current) return;
    busy.current = true;
    get<BarSeries>(`/api/market/bars?key=${encodeURIComponent(series!.key)}&range=${want}`)
      .then(
        (s) => {
          const add = s.bars.filter((b) => b.t < first);
          setPast((p) => {
            const cur = p.id === id ? p : { id, bars: [] };
            return { id, bars: [...add, ...cur.bars], next: add.length ? WIDER[want] : undefined };
          });
        },
        () => setPast((p) => ({ id, bars: p.id === id ? p.bars : [], next: undefined })),
      )
      .finally(() => (busy.current = false));
  }, [id, own.next, bars, series]);

  return { series, bars, error, loading, older: own.next ? older : undefined };
}

// ---- bloomd state: sources, jobs, status, kept fresh by the event stream ----

export interface SourceRow {
  id: string;
  name: string;
  profile: string;
  status: string;
  session: { state: string; since: string; lastOk?: string | null; lastError?: string | null; errorStreak?: number };
  datasets: Array<{ name: string; persist: string | null; freshness: string | null; next: string | null; lastOk: any }>;
}

export interface JobRow {
  id: string;
  kind: string;
  source: string;
  dataset: string | null;
  trigger: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  method: string | null;
  error: string | null;
  attempts?: any;
  rawDir?: string | null;
}

export interface DaemonState {
  connected: boolean;
  status: any | null;
  sources: SourceRow[];
  jobs: JobRow[];
  refresh(): void;
}

export const DaemonContext = createContext<DaemonState>({ connected: false, status: null, sources: [], jobs: [], refresh: () => {} });
export const useDaemon = () => useContext(DaemonContext);

// Every event from bloomd, for views that follow something live (ASK answers).
const eventListeners = new Set<(ev: any) => void>();
export function useDaemonEvents(fn: (ev: any) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (ev: any) => ref.current(ev);
    eventListeners.add(l);
    return () => void eventListeners.delete(l);
  }, []);
}

export function useDaemonState(): DaemonState {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<any | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    void get('/api/status').then(setStatus, () => {});
    void get<SourceRow[]>('/api/sources').then(setSources, () => {});
    void get<JobRow[]>('/api/jobs?limit=200').then(setJobs, () => {});
  }, []);

  useEffect(() => {
    refresh();
    const every = setInterval(refresh, 30_000);
    const off = connectEvents(
      (ev) => {
        for (const l of eventListeners) l(ev);
        // ASK streams many events; only refetch for the ones that change bloomd's state.
        if (ev.type === 'chat_event') return;
        if (ev.type === 'job_update') setJobs((js) => [ev.job, ...js.filter((j) => j.id !== ev.job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        // Coalesce bursts of events into one refetch.
        clearTimeout(timer.current);
        timer.current = setTimeout(refresh, 250);
      },
      (up) => {
        setConnected(up);
        if (up) refresh();
      },
    );
    return () => {
      off();
      clearInterval(every);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  return { connected, status, sources, jobs, refresh };
}

/**
 * A small JSON document bloomd keeps for the UI (layout, watchlists). One copy per key in
 * memory, shared by every view that uses it, so a change shows everywhere at once and a
 * view that remounts doesn't read back an older version before the save lands.
 */
class UiDoc {
  value: unknown;
  loaded = false;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | null = null;
  private dirty = false;

  constructor(readonly key: string) {}

  load(): void {
    this.loading ??= get<{ value: unknown }>(`/api/ui/state/${this.key}`)
      .then(
        (r) => {
          if (!this.dirty && r.value !== null && r.value !== undefined) this.value = r.value;
        },
        () => {},
      )
      .then(() => {
        this.loaded = true;
        this.emit();
      });
  }

  set(value: unknown): void {
    this.value = value;
    this.dirty = true;
    this.emit();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void api('PUT', `/api/ui/state/${this.key}`, { value }).catch(() => {}), 400);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private version = 0;
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

const docs = new Map<string, UiDoc>();

export function useUiState<T>(key: string, fallback: T): [T, (next: T) => void, boolean] {
  let doc = docs.get(key);
  if (!doc) docs.set(key, (doc = new UiDoc(key)));
  const d = doc;
  useEffect(() => d.load(), [d]);
  useSyncExternalStore(d.subscribe, d.getVersion);
  const set = useCallback((next: T) => d.set(next), [d]);
  return [(d.value as T | undefined) ?? fallback, set, d.loaded];
}
