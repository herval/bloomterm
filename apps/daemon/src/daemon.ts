import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserHost, consoleLogger, getWindowBounds, type BrowserAdapterDef, type HostEvent, type HostOptions, type Logger } from '@bloomterm/browser';
import type { AgentCli, AgentEvent } from '@bloomterm/agent';
import { browserAdapters, folderHash, marketProviders, newsProviders, secretSpecs, type Integration } from '@bloomterm/integrations';
import { bloomtermHome, homePaths, parseSecurity, watchedKeys, type Security, type Watchlists } from '@bloomterm/core';
import { openStore, type ChatAction, type ChatFile, type Insight, type Job, type JobKind, type Store } from '@bloomterm/store';
import type { FastifyInstance } from 'fastify';
import { ActionService } from './actions.ts';
import { Assistant, type EvolveMeta } from './assistant.ts';
import { loadConfig, type Config } from './config.ts';
import { capturePage, checkUrl, fetchAs, harEntry, harSummary, listRecordings, sanitize, type BodyMode } from './evolve/inspect.ts';
import { checksLine, loadCandidate, runChecks } from './evolve/workspace.ts';
import { FileService } from './files/service.ts';
import { InsightService } from './insights.ts';
import { LocalIntegrations } from './integrations.ts';
import { layout } from './layout.ts';
import { enrichPrompt, NEWS_SYSTEM, parseEnrich } from './news/enrich.ts';
import { NewsService } from './news/service.ts';
import { memoryStore, type SecretStore } from './market/secrets.ts';
import { MarketService } from './market/service.ts';
import { desktopNotifier } from './notify.ts';
import { JobRunner } from './runner.ts';
import { PRIORITY, Scheduler, validateSchedule, type ScheduleEntry } from './scheduler.ts';
import { buildServer, HttpError } from './server.ts';
import { Setup, systemProbes, type SetupProbes, type SetupState } from './setup.ts';
import { ensureToken } from './token.ts';

export interface DaemonOptions {
  home?: string;
  /** Overrides config.toml; 0 picks a free port. */
  port?: number;
  /** The data sources. main.ts passes the built-ins with your approved ones in place; tests pass fakes. */
  integrations: readonly Integration[];
  /** Your integrations folder (main.ts loads it first). By default one in `home`, over `integrations`. */
  local?: LocalIntegrations;
  /** Restarts bloomd, when something supervises it (launchd, the desktop app); without one, POST /api/restart answers 409. */
  restart?: () => void;
  /** Stops bloomd cleanly. Without it, POST /api/shutdown answers 409. */
  shutdown?: () => void;
  config?: Config;
  host?: Partial<HostOptions>;
  notify?: boolean;
  schedulerIntervalMs?: number;
  jitterMs?: number;
  log?: Logger;
  /** Where API keys live. In memory unless given (main.ts passes the Keychain), so tests never touch it. */
  secrets?: SecretStore;
  /** The built web UI (apps/web/dist by default). */
  webRoot?: string;
  /** Where POST /api/files/:id/save puts files: ~/Downloads unless given. */
  downloads?: string;
  /** The agent CLI that runs ASK and EVOLVE. None: both answer 503, and Setup says what to install. */
  agent?: AgentCli | null;
  /** How Setup looks for the agent CLI and Chrome; tests pass fakes. */
  setup?: Partial<SetupProbes>;
  /** EVOLVE: whether bloomd checks the agent's work when a run ends. */
  evolve?: { checks?: boolean };
  /** How often news feeds and the brief's schedule are checked; 0 doesn't start them (tests poll by hand). */
  newsTickMs?: number;
  briefTickMs?: number;
  /** How often new headlines go to the agent to group and tag (15 min); Infinity: only when asked (tests). */
  newsEnrichEveryMs?: number;
}

