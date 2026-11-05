import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore, type Store } from '../src/index.ts';

let dir: string;
let store: Store;
let clock: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bt-store-'));
  clock = new Date('2026-10-28T12:00:00Z');
  store = openStore(join(dir, 'bloomterm.db'), { now: () => clock });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const tick = (ms: number) => (clock = new Date(clock.getTime() + ms));

describe('database', () => {
  it('migrates to the latest schema and keeps files private', async () => {
    expect(store.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'bloomterm.db'))).mode & 0o777).toBe(0o600); // Windows has no such modes
    store.close();
    store = openStore(join(dir, 'bloomterm.db'));
    expect(store.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });

  it('refuses a database from a newer build', () => {
    store.db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    store.close();
    expect(() => openStore(join(dir, 'bloomterm.db'))).toThrow(/newer than this build/);
    store = openStore(':memory:');
  });
});

describe('sessions', () => {
  it('runs the state machine and persists it', async () => {
    expect((await store.sessions.get('b3')).state).toBe('unknown');
    await store.sessions.apply('b3', { type: 'probe_logged_out' });
    await store.sessions.apply('b3', { type: 'login_ok' });
    const rec = await store.sessions.apply('b3', { type: 'job_ok' }, new Date('2026-10-28T13:00:00Z'));
    expect(rec).toMatchObject({ state: 'ok', lastOk: '2026-10-28T13:00:00.000Z', errorStreak: 0 });
    expect((await store.sessions.all()).map((r) => r.source)).toEqual(['b3']);
  });
});

describe('jobs', () => {
  it('dedupes, claims by priority, and finishes', () => {
    const a = store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: 'positions', trigger: 'schedule' });
    expect(a.created).toBe(true);
    expect(store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: 'positions' })).toMatchObject({ created: false, job: { id: a.job.id } });
    tick(1);
    const probe = store.jobs.enqueue({ kind: 'probe', source: 'chase', priority: 10 }).job;

    expect(store.jobs.claimNext()?.id).toBe(probe.id);
    tick(1_500);
    const done = store.jobs.finish(probe.id, { status: 'ok', result: { state: 'ok' } });
    expect(done).toMatchObject({ status: 'ok', durationMs: 1_500 });
    expect(store.jobs.get(probe.id, { withResult: true })?.result).toEqual({ state: 'ok' });

    // `accept` can hold a job back (e.g. its profile is busy)
    expect(store.jobs.claimNext(() => false)).toBeNull();
    expect(store.jobs.claimNext()?.id).toBe(a.job.id);
    // A running job still dedupes
    expect(store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: 'positions' }).created).toBe(false);
  });

  it('recovers after a restart: runs go back in the queue, sign-ins fail', () => {
    const run = store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: 'positions' }).job;
    const login = store.jobs.enqueue({ kind: 'login', source: 'nubank' }).job;
    store.jobs.claimNext();
    store.jobs.claimNext();
    expect(store.jobs.recover()).toEqual({ requeued: 1, failed: 1 });
    expect(store.jobs.get(run.id)?.status).toBe('queued');
    expect(store.jobs.get(login.id)).toMatchObject({ status: 'failed', error: 'bloomd restarted during the sign-in' });
  });

  it('reports the last successful run of a dataset', () => {
    const j = store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: 'positions' }).job;
    store.jobs.claimNext();
    expect(store.jobs.lastOk('b3', 'positions')).toBeNull();
    store.jobs.finish(j.id, { status: 'ok' });
    expect(store.jobs.lastOk('b3', 'positions')).toBe(clock.toISOString());
  });
});

