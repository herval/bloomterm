import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

// A real bloomd, started the way the desktop app starts it, on a real Windows machine. It's the one
// place the whole start-up runs there. Not on a Mac: tests don't start one that might open windows.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

it.runIf(process.platform === 'win32')('starts, answers, and stops cleanly when asked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bt-daemon-'));
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'apps/cli/src/main.ts'), 'daemon', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, BLOOMTERM_HOME: home, BLOOMTERM_SUPERVISED: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  try {
    const state = join(home, 'state', 'bloomd.json');
    await vi.waitFor(() => expect(existsSync(state)).toBe(true), { timeout: 45_000, interval: 250 });
    const { port } = JSON.parse(await readFile(state, 'utf8'));
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ ok: true, name: 'bloomd' });

    const token = (await readFile(join(home, 'token'), 'utf8')).trim();
    expect((await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(202);
    expect(await exited).toBe(0);
    expect(existsSync(state)).toBe(false);
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 90_000);

// Windows ignores file modes, so ~/.bloomterm is private because of where it is: nothing in your
// user folder lets anyone in but you, the system and administrators.
it.runIf(process.platform === 'win32')('keeps a folder in your user folder from other accounts', async () => {
  const folder = join(homedir(), `.bt-private-${process.pid}`);
  await mkdir(folder);
  try {
    const access = execFileSync('icacls', [folder], { encoding: 'utf8', windowsHide: true });
    expect(access).toContain('Administrators');
    expect(access).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
