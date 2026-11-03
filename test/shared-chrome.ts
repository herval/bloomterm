import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { findChrome } from '../packages/browser/src/chrome.ts';

// One headless Chrome for every browser test, left running between runs, so a test run
// never launches or quits Chrome. Each test profile is its own context inside it.
//   pnpm test:chrome:stop   quits it

declare module 'vitest' {
  export interface ProvidedContext {
    chromeCdpUrl: string;
  }
}

const dir = join(homedir(), 'Library', 'Caches', 'bloomterm', 'test-chrome');
const pidFile = join(dir, '..', 'test-chrome.pid');

async function alive(): Promise<string | null> {
  try {
    const port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const url = `http://127.0.0.1:${port}`;
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

export async function sharedChrome(): Promise<string> {
  const running = await alive();
  if (running) return running;
  // The Chrome bloomterm itself would use (packages/browser/src/chrome.ts).
  const chrome = (await findChrome())?.executable;
  if (!chrome) throw new Error('Google Chrome not found: not in /Applications or ~/Applications, and Spotlight doesn’t know it');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rm(join(dir, 'DevToolsActivePort'), { force: true });
  const child = spawn(
    chrome,
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      // Never touch the real Keychain from tests.
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  await writeFile(pidFile, String(child.pid));
  for (let i = 0; i < 100; i++) {
    const url = await alive();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`test Chrome didn't start (profile ${dir})`);
}

export default async function setup(project: TestProject) {
  project.provide('chromeCdpUrl', await sharedChrome());
  // No teardown: the next run reuses it.
}

if (process.argv[2] === 'stop') {
  const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`stopped test Chrome (pid ${pid})`);
    } catch {
      console.log('test Chrome was not running');
    }
  }
  await rm(pidFile, { force: true });
}
