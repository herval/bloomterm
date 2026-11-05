import type { NewsItem, NewsStory } from '@bloomterm/core/web';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { get } from './api.ts';
import { useDaemonEvents } from './feeds.ts';

// Data the pages read from bloomd: news, the brief, why things moved, positions, and
// sparklines. Each reloads when bloomd says something changed.

export interface Insight {
  kind: 'brief' | 'why';
  key: string;
  status: 'running' | 'done' | 'error';
  text: string;
  data: Record<string, any>;
  error: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GETs `path` (null: nothing yet), again when `refreshOn` matches an event, and every `everyMs`. */
export function useApi<T>(path: string | null, o: { refreshOn?: (ev: any) => boolean; everyMs?: number } = {}) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; path?: string }>({ loading: !!path });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(() => {
    if (!path) return;
    void get<T>(path).then(
      (data) => setState({ data, loading: false, path }),
      (err) => setState((s) => ({ data: s.path === path ? s.data : undefined, error: (err as Error).message, loading: false, path })),
    );
  }, [path]);
  useEffect(() => {
    setState((s) => (s.path === path ? s : { loading: !!path }));
    reload();
    if (!o.everyMs) return;
    const t = setInterval(reload, o.everyMs);
    return () => clearInterval(t);
  }, [reload, o.everyMs]);
  useDaemonEvents((ev) => {
    if (!o.refreshOn?.(ev)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 300);
  });
  return { ...state, data: state.path === path ? state.data : undefined, reload };
}

const onNews = (ev: any) => ev.type === 'news';

export function useStories(q: Record<string, string | undefined>) {
  return useApi<NewsStory[]>(`/api/news/stories?${params(q)}`, { refreshOn: onNews, everyMs: 5 * 60_000 });
}

export function useNews(q: Record<string, string | undefined>, enabled = true) {
  return useApi<NewsItem[]>(enabled ? `/api/news?${params(q)}` : null, { refreshOn: onNews, everyMs: 5 * 60_000 });
}

export function useBrief() {
  return useApi<{ brief: Insight | null; agent: { kind: string; version: string } | null }>('/api/brief', { refreshOn: (ev) => ev.type === 'insight' && ev.insight.kind === 'brief' });
}

export function useWhy(keys: string[]) {
  const joined = [...new Set(keys)].join(',');
  return useApi<Record<string, Insight | null>>(joined ? `/api/why?keys=${encodeURIComponent(joined)}` : null, { refreshOn: (ev) => ev.type === 'insight' && ev.insight.kind === 'why' });
}

export interface Position {
  source: string;
  accountExternalId: string;
  rawSymbol: string;
  name?: string;
  quantity: number;
  price?: number;
  value: number;
  currency: string;
  costBasis?: number;
  fetchedAt: string;
  method: string;
}
export interface Balance {
  source: string;
  accountExternalId: string;
  cash?: number;
  total: number;
  currency: string;
  fetchedAt: string;
}

const onJob = (ev: any) => ev.type === 'job_update' && ev.job.status === 'ok';

export function useHoldings() {
  const positions = useApi<Position[]>('/api/positions', { refreshOn: onJob });
  const balances = useApi<Balance[]>('/api/balances', { refreshOn: onJob });
  return { positions: positions.data ?? [], balances: balances.data ?? [], loading: positions.loading || balances.loading };
}

const params = (q: Record<string, string | undefined>) => new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString();

// ---- sparklines: one month of closes per security, shared and cached for ten minutes ----

class Sparks {
  private data = new Map<string, { closes: number[]; at: number }>();
  private inflight = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  get = (key: string) => this.data.get(key)?.closes;

  want(keys: string[]) {
    for (const k of keys) {
      const have = this.data.get(k);
      if ((have && Date.now() - have.at < 10 * 60_000) || this.inflight.has(k)) continue;
      this.inflight.add(k);
      this.queue.push(k);
    }
    this.pump();
  }

  private pump() {
    while (this.active < 4 && this.queue.length) {
      const key = this.queue.shift()!;
      this.active++;
      void get<{ bars: { c: number }[] }>(`/api/market/bars?key=${encodeURIComponent(key)}&range=1M`)
        .then(
          (s) => this.data.set(key, { closes: s.bars.map((b) => b.c), at: Date.now() }),
          () => this.data.set(key, { closes: [], at: Date.now() }),
        )
        .finally(() => {
          this.inflight.delete(key);
          this.active--;
          this.version++;
          this.listeners.forEach((fn) => fn());
          this.pump();
        });
    }
  }
}

const sparks = new Sparks();

export function useSparks(keys: string[]): (key: string) => number[] | undefined {
  const joined = keys.join('\n');
  useEffect(() => {
    if (joined) sparks.want(joined.split('\n'));
  }, [joined]);
  useSyncExternalStore(sparks.subscribe, sparks.getVersion);
  return sparks.get;
}

/** GET /api/setup (apps/daemon/src/setup.ts): what bloomterm needs on this computer. */
export interface SetupState {
  checkedAt: string;
  ready: boolean;
  agent: {
    wanted: 'auto' | 'claude' | 'codex';
    installed: { kind: 'claude' | 'codex'; version: string }[];
    found: { kind: 'claude' | 'codex'; version: string; path: string } | null;
    signedIn: boolean | null;
    signIn: string | null;
    install: Record<'claude' | 'codex', string>;
    inUse: { kind: 'claude' | 'codex'; version: string } | null;
    restartNeeded: boolean;
  };
  chrome: { path: string | null; configured: string | null };
}

// One copy for the whole app, so the top bar's "Finish setup" goes as soon as the Setup page's
// check says it's done.
let setupState: SetupState | undefined;
const setupListeners = new Set<() => void>();
const setSetup = (s: SetupState) => {
  setupState = s;
  setupListeners.forEach((fn) => fn());
};

/** Reads setup again, or takes the state a check just returned. */
export function reloadSetup(fresh?: SetupState): void {
  if (fresh) return setSetup(fresh);
  void get<SetupState>('/api/setup').then(setSetup, () => {});
}

export function useSetup(): SetupState | undefined {
  const subscribe = useCallback((fn: () => void) => {
    setupListeners.add(fn);
    if (!setupState && setupListeners.size === 1) reloadSetup();
    return () => void setupListeners.delete(fn);
  }, []);
  return useSyncExternalStore(subscribe, () => setupState);
}
