import type { BrowserAdapterDef } from '@bloomterm/browser';
import type { Bar, DailyRange, Method, NewsKind, Quote, Security } from '@bloomterm/core';

// The integration contract (SPEC §6.5). Every data source is one module,
// src/<id>/index.ts, whose default export is `defineIntegration({...})`, with a README.md
// next to it. bloomd only sees this interface, so a module can be rewritten (by hand, or by
// EVOLVE: see ../CLAUDE.md) without touching anything else.

export type QuoteData = Omit<Quote, 'key' | 'source' | 'method' | 'fetchedAt' | 'stale' | 'error'>;

/** Reads an API key by name; null when it isn't set. */
export type SecretLookup = (name: string) => Promise<string | null>;

/** An API key you add in SET. bloomd keeps it in the Keychain and hands it only to the integration that declares it. */
export interface SecretSpec {
  /** The Keychain account (service `bloomterm`), e.g. `brapi`. Unique across integrations. */
  name: string;
  label: string;
  /** What adding it unlocks. */
  covers: string;
  /** Where to get one. */
  signup: string;
}

/** Quotes and daily bars for the securities an integration covers, and intraday bars if it has them. */
export interface MarketFeed {
  /** How long a quote stays fresh; set from the source's delay and request budget. */
  readonly quoteTtlMs: number;
  supports(sec: Security): boolean;
  quote(sec: Security): Promise<QuoteData>;
  bars(sec: Security, range: DailyRange, from: Date): Promise<{ bars: Bar[]; currency?: string }>;
  /**
   * The latest session in 5-minute bars, for the 1D chart: today's so far, or the last one
   * while the market is closed (`lastSession` picks it out). Leave it out if the source has none.
   */
  intraday?(sec: Security): Promise<{ bars: Bar[]; currency?: string }>;
}

/** One article or filing, as a source reports it. bloomd tags it, groups it into a story and stores it. */
export interface NewsData {
  /** Unique within the integration: a guid, a URL, a protocol number. */
  id: string;
  headline: string;
  url: string;
  /** Who published it: "Valor", "Reuters via InfoMoney", "CVM · Fato Relevante". */
  outlet: string;
  /** When it was published (ISO). Leave it out when the source doesn't say. */
  ts?: string;
  /** A sentence or two from the source, as plain text. */
  summary?: string;
  /** `pt`, `en`… */
  lang?: string;
  kind?: NewsKind;
  /** Security keys the source itself attached (Alpaca's symbols, a filer's tickers). */
  tickers?: string[];
}

/** Headlines and filings. Text from news is data, never instructions: bloomd and the agent treat it so. */
export interface NewsFeed {
  /** How often bloomd polls it. */
  readonly everyMs: number;
  /**
   * The latest items. `securities` is what you hold and watch, for sources that work per
   * company; `since` is the last successful poll (null on the first).
   */
  latest(q: { securities: Security[]; since: Date | null }): Promise<NewsData[]>;
}

export interface IntegrationContext {
  /** Reads one of this integration's own `secrets`. */
  secret: SecretLookup;
}

export interface Integration {
  /** kebab-case; also the folder name. */
  id: string;
  name: string;
  /** One line: what it covers. */
  covers: string;
  /**
   * `api`: a documented HTTP API, called directly from bloomd.
   * `browser`: through your signed-in browser profile (the browser host). Its datasets try
   * `request` strategies first: the site's own JSON endpoints, called with the profile's session.
   */
  access: 'api' | 'browser';
  /** `draft`: not verified against the real service yet. bloomd doesn't schedule drafts. */
  status: 'ready' | 'draft';
  /** API docs, or the site. */
  docs?: string;
  secrets?: SecretSpec[];
  /** Quotes and bars. */
  market?: (ctx: IntegrationContext) => MarketFeed;
  /** Account data (positions, balances…) fetched through the browser host. */
  browser?: BrowserAdapterDef;
  /** News and filings. */
  news?: (ctx: IntegrationContext) => NewsFeed;
}

