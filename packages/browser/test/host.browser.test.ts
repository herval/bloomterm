import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Position } from '@bloomterm/core';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { defineBrowserAdapter } from '../src/define.ts';
import { AllStrategiesFailedError, ChallengeError, CredentialFirewallError, DeniedActionError, MutationBlockedError, NeedsLoginError } from '../src/errors.ts';
import { BrowserHost } from '../src/host.ts';
import { consoleLogger } from '../src/log.ts';
import { POSITIONS, startFakeBank, type FakeBank } from './fake-bank.ts';

// Real Google Chrome (headless) against a local fake bank.

let bank: FakeBank;
let home: string;
let host: BrowserHost;

const positions = z.array(Position);

function adapterFor(base: string) {
  const fail = (msg: string) => async (): Promise<never> => {
    throw new Error(msg);
  };
  return defineBrowserAdapter({
    id: 'fakebank',
    name: 'Fake Bank',
    profile: 'finance',
    origins: [base],
    minIntervalMs: 0,
    maxJobsPerHour: 1_000,
    allowWrites: [{ url: /\/graphql$/, graphql: 'queries-only' }],
    login: {
      url: `${base}/login`,
      successUrl: /\/summary$/,
      check: async ({ request }) => (await request.get(`${base}/api/me`)).ok(),
    },
    datasets: {
      positions: {
        schema: positions,
        strategies: [{ kind: 'request', run: (ctx) => ctx.fetchJson(`${base}/api/positions`) }],
      },
      fallback: {
        schema: positions,
        strategies: [
          { kind: 'request', run: (ctx) => ctx.fetchJson(`${base}/api/broken`) },
          {
            kind: 'download',
            run: async ({ page, download }) => {
              await page.goto(`${base}/summary`);
              const csv = await (await download(page.getByText('Download CSV'))).text();
              return csv
                .trim()
                .split('\n')
                .slice(1)
                .map((line) => {
                  const [account, symbol, qty, value, ccy] = line.split(',');
                  return { accountExternalId: account!, rawSymbol: symbol!, quantity: Number(qty), value: Number(value), currency: ccy! };
                });
            },
          },
        ],
      },
      intercept: {
        schema: positions,
        strategies: [
          {
            kind: 'intercept',
            run: async ({ page, capture }) => {
              const [body] = await capture(/\/api\/positions$/, () => page.goto(`${base}/summary`));
              return body as any;
            },
          },
        ],
      },
      dom: {
        schema: positions,
        checks: [(rows) => (rows.length === 2 ? true : `expected 2 rows, got ${rows.length}`)],
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              const rows = await page.locator('#positions tr').all();
              const out = [];
              for (const row of rows.slice(1)) {
                const [symbol, qty, value, ccy] = await row.locator('td').allInnerTexts();
                out.push({ accountExternalId: 'A1', rawSymbol: symbol!, quantity: Number(qty), value: Number(value), currency: ccy! });
              }
              return out;
            },
          },
        ],
      },
      failsCheck: {
        schema: positions,
        checks: [() => 'totals do not match'],
        strategies: [{ kind: 'request', run: (ctx) => ctx.fetchJson(`${base}/api/positions`) }],
      },
      sneakyTrade: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              return page.evaluate(() => fetch('/api/trade', { method: 'POST', body: '{}' }).then(() => 'sent', () => 'failed'));
            },
          },
          { kind: 'request', run: async () => 'should never get here' },
        ],
      },
      requestWrite: {
        schema: z.any(),
        strategies: [{ kind: 'request', run: async ({ request }) => (await request.post(`${base}/api/trade`, { data: { amount: 1 } })).status() }],
      },
      clickBuy: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              await page.getByRole('button', { name: 'Buy' }).click();
              return 'clicked';
            },
          },
        ],
      },
      clickRefresh: {
        schema: z.string(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              await page.getByRole('button', { name: 'Refresh' }).click();
              return 'clicked';
            },
          },
        ],
      },
      typePassword: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/login`);
              await page.getByLabel('Password').fill('hunter2');
              return 'typed';
            },
          },
        ],
      },
      graphqlRead: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              return page.evaluate(() =>
                fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query P { positions { rawSymbol } }' }) }).then((r) => r.json()),
              );
            },
          },
        ],
      },
      graphqlMutation: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/summary`);
              return page.evaluate(() =>
                fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation T { transfer(amount: 1) { id } }' }) }).then(
                  () => 'sent',
                  () => 'failed',
                ),
              );
            },
          },
        ],
      },
      challenge: {
        schema: z.any(),
        strategies: [
          {
            kind: 'dom',
            run: async ({ page }) => {
              await page.goto(`${base}/challenge`);
              if (await page.getByText("Verify it's you").isVisible()) throw new ChallengeError('verification code requested');
              return 'no challenge';
            },
          },
        ],
      },
      broken: { schema: positions, strategies: [{ kind: 'request', run: fail('nope') }] },
    },
  });
}

