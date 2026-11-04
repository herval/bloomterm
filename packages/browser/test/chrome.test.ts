import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserHost, ChromeNotFoundError, consoleLogger, findChrome } from '../src/index.ts';

// Where bloomterm finds Chrome, with made-up app folders and a made-up Spotlight. The "Chrome"
// inside each is a shell script, so nothing real is launched. These are the Mac's lookups, so they
// don't run on Windows.

let root: string;
const apps = () => join(root, 'Applications');
const userApps = () => join(root, 'home', 'Applications');

/** A fake Chrome .app under `dir`; its binary writes its arguments next to the profile dir. */
async function fakeApp(dir: string, name = 'Google Chrome'): Promise<string> {
  const app = join(dir, `${name}.app`);
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  const bin = join(app, 'Contents', 'MacOS', name);
  await writeFile(bin, '#!/bin/sh\nd="${1#--user-data-dir=}"\necho "$@" > "$d.args"\n');
  await chmod(bin, 0o755);
  return app;
}

const none = async () => [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bloomterm-chrome-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('findChrome', () => {
  it('finds Chrome in ~/Applications when it isn’t in /Applications', async () => {
    const app = await fakeApp(userApps());
    const found = await findChrome({ dirs: [apps(), userApps()], spotlight: none });
    expect(found).toEqual({ app, executable: join(app, 'Contents/MacOS/Google Chrome'), how: 'applications' });
  });

  it('prefers /Applications, and stable Chrome over Beta', async () => {
    await fakeApp(apps(), 'Google Chrome Beta');
    const beta = await findChrome({ dirs: [apps(), userApps()], spotlight: none });
    expect(beta?.app).toBe(join(userApps(), 'Google Chrome.app'));
    const stable = await fakeApp(apps());
    expect((await findChrome({ dirs: [apps(), userApps()], spotlight: none }))?.app).toBe(stable);
  });

  it('asks Spotlight when it’s elsewhere, skipping the Trash and the installer’s disk image', async () => {
    const elsewhere = await fakeApp(join(root, 'Disk', 'Apps'));
    const trashed = await fakeApp(join(root, '.Trash'));
    const asked: string[] = [];
    const spotlight = async (id: string) => {
      asked.push(id);
      return id === 'com.google.Chrome' ? ['/Volumes/Google Chrome/Google Chrome.app', trashed, elsewhere] : [];
    };
    const found = await findChrome({ dirs: [join(root, 'empty')], spotlight });
    expect(found).toMatchObject({ app: elsewhere, how: 'spotlight' });
    expect(asked).toEqual(['com.google.Chrome']);
  });

  it('uses only the Chrome config.toml names: an app or its binary', async () => {
    const app = await fakeApp(join(root, 'Chosen'));
    const spotlight = async () => [join(apps(), 'Google Chrome.app')];
    expect(await findChrome({ configured: app, dirs: [apps()], spotlight })).toMatchObject({ app, how: 'config' });
    const bin = join(app, 'Contents/MacOS/Google Chrome');
    expect(await findChrome({ configured: bin, dirs: [apps()], spotlight })).toEqual({ app, executable: bin, how: 'config' });
    expect(await findChrome({ configured: join(root, 'Nope.app'), dirs: [apps()], spotlight })).toBeNull();
  });

  it('finds nothing when there’s no Chrome', async () => {
    expect(await findChrome({ dirs: [join(root, 'empty')], spotlight: none })).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('the browser host', () => {
  it('launches the Chrome config.toml names, and says so when it isn’t there', async () => {
    const app = await fakeApp(join(root, 'Configured'));
    const home = join(root, 'bt-home');
    const host = new BrowserHost({ home, chrome: app, profiles: { finance: { mode: 'parked' } }, log: consoleLogger('silent') });
    expect(await host.chromeExecutable()).toBe(join(app, 'Contents/MacOS/Google Chrome'));
    const rt = host.runtime('finance');
    const { exited } = await host.openPlain('finance');
    await exited;
    expect(existsSync(`${rt.dir}.args`)).toBe(true);
    expect(await readFile(`${rt.dir}.args`, 'utf8')).toContain(`--user-data-dir=${rt.dir}`);

    const missing = new BrowserHost({ home, chrome: join(root, 'Gone.app'), profiles: { finance: { mode: 'parked' } }, log: consoleLogger('silent') });
    const err = await missing.openPlain('finance').catch((e) => e);
    expect(err).toBeInstanceOf(ChromeNotFoundError);
    expect(err.message).toMatch(/Gone\.app.*config\.toml/);
    expect(missing.runtime('finance').gate.paused).toBe(false);
  });
});
