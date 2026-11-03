import { parseSecurity } from '@bloomterm/core/web';
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// Pages have URLs (/s/PETR4, /news?story=…), so Back works and a page can be bookmarked or
// opened in a new tab. History API only; bloomd serves the app for any of these paths.

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
window.addEventListener('popstate', notify);

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => location.pathname + location.search;

export interface Route {
  path: string;
  /** Path segments, decoded: `/s/PETR4` → ['s', 'PETR4']. */
  parts: string[];
  query: URLSearchParams;
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { path: url.pathname, parts: url.pathname.split('/').filter(Boolean).map(decodeURIComponent), query: url.searchParams };
}

export function navigate(to: string, o: { replace?: boolean } = {}): void {
  if (to === snapshot()) return;
  if (o.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
  if (!o.replace) document.querySelector('.page')?.scrollTo(0, 0);
}

/** Changes query parameters on the current page (filters, the selected story), without a history step. */
export function setQuery(changes: Record<string, string | null | undefined>): void {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  navigate(url.pathname + url.search, { replace: true });
}

/** A security's page: `/s/PETR4` when the ticker alone resolves to it, the full key otherwise. */
export function secPath(key: string, query?: Record<string, string>): string {
  const ticker = key.split(' ')[0]!;
  const short = parseSecurity(ticker)?.key === key ? ticker : key;
  const q = query ? `?${new URLSearchParams(query)}` : '';
  return `/s/${encodeURIComponent(short)}${q}`;
}

/** An in-app link: a plain <a> (middle-click and ⌘-click open a tab), routed without a reload. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={click} {...rest} />;
}
