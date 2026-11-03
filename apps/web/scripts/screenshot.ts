// The README's screenshots: the app on made-up demo data, in a throwaway data folder, so nothing
// of yours can show up. It drives the shared headless Chrome the tests use (no windows).
//   make screenshot   →   docs/screenshot.png, docs/screenshot-security.png
// SCREENSHOT_DEBUG=<file.png> saves what the page showed when a step times out.
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@bloomterm/browser';
import { Config, Daemon, memoryStore } from '@bloomterm/daemon';
import { defineIntegration, type MarketFeed, type NewsFeed } from '@bloomterm/integrations';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { sharedChrome } from '../../../test/shared-chrome.ts';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = resolve(web, '../../docs');

// Real tickers at made-up prices: `day` is today's change, `vol` the daily volatility.
const DEMO: Record<string, { name: string; ccy: string; price: number; day: number; vol: number }> = {
  AAPL: { name: 'Apple Inc', ccy: 'USD', price: 231.42, day: 0.008, vol: 0.016 },
  NVDA: { name: 'NVIDIA Corp', ccy: 'USD', price: 182.65, day: 0.034, vol: 0.027 },
  MSFT: { name: 'Microsoft Corp', ccy: 'USD', price: 512.3, day: 0.005, vol: 0.014 },
  SPY: { name: 'SPDR S&P 500 ETF', ccy: 'USD', price: 671.18, day: 0.004, vol: 0.009 },
  QQQ: { name: 'Invesco QQQ Trust', ccy: 'USD', price: 604.77, day: 0.009, vol: 0.012 },
  PETR4: { name: 'Petrobras PN', ccy: 'BRL', price: 31.84, day: -0.021, vol: 0.018 },
  VALE3: { name: 'Vale ON', ccy: 'BRL', price: 61.2, day: 0.016, vol: 0.017 },
  ITUB4: { name: 'Itaú Unibanco PN', ccy: 'BRL', price: 39.57, day: 0.003, vol: 0.012 },
  BBAS3: { name: 'Banco do Brasil ON', ccy: 'BRL', price: 22.91, day: -0.009, vol: 0.016 },
  IBOV: { name: 'Ibovespa', ccy: 'BRL', price: 146_218, day: -0.002, vol: 0.008 },
  USDBRL: { name: 'US Dollar / Brazilian Real', ccy: 'BRL', price: 5.381, day: 0.005, vol: 0.006 },
  BTCUSD: { name: 'Bitcoin', ccy: 'USD', price: 104_310, day: 0.023, vol: 0.028 },
  ETHUSD: { name: 'Ether', ccy: 'USD', price: 3_482, day: 0.041, vol: 0.034 },
};

/** A small seeded PRNG, so every run draws the same charts. */
function rng(seed: string) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 1779033703);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

const DAY = 86_400;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
const round = (x: number) => Math.round(x * (x > 1000 ? 1 : x > 10 ? 100 : 1000)) / (x > 1000 ? 1 : x > 10 ? 100 : 1000);

/** Five years of weekday bars ending today at the demo price, drawn backwards from it. */
const series = new Map<string, { t: number; o: number; h: number; l: number; c: number; v: number }[]>();
function daily(ticker: string) {
  const hit = series.get(ticker);
  if (hit) return hit;
  const d = DEMO[ticker] ?? { name: ticker, ccy: 'USD', price: 100, day: 0, vol: 0.015 };
  const r = rng(ticker);
  const days: number[] = [];
  for (let t = today; days.length < 1300; t -= DAY) if (![0, 6].includes(new Date(t * 1000).getUTCDay()) || ticker.endsWith('USD')) days.unshift(t);
  const closes = new Array<number>(days.length);
  closes[days.length - 1] = d.price;
  closes[days.length - 2] = d.price / (1 + d.day);
  // Drifting up over the years, so the long charts look like a market, and over the last month
  // the way today went, so the month-long sparklines agree with today's change.
  const recent = Math.sign(d.day) * d.vol * 0.25;
  for (let i = days.length - 3; i >= 0; i--) closes[i] = closes[i + 1]! / Math.exp((i > days.length - 24 ? recent : 0.0004) + d.vol * r.normal());
  const bars = days.map((t, i) => {
    const c = closes[i]!;
    const o = i ? closes[i - 1]! * Math.exp(d.vol * 0.3 * r.normal()) : c;
    const h = Math.max(o, c) * (1 + Math.abs(r.normal()) * d.vol * 0.4);
    const l = Math.min(o, c) * (1 - Math.abs(r.normal()) * d.vol * 0.4);
    return { t, o: round(o), h: round(h), l: round(l), c: round(c), v: Math.round(1e6 * (0.6 + r.next())) };
  });
  series.set(ticker, bars);
  return bars;
}