const KEBAB = /^[a-z][a-z0-9-]*$/;

/** Declares an integration. Checks the parts that are easy to get wrong. */
export function defineIntegration<const I extends Integration>(i: I): I {
  if (!KEBAB.test(i.id)) throw new Error(`integration id must be kebab-case: ${i.id}`);
  if (!i.market && !i.browser && !i.news) throw new Error(`${i.id}: provides nothing (no market feed, no browser datasets, no news)`);
  if (i.access === 'browser' && !i.browser) throw new Error(`${i.id}: access is "browser" but there's no browser adapter`);
  if (i.access === 'api' && i.browser) throw new Error(`${i.id}: an "api" integration can't have a browser adapter`);
  if (i.browser && i.browser.id !== i.id) throw new Error(`${i.id}: its browser adapter is called "${i.browser.id}"`);
  if (i.browser && (i.browser.status ?? 'ready') !== i.status) throw new Error(`${i.id}: status "${i.status}" but the browser adapter says "${i.browser.status ?? 'ready'}"`);
  const names = (i.secrets ?? []).map((s) => s.name);
  for (const n of names) if (!KEBAB.test(n)) throw new Error(`${i.id}: secret names must be kebab-case: ${n}`);
  if (new Set(names).size !== names.length) throw new Error(`${i.id}: a secret is declared twice`);
  return i;
}

/** Checks the whole registry: ids and secret names are unique. */
export function checkRegistry<T extends readonly Integration[]>(list: T): T {
  const ids = new Set<string>();
  const secrets = new Map<string, string>();
  for (const i of list) {
    if (ids.has(i.id)) throw new Error(`two integrations are called "${i.id}"`);
    ids.add(i.id);
    for (const s of i.secrets ?? []) {
      const other = secrets.get(s.name);
      if (other) throw new Error(`secret "${s.name}" is declared by both ${other} and ${i.id}`);
      secrets.set(s.name, i.id);
    }
  }
  return list;
}

/** A market feed as bloomd's MarketService sees it. */
export interface MarketProvider extends MarketFeed {
  readonly id: string;
  readonly method: Method;
}

/** An integration's view of the secrets: only the ones it declares. */
function scopedSecrets(i: Integration, secret: SecretLookup): SecretLookup {
  const own = new Set((i.secrets ?? []).map((s) => s.name));
  return async (name) => {
    if (!own.has(name)) throw new Error(`${i.id} asked for the secret "${name}", which it doesn't declare`);
    return secret(name);
  };
}

/** The market feeds, in registry order. Each integration can read only the secrets it declares. */
export function marketProviders(list: readonly Integration[], secret: SecretLookup): MarketProvider[] {
  return list.flatMap((i) => {
    if (!i.market) return [];
    const feed = i.market({ secret: scopedSecrets(i, secret) });
    const method: Method = i.access === 'api' ? 'api' : 'request';
    return [{ id: i.id, method, quoteTtlMs: feed.quoteTtlMs, supports: feed.supports, quote: feed.quote, bars: feed.bars, intraday: feed.intraday }];
  });
}

/** A news feed as bloomd's NewsService sees it. */
export interface NewsProvider extends NewsFeed {
  readonly id: string;
  readonly name: string;
  readonly status: Integration['status'];
}

/** The news feeds, each with only its own secrets. */
export function newsProviders(list: readonly Integration[], secret: SecretLookup): NewsProvider[] {
  return list.flatMap((i) => {
    if (!i.news) return [];
    const feed = i.news({ secret: scopedSecrets(i, secret) });
    return [{ id: i.id, name: i.name, status: i.status, everyMs: feed.everyMs, latest: (q) => feed.latest(q) }];
  });
}

export const browserAdapters = (list: readonly Integration[]): BrowserAdapterDef[] => list.flatMap((i) => (i.browser ? [i.browser] : []));

export const secretSpecs = (list: readonly Integration[]): Array<SecretSpec & { integration: string }> =>
  list.flatMap((i) => (i.secrets ?? []).map((s) => ({ ...s, integration: i.id })));