function newHost() {
  return new BrowserHost({
    home,
    profiles: { finance: { mode: 'headless', useSystemKeychain: false, cdpUrl: inject('chromeCdpUrl') } },
    interactiveHeadless: true,
    log: consoleLogger('silent'),
  }).register(adapterFor(bank.url));
}

/** Plays the user: waits for the sign-in tab and fills in the form. */
async function signInAsUser(h: BrowserHost) {
  for (let i = 0; i < 100; i++) {
    const page = h
      .runtime('finance')
      .anchor()
      ?.context()
      .pages()
      .find((p) => p.url().endsWith('/login'));
    if (page) {
      await page.getByLabel('Username').fill('herval');
      await page.getByLabel('Password').fill('correct horse');
      await page.getByRole('button', { name: 'Sign in' }).click();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sign-in tab never showed up');
}

beforeAll(async () => {
  bank = await startFakeBank();
  home = await mkdtemp(join(tmpdir(), 'bt-host-'));
  host = newHost();
});

afterAll(async () => {
  await host?.close();
  await bank?.close();
  await rm(home, { recursive: true, force: true });
});

describe('BrowserHost against a fake bank', () => {
  it('starts signed out: probe and run both say needs_login', async () => {
    expect((await host.probe('fakebank')).state).toBe('needs_login');
    await expect(host.run('fakebank', 'positions')).rejects.toBeInstanceOf(NeedsLoginError);
  });

  it('signs in when you finish the login form', async () => {
    const [rec] = await Promise.all([host.login('fakebank', { timeoutMs: 30_000 }), signInAsUser(host)]);
    expect(rec.state).toBe('ok');
    expect((await host.probe('fakebank')).state).toBe('ok');
  });

  it('fetches JSON with the session cookie and keeps a 0700 raw capture', async () => {
    const result = await host.run('fakebank', 'positions');
    expect(result.method).toBe('request');
    expect(result.data).toEqual(POSITIONS);
    expect((await stat(result.rawDir)).mode & 0o777).toBe(0o700);
    const files = await readdir(result.rawDir);
    expect(files.some((f) => f.includes('fetch-'))).toBe(true);
    for (const f of files) expect((await stat(join(result.rawDir, f))).mode & 0o777).toBe(0o600);
  });

  it('falls back to the CSV download when the API fails', async () => {
    const result = await host.run('fakebank', 'fallback');
    expect(result.method).toBe('download');
    expect(result.attempts.map((a) => [a.kind, a.ok])).toEqual([
      ['request', false],
      ['download', true],
    ]);
    expect(result.data).toEqual(POSITIONS);
  });

  it('captures the JSON the page loads (intercept) and reads the table (dom)', async () => {
    expect((await host.run('fakebank', 'intercept')).data).toEqual(POSITIONS);
    expect((await host.run('fakebank', 'dom')).data).toEqual(POSITIONS);
  });

  it('rejects output that fails a sanity check', async () => {
    await expect(host.run('fakebank', 'failsCheck')).rejects.toBeInstanceOf(AllStrategiesFailedError);
  });

  it('blocks a POST to the bank made from page JS, and the job fails', async () => {
    const before = bank.hits['POST /api/trade'] ?? 0;
    await expect(host.run('fakebank', 'sneakyTrade')).rejects.toBeInstanceOf(MutationBlockedError);
    expect(bank.hits['POST /api/trade'] ?? 0).toBe(before);
  });

  it('blocks a POST through ctx.request', async () => {
    await expect(host.run('fakebank', 'requestWrite')).rejects.toBeInstanceOf(MutationBlockedError);
    expect(bank.hits['POST /api/trade'] ?? 0).toBe(0);
  });

  it('refuses to click Buy but clicks harmless buttons', async () => {
    await expect(host.run('fakebank', 'clickBuy')).rejects.toBeInstanceOf(DeniedActionError);
    expect(bank.hits['POST /api/trade'] ?? 0).toBe(0);
    expect((await host.run('fakebank', 'clickRefresh')).data).toBe('clicked');
  });

  it('refuses to type into a password field', async () => {
    await expect(host.run('fakebank', 'typePassword')).rejects.toBeInstanceOf(CredentialFirewallError);
  });

  it('lets GraphQL queries through and blocks mutations', async () => {
    expect((await host.run('fakebank', 'graphqlRead')).data).toMatchObject({ data: { positions: POSITIONS } });
    const before = bank.hits['POST /graphql'] ?? 0;
    await expect(host.run('fakebank', 'graphqlMutation')).rejects.toBeInstanceOf(MutationBlockedError);
    expect(bank.hits['POST /graphql']).toBe(before);
  });

  it('marks the source as challenged when a verification step appears (headless: no window to show)', async () => {
    await expect(host.run('fakebank', 'challenge')).rejects.toBeInstanceOf(ChallengeError);
    expect((await host.sessions.get('fakebank')).state).toBe('challenge');
    expect((await host.probe('fakebank')).state).toBe('ok');
  });

  it('keeps a session cookie when the host restarts (cookies saved with the profile)', async () => {
    await host.close();
    host = newHost();
    expect((await host.probe('fakebank')).state).toBe('ok');
  });
});