export type DaemonEvent =
  | HostEvent
  | { type: 'job_update'; job: Job }
  | { type: 'chat_event'; chatId: string; seq: number; event: AgentEvent }
  | { type: 'chat_done'; chatId: string; seq: number; status: 'done' | 'error' }
  | { type: 'chat_file'; chatId: string; file: ChatFile }
  | { type: 'chat_action'; chatId: string; action: ChatAction }
  | { type: 'news'; added: number; sources: string[] }
  | { type: 'insight'; insight: Insight };

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export const stateFile = (home: string) => join(homePaths(home).state, 'bloomd.json');
export const defaultWebRoot = () => layout().web;

/** bloomd (SPEC §8.1): owns the store, the browser host, the job runner and the scheduler. */
export class Daemon {
  readonly home: string;
  readonly log: Logger;
  store!: Store;
  host!: BrowserHost;
  market!: MarketService;
  assistant!: Assistant;
  news!: NewsService;
  insights!: InsightService;
  files!: FileService;
  actions!: ActionService;
  local!: LocalIntegrations;
  setup!: Setup;
  readonly secrets: SecretStore;
  port = 0;
  private config!: Config;
  private server!: FastifyInstance;
  private runner!: JobRunner;
  private scheduler!: Scheduler;
  private startedAt = '';
  private listeners = new Set<(ev: DaemonEvent) => void>();
  private notify = desktopNotifier();
  private uiCodes = new Map<string, number>();

  constructor(private readonly opts: DaemonOptions) {
    this.home = opts.home ?? bloomtermHome();
    this.log = opts.log ?? consoleLogger();
    this.secrets = opts.secrets ?? memoryStore();
  }

