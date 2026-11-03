import type { Locator, Page } from 'playwright-core';
import type { ZodType } from 'zod';
import type { RawCapture } from './capture.ts';
import type { GuardedRequest } from './guard.ts';

export type SessionState = 'unknown' | 'ok' | 'needs_login' | 'challenge' | 'blocked';

export type ProfileMode = 'parked' | 'headless';

export interface ProfileConfig {
  name: string;
  /** `parked`: a real window kept off-screen, brought forward when you're needed (SPEC §6.2). */
  mode: ProfileMode;
  /** A Playwright browser channel, instead of the Google Chrome chrome.ts finds. */
  channel?: string;
  /** The browser to launch, instead of the Google Chrome chrome.ts finds. */
  executablePath?: string;
  /** Max concurrent job tabs in this profile. */
  maxTabs?: number;
  /** Service workers can send requests the mutation guard can't see, so they're blocked by default. */
  serviceWorkers?: 'block' | 'allow';
  /**
   * Keep session cookies across Chrome restarts by setting the profile's startup
   * preference to "continue where you left off". Many banks only set session cookies.
   */
  keepSessionCookies?: boolean;
  /**
   * Encrypt cookies and saved passwords with the real macOS Keychain (default) rather
   * than Playwright's mock keychain, whose key is a public constant.
   */
  useSystemKeychain?: boolean;
  locale?: string;
  timezoneId?: string;
  /**
   * Attach to a Chrome that's already running (its DevTools URL) instead of launching one.
   * The profile becomes a context in that Chrome; closing it closes only the context and
   * keeps its cookies in the profile dir. Always headless. Tests use this to share one Chrome.
   */
  cdpUrl?: string;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface DownloadedFile {
  path: string;
  filename: string;
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  html: string;
  screenshot: Buffer;
}

export interface CaptureOptions {
  /** How many matching JSON responses to wait for after the action. Default 1. */
  min?: number;
  timeoutMs?: number;
}

/** What a strategy gets. `page` and `request` are wrapped by the mutation guard and credential firewall. */
export interface StrategyContext {
  page: Page;
  request: GuardedRequest;
  /** GET (or guarded write) with the profile's cookies; saves the body to raw; 401 → NeedsLoginError. */
  fetchJson<T = unknown>(url: string, init?: { method?: string; data?: unknown; headers?: Record<string, string> }): Promise<T>;
  /** Collects JSON responses whose URL matches `pattern` while `action` runs. */
  capture(pattern: RegExp, action: () => Promise<unknown>, options?: CaptureOptions): Promise<unknown[]>;
  /** Clicks `trigger` (or runs it) and saves the resulting download to raw. */
  download(trigger: Locator | (() => Promise<unknown>), options?: { timeoutMs?: number }): Promise<DownloadedFile>;
  snapshot(): Promise<Snapshot>;
  raw: RawCapture;
  log: Logger;
}

export type StrategyKind = 'request' | 'download' | 'intercept' | 'dom' | 'llm';

export type Strategy<T> =
  | { kind: Exclude<StrategyKind, 'llm'>; run: (ctx: StrategyContext) => Promise<T> }
  | {
      kind: 'llm';
      /** What to extract, in words. The dataset schema is sent along. */
      prompt: string;
      /** Gets the page to where the data is before the snapshot. */
      prepare?: (ctx: StrategyContext) => Promise<void>;
    };

/** Returns true when fine, or a message saying what's wrong. */
export type Check<T> = (data: T) => true | string;

export interface DatasetDef<T = unknown> {
  schema: ZodType<T>;
  strategies: Strategy<T>[];
  checks?: Check<T>[];
  /** e.g. '8h'. How old the data may get before it's shown as stale. */
  freshness?: string;
  /** When bloomd fetches it on its own. Cron in `tz` (default: the machine's zone). */
  schedule?: { cron: string; tz?: string };
  /** Which bloomd table the output goes to. Omit to keep it only as the job's result. */
  persist?: 'positions' | 'balances' | 'accounts';
}

export interface CheckContext {
  /** Shares the profile's cookies. Prefer it: it doesn't touch any tab you might be typing in. */
  request: GuardedRequest;
  /** A background tab, for sites whose sign-in state only shows in a rendered page. Not available while you're signing in. */
  openPage?: () => Promise<Page>;
  interactive: boolean;
}

export interface LoginDef {
  url: string;
  /** During LOGIN, reaching a URL like this counts as signed in (then confirmed with `check`). */
  successUrl?: RegExp;
  /** Cheap "are we signed in?" probe. */
  check: (ctx: CheckContext) => Promise<boolean>;
  /** How often bloomd probes a signed-in source to catch an expired session. Default 60 min. */
  probeEveryMinutes?: number;
}

export interface WriteRule {
  url: RegExp;
  /** Allow GraphQL POSTs at `url`, but only `query` operations. */
  graphql?: 'queries-only';
  /** Persisted (hash-only) GraphQL operations that are known to be reads. */
  persistedOperations?: string[];
}

export type AllowWrite = RegExp | WriteRule;

export interface BrowserAdapterDef {
  id: string;
  name: string;
  profile: string;
  /** Every origin the institution uses. Non-GET requests to these are blocked unless allowed. */
  origins: string[];
  /** `draft` adapters haven't been verified against the real site yet. */
  status?: 'draft' | 'ready';
  login: LoginDef;
  allowWrites?: AllowWrite[];
  /** WebSocket URLs on `origins` the site needs. Others are refused. */
  allowWebSockets?: RegExp[];
  /** Exceptions to the click deny-list, matched against the element's name. */
  allowClickNames?: RegExp;
  /** Politeness (SPEC §6.9). */
  minIntervalMs?: number;
  maxJobsPerHour?: number;
  datasets: Record<string, DatasetDef<any>>;
}

export interface LlmExtractor {
  extract(input: { prompt: string; jsonSchema: unknown; snapshot: Snapshot }): Promise<unknown>;
}

export interface JobResult<T = unknown> {
  jobId: string;
  source: string;
  dataset: string;
  data: T;
  method: StrategyKind;
  confidence: 'high' | 'llm';
  fetchedAt: string;
  durationMs: number;
  rawDir: string;
  attempts: { kind: string; ok: boolean; error?: string; durationMs: number }[];
}
