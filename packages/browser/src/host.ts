import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { bloomtermHome, homePaths } from '@bloomterm/core';
import { RawCapture } from './capture.ts';
import { findChrome } from './chrome.ts';
import { makeStrategyContext } from './context.ts';
import { BlockedError, ChallengeError, ChromeNotFoundError, NeedsLoginError } from './errors.ts';
import { firewallPage } from './firewall.ts';
import { guardRequest, installGuard, type GuardPolicy, type GuardedRequest, type Violation } from './guard.ts';
import { bannerScript, waitForSignIn, type InteractiveOutcome } from './login.ts';
import { consoleLogger } from './log.ts';
import { SiteGate } from './queue.ts';
import { prepareProfileDir, ProfileRuntime } from './runtime.ts';
import { SessionStore, type SessionEvent, type SessionRecord, type SessionStoreLike } from './session.ts';
import { runStrategies } from './strategies.ts';
import type { BrowserAdapterDef, JobResult, LlmExtractor, Logger, ProfileConfig } from './types.ts';


export const DEFAULT_PROFILES: Record<string, ProfileConfig> = {
  finance: { name: 'finance', mode: 'parked' },
  web: { name: 'web', mode: 'parked' },
};

export interface HostOptions {
  home?: string;
  profiles?: Record<string, Partial<ProfileConfig>>;
  llm?: LlmExtractor;
  log?: Logger;
  /** How long a sign-in or challenge window waits for you. */
  interactiveTimeoutMs?: number;
  /** Tests only: run sign-in in a headless browser instead of relaunching headed. */
  interactiveHeadless?: boolean;
  /** Where session state lives. Defaults to `state/sessions.json`; bloomd passes its SQLite store. */
  sessions?: SessionStoreLike;
  /** [browser] chrome from config.toml: the Chrome to use. Otherwise chrome.ts finds it. */
  chrome?: string;
}

export type HostEvent =
  | { type: 'session'; record: SessionRecord }
  | { type: 'attention'; source: string; reason: 'needs_login' | 'challenge' | 'blocked' | 'sign_in_open'; message: string }
  | { type: 'job'; source: string; dataset: string; ok: boolean; jobId: string; method?: string; error?: string; durationMs: number };

export interface RunOptions {
  /** Run even if the session is marked needs_login/blocked. */
  force?: boolean;
  /** Bring the window forward on a challenge and wait for you (parked profiles). Default true. */
  interactiveChallenges?: boolean;
  /** Names the raw capture dir; bloomd passes its job id so the two line up. */
  jobId?: string;
}

type JobOptions = RunOptions & {
  /** EVOLVE try runs: session state and job events are left alone. */
  trial?: boolean;
};

/**
 * The browser layer's entry point (SPEC §6): one Chrome per profile, adapters,
 * sessions, jobs. bloomd owns the one instance; nothing else should open the same profiles.
 */
export class BrowserHost extends EventEmitter {
  readonly home: string;
  private readonly paths: ReturnType<typeof homePaths>;
  private readonly profiles: Record<string, ProfileConfig>;
  private readonly runtimes = new Map<string, ProfileRuntime>();
  private readonly adapters = new Map<string, BrowserAdapterDef>();
  private readonly gates = new Map<string, SiteGate>();
  readonly sessions: SessionStoreLike;
  private readonly log: Logger;

  constructor(private readonly opts: HostOptions = {}) {
    super();
    this.home = opts.home ?? bloomtermHome();
    this.paths = homePaths(this.home);
    this.log = opts.log ?? consoleLogger();
    this.profiles = { ...DEFAULT_PROFILES };
    for (const [name, cfg] of Object.entries(opts.profiles ?? {})) {
      this.profiles[name] = { ...(this.profiles[name] ?? { mode: 'parked' }), ...cfg, name };
    }
    this.sessions = opts.sessions ?? new SessionStore(join(this.paths.state, 'sessions.json'));
  }

  register(...adapters: BrowserAdapterDef[]): this {
    for (const a of adapters) {
      if (!this.profiles[a.profile]) throw new Error(`${a.id}: unknown profile "${a.profile}"`);
      this.adapters.set(a.id, a);
    }
    return this;
  }