  async start(): Promise<DaemonInfo> {
    // The home holds the token, the DB and signed-in profiles: yours only, even if it existed already.
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    this.config = this.opts.config ?? (await loadConfig(this.home));
    const token = await ensureToken(this.home);
    this.store = openStore(join(this.home, 'bloomterm.db'));
    this.market = new MarketService(marketProviders(this.opts.integrations, this.secrets.get), { log: this.log });
    this.files = new FileService({ home: this.home, store: this.store, log: this.log, emit: (ev) => this.emit(ev), downloads: this.opts.downloads });
    void this.files.sweep().catch((err) => this.log.warn('clearing old uploads failed', { error: String(err) }));
    this.local = this.opts.local ?? new LocalIntegrations({ home: this.home, builtins: this.opts.integrations, log: this.log });
    this.assistant = new Assistant({
      cli: this.opts.agent ?? null,
      home: this.home,
      store: this.store,
      config: this.config.agent,
      log: this.log,
      emit: (ev) => this.emit(ev),
      local: this.local,
      evolve: this.opts.evolve,
      files: this.files,
    });
    const agent = this.opts.agent ?? null;
    this.news = new NewsService({
      store: this.store,
      providers: newsProviders(this.opts.integrations, this.secrets.get),
      securities: () => this.followed(),
      enrich:
        agent && this.config.news.ai
          ? async (input) => {
              const r = await this.assistant.oneShot({ system: NEWS_SYSTEM, prompt: enrichPrompt(input) });
              if (!r.ok) throw new Error(r.error ?? 'the agent failed');
              return parseEnrich(r.text, input);
            }
          : null,
      enrichEveryMs: this.opts.newsEnrichEveryMs,
      log: this.log,
      emit: (ev) => this.emit(ev),
    });
    this.insights = new InsightService({
      store: this.store,
      quotes: (keys) => this.market.quoteMany(keys),
      closes: async (key) => (await this.market.bars(key, '1M')).bars,
      followed: () => this.followed(),
      agent: () => (agent ? { kind: agent.kind, run: (o) => this.assistant.oneShot(o) } : null),
      config: { ...this.config.brief, sharePortfolio: this.config.agent.share_portfolio },
      health: () => this.needsAttention(),
      log: this.log,
      emit: (ev) => this.emit(ev),
    });
    this.store.chats.recover();
    const recovered = this.store.jobs.recover();
    if (recovered.requeued || recovered.failed) this.log.info('recovered jobs from last run', recovered);

    this.setup = new Setup({ probes: { ...systemProbes, ...this.opts.setup }, config: this.config, inUse: this.opts.agent ?? null, log: this.log });
    const profiles: HostOptions['profiles'] = { ...this.config.profiles, ...(this.opts.host?.profiles ?? {}) };
    this.host = new BrowserHost({ home: this.home, log: this.log, chrome: this.config.browser.chrome, ...this.opts.host, profiles, sessions: this.store.sessions });
    this.host.register(...this.adapters);
    this.host.on('event', (ev: HostEvent) => this.onHostEvent(ev));
    this.actions = new ActionService({
      store: this.store,
      log: this.log,
      emit: (ev) => this.emit(ev),
      integrations: () => this.integrationList(),
      browser: () =>
        this.adapters.map((a) => ({
          id: a.id,
          name: a.name,
          profile: a.profile,
          loginUrl: a.login.url,
          datasets: Object.entries(a.datasets).map(([name, ds]) => ({ name, persist: ds.persist ?? null })),
        })),
      session: (source) => this.store.sessions.getSync(source).state,
      openProfile: (name, o) => this.openProfile(name, o),
      enqueue: (input) => this.enqueue(input),
      evolve: (input) => this.assistant.evolve(input),
    });

    const entries = this.scheduleEntries();
    this.scheduler = new Scheduler({
      entries: () => entries,
      probes: () =>
        this.host
          .list()
          .filter((a) => a.status !== 'draft')
          .map((a) => ({ source: a.id, everyMinutes: a.login.probeEveryMinutes ?? 60 })),
      state: (source) => this.store.sessions.getSync(source).state,
      schedules: this.store.schedules,
      jobs: this.store.jobs,
      jitterMs: this.opts.jitterMs,
      log: this.log,
      onEnqueued: (job) => {
        this.emit({ type: 'job_update', job });
        this.runner.kick();
      },
    });
    this.runner = new JobRunner({
      store: this.store,
      host: this.host,
      log: this.log,
      concurrency: this.config.daemon.concurrency,
      onUpdate: (job) => this.emit({ type: 'job_update', job }),
    });

    this.server = buildServer(this, token, this.opts.webRoot ?? defaultWebRoot());
    try {
      await this.server.listen({ host: '127.0.0.1', port: this.opts.port ?? this.config.daemon.port });
    } catch (err: any) {
      this.store.close();
      if (err?.code === 'EADDRINUSE') throw new Error(`port ${this.opts.port ?? this.config.daemon.port} is in use: is bloomd already running? (bt status)`);
      throw err;
    }
    const addr = this.server.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.startedAt = new Date().toISOString();
    const info: DaemonInfo = { pid: process.pid, port: this.port, startedAt: this.startedAt };
    await mkdir(homePaths(this.home).state, { recursive: true, mode: 0o700 });
    await writeFile(stateFile(this.home), JSON.stringify(info), { mode: 0o600 });

    this.runner.start();
    this.scheduler.start(this.opts.schedulerIntervalMs);
    if (this.opts.newsTickMs !== 0) this.news.start(this.opts.newsTickMs);
    if (this.opts.briefTickMs !== 0) this.insights.start(this.opts.briefTickMs);
    this.log.info('bloomd listening', { url: `http://127.0.0.1:${this.port}`, home: this.home, schedules: entries.length });
    return info;
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.news?.stop();
    this.insights?.stop();
    this.runner?.stop();
    this.assistant?.stopAll();
    await this.server?.close().catch(() => {});
    await this.host?.close();
    this.store?.close();
    await rm(stateFile(this.home), { force: true });
    this.log.info('bloomd stopped');
  }

  /** A one-time code `bt ui` puts in the URL; the page trades it for the token within a minute. */
  createUiCode(): { code: string; expiresInS: number } {
    const now = Date.now();
    for (const [c, exp] of this.uiCodes) if (exp < now) this.uiCodes.delete(c);
    const code = randomBytes(24).toString('hex');
    this.uiCodes.set(code, now + 60_000);
    return { code, expiresInS: 60 };
  }

  redeemUiCode(code: string): boolean {
    const exp = this.uiCodes.get(code);
    this.uiCodes.delete(code);
    return exp !== undefined && exp >= Date.now();
  }

