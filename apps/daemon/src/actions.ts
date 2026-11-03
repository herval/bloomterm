import { Account, Balance, fold, Position } from '@bloomterm/core';
import type { Logger } from '@bloomterm/browser';
import type { ChatAction, Store } from '@bloomterm/store';
import { z } from 'zod';
import { checkUrl } from './evolve/inspect.ts';
import { INTEGRATION_ID } from './evolve/workspace.ts';
import { HttpError } from './server.ts';

// What the agent proposes in ASK and only you carry out (SPEC §10.5): it calls a tool, a card
// shows up under its answer, and nothing happens until you click.
// - import: positions or balances it read from a file you attached. Import saves them as a
//   snapshot of their own (method "manual"), which a later fetch of that source replaces.
// - connect: an account at a bank or broker. If bloomterm has its integration, you sign in
//   (LOGIN) and fetch. If not, you open its site in the finance profile and sign in yourself,
//   then EVOLVE maps it read-only, and you review and approve its work. Agents never see passwords.

const Source = z.string().regex(INTEGRATION_ID, 'a lowercase id like "itau" or "banco-inter"');
/** A label or the last digits; a long run of digits is an account number, and doesn't belong here. */
const NoAccountNumbers = (s: string) => !/\d{6,}/.test(s);

export const ImportProposal = z.object({
  kind: z.enum(['positions', 'balances']),
  source: Source,
  title: z.string().trim().min(1).max(200),
  file: z.string().max(40).optional(),
  accounts: z.array(Account).max(50).optional(),
  rows: z.array(z.unknown()).min(1).max(5_000),
});

export const ConnectProposal = z.object({
  institution: z.string().trim().min(2).max(60),
  url: z.string().max(500).optional(),
});

export type ActionStep = 'apply' | 'open' | 'evolve' | 'fetch' | 'dismiss';

export interface ActionDeps {
  store: Store;
  log: Logger;
  emit: (ev: { type: 'chat_action'; chatId: string; action: ChatAction }) => void;
  integrations: () => { id: string; name: string; access: string; secrets: string[]; provides: string[] }[];
  /** Browser integrations bloomd runs, with where they sign in and what they fetch. */
  browser: () => { id: string; name: string; profile: string; loginUrl: string; datasets: { name: string; persist: string | null }[] }[];
  session: (source: string) => string;
  openProfile: (name: string, o: { url: string }) => Promise<unknown>;
  enqueue: (input: { kind: 'login' | 'run'; source: string; dataset?: string }) => { id: string };
  evolve: (input: { integration: string; goal: string }) => Promise<{ chat: { id: string } }>;
}

export class ActionService {
  constructor(private readonly d: ActionDeps) {}

  /** The agent proposes; returns what it should tell you, or why the proposal doesn't hold up. */
  propose(chatId: string, seq: number, body: { kind?: unknown } & Record<string, unknown>): { action: ChatAction; summary: string } {
    const action =
      body.kind === 'connect' ? this.d.store.actions.create({ chatId, seq, kind: 'connect', data: this.connectData(ConnectProposal.parse(body)) }) : this.importAction(chatId, seq, body);
    this.d.emit({ type: 'chat_action', chatId, action });
    return { action, summary: this.summary(action) };
  }

