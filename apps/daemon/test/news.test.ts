import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@bloomterm/browser';
import { defineIntegration, ProviderError, type NewsData } from '@bloomterm/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Config } from '../src/config.ts';
import { Daemon, type DaemonEvent } from '../src/daemon.ts';
import { bullets, InsightService, localDay } from '../src/insights.ts';
import { memoryStore } from '../src/market/secrets.ts';
import { parseEnrich } from '../src/news/enrich.ts';
import { fakeMarket } from './fakes.ts';

// News and the agent's writing, end to end through bloomd's API: a made-up feed, the fake
// agent CLI, no network.

const FAKE_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fake-agent.mjs');

let home: string;
let daemon: Daemon;
let token: string;
const events: DaemonEvent[] = [];
let feed: NewsData[] = [];
let failing = false;
let asked: string[] = [];

const fakeNews = defineIntegration({
  id: 'fakenews',
  name: 'Fake news',
  covers: 'made-up headlines',
  access: 'api',
  status: 'ready',
  news: () => ({
    everyMs: 60_000,
    async latest({ securities }) {
      asked = securities.map((s) => s.key);
      if (failing) throw new ProviderError('fakenews', 'fakenews is down');
      return feed;
    },
  }),
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-news-'));
  daemon = new Daemon({
    home,
    port: 0,
    integrations: [fakeMarket, fakeNews],
    config: Config.parse({}),
    host: { profiles: {} },
    secrets: memoryStore(),
    agent: { kind: 'claude', path: FAKE_AGENT, version: 'fake' },
    notify: false,
    newsTickMs: 0,
    briefTickMs: 0,
    // The agent groups stories when a test asks it to, not after every refresh.
    newsEnrichEveryMs: Infinity,
    log: consoleLogger('silent'),
  });
  await daemon.start();
  daemon.subscribe((e) => events.push(e));
  token = (await readFile(join(home, 'token'), 'utf8')).trim();
});

afterAll(async () => {
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
});

describe('news', () => {
  it('stores, tags and groups what a feed returns, once', async () => {
    feed = [
      { id: '1', headline: 'Petrobras raises third-quarter oil output to a record', url: 'https://news.example.com/1', outlet: 'Wire A', ts: ago(50), lang: 'en' },
      { id: '2', headline: "Petrobras' third-quarter oil output hits record", url: 'https://news.example.com/2', outlet: 'Wire B', ts: ago(40), lang: 'en' },
      { id: '3', headline: 'Central bank holds rates', url: 'https://news.example.com/3', outlet: 'Wire A', ts: ago(30), tickers: ['USDBRL Curncy'] },
      { id: '4', headline: 'No link here', url: 'javascript:alert(1)', outlet: 'Wire A' },
      { id: '5', headline: 'From the future', url: 'https://news.example.com/5', outlet: 'Wire A', ts: new Date(Date.now() + 86_400_000).toISOString() },
    ];
    const [status] = (await api('POST', '/api/news/refresh')).body;
    expect(status).toMatchObject({ id: 'fakenews', error: null, added: 4 });
    // It asked about what you follow: the default watchlist.
    expect(asked).toContain('PETR4 BZ Equity');
    expect(events).toContainEqual({ type: 'news', added: 4, sources: ['fakenews'] });

    const items = (await api('GET', '/api/news?security=petr4')).body;
    expect(items.map((i: any) => i.id)).toEqual(['fakenews:2', 'fakenews:1']);
    expect(items[0].tags).toEqual(expect.arrayContaining([{ security: 'PETR4 BZ Equity', by: 'rule' }]));
    expect((await api('GET', '/api/news?q=central')).body[0].tags).toEqual([{ security: 'USDBRL Curncy', by: 'source' }]);
    expect(Date.parse((await api('GET', '/api/news?q=future')).body[0].ts)).toBeLessThanOrEqual(Date.now());

    const stories = (await api('GET', '/api/news/stories?for=me')).body;
    const petro = stories.find((s: any) => s.items.length === 2);
    expect(petro).toMatchObject({ title: 'Petrobras raises third-quarter oil output to a record', by: 'rule', outlets: ['Wire B', 'Wire A'] });

    expect((await api('POST', '/api/news/refresh')).body[0].added).toBe(0);
  });

  it('lets the agent regroup, retitle and retag, keeping only keys that parse', async () => {
    const r = await daemon.news.enrich();
    expect(r).toMatchObject({ items: 4 });
    const stories = (await api('GET', '/api/news/stories?security=PETR3')).body;
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ title: 'Petrobras output (fake agent)', summary: 'Grouped by the fake agent.', by: 'agent' });
    const tags = (await api('GET', '/api/news?security=PETR4')).body[0].tags.map((t: any) => `${t.security}/${t.by}`).sort();
    expect(tags).toEqual(['PETR3 BZ Equity/agent', 'PETR4 BZ Equity/agent']);
    // The source's own tags stay, whatever the agent says.
    expect((await api('GET', '/api/news?q=central')).body[0].tags).toEqual([{ security: 'USDBRL Curncy', by: 'source' }]);
    expect(await daemon.news.enrich()).toBeNull();
  });

  it('reports a failing feed and says so where the brief looks', async () => {
    failing = true;
    const [status] = (await api('POST', '/api/news/refresh')).body;
    expect(status).toMatchObject({ error: 'fakenews is down' });
    expect(daemon.needsAttention()).toContain('Fake news: fakenews is down');
    failing = false;
    await api('POST', '/api/news/refresh');
    expect(daemon.needsAttention()).toEqual([]);
  });

  it('reads the agent’s answer defensively', () => {
    const input = { items: [{ ref: 'n1', headline: 'a', outlet: 'x', ts: '', lang: null, tags: [] }, { ref: 'n2', headline: 'b', outlet: 'x', ts: '', lang: null, tags: [] }], stories: [{ ref: 's1', title: 'old' }] };
    const out = parseEnrich('Sure! {"stories":[{"ref":"s9","title":"A","items":["n1","n7"]},{"ref":"s1","title":"B","items":["n1","n2"]}],"tags":{"n2":["petr4","???"],"n8":["AAPL"]}} hope that helps', input);
    expect(out).toEqual({ stories: [{ ref: undefined, title: 'A', summary: undefined, items: ['n1'] }, { ref: 's1', title: 'B', summary: undefined, items: ['n2'] }], tags: { n2: ['PETR4 BZ Equity'] } });
    expect(() => parseEnrich('no json here', input)).toThrow('without JSON');
  });
});