  private get adapters(): BrowserAdapterDef[] {
    return browserAdapters(this.opts.integrations);
  }

  /** The API keys the integrations declare. SET can store only these. */
  secretNames(): string[] {
    return secretSpecs(this.opts.integrations).map((s) => s.name);
  }

  /** Which API keys are set, and where from. Never the values. */
  async secretStatus() {
    return Promise.all(secretSpecs(this.opts.integrations).map(async (s) => ({ ...s, provider: s.integration, from: await this.secrets.source(s.name) })));
  }

  /** Every integration and what it provides (SRC, and the agent's tools). */
  integrationList() {
    return this.opts.integrations.map((i) => ({
      id: i.id,
      origin: this.local.loaded.has(i.id) ? ('yours' as const) : ('built-in' as const),
      name: i.name,
      covers: i.covers,
      access: i.access,
      status: i.status,
      docs: i.docs ?? null,
      provides: [...(i.market ? ['market'] : []), ...(i.news ? ['news'] : []), ...Object.keys(i.browser?.datasets ?? {})],
      secrets: (i.secrets ?? []).map((s) => s.name),
    }));
  }

  /** What you hold and watch: every watchlist, and every position bloomterm can name. */
  followed(): Security[] {
    const keys = new Set(watchedKeys(this.store.ui.get<Watchlists>('watchlists')?.value));
    for (const p of this.store.holdings.currentPositions()) {
      const sec = parseSecurity(p.rawSymbol);
      if (sec) keys.add(sec.key);
    }
    return [...keys].flatMap((k) => parseSecurity(k) ?? []);
  }

  /** Sources that need you: signed out or blocked, and news feeds that are failing. */
  needsAttention(): string[] {
    const sessions = this.host
      .list()
      .filter((a) => a.status !== 'draft')
      .flatMap((a) => {
        const state = this.store.sessions.getSync(a.id).state;
        return ['needs_login', 'challenge', 'blocked'].includes(state) ? [`${a.name}: ${state.replace('_', ' ')}`] : [];
      });
    const feeds = this.news.feeds().flatMap((f) => (f.error ? [`${f.name}: ${f.error}`] : []));
    return [...sessions, ...feeds];
  }

  // ---- EVOLVE's view of the sites (SPEC §6.11); the agent reaches these through `bt mcp --evolve` ----

  /** Bodies come as samples, or as shapes when you've turned portfolio sharing off. */
  private get bodyMode(): BodyMode {
    return this.config.agent.share_portfolio ? 'sample' : 'shape';
  }

  recordings() {
    return listRecordings(this.home);
  }

  recording(file: string, q: { index?: number; match?: string }) {
    return q.index === undefined ? harSummary(this.home, file, { match: q.match, mode: this.bodyMode }) : harEntry(this.home, file, q.index, this.bodyMode);
  }

  /** The integration's own profile and origins if bloomd has it; otherwise `profile` (finance by default). */
  private target(integration: string, url: URL, profile?: string) {
    const adapter = this.adapters.find((a) => a.id === integration);
    const name = profile ?? adapter?.profile ?? 'finance';
    if (!this.host.profileNames().includes(name)) throw new HttpError(404, `unknown profile "${name}". Known: ${this.host.profileNames().join(', ')}`);
    return { profile: name, origins: [...new Set([...(adapter?.origins ?? []), url.origin])] };
  }

  capture(o: { integration: string; url: string; profile?: string; waitMs?: number }) {
    const url = checkUrl(o.url);
    return capturePage(this.host, { ...this.target(o.integration, url, o.profile), url, waitMs: o.waitMs ?? 8_000, mode: this.bodyMode });
  }

  fetchAs(o: { integration: string; url: string; profile?: string }) {
    const url = checkUrl(o.url);
    return fetchAs(this.host, { ...this.target(o.integration, url, o.profile), url, mode: this.bodyMode });
  }