/** Today's session in 5-minute bars, 13:30 to 20:00 UTC: a random walk from yesterday's close, bent to end at today's. */
function session(ticker: string) {
  const bars = daily(ticker);
  const [from, to] = [bars.at(-2)!.c, bars.at(-1)!.c];
  const r = rng(`${ticker} intraday`);
  const vol = (DEMO[ticker]?.vol ?? 0.015) / 9;
  let walk = 0;
  const steps = Array.from({ length: 78 }, () => (walk += vol * r.normal()));
  const start = today + 13.5 * 3600;
  let prev = from;
  return steps.map((w, i) => {
    const c = from * Math.exp(w - (steps.at(-1)! * (i + 1)) / 78 + (Math.log(to / from) * (i + 1)) / 78);
    const o = prev;
    prev = c;
    return { t: start + i * 300, o: round(o), h: round(Math.max(o, c) * (1 + vol / 3)), l: round(Math.min(o, c) * (1 - vol / 3)), c: round(c), v: 10_000 + Math.round(5_000 * r.next()) };
  });
}

const market: MarketFeed = {
  quoteTtlMs: 60_000,
  supports: () => true,
  async quote(sec) {
    const bars = daily(sec.ticker);
    const last = bars.at(-1)!.c;
    const prevClose = bars.at(-2)!.c;
    const d = DEMO[sec.ticker];
    const today = session(sec.ticker);
    return {
      symbol: sec.ticker,
      name: d?.name ?? sec.ticker,
      currency: d?.ccy ?? 'USD',
      last,
      prevClose,
      change: round(last - prevClose),
      changePct: Math.round(((last - prevClose) / prevClose) * 10_000) / 100,
      changeBasis: sec.sector === 'Crypto' ? '24h' : 'prev_close',
      open: today[0]!.o,
      high: Math.max(...today.map((b) => b.h)),
      low: Math.min(...today.map((b) => b.l)),
      volume: today.reduce((sum, b) => sum + b.v, 0),
      asOf: new Date().toISOString(),
      delayMinutes: 0,
    };
  },
  async bars(sec, _range, from) {
    return { bars: daily(sec.ticker).filter((b) => b.t >= from.getTime() / 1000), currency: DEMO[sec.ticker]?.ccy };
  },
  async intraday(sec) {
    return { bars: session(sec.ticker), currency: DEMO[sec.ticker]?.ccy };
  },
};

// Plain market headlines, none of them about anything that happened.
const news: NewsFeed = {
  everyMs: 3_600_000,
  async latest() {
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    return [
      { id: 'd1', headline: 'Chipmakers lead US stocks higher', url: 'https://example.com/d1', outlet: 'CNBC', ts: at(1) },
      { id: 'd2', headline: 'Crude slips as traders weigh supply outlook', url: 'https://example.com/d2', outlet: 'MarketWatch', ts: at(2) },
      { id: 'd3', headline: 'Iron ore firms in Asia on steel demand', url: 'https://example.com/d3', outlet: 'Valor', ts: at(3) },
      { id: 'd4', headline: 'Ibovespa opens flat ahead of the Copom decision', url: 'https://example.com/d4', outlet: 'InfoMoney', ts: at(4) },
      { id: 'd5', headline: 'Bitcoin climbs back above 100,000', url: 'https://example.com/d5', outlet: 'Exame', ts: at(5) },
      { id: 'd6', headline: 'Treasury yields steady before jobs data', url: 'https://example.com/d6', outlet: 'MarketWatch', ts: at(6) },
    ];
  },
};

const DEMO_AGENT = { kind: 'claude' as const, path: join(web, 'scripts/demo-agent.mjs'), version: 'demo' };

const home = await mkdtemp(join(tmpdir(), 'bt-screenshot-'));
const cdpUrl = await sharedChrome();
await chmod(DEMO_AGENT.path, 0o755);
const webRoot = join(home, 'web');
await build({ root: web, configFile: join(web, 'vite.config.ts'), logLevel: 'silent', build: { outDir: webRoot, emptyOutDir: true } });

