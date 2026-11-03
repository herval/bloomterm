import { chmod, readFile } from 'node:fs/promises';
import type { Locator, Page, Response } from 'playwright-core';
import type { RawCapture } from './capture.ts';
import { NeedsLoginError } from './errors.ts';
import { firewallPage } from './firewall.ts';
import type { GuardedRequest } from './guard.ts';
import type { BrowserAdapterDef, CaptureOptions, DownloadedFile, Logger, Snapshot, StrategyContext } from './types.ts';

export interface ContextDeps {
  /** The real page. Adapters only ever see the firewalled one. */
  page: Page;
  adapter: BrowserAdapterDef;
  request: GuardedRequest;
  raw: RawCapture;
  log: Logger;
}

export function makeStrategyContext({ page, adapter, request, raw, log }: ContextDeps): StrategyContext {
  const fwPage = firewallPage(page, { request, allowClickNames: adapter.allowClickNames });

  const fetchJson: StrategyContext['fetchJson'] = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const res = await request.fetch(url, { method, data: init?.data, headers: init?.headers });
    const status = res.status();
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text
    }
    await raw.save(`fetch-${new URL(url).pathname}.json`, { url, method, status, body });
    if (status === 401) throw new NeedsLoginError(`${url} returned 401`);
    if (status >= 400) throw new Error(`${url} returned HTTP ${status}`);
    if (typeof body === 'string') throw new Error(`${url} did not return JSON`);
    return body as any;
  };

  const capture = async (pattern: RegExp, action: () => Promise<unknown>, options: CaptureOptions = {}) => {
    const min = options.min ?? 1;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const bodies: unknown[] = [];
    const pending: Promise<void>[] = [];
    const onResponse = (res: Response) => {
      if (!pattern.test(res.url())) return;
      pending.push(
        res
          .json()
          .then(async (body) => {
            bodies.push(body);
            await raw.save(`capture-${new URL(res.url()).pathname}.json`, { url: res.url(), status: res.status(), body });
          })
          .catch(() => {}),
      );
    };
    page.on('response', onResponse);
    try {
      await action();
      const deadline = Date.now() + timeoutMs;
      while (bodies.length < min && Date.now() < deadline) {
        await Promise.allSettled(pending);
        if (bodies.length < min) await page.waitForTimeout(100);
      }
      await Promise.allSettled(pending);
    } finally {
      page.off('response', onResponse);
    }
    if (bodies.length < min) throw new Error(`captured ${bodies.length} of ${min} responses matching ${pattern}`);
    return bodies;
  };

  const download = async (trigger: Locator | (() => Promise<unknown>), options: { timeoutMs?: number } = {}): Promise<DownloadedFile> => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: options.timeoutMs ?? 60_000 }),
      typeof trigger === 'function' ? trigger() : trigger.click(),
    ]);
    const filename = dl.suggestedFilename();
    const path = await raw.pathFor(filename);
    await dl.saveAs(path);
    await chmod(path, 0o600);
    log.debug('downloaded', { filename });
    return { path, filename, text: () => readFile(path, 'utf8'), buffer: () => readFile(path) };
  };

  const snapshot = async (): Promise<Snapshot> => {
    const snap: Snapshot = {
      url: page.url(),
      title: await page.title(),
      text: await page.locator('body').innerText().catch(() => ''),
      html: await page.content(),
      screenshot: await page.screenshot({ fullPage: true }),
    };
    await raw.save('snapshot.html', snap.html);
    await raw.save('snapshot.png', snap.screenshot);
    return snap;
  };

  return { page: fwPage, request, fetchJson, capture, download, snapshot, raw, log };
}
