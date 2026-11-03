import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { findChrome } from './chrome.ts';
import { ChromeNotFoundError } from './errors.ts';
import { PauseGate, Semaphore } from './queue.ts';
import type { Logger, ProfileConfig } from './types.ts';
import { activatePid, activateProfileApp, frontmostPid, park, profileAppPid, unpark, type ParkResult } from './window.ts';

export interface EnsureOptions {
  /** Force a headed window (sign-in on a headless profile). */
  headed?: boolean;
  /** Start on-screen instead of parked. */
  visible?: boolean;
  /** Record a HAR of everything this browser does until it's closed. */
  recordHar?: string;
}

async function defaultChrome(): Promise<string> {
  const found = await findChrome();
  if (!found) throw new ChromeNotFoundError();
  return found.executable;
}

/**
 * One Chrome per profile dir (SPEC §6.1–6.2). Owns the launch, the off-screen window,
 * the tab slots, and the pause gate jobs wait on while you have the window.
 */
export class ProfileRuntime {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private launchedAs: { headed: boolean; har?: string } | null = null;
  /** Set when attached to a running Chrome (`cdpUrl`): the connection, not a Chrome we own. */
  private attached: Browser | null = null;
  readonly slots: Semaphore;
  readonly gate = new PauseGate();
  parkedAs: ParkResult | null = null;
  private frontBeforeShow: number | null = null;

  constructor(
    readonly config: ProfileConfig,
    readonly dir: string,
    private readonly log: Logger,
    /** The Chrome to launch when the profile names neither an executable nor a channel. */
    private readonly chrome: () => Promise<string> = defaultChrome,
  ) {
    this.slots = new Semaphore(config.maxTabs ?? 2);
  }

  get running(): boolean {
    return this.context !== null;
  }

