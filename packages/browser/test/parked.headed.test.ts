import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineBrowserAdapter } from '../src/define.ts';
import { ChallengeError } from '../src/errors.ts';
import { BrowserHost } from '../src/host.ts';
import { consoleLogger } from '../src/log.ts';
import { getWindowBounds } from '../src/window.ts';
import { startFakeBank, type FakeBank } from './fake-bank.ts';

// Opt-in: shows real Chrome windows on your screen for a few seconds.
//   BLOOMTERM_HEADED_TESTS=1 pnpm vitest run --project headed

let bank: FakeBank;
let home: string;
let host: BrowserHost;
let challenged = 0;

beforeAll(async () => {
  bank = await startFakeBank();
  home = await mkdtemp(join(tmpdir(), 'bt-headed-'));
  const base = bank.url;
  host = new BrowserHost({
    home,
    // Mock keychain so the test can't trigger a Keychain password prompt.
    profiles: { finance: { mode: 'parked', useSystemKeychain: false } },
    log: consoleLogger('silent'),
    interactiveTimeoutMs: 30_000,
  }).register(
    defineBrowserAdapter({
      id: 'fakebank',
      name: 'Fake Bank',
      profile: 'finance',
      origins: [base],
      minIntervalMs: 0,
      login: { url: `${base}/login`, successUrl: /\/summary$/, check: async ({ request }) => (await request.get(`${base}/api/me`)).ok() },
      datasets: {
        // Hits a verification page the first time only.
        challengeOnce: {
          schema: z.string(),
          strategies: [
            {
              kind: 'dom',
              run: async ({ page }) => {
                if (challenged++ === 0) {
                  await page.goto(`${base}/challenge`);
                  throw new ChallengeError('verification code requested');
                }
                await page.goto(`${base}/summary`);
                // The page sets its title after its own fetch resolves.
                await page.waitForFunction(() => document.title.startsWith('loaded'));
                return page.title();
              },
            },
          ],
        },
      },
    }),
  );
});

afterAll(async () => {
  await host?.close();
  await bank?.close();
  await rm(home, { recursive: true, force: true });
});

const pages = () => host.runtime('finance').anchor()?.context().pages() ?? [];
async function waitForPage(pred: (url: string) => boolean) {
  for (let i = 0; i < 100; i++) {
    const p = pages().find((pg) => pred(pg.url()));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('page never showed up');
}

describe.runIf(process.env.BLOOMTERM_HEADED_TESTS)('parked profile (headed)', () => {
  it('shows the sign-in window, then parks it again', async () => {
    const login = host.login('fakebank');
    const page = await waitForPage((u) => u.endsWith('/login'));
    await page.waitForFunction(() => !!document.getElementById('__bloomterm_banner'));
    // On a screen, not minimized or at the parked strip.
    await expect.poll(async () => getWindowBounds(page), { timeout: 10_000 }).toMatchObject({ windowState: 'normal', left: expect.any(Number) });
    await expect.poll(async () => (await getWindowBounds(page)).left ?? -99_999, { timeout: 10_000 }).toBeGreaterThan(-3000);
    await page.getByLabel('Username').fill('herval');
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect((await login).state).toBe('ok');
    const anchor = host.runtime('finance').anchor()!;
    await expect.poll(async () => (await getWindowBounds(anchor)).windowState, { timeout: 10_000 }).toBe('minimized');
  });

  it('brings the window forward on a challenge and retries once you clear it', async () => {
    const job = host.run<string>('fakebank', 'challengeOnce');
    const page = await waitForPage((u) => u.endsWith('/challenge'));
    await page.waitForFunction(() => !!document.getElementById('__bloomterm_banner'));
    await expect.poll(async () => (await getWindowBounds(page)).windowState, { timeout: 10_000 }).toBe('normal');
    // "You" finish the verification by clicking the banner button.
    await page.locator('#__bloomterm_banner button').click();
    const result = await job;
    expect(result.data).toBe('loaded 2');
    expect((await host.sessions.get('fakebank')).state).toBe('ok');
  });
});
