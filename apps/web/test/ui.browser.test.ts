import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger, defineBrowserAdapter, z } from '@bloomterm/browser';
import { Config, Daemon, memoryStore, type SetupProbes } from '@bloomterm/daemon';
import { defineIntegration, type MarketFeed, type NewsFeed } from '@bloomterm/integrations';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

// The UI end to end: built with Vite, served by a real bloomd with fake market data, fake
// news and a fake agent CLI, driven in the shared headless Chrome (no windows, no network).
// BLOOMTERM_UI_BROWSER=webkit drives a headless WebKit instead, the desktop app's engine.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let home: string;
let daemon: Daemon;
let token: string;
let browser: Browser;
let page: Page;

const fakeMarket: MarketFeed = {
  quoteTtlMs: 1_000,
  supports: (sec) => sec.sector === 'Equity' || sec.sector === 'Crypto',
  async quote(sec) {
    const last = sec.ticker.length * 10 + 0.5;
    return { symbol: sec.ticker, name: `${sec.ticker} Inc`, currency: 'USD', last, prevClose: last - 1, change: 1, changePct: 2, changeBasis: 'prev_close', asOf: new Date().toISOString(), delayMinutes: 0 };
  },
  async bars(_sec, _range, from) {
    const start = Math.floor(from.getTime() / 86_400_000) * 86_400;
    return { bars: Array.from({ length: 260 }, (_, i) => ({ t: start + i * 86_400, o: 100 + i, h: 103 + i, l: 99 + i, c: 101 + i, v: 1_000 + i })) };
  },
  // Today's session from 13:30 UTC, 78 five-minute bars.
  async intraday() {
    const start = Math.floor(Date.now() / 86_400_000) * 86_400 + 13.5 * 3600;
    return { bars: Array.from({ length: 78 }, (_, i) => ({ t: start + i * 300, o: 40 + i / 10, h: 40.3 + i / 10, l: 39.9 + i / 10, c: 40.1 + i / 10, v: 500 })) };
  },
};

// Two outlets on the same Petrobras news (the fake agent groups them into one story), and one other.
const fakeNews: NewsFeed = {
  everyMs: 3_600_000,
  async latest() {
    const ts = new Date().toISOString();
    return [
      { id: 'n1', headline: 'Petrobras raises its 2026 output target', url: 'https://example.com/1', outlet: 'Valor', ts },
      { id: 'n2', headline: 'Petrobras eleva meta de produção', url: 'https://example.com/2', outlet: 'InfoMoney', ts, lang: 'pt' },
      { id: 'n3', headline: 'Copom holds the Selic rate', url: 'https://example.com/3', outlet: 'Exame', ts },
    ];
  },
};

const adapter = defineBrowserAdapter({
  id: 'fakebank',
  name: 'Fake Bank',
  profile: 'finance',
  origins: ['http://127.0.0.1:1'],
  login: { url: 'http://127.0.0.1:1/login', check: async () => false },
  datasets: { me: { schema: z.object({ user: z.string() }), strategies: [{ kind: 'request', run: async () => ({ user: 'x' }) }] } },
});

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
};

const FAKE_AGENT = { kind: 'claude' as const, path: join(root, '../../test/fake-agent.mjs'), version: 'fake 1.0' };
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** What Setup finds on this "Mac": everything, unless a test takes something away. */
function fakeMac(agents: (typeof FAKE_AGENT)[]) {
  const mac = { agents, signedIn: true as boolean | null, chrome: CHROME as string | null };
  const probes: SetupProbes = {
    agents: async () => mac.agents,
    signedIn: async () => mac.signedIn,
    chrome: async () => (mac.chrome ? { app: null, executable: mac.chrome, how: 'applications' as const } : null),
  };
  return { mac, probes };
}
const setupMac = fakeMac([FAKE_AGENT]);

/** A browser that says it's on a Mac or Windows, whichever machine runs this, and sizes the page. */
async function contextOn(platform: 'MacIntel' | 'Win32') {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript((p) => Object.defineProperty(navigator, 'platform', { value: p }), platform);
  return context;
}

const panel = (n: number) => page.locator(`[data-panel="${n}"]`);
async function command(text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-ui-'));
  const webRoot = join(home, 'web');
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: webRoot, emptyOutDir: true } });
  daemon = new Daemon({
    home,
    port: 0,
    integrations: [
      defineIntegration({ id: 'fake', name: 'Fake market', covers: 'everything, made up', access: 'api', status: 'ready', secrets: [{ name: 'fake-token', label: 'Fake token', covers: 'more made-up data', signup: 'https://example.com' }], market: () => fakeMarket }),
      defineIntegration({ id: 'fakebank', name: 'Fake Bank', covers: 'a fake bank', access: 'browser', status: 'ready', browser: adapter }),
      defineIntegration({ id: 'fakenews', name: 'Fake news', covers: 'made-up headlines', access: 'api', status: 'ready', news: () => fakeNews }),
    ],
    config: Config.parse({}),
    host: { profiles: { finance: { mode: 'headless', useSystemKeychain: false, cdpUrl: inject('chromeCdpUrl') } } },
    secrets: memoryStore(),
    webRoot,
    downloads: join(home, 'Downloads'),
    agent: FAKE_AGENT,
    setup: setupMac.probes,
    notify: false,
    schedulerIntervalMs: 3_600_000,
    // The brief is written when the test asks for it, not by the 07:00 schedule.
    briefTickMs: 0,
    log: consoleLogger('silent'),
  });
  await daemon.start();
  token = (await readFile(join(home, 'token'), 'utf8')).trim();
  browser = process.env.BLOOMTERM_UI_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.connectOverCDP(inject('chromeCdpUrl'));
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (err) => console.error('[page]', err.message));
});