describe('the brief and why things moved', () => {
  it('writes the brief on demand, keeping only the bullets', async () => {
    const started = await api('POST', '/api/brief');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: 'brief', key: localDay(new Date()), status: 'running' });
    await expect.poll(async () => (await api('GET', '/api/brief')).body.brief.status, { timeout: 10_000 }).toBe('done');
    const { brief } = (await api('GET', '/api/brief')).body;
    expect(brief.text).toBe('- Markets mixed (fake brief).\n- PETR4 led your movers (fake brief).');
    expect(brief.agent).toBe('claude');
    expect(brief.data).toMatchObject({ day: localDay(new Date()), markets: expect.any(Number) });
    expect(events.filter((e) => e.type === 'insight').map((e: any) => e.insight.status)).toEqual(['running', 'done']);
  });

  it('explains a move, citing only news it was given', async () => {
    const r = await api('POST', '/api/why', { key: 'PETR4' });
    expect(r.status).toBe(202);
    const key = 'PETR4 BZ Equity';
    await expect.poll(async () => (await api('GET', `/api/why?keys=${encodeURIComponent('petr4,AAPL')}`)).body[key]?.status, { timeout: 10_000 }).toBe('done');
    const all = (await api('GET', '/api/why?keys=PETR4,AAPL')).body;
    expect(all['AAPL US Equity']).toBeNull();
    expect(all[key]).toMatchObject({ text: 'It moved with its market (fake agent).', data: { changePct: 2, cites: ['fakenews:2'] } });
    expect((await api('POST', '/api/why', { key: '???' })).status).toBe(400);
  });

  it('writes the brief once its time has passed on a weekday, and retries a failure later', async () => {
    // In the past: the test above writes today's real brief to this store, and a brief is one per day.
    let now = new Date(2025, 10, 5, 6, 30); // a Wednesday, before 07:00
    let runs = 0;
    const insights = new InsightService({
      store: daemon.store,
      quotes: async () => [],
      closes: async () => [],
      followed: () => [],
      agent: () => ({ kind: 'claude', run: async () => (++runs === 1 ? { ok: false, error: 'boom', text: '', sessionId: null, agent: 'claude' } : { ok: true, text: '- ok', sessionId: null, agent: 'claude' }) }),
      config: { enabled: true, cron: '0 7 * * 1-5', sharePortfolio: true },
      health: () => [],
      log: consoleLogger('silent'),
      emit: () => {},
      now: () => now,
    });
    expect(await insights.tick()).toBeNull();
    now = new Date(2025, 10, 5, 7, 5);
    expect(await insights.tick()).toMatchObject({ status: 'error', error: 'boom' });
    now = new Date(2025, 10, 5, 7, 20);
    expect(await insights.tick()).toBeNull();
    now = new Date(2025, 10, 5, 7, 40);
    expect(await insights.tick()).toMatchObject({ status: 'done', text: '- ok' });
    expect(await insights.tick()).toBeNull();
    now = new Date(2025, 10, 8, 9, 0); // Saturday
    expect(await insights.tick()).toBeNull();
    expect(runs).toBe(2);
  });

  it('keeps bullets out of prose', () => {
    expect(bullets('Sure:\n* one\n• two\nThanks')).toBe('- one\n- two');
    expect(bullets('just text')).toBe('just text');
  });
});