  list(): BrowserAdapterDef[] {
    return [...this.adapters.values()];
  }

  profileNames(): string[] {
    return Object.keys(this.profiles);
  }

  adapter(id: string): BrowserAdapterDef {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`unknown source "${id}". Known: ${[...this.adapters.keys()].join(', ') || '(none)'}`);
    return a;
  }

  runtime(profile: string): ProfileRuntime {
    let rt = this.runtimes.get(profile);
    if (!rt) {
      const cfg = this.profiles[profile];
      if (!cfg) throw new Error(`unknown profile "${profile}"`);
      rt = new ProfileRuntime(cfg, this.paths.profile(profile), this.log, () => this.chromeExecutable());
      this.runtimes.set(profile, rt);
    }
    return rt;
  }

  /**
   * The Chrome to launch, looked up at each launch, so Chrome installed while bloomd runs is
   * found. Throws ChromeNotFoundError when there's none.
   */
  async chromeExecutable(): Promise<string> {
    const found = await findChrome({ configured: this.opts.chrome });
    if (!found) throw new ChromeNotFoundError(this.opts.chrome);
    return found.executable;
  }

  /** Is the source signed in? Uses the adapter's cheap check. */
  async probe(id: string): Promise<SessionRecord> {
    const adapter = this.adapter(id);
    const rt = this.runtime(adapter.profile);
    await rt.gate.wait();
    const release = await rt.slots.acquire();
    const opened: Page[] = [];
    try {
      const context = await rt.ensure();
      const violations: Violation[] = [];
      const request = guardRequest(context.request, policyOf(adapter), (v) => violations.push(v));
      const ok = await adapter.login.check({
        request,
        interactive: false,
        openPage: async () => {
          const page = await rt.newJobPage();
          opened.push(page);
          await installGuard(page, policyOf(adapter), (v) => violations.push(v));
          return firewallPage(page, { request, allowClickNames: adapter.allowClickNames });
        },
      });
      return await this.apply(id, ok ? { type: 'probe_ok' } : { type: 'probe_logged_out' });
    } finally {
      for (const p of opened) await p.close().catch(() => {});
      release();
    }
  }

  /** Opens the sign-in window and waits for you (SPEC §6.4). */
  async login(id: string, opts: { timeoutMs?: number } = {}): Promise<SessionRecord> {
    const adapter = this.adapter(id);
    const rt = this.runtime(adapter.profile);
    const resume = rt.gate.pause();
    const headlessProfile = rt.config.mode === 'headless';
    let page: Page | undefined;
    try {
      // A headless profile relaunches headed for the sign-in, then goes back to headless.
      const context = await rt.ensure(headlessProfile && !this.opts.interactiveHeadless ? { headed: true, visible: true } : {});
      page = await context.newPage();
      let confirm!: () => void;
      const confirmed = new Promise<void>((r) => (confirm = r));
      await page.exposeBinding('__bloomtermDone', () => confirm());
      await page.addInitScript({ content: bannerScript(`bloomterm: sign in to ${adapter.name}. This window parks itself when you're in.`) });
      await page.goto(adapter.login.url).catch((err) => this.log.warn('login page did not load cleanly', { source: id, error: String(err) }));
      await rt.show(page);
      this.emitEvent({ type: 'attention', source: id, reason: 'sign_in_open', message: `Sign in to ${adapter.name} in the Chrome window` });

      const request = guardRequest(context.request, policyOf(adapter), () => {});
      const signedIn = async () => (adapter.login.successUrl?.test(page!.url()) ?? false) || (await adapter.login.check({ request, interactive: true }));
      const outcome = await waitForSignIn(page, signedIn, {
        timeoutMs: opts.timeoutMs ?? this.opts.interactiveTimeoutMs ?? 10 * 60_000,
        slowPollMs: 15_000,
        confirmed,
      });
      if (outcome === 'confirmed') this.log.warn("you confirmed the sign-in but the adapter's check disagrees; the check may need fixing", { source: id });
      return await this.apply(id, outcome === 'ok' || outcome === 'confirmed' ? { type: 'login_ok' } : { type: 'login_failed' });
    } finally {
      await page?.close().catch(() => {});
      const anchor = rt.anchor();
      if (anchor) await rt.hide(anchor).catch(() => {});
      if (headlessProfile && !this.opts.interactiveHeadless) await rt.close();
      resume();
    }
  }

  /** Runs one dataset of one source: probe, then strategies in order (SPEC §6.5–6.6). */
  async run<T = unknown>(id: string, dataset: string, opts: RunOptions = {}): Promise<JobResult<T>> {
    const adapter = this.adapter(id);
    const ds = adapter.datasets[dataset];
    if (!ds) throw new Error(`${id} has no dataset "${dataset}". Known: ${Object.keys(adapter.datasets).join(', ')}`);

    const rec = await this.sessions.get(id);
    if (!opts.force && rec.state === 'blocked') throw new BlockedError(`${id} is blocked (${rec.lastError ?? 'bot wall'}). Clear it in the browser, then: bt probe ${id}`);
    if (!opts.force && rec.state === 'needs_login') throw new NeedsLoginError(`${id} needs a sign-in: bt login ${id}`);

    return this.gate(adapter).run(async () => {
      const rt = this.runtime(adapter.profile);
      await rt.gate.wait();
      const release = await rt.slots.acquire();
      try {
        return await this.runJob<T>(adapter, dataset, rt, opts);
      } finally {
        release();
      }
    });
  }

  /**
   * EVOLVE (SPEC §6.11): runs one dataset of a candidate adapter that isn't registered, with
   * the mutation guard on. Same rate limits as the real source; session state is left alone.
   */
  async tryRun<T = unknown>(adapter: BrowserAdapterDef, dataset: string): Promise<JobResult<T>> {
    if (!this.profiles[adapter.profile]) throw new Error(`${adapter.id}: unknown profile "${adapter.profile}"`);
    if (!adapter.datasets[dataset]) throw new Error(`${adapter.id} has no dataset "${dataset}". Known: ${Object.keys(adapter.datasets).join(', ')}`);
    return this.gate(adapter).run(async () => {
      const rt = this.runtime(adapter.profile);
      await rt.gate.wait();
      const release = await rt.slots.acquire();
      try {
        return await this.runJob<T>(adapter, dataset, rt, { trial: true, interactiveChallenges: false, jobId: `try-${Date.now().toString(36)}` });
      } finally {
        release();
      }
    });
  }

  /**
   * EVOLVE: a page on `profile` for looking around a site, guard on. Nothing is saved and
   * session state is left alone.
   */
  async explore<T>(profile: string, policy: GuardPolicy, fn: (page: Page, request: GuardedRequest, violations: Violation[]) => Promise<T>): Promise<T> {
    const rt = this.runtime(profile);
    await rt.gate.wait();
    const release = await rt.slots.acquire();
    let page: Page | undefined;
    try {
      const context = await rt.ensure();
      const violations: Violation[] = [];
      const request = guardRequest(context.request, policy, (v) => violations.push(v));
      page = await rt.newJobPage();
      await installGuard(page, policy, (v) => violations.push(v));
      return await fn(page, request, violations);
    } finally {
      await page?.close().catch(() => {});
      release();
    }
  }

  private async runJob<T>(adapter: BrowserAdapterDef, dataset: string, rt: ProfileRuntime, opts: JobOptions): Promise<JobResult<T>> {
    const id = adapter.id;
    const ds = adapter.datasets[dataset]!;
    const started = new Date();
    const jobId = opts.jobId ?? `${started.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
    const raw = new RawCapture(this.paths.raw, id, jobId, started);
    const context = await rt.ensure();
    const violations: Violation[] = [];
    const policy = policyOf(adapter);
    const onViolation = (v: Violation) => {
      violations.push(v);
      this.log.error('mutation guard blocked a request', { source: id, ...v });
    };
    const request = guardRequest(context.request, policy, onViolation);

    if (!(await adapter.login.check({ request, interactive: false }).catch(() => false))) {
      if (!opts.trial) await this.apply(id, { type: 'probe_logged_out' });
      throw new NeedsLoginError(`${id} needs a sign-in: bt login ${id}`);
    }

    let guardOn = true;
    const page = await rt.newJobPage();
    page.on('popup', (popup) => void installGuard(popup, policy, onViolation, () => guardOn));
    await installGuard(page, policy, onViolation, () => guardOn);
    const ctx = makeStrategyContext({ page, adapter, request, raw, log: this.log });

    try {
      const out = await runStrategies<T>(dataset, ds as any, ctx, { llm: this.opts.llm, violations: () => violations });
      const result: JobResult<T> = {
        jobId,
        source: id,
        dataset,
        data: out.data,
        method: out.method,
        confidence: out.method === 'llm' ? 'llm' : 'high',
        fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - started.getTime(),
        rawDir: raw.dir,
        attempts: out.attempts,
      };
      await raw.save('result.json', { ...result, data: undefined });
      if (opts.trial) return result;
      await this.apply(id, { type: 'job_ok' });
      this.emitEvent({ type: 'job', source: id, dataset, ok: true, jobId, method: out.method, durationMs: result.durationMs });
      return result;
    } catch (err) {
      await saveFailure(page, raw);
      if (err instanceof ChallengeError && rt.headed && opts.interactiveChallenges !== false) {
        const outcome = await this.resolveChallenge(adapter, rt, page, request, () => (guardOn = false), () => (guardOn = true));
        if (outcome === 'ok' || outcome === 'confirmed') {
          await page.close().catch(() => {});
          // Same job, fresh capture dir, so the first attempt's files aren't overwritten.
          return this.runJob<T>(adapter, dataset, rt, { ...opts, jobId: `${jobId}-retry`, interactiveChallenges: false });
        }
      }
      if (opts.trial) throw err;
      await this.apply(id, eventFor(err));
      this.emitEvent({ type: 'job', source: id, dataset, ok: false, jobId, error: String((err as Error).message ?? err), durationMs: Date.now() - started.getTime() });
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async resolveChallenge(
    adapter: BrowserAdapterDef,
    rt: ProfileRuntime,
    page: Page,
    request: GuardedRequest,
    guardOff: () => void,
    guardOn: () => void,
  ): Promise<InteractiveOutcome> {
    await this.apply(adapter.id, { type: 'challenge' });
    this.emitEvent({ type: 'attention', source: adapter.id, reason: 'challenge', message: `${adapter.name} wants a verification step. Finish it in the Chrome window.` });
    const resume = rt.gate.pause();
    guardOff(); // you're driving now
    try {
      let confirm!: () => void;
      const confirmed = new Promise<void>((r) => (confirm = r));
      await page.exposeBinding('__bloomtermDone', () => confirm()).catch(() => {});
      await page.addInitScript({ content: bannerScript(`bloomterm: ${adapter.name} wants a verification step. Finish it here.`) });
      await page.evaluate(bannerScript(`bloomterm: ${adapter.name} wants a verification step. Finish it here.`)).catch(() => {});
      await rt.show(page);
      const outcome = await waitForSignIn(page, () => adapter.login.check({ request, interactive: true }), {
        timeoutMs: this.opts.interactiveTimeoutMs ?? 10 * 60_000,
        slowPollMs: 15_000,
        confirmed,
      });
      if (outcome === 'ok' || outcome === 'confirmed') await this.apply(adapter.id, { type: 'challenge_resolved' });
      return outcome;
    } finally {
      guardOn();
      await rt.hide(rt.anchor() ?? page).catch(() => {});
      resume();
    }
  }

  /** Opens a profile on-screen for you to browse or sign in by hand; resolves when you close the tab. */
  async openProfile(profile: string, opts: { url?: string; recordHar?: string } = {}): Promise<void> {
    const rt = this.runtime(profile);
    const resume = rt.gate.pause();
    try {
      const context = await rt.ensure({ headed: true, visible: true, recordHar: opts.recordHar });
      const page = await context.newPage();
      if (opts.url) await page.goto(opts.url).catch((err) => this.log.warn('page did not load cleanly', { error: String(err) }));
      await rt.show(page);
      await page.waitForEvent('close', { timeout: 0 });
    } finally {
      // Closing flushes the HAR; otherwise go back to the profile's normal mode on next use.
      if (opts.recordHar || rt.config.mode === 'headless') await rt.close();
      else {
        const anchor = rt.anchor();
        if (anchor) await rt.hide(anchor).catch(() => {});
      }
      resume();
    }
  }

  /**
   * Opens a profile in plain Chrome, with nothing attached to it, for sites that turn away an
   * automated browser (Google's sign-in, bot checks). bloomterm's own Chrome for the profile
   * closes first, and jobs on it wait until you quit this one (⌘Q; closing the window isn't
   * enough on macOS). Resolves once Chrome has started; `exited` resolves when it quits.
   */
  async openPlain(profile: string, opts: { url?: string } = {}): Promise<{ pid: number; exited: Promise<void> }> {
    const rt = this.runtime(profile);
    if (rt.config.cdpUrl) throw new Error(`profile "${profile}" lives in a Chrome bloomterm attaches to (cdpUrl), so there's no plain one to open`);
    const resume = rt.gate.pause();
    try {
      await rt.close();
      await prepareProfileDir(rt.dir, rt.config);
      const args = [`--user-data-dir=${rt.dir}`, '--no-first-run', '--no-default-browser-check'];
      if (rt.config.keepSessionCookies !== false) args.push('--restore-last-session');
      if (opts.url) args.push(opts.url);
      // Detached, so it outlives a bloomd restart instead of quitting with it.
      const child = spawn(rt.config.executablePath ?? (await this.chromeExecutable()), args, { stdio: 'ignore', detached: true });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      this.log.info('opened plain chrome', { profile, pid: child.pid });
      return { pid: child.pid!, exited: exited.finally(resume) };
    } catch (err) {
      resume();
      throw err;
    }
  }

  /** Signs you out of everything in a profile by deleting it. */
  async wipeProfile(profile: string): Promise<string> {
    const rt = this.runtime(profile);
    await rt.close();
    await rm(rt.dir, { recursive: true, force: true });
    return rt.dir;
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.close()));
  }

  private gate(adapter: BrowserAdapterDef): SiteGate {
    let g = this.gates.get(adapter.id);
    if (!g) {
      g = new SiteGate({ minIntervalMs: adapter.minIntervalMs ?? 5_000, jitter: 0.3, maxJobsPerHour: adapter.maxJobsPerHour ?? 12 });
      this.gates.set(adapter.id, g);
    }
    return g;
  }

  private async apply(source: string, ev: SessionEvent): Promise<SessionRecord> {
    const before = await this.sessions.get(source);
    const record = await this.sessions.apply(source, ev);
    if (record.state !== before.state) {
      this.emitEvent({ type: 'session', record });
      if (record.state === 'needs_login') {
        const name = this.adapters.get(source)?.name ?? source;
        this.emitEvent({ type: 'attention', source, reason: 'needs_login', message: `${name}: sign-in needed — bt login ${source}` });
      } else if (record.state === 'blocked') {
        this.emitEvent({ type: 'attention', source, reason: 'blocked', message: `${source} is blocked: ${record.lastError ?? ''}` });
      }
    }
    return record;
  }

  private emitEvent(ev: HostEvent): void {
    this.emit('event', ev);
  }
}

function policyOf(a: BrowserAdapterDef): GuardPolicy {
  return { origins: a.origins, allowWrites: a.allowWrites, allowWebSockets: a.allowWebSockets };
}

function eventFor(err: unknown): SessionEvent {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof NeedsLoginError) return { type: 'needs_login', error: message };
  if (err instanceof ChallengeError) return { type: 'challenge', error: message };
  if (err instanceof BlockedError) return { type: 'blocked', error: message };
  return { type: 'job_error', error: message };
}

async function saveFailure(page: Page, raw: RawCapture): Promise<void> {
  try {
    if (page.isClosed()) return;
    await raw.save('failure.png', await page.screenshot({ fullPage: true, timeout: 10_000 }));
    await raw.save('failure.html', await page.content());
  } catch {
    // best effort
  }
}