  private importAction(chatId: string, seq: number, body: unknown): ChatAction {
    const p = ImportProposal.parse(body);
    const parsed = (p.kind === 'positions' ? z.array(Position) : z.array(Balance)).safeParse(p.rows);
    if (!parsed.success) throw new HttpError(400, `rows don't match the ${p.kind} schema:\n${z.prettifyError(parsed.error).slice(0, 2_000)}`);
    const rows = parsed.data as (Position | Balance)[];
    const ids = [...rows.map((r) => r.accountExternalId), ...(p.accounts ?? []).map((a) => a.externalId)];
    if (!ids.every(NoAccountNumbers)) throw new HttpError(400, 'account ids look like account numbers; use a label (like "itau-cc") or the last 4 digits');
    if (p.file) {
      const f = this.d.store.files.get(p.file);
      if (!f || f.chatId !== chatId) throw new HttpError(404, `no file ${p.file} in this conversation`);
    }
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const v = 'value' in r ? r.value : r.total;
      totals[r.currency] = Math.round(((totals[r.currency] ?? 0) + v) * 100) / 100;
    }
    const current = p.kind === 'positions' ? this.d.store.holdings.currentPositions(p.source) : this.d.store.holdings.currentBalances(p.source);
    const replaces = current.length ? { rows: current.length, fetchedAt: current[0]!.fetchedAt, method: current[0]!.method } : null;
    return this.d.store.actions.create({ chatId, seq, kind: 'import', data: { ...p, rows, totals, replaces } });
  }

  private connectData(p: z.infer<typeof ConnectProposal>) {
    const f = fold(p.institution);
    const slug = f.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const browser = this.d.browser().find((b) => b.id === slug || fold(b.name).includes(f) || f.includes(fold(b.name)));
    if (browser) return { mode: 'existing', institution: p.institution, integration: browser.id, name: browser.name, profile: browser.profile, url: browser.loginUrl };
    const api = this.d.integrations().find((i) => i.id === slug || fold(i.name).includes(f) || f.includes(fold(i.name)));
    if (api?.secrets.length) return { mode: 'api', institution: p.institution, integration: api.id, name: api.name, secrets: api.secrets };
    if (!INTEGRATION_ID.test(slug)) throw new HttpError(400, `can't make an integration id from "${p.institution}"`);
    if (!p.url) throw new HttpError(400, `bloomterm has no ${p.institution} integration yet; pass its sign-in page as \`url\` so the owner can open it`);
    const url = checkUrl(p.url);
    if (url.protocol !== 'https:') throw new HttpError(400, 'the sign-in page must be https');
    return { mode: 'new', institution: p.institution, integration: slug, name: p.institution, profile: 'finance', url: url.href, host: url.hostname };
  }

  private summary(a: ChatAction): string {
    const d = a.data as any;
    if (a.kind === 'import') {
      return `A card under your answer shows ${d.rows.length} ${d.kind} for "${d.source}" to the owner. Nothing is saved until they click Import${d.replaces ? `; it replaces the ${d.replaces.rows} ${d.kind} from ${d.source} now in bloomterm` : ''}. Tell them to check it.`;
    }
    if (d.mode === 'existing') return `bloomterm has the ${d.name} integration. The card lets the owner sign in (a browser window they type their password into) and then fetch. Tell them that.`;
    if (d.mode === 'api') return `${d.name} connects with an API key (${d.secrets.join(', ')}), not a sign-in. The card links to Settings, where the owner pastes it.`;
    return `No ${d.name} integration yet. The card lets the owner open ${d.host} in bloomterm's finance browser and sign in there themselves, then start EVOLVE, which maps the site read-only; they review its work and approve it before it runs. Tell them that; never ask for their password or codes.`;
  }

  /** A click on a card. */
  async step(id: string, step: ActionStep): Promise<ChatAction> {
    const a = this.d.store.actions.get(id);
    if (!a) throw new HttpError(404, `no action ${id}`);
    if (step === 'dismiss') return this.update(a, { status: 'dismissed' });
    if (a.status !== 'pending') throw new HttpError(409, `this was ${a.status} already`);
    const d = a.data as any;
    const now = new Date().toISOString();
    if (a.kind === 'import') {
      if (step !== 'apply') throw new HttpError(400, `an import can only be applied or dismissed`);
      try {
        return this.update(a, { status: 'done', result: { ...this.apply(a), at: now } });
      } catch (err) {
        return this.update(a, { status: 'failed', error: (err as Error).message });
      }
    }
    if (d.mode === 'api') throw new HttpError(400, `${d.name} uses an API key: add it in Settings`);
    if (step === 'open') {
      if (d.mode === 'existing') return this.update(a, { result: { login: this.d.enqueue({ kind: 'login', source: d.integration }).id, openedAt: now } });
      await this.d.openProfile(d.profile, { url: d.url });
      return this.update(a, { result: { openedAt: now } });
    }
    if (step === 'fetch') {
      if (d.mode !== 'existing') throw new HttpError(400, `${d.name} has no integration to fetch with yet`);
      const ds = this.d.browser().find((b) => b.id === d.integration)?.datasets.filter((x) => x.persist) ?? [];
      const jobs = ds.map((x) => this.d.enqueue({ kind: 'run', source: d.integration, dataset: x.name }).id);
      return this.update(a, { status: 'done', result: { jobs, at: now } });
    }
    if (step === 'evolve') {
      const goal =
        d.mode === 'new'
          ? `Build the ${d.name} integration. The owner signed in at ${d.url} in the ${d.profile} profile from Ask just now. Map their accounts, balances and positions read-only: start with browser_capture on that site, write the adapter, and check every dataset with try_dataset.`
          : `Check ${d.integration} against the live site (the owner just signed in) and fix whatever is broken or missing.`;
      const r = await this.d.evolve({ integration: d.integration, goal });
      return this.update(a, { status: 'done', result: { evolve: { chatId: r.chat.id }, at: now } });
    }
    throw new HttpError(400, `a connect card can open, evolve, fetch or dismiss`);
  }

  /** Saves an import as snapshots of their own: accounts first, then the rows. */
  private apply(a: ChatAction) {
    const d = a.data as z.infer<typeof ImportProposal> & { rows: unknown[] };
    const { store } = this.d;
    const fetchedAt = new Date().toISOString();
    const jobs: string[] = [];
    const save = (kind: 'accounts' | 'positions' | 'balances', rows: unknown[]) => {
      const job = store.jobs.record({ source: d.source, dataset: 'import', method: 'manual', result: { chat: a.chatId, action: a.id, file: d.file ?? null, kind, rows: rows.length } });
      jobs.push(job.id);
      return store.holdings.save(kind, { jobId: job.id, source: d.source, dataset: 'import', method: 'manual', confidence: 'manual', fetchedAt }, rows);
    };
    if (d.accounts?.length) save('accounts', d.accounts);
    const saved = save(d.kind, d.rows);
    this.d.log.info('import saved', { source: d.source, kind: d.kind, rows: saved });
    return { saved, jobs };
  }

  private update(a: ChatAction, patch: Parameters<Store['actions']['update']>[1]): ChatAction {
    const action = this.d.store.actions.update(a.id, patch);
    this.d.emit({ type: 'chat_action', chatId: a.chatId, action });
    return action;
  }
}