describe('holdings', () => {
  const meta = (jobId: string, fetchedAt: string) => ({ jobId, source: 'b3', dataset: 'positions', method: 'download', confidence: 'high', fetchedAt });
  const finishedJob = () => {
    const j = store.jobs.enqueue({ kind: 'run', source: 'b3', dataset: `positions` }).job;
    store.jobs.claimNext();
    store.jobs.finish(j.id, { status: 'ok' });
    return j.id;
  };

  it('keeps every snapshot and serves the latest, with provenance', () => {
    const first = finishedJob();
    store.holdings.save('positions', meta(first, '2026-10-27T12:00:00Z'), [
      { accountExternalId: 'XP', rawSymbol: 'PETR4', quantity: 100, value: 3812, currency: 'BRL' },
      { accountExternalId: 'XP', rawSymbol: 'TESOURO IPCA+ 2035', quantity: 1.5, value: 4900, currency: 'BRL', indexer: 'IPCA', rate: 6.1, maturity: '2035-05-15' },
    ]);
    const second = finishedJob();
    store.holdings.save('positions', meta(second, '2026-10-28T12:00:00Z'), [
      { accountExternalId: 'XP', rawSymbol: 'PETR4', quantity: 200, value: 7624, currency: 'BRL' },
    ]);
    const current = store.holdings.currentPositions();
    expect(current).toEqual([
      { source: 'b3', accountExternalId: 'XP', rawSymbol: 'PETR4', quantity: 200, value: 7624, currency: 'BRL', method: 'download', confidence: 'high', fetchedAt: '2026-10-28T12:00:00Z' },
    ]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM position').get()).toEqual({ n: 3 });
    expect(store.holdings.accounts()).toMatchObject([{ source: 'b3', externalId: 'XP' }]);
  });

  it('treats an empty fetch as "no positions now", not "no data"', () => {
    store.holdings.save('positions', meta(finishedJob(), '2026-10-27T12:00:00Z'), [
      { accountExternalId: 'XP', rawSymbol: 'PETR4', quantity: 1, value: 38, currency: 'BRL' },
    ]);
    store.holdings.save('positions', meta(finishedJob(), '2026-10-28T12:00:00Z'), []);
    expect(store.holdings.currentPositions()).toEqual([]);
  });

  it('rejects rows that do not match the schema', () => {
    expect(() => store.holdings.save('positions', meta(finishedJob(), '2026-10-28T12:00:00Z'), [{ rawSymbol: 'X' }])).toThrow();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  });

  it('stores balances and account details', () => {
    const j = finishedJob();
    store.holdings.save('accounts', { ...meta(j, '2026-10-28T12:00:00Z'), dataset: 'accounts' }, [
      { externalId: 'CARD', institution: 'Chase', name: 'Sapphire', type: 'credit_card', currency: 'USD', mask: '1234' },
    ]);
    const k = finishedJob();
    store.holdings.save('balances', { ...meta(k, '2026-10-28T12:00:00Z'), dataset: 'balances' }, [
      { accountExternalId: 'CARD', total: -812.4, currency: 'USD', statementBalance: 640.1, creditLimit: 10_000, dueDate: '2026-11-15' },
    ]);
    expect(store.holdings.currentBalances()).toMatchObject([{ accountExternalId: 'CARD', total: -812.4, dueDate: '2026-11-15', method: 'download' }]);
    expect(store.holdings.accounts()).toMatchObject([{ externalId: 'CARD', name: 'Sapphire', mask: '1234' }]);
  });
});

describe('news', () => {
  const item = (id: string, ts: string, headline: string, outlet = 'Example Wire') => ({ source: 'rss', id, ts, headline, outlet, url: `https://news.example.com/${id}`, kind: 'news' as const, lang: 'en' });

  it('stores each item once and says which were new', () => {
    expect(store.news.insert([item('1', '2026-10-28T10:00:00Z', 'A'), item('2', '2026-10-28T11:00:00Z', 'B')], clock.toISOString())).toEqual(['rss:1', 'rss:2']);
    expect(store.news.insert([item('2', '2026-10-28T11:00:00Z', 'B'), item('3', '2026-10-28T11:30:00Z', 'C')], clock.toISOString())).toEqual(['rss:3']);
    expect(store.news.list().map((n) => n.id)).toEqual(['rss:3', 'rss:2', 'rss:1']);
    expect(store.news.counts()).toEqual([{ source: 'rss', items: 3, latest: '2026-10-28T11:30:00Z' }]);
  });

  it('finds items by security, words and time, and keeps a tag’s first origin', () => {
    store.news.insert([item('1', '2026-10-28T10:00:00Z', 'Petrobras raises output'), item('2', '2026-10-28T11:00:00Z', '100% sure_thing')], clock.toISOString());
    store.news.tag('rss:1', ['PETR4 BZ Equity', 'PETR3 BZ Equity'], 'source');
    store.news.tag('rss:1', ['PETR4 BZ Equity'], 'rule');
    expect(store.news.get('rss:1')!.tags).toEqual(expect.arrayContaining([{ security: 'PETR4 BZ Equity', by: 'source' }]));
    expect(store.news.list({ securities: ['PETR3 BZ Equity'] }).map((n) => n.id)).toEqual(['rss:1']);
    expect(store.news.list({ q: 'raises petrobras' }).map((n) => n.id)).toEqual(['rss:1']);
    expect(store.news.list({ q: '%' }).map((n) => n.id)).toEqual(['rss:2']);
    expect(store.news.list({ since: '2026-10-28T10:30:00Z' }).map((n) => n.id)).toEqual(['rss:2']);
    store.news.retag('rss:1', ['VALE3 BZ Equity']);
    expect(store.news.get('rss:1')!.tags.map((t) => `${t.security}/${t.by}`).sort()).toEqual(['PETR3 BZ Equity/source', 'PETR4 BZ Equity/source', 'VALE3 BZ Equity/agent']);
  });

  it('groups items into stories, ranked by outlets or recency', () => {
    store.news.insert([item('1', '2026-10-28T09:00:00Z', 'Rates held', 'A'), item('2', '2026-10-28T09:30:00Z', 'Rates held again', 'B'), item('3', '2026-10-28T11:00:00Z', 'Oil up', 'A')], clock.toISOString());
    store.news.createStory({ id: 's1', title: 'Rates held', by: 'rule' }, clock.toISOString());
    store.news.createStory({ id: 's2', title: 'Oil up', by: 'rule' }, clock.toISOString());
    store.news.assign('rss:1', 's1');
    store.news.assign('rss:2', 's1');
    store.news.assign('rss:3', 's2');
    store.news.tag('rss:3', ['XOM US Equity'], 'rule');
    const since = '2026-10-28T00:00:00Z';
    expect(store.news.stories({ since }).map((s) => s.id)).toEqual(['s2', 's1']);
    const [top] = store.news.stories({ since, rank: 'top' });
    expect(top).toMatchObject({ id: 's1', outlets: ['B', 'A'], firstTs: '2026-10-28T09:00:00Z', lastTs: '2026-10-28T09:30:00Z' });
    expect(top!.items).toHaveLength(2);
    expect(store.news.stories({ since, securities: ['XOM US Equity'] }).map((s) => s.id)).toEqual(['s2']);
    store.news.updateStory('s2', { title: 'Oil climbs', summary: 'Crude rose.' }, clock.toISOString());
    expect(store.news.stories({ since, securities: ['XOM US Equity'] })[0]).toMatchObject({ title: 'Oil climbs', summary: 'Crude rose.', by: 'agent' });
    expect(store.news.prune('2026-10-28T10:00:00Z')).toBe(2);
    expect(store.news.stories({ since }).map((s) => s.id)).toEqual(['s2']);
  });

  it('tracks what the agent has looked at', () => {
    store.news.insert([item('1', '2026-10-28T10:00:00Z', 'A'), item('2', '2026-10-28T11:00:00Z', 'B')], clock.toISOString());
    store.news.markAi(['rss:2'], clock.toISOString());
    expect(store.news.pendingAi(10, '2026-10-27T00:00:00Z').map((n) => n.id)).toEqual(['rss:1']);
  });
});

describe('insights', () => {
  it('keeps the last good text while a new one is written, and fails runs bloomd lost', () => {
    store.insights.start('brief', '2026-10-28', 'claude');
    expect(store.insights.get('brief', '2026-10-28')).toMatchObject({ status: 'running', text: '' });
    tick(1000);
    store.insights.finish('brief', '2026-10-28', { status: 'done', text: '- Up 1%', data: { cites: ['rss:1'] } });
    store.insights.start('brief', '2026-10-28', 'codex');
    expect(store.insights.get('brief', '2026-10-28')).toMatchObject({ status: 'running', text: '- Up 1%', agent: 'codex' });
    store.insights.finish('brief', '2026-10-28', { status: 'error', error: 'timed out' });
    expect(store.insights.get('brief', '2026-10-28')).toMatchObject({ status: 'error', text: '- Up 1%', error: 'timed out', data: { cites: ['rss:1'] } });
    store.insights.start('why', '2026-10-28|PETR4 BZ Equity', 'claude');
    expect(store.insights.recover()).toBe(1);
    expect(store.insights.latest('brief', { done: false })?.key).toBe('2026-10-28');
  });
});