afterAll(async () => {
  await browser?.close();
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
});

const sidebar = (name: string) => page.locator('.sidebar').getByRole('link', { name, exact: true });

/** Signs the page in with a fresh one-time code and waits for Today, so a block can run on its own. */
async function signIn() {
  const { body } = await call('POST', '/api/ui/code');
  await page.goto(`http://127.0.0.1:${daemon.port}/#code=${body.code}`);
  await page.locator('.phead h1', { hasText: 'Today' }).waitFor();
}

describe('the app', () => {
  it('asks you to use bt ui when the browser has no token', async () => {
    await page.goto(`http://127.0.0.1:${daemon.port}/`);
    await expect.poll(() => page.locator('.signin').textContent()).toContain('pnpm bt ui');
  });

  it('signs in with a one-time code, which only works once', async () => {
    const { body } = await call('POST', '/api/ui/code');
    // Same page, new fragment: a link from `bt ui` landing in an open tab.
    await page.goto(`http://127.0.0.1:${daemon.port}/#code=${body.code}`);
    await expect.poll(() => page.locator('.phead h1').textContent()).toBe('Today');
    expect(page.url()).not.toContain('code=');
    expect((await call('POST', '/api/ui/session', { code: body.code })).status).toBe(401);
    await expect.poll(() => page.getByRole('img', { name: 'bloomd connected' }).count()).toBe(1);
  });

  it('gives every page a URL, and Back walks through them', async () => {
    await sidebar('Markets').click();
    await expect.poll(() => page.url()).toMatch(/\/markets$/);
    const row = page.locator('.tbl tr', { hasText: 'AAPL Inc' });
    await expect.poll(() => row.textContent()).toContain('40.50');
    await row.getByRole('link', { name: 'AAPL', exact: true }).click();
    await expect.poll(() => page.url()).toMatch(/\/s\/AAPL$/);
    await expect.poll(() => page.locator('.sh-title h1').textContent()).toBe('AAPL');
    await expect.poll(() => page.locator('.bigchart canvas').count()).toBeGreaterThan(0);
    await page.goBack();
    await expect.poll(() => page.url()).toMatch(/\/markets$/);
    // A page's URL works on its own: bloomd serves the app for it.
    await page.goto(`http://127.0.0.1:${daemon.port}/s/NVDA?range=1Y`);
    await expect.poll(() => page.locator('.sh-title h1').textContent()).toBe('NVDA');
    await expect.poll(() => page.locator('.chartcard .seg button.on').first().textContent()).toBe('1Y');
    expect(await page.title()).toBe('NVDA · bloomterm');
    // Beside today's change, the change over the range: 40.50 now, against the first bar's open of 100.
    await expect.poll(() => page.getByLabel('Change over the range').textContent()).toBe('-59.50 (-59.50%)past year');
    // Scrolled or zoomed back to its first bar, the chart loads older ones: 5Y, then all of it.
    const legend = () => page.locator('.chartcard .legend').textContent();
    await expect.poll(legend).toContain('260 days');
    const box = (await page.locator('.bigchart').boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(legend).toContain('520 days');
    // The view stays on the same bars, so it takes zooming out to reach the new first one.
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 400);
        return legend();
      })
      .toContain('780 days');
    // The range's own change doesn't move with the older bars.
    expect(await page.getByLabel('Change over the range').textContent()).toBe('-59.50 (-59.50%)past year');
    await page.locator('.chartcard .seg button', { hasText: '5D' }).click();
    await expect.poll(() => page.getByLabel('Change over the range').textContent()).toContain('past 5 days');
    // 1D: today's session in 5-minute bars, with no change of its own (today's is beside the price) and no SMAs.
    await page.locator('.chartcard .seg button', { hasText: '1D' }).click();
    await expect.poll(legend).toContain('fake · 5-min bars');
    await expect.poll(() => page.locator('.bigchart canvas').count()).toBeGreaterThan(0);
    expect(await page.getByLabel('Change over the range').count()).toBe(0);
    expect(await page.locator('.chartcard').getByRole('button', { name: 'SMA' }).count()).toBe(0);
  });

  it('finds securities and runs mnemonics from ⌘K', async () => {
    const input = page.getByRole('textbox', { name: 'Search or ask' });
    await page.keyboard.press('Control+k');
    await input.fill('vale');
    await expect.poll(() => page.locator('.pitem.sel').textContent()).toContain('VALE3');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toMatch(/\/s\/VALE3$/);

    await page.keyboard.press('Control+k');
    await input.fill('aapl gp 5y');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toMatch(/\/s\/AAPL\?range=5Y$/);

    // Typing outside a field starts a search.
    await page.keyboard.press('m');
    await expect.poll(() => input.inputValue()).toBe('m');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.palette').count()).toBe(0);
  });

  it('groups the news into stories with the agent, tags them, and shows them on the security', async () => {
    await sidebar('News').click();
    const story = page.locator('.story', { hasText: 'Petrobras output (fake agent)' });
    await expect.poll(() => story.count(), { timeout: 15_000 }).toBe(1);
    await story.click();
    await expect.poll(() => page.url()).toContain('story=');
    const detail = page.locator('.story-card');
    await expect.poll(() => detail.locator('.newsrow').count()).toBe(2);
    expect(await detail.textContent()).toContain('2 outlets');
    // The tag the agent made up ("nonsense") is gone; PETR4 leads to its page, with the same news.
    expect(await detail.locator('.chips').first().textContent()).not.toContain('nonsense');
    await detail.locator('.chips').first().getByRole('link', { name: /PETR4/ }).click();
    await expect.poll(() => page.url()).toMatch(/\/s\/PETR4$/);
    await expect.poll(() => page.locator('.newsrow').count()).toBe(2);
    // A chip on a security's own news goes to the other security's page.
    await page.locator('.newsrow .chips').first().getByRole('link', { name: /PETR3/ }).click();
    await expect.poll(() => page.url()).toMatch(/\/s\/PETR3$/);
    await expect.poll(() => page.locator('.sh-title h1').textContent()).toBe('PETR3');
  });

  it('writes the brief with your agent, and says why a mover moved', async () => {
    await sidebar('Today').click();
    const brief = page.locator('.card.brief');
    await brief.getByRole('button', { name: /Write it now/ }).click();
    await expect.poll(() => brief.locator('.brief-body').textContent()).toContain('Markets mixed (fake brief)');
    // News on what you watch is here too.
    await expect.poll(() => page.locator('.card', { hasText: 'News for you' }).locator('.story').count()).toBeGreaterThan(0);

    const mover = page.locator('.mover').first();
    await mover.getByRole('button', { name: 'Why?' }).click();
    await expect.poll(() => mover.locator('.whybox').textContent()).toContain('It moved with its market (fake agent).');

    // A ticker you follow, in the brief, opens its page.
    await brief.getByRole('button', { name: 'PETR4' }).click();
    await expect.poll(() => page.url()).toMatch(/\/s\/PETR4$/);
  });

  it('asks in the drawer, answers with live widgets, and pins the answer to Today', async () => {
    await sidebar('Today').click();
    await page.keyboard.press('Control+j');
    const drawer = page.locator('.drawer');
    await drawer.getByLabel('Ask a question').fill('How is PETR4 doing?');
    await page.keyboard.press('Enter');
    const answer = drawer.locator('.a').last();
    await expect.poll(() => answer.textContent()).toContain('You asked: How is PETR4 doing?');
    await expect.poll(() => drawer.locator('.tile').first().textContent()).toContain('PETR4');
    // A table with long cells wraps to fit the drawer; nothing scrolls sideways.
    await expect.poll(() => answer.locator('.md-table td').last().textContent()).toContain('how to fill it.');
    expect(await drawer.locator('.askbody').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await answer.locator('.md-wrap').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await drawer.getByRole('button', { name: /Pin to Today/ }).click();
    await expect.poll(() => page.locator('.pin .pt').textContent()).toBe('How is PETR4 doing?');
    // Pins are kept in bloomd (saved a moment after the change).
    await expect.poll(async () => (await call('GET', '/api/ui/state/pins')).body.value?.length).toBe(1);
    await drawer.getByRole('button', { name: 'Close Ask' }).click();
    await expect.poll(() => drawer.count()).toBe(0);
  });

  it('fits a phone: a tab bar instead of the sidebar, nothing wider than the screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator('.sidebar').isVisible()).toBe(false);
    await page.locator('.tabbar').getByRole('link', { name: 'News' }).click();
    await expect.poll(() => page.url()).toMatch(/\/news$/);
    await page.locator('.tabbar').getByRole('link', { name: 'Today' }).click();
    await expect.poll(() => page.locator('.card.brief').count()).toBe(1);
    expect(await page.evaluate(() => document.querySelector('.page')!.scrollWidth - document.querySelector('.page')!.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1600, height: 1000 });
  });

  it('keeps the terminal: four panels on one board', async () => {
    await sidebar('Terminal').click();
    await expect.poll(() => page.locator('.panel').count()).toBe(4);
  });

  it('shows the watchlist with quotes, and says why a row has none', async () => {
    const w = panel(2);
    await expect.poll(() => w.locator('tbody tr').count()).toBeGreaterThan(5);
    await expect.poll(() => w.locator('tr', { hasText: 'AAPL US Equity' }).textContent()).toContain('40.50');
    await expect.poll(() => w.locator('tr', { hasText: 'IBOV Index' }).textContent()).toContain('no source for IBOV Index');
  });

  it('runs a command in the active panel and moves the linked panels with it', async () => {
    await command('aapl gp 5y');
    await expect.poll(() => panel(2).locator('.ph').textContent()).toContain('GP');
    await expect.poll(() => panel(2).locator('.ranges .on').textContent()).toBe('5Y');
    await expect.poll(() => panel(2).locator('.chart canvas').count()).toBeGreaterThan(0);
    // Panels 1 (GP) and 3 (OV) are in link group A with it.
    await expect.poll(() => panel(1).locator('.psec').textContent()).toBe('AAPL US Equity');
    await expect.poll(() => panel(3).locator('.psec').textContent()).toBe('AAPL US Equity');
    // Esc goes back to the watchlist.
    await page.keyboard.press('Escape');
    await expect.poll(() => panel(2).locator('.pfn').textContent()).toBe('W');
  });

  it('drills into a numbered row', async () => {
    await command('3');
    await expect.poll(() => panel(3).locator('.psec').textContent()).toBe('SPY US Equity');
    await expect.poll(() => panel(3).locator('.big').first().textContent()).toBe('30.50');
  });

  it('edits the watchlist from the command line', async () => {
    await command('W ADD msft');
    await expect.poll(() => panel(2).locator('tr', { hasText: 'MSFT US Equity' }).count()).toBe(1);
    await expect.poll(() => page.locator('.msg').textContent()).toContain('added MSFT US Equity');
  });

  it('explains what it did not understand', async () => {
    await command('petrobras');
    await expect.poll(() => page.locator('.msg.error').textContent()).toContain('Unknown security or function "petrobras"');
  });

  it('answers questions in an ASK panel, streaming, with commands you can click', async () => {
    await page.keyboard.press('Control+3');
    await command('how is PETR4 doing today');
    await expect.poll(() => panel(3).locator('.pfn').textContent()).toBe('ASK');
    const answer = () => panel(3).locator('.a').last();
    await expect.poll(() => answer().textContent()).toContain('You asked: how is PETR4 doing today');
    await expect.poll(() => answer().locator('.tool').first().textContent()).toContain('get_quotes');
    await expect.poll(() => answer().locator('.md-table td').first().textContent()).toBe('PETR4');
    expect(await answer().locator('b').textContent()).toBe('52.55');
    await expect.poll(() => answer().textContent()).toContain('how to fill it.');

    // The command line keeps the conversation going.
    await command('and VALE3?');
    await expect.poll(() => answer().textContent()).toContain('(continuing) You asked: and VALE3?');
    await expect.poll(() => panel(3).locator('.q').count()).toBe(2);

    // A command in the answer opens in another panel; the conversation stays put.
    await answer().getByRole('button', { name: 'PETR4 GP 1Y' }).click();
    await expect.poll(() => panel(4).locator('.pfn').textContent()).toBe('GP');
    expect(await panel(4).locator('.psec').textContent()).toBe('PETR4 BZ Equity');
    expect(await panel(3).locator('.pfn').textContent()).toBe('ASK');

    // Esc in ASK goes back to what the panel showed before.
    await page.keyboard.press('Control+3');
    await page.keyboard.press('Escape');
    await expect.poll(() => panel(3).locator('.pfn').textContent()).toBe('OV');
  });

  it('runs EVOLVE from the command line, and runs its work only once you review and approve it', async () => {
    await page.keyboard.press('Control+3');
    await command('EVOLVE newbank map the positions page');
    await expect.poll(() => panel(3).locator('.pfn').textContent()).toBe('ASK');
    await expect.poll(() => panel(3).locator('.evolve-head').textContent()).toMatch(/EVOLVE newbank\s*new/);
    await expect.poll(() => panel(3).locator('.a').last().textContent()).toContain('Mapped newbank');
    const foot = panel(3).locator('.evolve-foot');
    await expect.poll(() => foot.textContent(), { timeout: 20_000 }).toContain("bloomd's checks: ✓ loads · ✓ typecheck · ✓ tests · ✓ README");
    expect(await panel(3).locator('.tool').allTextContents()).toEqual([expect.stringContaining('prepare'), expect.stringContaining('Write'), expect.stringContaining('check')]);

    // Approve shows up once you've looked at the diff, and approves what it showed.
    expect(await foot.getByRole('button', { name: 'Approve newbank' }).count()).toBe(0);
    await foot.getByRole('button', { name: 'Review diff' }).click();
    await expect.poll(() => foot.locator('pre.diff').textContent()).toContain('+++ b/index.ts');
    expect(await foot.locator('pre.diff .add').count()).toBeGreaterThan(5);
    expect(await foot.textContent()).not.toContain('stray.txt');
    await foot.getByRole('button', { name: 'Approve newbank' }).click();
    await expect.poll(() => foot.textContent()).toContain('✓ approved');
    // This bloomd runs in a test, not under launchd or the desktop app: no restart button.
    expect(await foot.textContent()).toContain('restart bloomd to run it');
    expect(await readFile(join(home, 'integrations/newbank/index.ts'), 'utf8')).toContain("id: 'newbank'");

    // EVOLVE alone lists runs, tagged, alongside ASK chats.
    await command('EVOLVE');
    await expect.poll(() => panel(3).locator('.tag').first().textContent()).toBe('EVOLVE newbank');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  it('saves an API key from SET without ever sending it back', async () => {
    await page.keyboard.press('Control+4');
    await command('SET');
    await expect.poll(() => panel(4).locator('.pfn').textContent()).toBe('SET');
    const row = panel(4).locator('tr', { hasText: 'Fake token' });
    await expect.poll(() => row.textContent()).toContain('not set');
    await row.getByLabel('Fake token').fill('test-token-123456');
    await row.getByRole('button', { name: 'save' }).click();
    await expect.poll(() => row.locator('td').nth(2).textContent()).toBe('set');
    expect(await daemon.secrets.get('fake-token')).toBe('test-token-123456');
    const listed = await call('GET', '/api/settings/secrets');
    expect(JSON.stringify(listed.body)).not.toContain('test-token-123456');
    expect(listed.body.find((s: any) => s.name === 'fake-token').from).toBe('keychain');
    // A paste with spaces is refused.
    expect((await call('PUT', '/api/settings/secrets/fake-token', { value: 'not a key' })).status).toBe(400);
    expect((await call('PUT', '/api/settings/secrets/github', { value: 'abcdefghijk' })).status).toBe(400);
  });

  it('opens a browser profile from SET', async () => {
    // Answered here instead of by bloomd: a real open holds the profile until its tab closes.
    const opened: string[] = [];
    await page.route('**/api/profiles/*/open', (route) => {
      opened.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 202, contentType: 'application/json', body: '{"profile":"finance"}' });
    });
    const row = panel(4).locator('tr', { has: page.getByRole('button', { name: 'open' }) }).filter({ hasText: 'finance' });
    await expect.poll(() => row.textContent()).toContain('Fake Bank');
    await row.getByRole('button', { name: 'open' }).click();
    await expect.poll(() => page.locator('.msg').textContent()).toContain('opened the finance profile');
    expect(opened).toEqual(['/api/profiles/finance/open']);
    await page.unroute('**/api/profiles/*/open');
  });

  it('keeps the layout in bloomd across reloads', async () => {
    await page.waitForTimeout(600); // the layout saves 400ms after a change
    await page.reload();
    await expect.poll(() => panel(4).locator('.pfn').textContent()).toBe('SET');
    expect((await call('GET', '/api/ui/state/watchlists')).body.value.lists.Core).toContain('MSFT US Equity');
  });

  it('resizes panels by dragging the dividers, and keeps the sizes', async () => {
    const sizes = async () => (await call('GET', '/api/ui/state/layout')).body.value.sizes;
    const box = async (n: number) => (await panel(n).boundingBox())!;
    const main = (await page.locator('.panels').boundingBox())!;
    const y = main.y + 200;

    // Left/right: drag the vertical divider to 70%.
    const col = (await page.locator('.split.col').boundingBox())!;
    const before = (await box(1)).width;
    await page.mouse.move(col.x + col.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(main.x + main.width * 0.7, y, { steps: 5 });
    await page.mouse.up();
    expect((await box(1)).width).toBeGreaterThan(before * 1.3);
    expect((await box(3)).width).toBe((await box(1)).width);
    await expect.poll(async () => (await sizes())?.col ?? 0).toBeGreaterThan(0.65);

    // Top/bottom of the right column only: drag its divider up to 30%.
    const row = (await page.locator('.pcol').nth(1).locator('.split.row').boundingBox())!;
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width / 2, main.y + main.height * 0.3, { steps: 5 });
    await page.mouse.up();
    expect((await box(2)).height).toBeLessThan((await box(4)).height * 0.6);
    expect(Math.abs((await box(1)).height - (await box(3)).height)).toBeLessThan(3);
    await expect.poll(async () => (await sizes())?.rows[1] ?? 1).toBeLessThan(0.35);

    await page.reload();
    await expect.poll(async () => (await panel(1).boundingBox())?.width ?? 0).toBeGreaterThan(main.width * 0.65);

    // Double-click evens it out.
    const again = (await page.locator('.split.col').boundingBox())!;
    await page.mouse.dblclick(again.x + again.width / 2, y);
    await expect.poll(async () => (await sizes())?.col).toBe(0.5);

    // Maximize still shows one panel, and restores all four.
    await page.keyboard.press('Control+m');
    await expect.poll(() => page.locator('.panel:visible').count()).toBe(1);
    await page.keyboard.press('Control+m');
    await expect.poll(() => page.locator('.panel:visible').count()).toBe(4);
  });

  it('refuses other origins and serves the page with a strict CSP', async () => {
    expect((await call('GET', '/api/status', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/status', undefined, { origin: `http://127.0.0.1:${daemon.port}` })).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain('<div id="root">');
    // The page itself is public, the API isn't.
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/status`)).status).toBe(401);
  });
});

describe('files and cards in Ask', () => {
  const opened: string[] = [];
  beforeAll(async () => {
    // "Open sign-in" would show a real window; record it instead.
    daemon.openProfile = async (name, o) => (opened.push(`${name} ${o.url}`), { profile: name });
    await signIn();
    await page.keyboard.press('Control+j');
    await drawer().waitFor();
  });
  const drawer = () => page.locator('.drawer');
  const csv = (name: string, text: string, enc: BufferEncoding = 'utf8') => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, enc) });

  it('attaches a spreadsheet, and imports what the agent found only when you click Import', async () => {
    await drawer().getByLabel('Attach spreadsheets').setInputFiles(csv('carteira.csv', 'Ticker;Qtd;Valor\nPETR4;100;5.255,00\nVALE3;50;3.100,50\n'));
    await expect.poll(() => drawer().getByLabel('Attached files').textContent()).toContain('carteira.csv3 rows');
    await drawer().getByLabel('Ask a question').fill('import these positions');
    await page.keyboard.press('Enter');
    const card = drawer().getByLabel('Import 2 positions');
    await expect.poll(() => card.textContent(), { timeout: 20_000 }).toContain('Total 8,355.50 BRL');
    expect(await drawer().locator('.qfiles').textContent()).toContain('carteira.csv');
    expect((await call('GET', '/api/positions?source=fakebank')).body).toEqual([]);
    await card.getByRole('button', { name: 'Import' }).click();
    await expect.poll(() => card.textContent()).toContain('Imported 2 positions');
    expect((await call('GET', '/api/positions?source=fakebank')).body.map((p: any) => p.rawSymbol)).toEqual(['PETR4', 'VALE3']);
  });

  it('reads a bank export and hands back a workbook to download', async () => {
    await drawer().getByRole('button', { name: 'New' }).click();
    await drawer().getByLabel('Attach spreadsheets').setInputFiles(csv('extrato.csv', 'Data;Descrição;Valor\n01/10/2026;PIX recebido;1.234,56\n02/10/2026;Cartão;-89,90\n02/10/2026;Cartão;-10,10\n', 'latin1'));
    await expect.poll(() => drawer().getByLabel('Attached files').textContent()).toContain('4 rows');
    await page.keyboard.press('Enter'); // a file alone is a question too
    const out = drawer().getByRole('button', { name: 'Download totals.xlsx' });
    await expect.poll(() => out.count(), { timeout: 20_000 }).toBe(1);
    expect(await drawer().locator('.md-table').last().textContent()).toContain('Cartão-1002');
    const [file] = await Promise.all([page.waitForEvent('download'), out.click()]);
    expect(file.suggestedFilename()).toBe('totals.xlsx');
  });

  it('connects a bank: the sign-in window opens only on your click, then EVOLVE maps it', async () => {
    await drawer().getByRole('button', { name: 'New' }).click();
    await drawer().getByLabel('Ask a question').fill('connect my bank account');
    await page.keyboard.press('Enter');
    const card = drawer().getByLabel('Connect Banco Exemplo');
    await expect.poll(() => card.textContent(), { timeout: 20_000 }).toContain('banco.example.com');
    expect(opened).toEqual([]);
    await card.getByRole('button', { name: 'Open sign-in window' }).click();
    await expect.poll(() => opened).toEqual(['finance https://banco.example.com/login']);
    await card.getByRole('button', { name: 'Map it with EVOLVE' }).click();
    await expect.poll(() => card.getByRole('link', { name: /EVOLVE banco-exemplo/ }).count()).toBe(1);
    await expect.poll(() => card.textContent(), { timeout: 20_000 }).toContain('checks pass; review it');
    await drawer().getByRole('button', { name: 'Close Ask' }).click();
  });
});

describe('themes', () => {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  it('is light unless you pick dark, from the top bar, Settings or ⌘K, and remembers it', async () => {
    await signIn();
    await page.evaluate(() => localStorage.removeItem('bloomterm.theme'));
    await page.reload();
    await expect.poll(() => page.locator('.phead h1').textContent()).toBe('Today');
    expect(await theme()).toBe('light');
    expect(await bg()).toBe('rgb(244, 245, 247)');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect(await theme()).toBe('dark');
    expect(await bg()).toBe('rgb(11, 13, 16)');
    await page.reload();
    await expect.poll(() => page.locator('.phead h1').textContent()).toBe('Today');
    expect(await theme()).toBe('dark');

    await sidebar('Settings').click();
    const themes = page.getByRole('radiogroup', { name: 'Theme' });
    expect(await themes.getByRole('radio', { checked: true }).textContent()).toBe('Dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await themes.getByRole('radio', { name: 'System' }).click();
    expect(await theme()).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(theme).toBe('dark');
    await themes.getByRole('radio', { name: 'Light' }).click();
    expect(await theme()).toBe('light');
    await page.emulateMedia({ colorScheme: null });

    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: 'Search or ask' }).fill('dark');
    await page.getByRole('option', { name: /Switch to dark theme/ }).click();
    expect(await theme()).toBe('dark');
    expect(await page.evaluate(() => localStorage.getItem('bloomterm.theme'))).toBe('dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
  });
});

describe('in the desktop app', () => {
  // apps/desktop sets this before the page loads.
  let desk: Page;
  beforeAll(async () => {
    const context = await contextOn('MacIntel');
    await context.addInitScript(() => ((window as any).__BLOOMTERM_DESKTOP__ = true));
    desk = await context.newPage();
  });
  afterAll(() => desk.context().close());
  const menu = (detail: unknown) => desk.evaluate((d) => window.dispatchEvent(new CustomEvent('bloomterm:desktop', { detail: d })), detail);

  it('says where to sign in again', async () => {
    await desk.goto(`http://127.0.0.1:${daemon.port}/`);
    await expect.poll(() => desk.locator('.signin').textContent()).toContain('Open bloomterm in the menu bar');
  });

  it('opens pages and Ask from the menu bar', async () => {
    const { body } = await call('POST', '/api/ui/code');
    await desk.goto(`http://127.0.0.1:${daemon.port}/#code=${body.code}`);
    await desk.locator('.phead h1', { hasText: 'Today' }).waitFor();
    await menu({ go: '/sources' });
    await expect.poll(() => desk.url()).toMatch(/\/sources$/);
    expect(await desk.locator('.drawer').count()).toBe(0);
    await menu({ ask: true });
    await desk.locator('.drawer').waitFor();
  });

  it('saves a download into Downloads, since its web view saves nothing', async () => {
    // The workbook the agent wrote in "files and cards in Ask".
    const chats = (await call('GET', '/api/chats?kind=ask')).body as { id: string }[];
    const withFile: string[] = [];
    for (const c of chats) if ((await call('GET', `/api/chats/${c.id}`)).body.files.some((f: any) => f.name === 'totals.xlsx')) withFile.push(c.id);
    await desk.goto(`http://127.0.0.1:${daemon.port}/ask/${withFile[0]}`);
    await desk.getByRole('button', { name: 'Download totals.xlsx' }).click();
    await expect.poll(() => desk.locator('.toast').last().textContent()).toContain(`Saved to ${join(home, 'Downloads/totals.xlsx')}`);
    expect((await readFile(join(home, 'Downloads/totals.xlsx'))).length).toBeGreaterThan(1000);
  });
});

describe('setup', () => {
  // A second bloomd that started before any agent CLI was installed, on a Mac without Chrome.
  let bare: Daemon;
  let bareHome: string;
  let bareToken: string;
  let fresh: Page;
  const bareMac = fakeMac([]);
  const restart = vi.fn();
  const step = (p: Page, n: number) => p.locator('.setupstep').nth(n);
  const chip = (p: Page) => p.locator('.topbar').getByRole('link', { name: 'Finish setup' });
  const freshPage = async (platform: 'MacIntel' | 'Win32' = 'MacIntel') => (await contextOn(platform)).newPage();
  const signInTo = async (p: Page, d: Daemon, t: string) => {
    const res = await fetch(`http://127.0.0.1:${d.port}/api/ui/code`, { method: 'POST', headers: { authorization: `Bearer ${t}` } });
    const { code } = (await res.json()) as { code: string };
    await p.goto(`http://127.0.0.1:${d.port}/#code=${code}`);
  };

  beforeAll(async () => {
    bareMac.mac.chrome = null;
    bareHome = await mkdtemp(join(tmpdir(), 'bt-ui-bare-'));
    bare = new Daemon({
      home: bareHome,
      port: 0,
      integrations: [defineIntegration({ id: 'fake', name: 'Fake market', covers: 'everything, made up', access: 'api', status: 'ready', market: () => fakeMarket })],
      config: Config.parse({}),
      host: { profiles: {} },
      secrets: memoryStore(),
      webRoot: join(home, 'web'),
      agent: null,
      setup: bareMac.probes,
      restart,
      notify: false,
      schedulerIntervalMs: 3_600_000,
      briefTickMs: 0,
      log: consoleLogger('silent'),
    });
    await bare.start();
    bareToken = (await readFile(join(bareHome, 'token'), 'utf8')).trim();
    fresh = await freshPage();
  });

  afterAll(async () => {
    await fresh?.context().close();
    await bare?.stop();
    await rm(bareHome, { recursive: true, force: true });
  });

  it('opens by itself the first time, and says what to install', async () => {
    await signInTo(fresh, bare, bareToken);
    await fresh.locator('.phead h1', { hasText: 'Setup' }).waitFor();
    expect(fresh.url()).toMatch(/\/setup$/);
    expect(await step(fresh, 0).locator('.steptitle').textContent()).toBe('Install Claude Code or Codex');
    expect(await step(fresh, 0).textContent()).toContain(process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'npm i -g @anthropic-ai/claude-code && claude');
    expect(await step(fresh, 1).locator('.steptitle').textContent()).toBe('Install Google Chrome');
    expect(await step(fresh, 1).getByRole('link', { name: /Get Chrome/ }).getAttribute('href')).toBe('https://www.google.com/chrome/');
    await chip(fresh).waitFor();

    // Only the first time: Today stays Today after that, with the chip to come back.
    await fresh.locator('.sidebar').getByRole('link', { name: 'Today', exact: true }).click();
    await fresh.locator('.phead h1', { hasText: 'Today' }).waitFor();
    await fresh.reload();
    await fresh.locator('.phead h1', { hasText: 'Today' }).waitFor();
    await fresh.locator('.topbar').getByRole('button', { name: /no agent/ }).click();
    await fresh.locator('.phead h1', { hasText: 'Setup' }).waitFor();
  });

  it('restarts bloomd to use an agent installed since, once you check again', async () => {
    bareMac.mac.agents = [FAKE_AGENT];
    bareMac.mac.chrome = CHROME;
    await fresh.getByRole('button', { name: 'Check again' }).click();
    await fresh.getByRole('button', { name: 'Restarting bloomd…' }).waitFor();
    await expect.poll(() => restart.mock.calls.length).toBe(1);
    expect(await step(fresh, 0).locator('.steptitle').textContent()).toBe('Claude Code is installed');
    expect(await step(fresh, 1).getAttribute('class')).toContain('ok');
    expect(await step(fresh, 1).textContent()).toContain('/Applications/Google Chrome.app');
  });

  it('asks you to sign in to the agent, and is done once you have', async () => {
    setupMac.mac.signedIn = false;
    const p = await freshPage();
    try {
      // You signed out of Claude Code in a terminal; bloomd notices when it checks next.
      await call('POST', '/api/setup/check');
      await signInTo(p, daemon, token);
      await p.locator('.phead h1', { hasText: 'Setup' }).waitFor();
      expect(await step(p, 0).locator('.steptitle').textContent()).toBe('Sign in to Claude Code');
      expect(await step(p, 0).locator('.shellcmd code').textContent()).toContain('auth login');
      await chip(p).waitFor();

      setupMac.mac.signedIn = true;
      await p.getByRole('button', { name: 'Check again' }).click();
      await p.getByText('All set.').waitFor();
      expect(await step(p, 0).locator('.steptitle').textContent()).toBe('Claude Code fake, signed in');
      await expect.poll(() => chip(p).count()).toBe(0);

      // Once it's all set, Settings says which Chrome, and links back here.
      await p.locator('.sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
      await expect.poll(() => p.locator('.settings').textContent()).toContain('Chrome: /Applications/Google Chrome.app.');
      await p.locator('.settings').getByRole('link', { name: 'Setup' }).click();
      await p.locator('.phead h1', { hasText: 'Setup' }).waitFor();
    } finally {
      setupMac.mac.signedIn = true;
      await p.context().close();
    }
  });

  it('fits a phone', async () => {
    // The widest it gets: nothing installed, so both install commands show.
    bareMac.mac.agents = [];
    bareMac.mac.chrome = null;
    await fetch(`http://127.0.0.1:${bare.port}/api/setup/check`, { method: 'POST', headers: { authorization: `Bearer ${bareToken}` } });
    await fresh.setViewportSize({ width: 390, height: 844 });
    await fresh.goto(`http://127.0.0.1:${bare.port}/setup`);
    await fresh.locator('.setupsteps').waitFor();
    await chip(fresh).waitFor();
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The card clips what overflows it, so the page's width alone doesn't show a command running
    // off its edge: nothing in it may end past it. Commands show as typed, not in capitals.
    const past = await fresh.evaluate(() => {
      const edge = document.querySelector('.setup .card')!.getBoundingClientRect().right;
      return [...document.querySelectorAll('.setup .card *')].filter((e) => e.getBoundingClientRect().right > edge + 0.5).map((e) => e.className || e.tagName);
    });
    expect(past).toEqual([]);
    expect(await fresh.locator('.shellcmd code').first().evaluate((e) => getComputedStyle(e).textTransform)).toBe('none');
  });

  it('talks like Windows on Windows', async () => {
    bareMac.mac.agents = [];
    bareMac.mac.chrome = null;
    await fetch(`http://127.0.0.1:${bare.port}/api/setup/check`, { method: 'POST', headers: { authorization: `Bearer ${bareToken}` } });
    const p = await freshPage('Win32');
    try {
      await signInTo(p, bare, bareToken);
      await p.locator('.phead h1', { hasText: 'Setup' }).waitFor();
      expect(await p.locator('.phead').textContent()).toContain('what bloomterm needs on this PC');
      expect(await step(p, 0).textContent()).toContain('Install one in PowerShell, from the Start menu:');
      expect(await p.locator('.searchbox kbd').textContent()).toBe('Ctrl+K');

      await p.keyboard.press('Control+k');
      await expect.poll(() => p.locator('body').innerText()).toContain('Ctrl+↵');
      await p.keyboard.press('Escape');

      for (const path of ['setup', 'settings', 'help']) {
        await p.goto(`http://127.0.0.1:${bare.port}/${path}`);
        await p.locator('.phead h1').waitFor();
        expect(await p.locator('body').innerText()).not.toMatch(/⌘|this Mac|Keychain|macOS|menu bar|in Terminal/i);
      }
      await p.goto(`http://127.0.0.1:${bare.port}/settings`);
      await expect.poll(() => p.locator('.settings').innerText()).toContain('close it');
      expect(await p.locator('.phead').textContent()).toContain('API keys live in your Windows Credential Manager');
    } finally {
      await p.context().close();
    }
  });
});