  async ensure(opts: EnsureOptions = {}): Promise<BrowserContext> {
    const headed = this.config.cdpUrl ? false : (opts.headed ?? this.config.mode === 'parked');
    if (this.launching) await this.launching.catch(() => {});
    if (this.context && this.launchedAs?.headed === headed && this.launchedAs.har === opts.recordHar) return this.context;
    if (this.context) await this.close();
    this.launching = this.launch(headed, opts);
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async launch(headed: boolean, opts: EnsureOptions): Promise<BrowserContext> {
    await prepareProfileDir(this.dir, this.config);
    if (this.config.cdpUrl) return this.attach(opts);
    const parkOnLaunch = headed && !opts.visible;
    this.log.info('launching chrome', { profile: this.config.name, headed, parked: parkOnLaunch });
    const keepSessionCookies = this.config.keepSessionCookies !== false;
    const args = [parkOnLaunch ? '--window-position=-10000,-10000' : '--window-position=80,80', '--window-size=1280,900'];
    // The startup pref alone doesn't bring session cookies back; this flag does (tested on Chrome 155).
    if (keepSessionCookies) args.push('--restore-last-session');
    // Playwright's own lookup ("chrome" channel) only tries /Applications; chrome.ts looks further.
    const executablePath = this.config.executablePath ?? (this.config.channel ? undefined : await this.chrome());
    const frontBefore = parkOnLaunch ? await frontmostPid() : null;
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.dir, {
        channel: executablePath ? undefined : this.config.channel,
        executablePath,
        headless: !headed,
        viewport: headed ? null : { width: 1280, height: 900 },
        acceptDownloads: true,
        serviceWorkers: this.config.serviceWorkers ?? 'block',
        locale: this.config.locale,
        timezoneId: this.config.timezoneId,
        args,
        // Playwright defaults to a mock keychain, which encrypts cookies with a fixed key.
        // Use the real macOS Keychain ("Chrome Safe Storage") unless told otherwise.
        ignoreDefaultArgs: this.config.useSystemKeychain === false ? undefined : ['--use-mock-keychain', '--password-store=basic'],
        recordHar: opts.recordHar ? { path: opts.recordHar, content: 'embed' } : undefined,
      });
    } catch (err) {
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(String(err))) {
        throw new Error(`profile "${this.config.name}" is already open in another Chrome (another bt or bloomd?): ${this.dir}`);
      }
      throw err;
    }
    this.adopt(context, { headed, har: opts.recordHar });
    if (parkOnLaunch) {
      const anchor = context.pages()[0] ?? (await context.newPage());
      this.parkedAs = await park(anchor);
      this.log.debug('parked window', { profile: this.config.name, as: this.parkedAs });
      if (frontBefore && frontBefore !== (await profileAppPid(this.dir))) await activatePid(frontBefore);
    }
    return context;
  }

  /** A fresh context in the running Chrome, with the cookies this profile had when it last closed. */
  private async attach(opts: EnsureOptions): Promise<BrowserContext> {
    this.log.info('attaching to chrome', { profile: this.config.name, cdpUrl: this.config.cdpUrl });
    const browser = await chromium.connectOverCDP(this.config.cdpUrl!);
    const state = storageStateFile(this.dir);
    const context = await browser.newContext({
      storageState: existsSync(state) ? state : undefined,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      serviceWorkers: this.config.serviceWorkers ?? 'block',
      locale: this.config.locale,
      timezoneId: this.config.timezoneId,
      recordHar: opts.recordHar ? { path: opts.recordHar, content: 'embed' } : undefined,
    });
    this.attached = browser;
    this.adopt(context, { headed: false, har: opts.recordHar });
    return context;
  }

  private adopt(context: BrowserContext, as: { headed: boolean; har?: string }): void {
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    context.on('close', () => {
      if (this.context === context) {
        this.context = null;
        this.launchedAs = null;
      }
    });
    this.context = context;
    this.launchedAs = as;
  }

  get headed(): boolean {
    return this.launchedAs?.headed ?? false;
  }

  /** A new tab in whatever browser is running (launching the default one if none is). */
  async newPage(): Promise<Page> {
    const context = this.context ?? (await this.ensure());
    return context.newPage();
  }

  /** A tab for a background job. In a parked window, a new tab un-minimizes it, so park it again. */
  async newJobPage(): Promise<Page> {
    const page = await this.newPage();
    if (this.headed && this.config.mode === 'parked' && !this.gate.paused) this.parkedAs = await park(page);
    return page;
  }

  /** The first tab, kept open so the window survives job tabs closing. */
  anchor(): Page | undefined {
    return this.context?.pages()[0];
  }

  /** Puts the page's window in front of you. */
  async show(page: Page): Promise<void> {
    if (!this.launchedAs?.headed) return;
    const front = await frontmostPid();
    if (front && front !== (await profileAppPid(this.dir))) this.frontBeforeShow = front;
    await unpark(page);
    await activateProfileApp(this.dir);
  }

  /** Parks the window again (parked profiles only) and gives focus back to the app you were in. */
  async hide(page: Page): Promise<void> {
    if (!this.launchedAs?.headed || this.config.mode !== 'parked') return;
    this.parkedAs = await park(page);
    if (this.frontBeforeShow) await activatePid(this.frontBeforeShow);
    this.frontBeforeShow = null;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    const attached = this.attached;
    this.context = null;
    this.launchedAs = null;
    this.attached = null;
    if (ctx && attached) {
      // A launched profile keeps cookies on disk by itself; an attached one needs saving.
      const state = await ctx.storageState().catch(() => null);
      if (state) await writeFile(storageStateFile(this.dir), JSON.stringify(state), { mode: 0o600 });
    }
    await ctx?.close().catch(() => {});
    // Disconnects; the Chrome we attached to keeps running.
    await attached?.close().catch(() => {});
  }
}

const storageStateFile = (dir: string) => join(dir, 'storage-state.json');

/**
 * Creates the profile dir (0700). With `keepSessionCookies`, sets Chrome's startup
 * preference to "continue where you left off", which also keeps session cookies.
 */
export async function prepareProfileDir(dir: string, config: ProfileConfig): Promise<void> {
  await mkdir(join(dir, 'Default'), { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (config.keepSessionCookies === false) return;
  const prefsFile = join(dir, 'Default', 'Preferences');
  let prefs: any = {};
  try {
    prefs = JSON.parse(await readFile(prefsFile, 'utf8'));
  } catch {
    // first launch
  }
  if (prefs?.session?.restore_on_startup === 1) return;
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
  await writeFile(prefsFile, JSON.stringify(prefs), { mode: 0o600 });
}