  /** An EVOLVE run, and its copy of the integration. */
  private evolveRun(run: string): { meta: EvolveMeta; folder: string } {
    const chat = this.store.chats.get(run);
    if (!chat || chat.kind !== 'evolve') throw new HttpError(404, `no EVOLVE run ${run}`);
    const meta = chat.meta as unknown as EvolveMeta;
    // Runs from before EVOLVE worked in your data folder had a git branch instead.
    if (!meta.dir) throw new HttpError(410, `that run is from an older bloomterm; start a new one with EVOLVE ${meta.integration}`);
    return { meta, folder: join(meta.dir, meta.integration) };
  }

  /** Runs one dataset of the run's copy against the live site. Nothing is saved. */
  async tryDataset(run: string, dataset: string) {
    const { meta, folder } = this.evolveRun(run);
    let adapter: BrowserAdapterDef;
    try {
      adapter = await loadCandidate(folder, meta.integration);
    } catch (err) {
      return { ok: false, stage: 'load', error: String((err as Error).message ?? err) };
    }
    try {
      const r = await this.host.tryRun(adapter, dataset);
      const rows = Array.isArray(r.data) ? r.data.length : undefined;
      return { ok: true, method: r.method, attempts: r.attempts, durationMs: r.durationMs, rows, data: sanitize(r.data, this.bodyMode) };
    } catch (err: any) {
      return { ok: false, stage: 'run', error: String(err?.message ?? err), attempts: err?.attempts, issues: Array.isArray(err?.issues) ? err.issues.slice(0, 20) : undefined };
    }
  }

  // ---- Your integrations (SPEC §6.11): they run only once you approve their exact files ----

  /** What approving a run's copy (or, with no run, your folder as it is now) would change. */
  async integrationDiff(id: string, run?: string) {
    const target = run ? this.evolveRun(run).folder : join(this.local.root, id);
    if (run && this.evolveRun(run).meta.integration !== id) throw new HttpError(400, `run ${run} isn't about ${id}`);
    if (!existsSync(target)) throw new HttpError(404, run ? `run ${run} has no ${id}/ folder` : `you have no integration "${id}"`);
    return this.local.diff(id, target);
  }

  /**
   * Approves a run's copy, exactly as you reviewed it (`hash`): bloomd's checks must pass on
   * those files, then they go into your integrations folder. They run after a restart.
   */
  async approveRun(run: string, o: { hash: string }) {
    const { meta, folder } = this.evolveRun(run);
    if (this.assistant.isRunning(run)) throw new HttpError(409, 'EVOLVE is still working on it; wait for it to finish');
    if (!existsSync(folder)) throw new HttpError(404, `run ${run} has no ${meta.integration}/ folder`);
    const hash = await folderHash(folder);
    if (hash !== o.hash) throw new HttpError(409, `${meta.integration}'s files changed since you looked at them; review the diff again`);
    const checks = meta.hash === hash && meta.checks ? meta.checks : await this.assistant.checkRun(run);
    if (!checks.ok) throw new HttpError(409, `bloomd's checks fail (${checksLine(checks)}); ask EVOLVE to fix them first`);
    const approved = await this.local.approve(meta.integration, folder, { hash, run });
    this.store.chats.setMeta(run, { approved: { hash, at: approved.at } });
    this.log.info('approved an integration', { id: meta.integration, run, hash: hash.slice(0, 12) });
    return { approved, supervised: !!this.opts.restart };
  }

  /** Approves your folder as it is, after you edited it by hand; the same checks first. */
  async approveIntegration(id: string, o: { hash: string }) {
    const dir = join(this.local.root, id);
    if (!existsSync(dir)) throw new HttpError(404, `you have no integration "${id}"`);
    if ((await folderHash(dir)) !== o.hash) throw new HttpError(409, `${id}'s files changed since you looked at them; review the diff again`);
    const checks = await runChecks(dir, id);
    if (!checks.ok) throw new HttpError(409, `bloomd's checks fail (${checksLine(checks)}):\n${checks.output}`);
    const approved = await this.local.approve(id, dir, { hash: o.hash });
    this.log.info('approved an integration', { id, hash: o.hash.slice(0, 12) });
    return { approved, checks, supervised: !!this.opts.restart };
  }

