import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserHost, consoleLogger } from '../src/index.ts';

// openPlain with a stand-in for Chrome: it writes down its arguments and "quits" when the test
// drops a file next to the profile. No real Chrome, no windows.

let home: string;
let stub: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bloomterm-plain-'));
  stub = join(home, 'chrome.sh');
  await writeFile(stub, '#!/bin/sh\nd="${1#--user-data-dir=}"\necho "$@" > "$d.args"\nwhile [ ! -f "$d.quit" ]; do sleep 0.05; done\n');
  await chmod(stub, 0o755);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const newHost = () =>
  new BrowserHost({
    home,
    profiles: { finance: { mode: 'parked', executablePath: stub }, shared: { mode: 'headless', cdpUrl: 'http://127.0.0.1:9' } },
    log: consoleLogger('silent'),
  });

describe('openPlain', () => {
  // Chrome's stand-in is a shell script, and Windows only starts a real .exe here.
  it.skipIf(process.platform === 'win32')('starts Chrome on the profile with nothing attached, and holds jobs until it quits', async () => {
    const host = newHost();
    const rt = host.runtime('finance');
    const { exited } = await host.openPlain('finance', { url: 'https://example.com/' });
    // A process starting: slow when the whole suite runs at once.
    await expect.poll(() => existsSync(`${rt.dir}.args`), { timeout: 10_000 }).toBe(true);
    const args = (await readFile(`${rt.dir}.args`, 'utf8')).trim();
    expect(args).toBe(`--user-data-dir=${rt.dir} --no-first-run --no-default-browser-check --restore-last-session https://example.com/`);
    expect(args).not.toMatch(/remote-debugging|enable-automation/);
    expect(rt.running).toBe(false);
    expect(rt.gate.paused).toBe(true);

    await writeFile(`${rt.dir}.quit`, '');
    await exited;
    expect(rt.gate.paused).toBe(false);
  });

  it("lets jobs go again if Chrome can't start", async () => {
    const host = new BrowserHost({ home, profiles: { finance: { mode: 'parked', executablePath: join(home, 'no-such-chrome') } }, log: consoleLogger('silent') });
    await expect(host.openPlain('finance')).rejects.toThrow(/ENOENT/);
    expect(host.runtime('finance').gate.paused).toBe(false);
  });

  it('refuses a profile that lives in a Chrome bloomterm attaches to', async () => {
    const host = newHost();
    await expect(host.openPlain('shared')).rejects.toThrow(/cdpUrl/);
    expect(host.runtime('shared').gate.paused).toBe(false);
  });
});