const daemon = new Daemon({
  home,
  port: 0,
  integrations: [
    defineIntegration({ id: 'demo', name: 'Demo market', covers: 'made-up prices', access: 'api', status: 'ready', market: () => market }),
    defineIntegration({ id: 'demo-news', name: 'Demo news', covers: 'made-up headlines', access: 'api', status: 'ready', news: () => news }),
  ],
  config: Config.parse({}),
  host: { profiles: { finance: { mode: 'headless', useSystemKeychain: false, cdpUrl } } },
  secrets: memoryStore(),
  webRoot,
  downloads: join(home, 'Downloads'),
  agent: DEMO_AGENT,
  setup: { agents: async () => [DEMO_AGENT], signedIn: async () => true, chrome: async () => ({ app: null, executable: '/Applications/Google Chrome.app', how: 'applications' as const }) },
  notify: false,
  schedulerIntervalMs: 3_600_000,
  briefTickMs: 0,
  log: consoleLogger('silent'),
});
await daemon.start();

// A demo portfolio: a US broker and a Brazilian one, valued at the demo prices.
const fetchedAt = new Date().toISOString();
const hold = (source: string, kind: 'accounts' | 'positions' | 'balances', rows: unknown[]) => {
  const job = daemon.store.jobs.record({ source, dataset: 'demo', method: 'manual', result: { demo: true } });
  daemon.store.holdings.save(kind, { jobId: job.id, source, dataset: 'demo', method: 'manual', confidence: 'manual', fetchedAt }, rows);
};
const pos = (account: string, symbol: string, quantity: number) => {
  const d = DEMO[symbol]!;
  return { accountExternalId: account, rawSymbol: symbol, name: d.name, quantity, price: d.price, value: Math.round(quantity * d.price * 100) / 100, currency: d.ccy };
};
hold('demo-us', 'accounts', [{ externalId: 'us', institution: 'Demo Brokerage', name: 'Individual', type: 'brokerage', currency: 'USD' }]);
hold('demo-us', 'positions', [pos('us', 'AAPL', 40), pos('us', 'NVDA', 60), pos('us', 'SPY', 25), pos('us', 'BTCUSD', 0.15), pos('us', 'ETHUSD', 2)]);
hold('demo-us', 'balances', [{ accountExternalId: 'us', cash: 4_200, total: 4_200, currency: 'USD' }]);
hold('demo-br', 'accounts', [{ externalId: 'br', institution: 'Corretora Demo', name: 'Conta', type: 'brokerage', currency: 'BRL' }]);
hold('demo-br', 'positions', [pos('br', 'PETR4', 800), pos('br', 'VALE3', 300), pos('br', 'ITUB4', 500), pos('br', 'BBAS3', 400)]);
hold('demo-br', 'balances', [{ accountExternalId: 'br', cash: 12_500, total: 12_500, currency: 'BRL' }]);

const token = (await readFile(join(home, 'token'), 'utf8')).trim();
const base = `http://127.0.0.1:${daemon.port}`;
const code = (await (await fetch(`${base}/api/ui/code`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as { code: string };

const browser = await chromium.connectOverCDP(cdpUrl);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await context.newPage();
try {
  await mkdir(docs, { recursive: true });
  await page.goto(`${base}/#code=${code.code}`);
  await page.locator('.phead h1', { hasText: 'Today' }).waitFor();
  const brief = page.locator('.card.brief');
  await brief.getByRole('button', { name: /Write it now/ }).click();
  await brief.locator('.brief-body', { hasText: 'Chipmakers' }).waitFor();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: join(docs, 'screenshot.png') });

  // Shorter, since a security's page ends sooner.
  await page.setViewportSize({ width: 1440, height: 780 });
  await page.goto(`${base}/s/NVDA?range=1Y`);
  await page.locator('.bigchart canvas').first().waitFor();
  await page.getByRole('button', { name: 'Explain' }).click();
  await page.getByText('Chipmakers rallied').waitFor();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: join(docs, 'screenshot-security.png') });
  console.log(`screenshot: ${join(docs, 'screenshot.png')}, ${join(docs, 'screenshot-security.png')}`);
} catch (err) {
  if (process.env.SCREENSHOT_DEBUG) {
    await page.screenshot({ path: process.env.SCREENSHOT_DEBUG });
    console.error(await page.locator('.card.brief').textContent().catch(() => '(no brief card)'));
  }
  throw err;
} finally {
  await context.close();
  await browser.close();
  await daemon.stop();
  await rm(home, { recursive: true, force: true });
}