  /** Takes your integration out; the built-in, if any, comes back after a restart. */
  async removeIntegration(id: string) {
    await this.local.remove(id).catch((err) => {
      throw new HttpError(404, (err as Error).message);
    });
    this.log.info('removed an integration', { id });
    return { removed: id, supervised: !!this.opts.restart };
  }

  /**
   * Setup, checked again (you installed or signed in to something). When an agent CLI is there
   * now and bloomd started without one, bloomd restarts to use it, if something will start it
   * again; otherwise the page says to.
   */
  async checkSetup(): Promise<SetupState & { restarting: boolean }> {
    const state = await this.setup.check();
    const restarting = state.agent.restartNeeded && !!this.opts.restart;
    if (restarting) this.restart();
    return { ...state, restarting };
  }

  /** Restarts bloomd, if launchd or the desktop app will start it again. */
  shutdown(): { stopping: true } {
    const shutdown = this.opts.shutdown;
    if (!shutdown) throw new HttpError(409, "this bloomd can't stop itself");
    setTimeout(shutdown, 100);
    return { stopping: true };
  }

  restart(): { restarting: true } {
    const restart = this.opts.restart;
    if (!restart) throw new HttpError(409, "bloomd runs in a terminal here, so it can't restart itself; stop it and start it again");
    this.log.info('restarting');
    setTimeout(restart, 100);
    return { restarting: true };
  }

  subscribe(fn: (ev: DaemonEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue(input: { kind: JobKind; source: string; dataset?: string; force?: boolean }): Job {
    const adapter = this.adapterOr404(input.source);
    if (input.kind === 'run' && !adapter.datasets[input.dataset!]) {
      throw new HttpError(404, `${input.source} has no dataset "${input.dataset}". Known: ${Object.keys(adapter.datasets).join(', ')}`);
    }
    const priority = input.kind === 'login' ? PRIORITY.login : PRIORITY.manual;
    const { job, created } = this.store.jobs.enqueue({ ...input, trigger: 'manual', priority });
    if (created) this.emit({ type: 'job_update', job });
    this.runner.kick();
    return job;
  }

  sources() {
    const upcoming = this.scheduler.upcoming();
    return this.host.list().map((a) => ({
      id: a.id,
      name: a.name,
      profile: a.profile,
      status: a.status ?? 'ready',
      session: this.store.sessions.getSync(a.id),
      datasets: Object.entries(a.datasets).map(([name, ds]) => ({
        name,
        persist: ds.persist ?? null,
        freshness: ds.freshness ?? null,
        next: upcoming.find((u) => u.source === a.id && u.dataset === name)?.next ?? null,
        lastOk: this.store.jobs.lastOk(a.id, name),
      })),
    }));
  }

  status() {
    return {
      pid: process.pid,
      port: this.port,
      home: this.home,
      startedAt: this.startedAt,
      uptimeS: Math.round(process.uptime()),
      /** Something restarts bloomd when it exits (launchd, the desktop app), so POST /api/restart works. */
      supervised: !!this.opts.restart,
      agent: this.assistant.status(),
      running: this.runner.running().map((j) => ({ id: j.id, kind: j.kind, source: j.source, dataset: j.dataset })),
      queued: this.store.jobs.list({ status: 'queued', limit: 500 }).length,
      sessions: this.host.list().map((a) => ({ source: a.id, state: this.store.sessions.getSync(a.id).state })),
      profiles: this.host.profileNames().map((name) => ({ name, running: this.host.runtime(name).running })),
    };
  }

  /**
   * Opens a profile for you in plain Chrome, which sites that refuse automated browsers accept;
   * returns once it's up. When you quit it, the profile's sources are probed, so a sign-in you
   * made there shows. With `record`, it's bloomterm's own Chrome instead (a HAR needs it), saved
   * when you close the tab.
   */
  async openProfile(name: string, o: { url?: string; record?: boolean }): Promise<{ profile: string; har?: string }> {
    if (!this.host.profileNames().includes(name)) throw new HttpError(404, `unknown profile "${name}"`);
    if (o.record) {
      const har = join(homePaths(this.home).records, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.har`);
      void (async () => {
        await mkdir(homePaths(this.home).records, { recursive: true, mode: 0o700 });
        await this.host.openProfile(name, { url: o.url, recordHar: har });
      })().catch((err) => this.log.error('open profile failed', { profile: name, error: String(err) }));
      return { profile: name, har };
    }
    const busy = this.runner.running().filter((j) => this.host.adapter(j.source).profile === name);
    if (busy.length) throw new HttpError(409, `profile "${name}" has ${busy.length} job(s) running; try again when they finish`);
    const { exited } = await this.host.openPlain(name, { url: o.url }).catch((err) => {
      throw new HttpError(500, `couldn't open Chrome: ${(err as Error).message}`);
    });
    void exited.then(() => {
      for (const a of this.host.list().filter((a) => a.profile === name)) this.enqueue({ kind: 'probe', source: a.id });
    });
    return { profile: name };
  }

  /** Stops a conversation if it's running, and deletes it with its files. */
  async deleteChat(id: string): Promise<{ deleted: string }> {
    this.assistant.stop(id);
    await this.files.removeChat(id);
    this.store.chats.delete(id);
    return { deleted: id };
  }

  async wipeProfile(name: string): Promise<{ deleted: string }> {
    if (!this.host.profileNames().includes(name)) throw new HttpError(404, `unknown profile "${name}"`);
    const busy = this.runner.running().filter((j) => this.host.adapter(j.source).profile === name);
    if (busy.length) throw new HttpError(409, `profile "${name}" has ${busy.length} job(s) running; try again when they finish`);
    return { deleted: await this.host.wipeProfile(name) };
  }

  /** Launches each profile (parked) and reports what the window did. */
  async doctor() {
    const out = [];
    for (const name of this.host.profileNames()) {
      const rt = this.host.runtime(name);
      try {
        const context = await rt.ensure();
        const anchor = rt.anchor();
        out.push({
          profile: name,
          mode: rt.config.mode,
          chrome: context.browser()?.version() ?? null,
          parkedAs: rt.parkedAs,
          window: anchor && rt.headed ? await getWindowBounds(anchor) : null,
          dir: rt.dir,
        });
      } catch (err) {
        out.push({ profile: name, mode: rt.config.mode, error: String((err as Error).message ?? err), dir: rt.dir });
      }
    }
    return out;
  }

  private scheduleEntries(): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];
    const known = new Set<string>();
    for (const a of this.adapters) {
      for (const [dataset, ds] of Object.entries(a.datasets)) {
        const key = `${a.id}.${dataset}`;
        known.add(key);
        const override = this.config.schedules[key];
        if (override?.enabled === false || a.status === 'draft') continue;
        const cron = override?.cron ?? ds.schedule?.cron;
        if (!cron) continue;
        const e = { source: a.id, dataset, cron, tz: override?.tz ?? ds.schedule?.tz };
        validateSchedule(e);
        entries.push(e);
      }
    }
    for (const key of Object.keys(this.config.schedules)) {
      if (!known.has(key)) this.log.warn('config.toml schedules a dataset that no adapter has', { key });
    }
    return entries;
  }

  private onHostEvent(ev: HostEvent): void {
    this.emit(ev);
    if (ev.type === 'attention' && ev.reason !== 'sign_in_open' && (this.opts.notify ?? this.config.notify[process.platform === 'win32' ? 'windows' : 'macos'])) {
      this.notify(`${ev.source}:${ev.reason}`, 'bloomterm', ev.message);
    }
    if (ev.type === 'session' && ev.record.state === 'ok') {
      // Signed back in: run anything that was waiting on it.
      setImmediate(() => {
        this.scheduler.tick();
        this.runner.kick();
      });
    }
  }

  private adapterOr404(id: string): BrowserAdapterDef {
    try {
      return this.host.adapter(id);
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  }

  private emit(ev: DaemonEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // a broken subscriber shouldn't break the daemon
      }
    }
  }
}
