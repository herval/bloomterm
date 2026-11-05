import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

// Where Google Chrome is (SPEC §6.2). bloomterm drives your own Chrome, so it has to find it:
//   1. where config.toml says ([browser] chrome: the app, or the binary inside it);
//   2. on a Mac: /Applications, then ~/Applications;
//      on Windows: the two places its installer can put it, for everyone or just for you;
//   3. on a Mac: wherever Spotlight knows it is (a folder inside Applications, another disk).
// Stable Chrome first, then Beta, Dev and Canary. Copies in the Trash or on a mounted disk image
// (the installer's) don't count: they're about to go away.

const run = promisify(execFile);

/** Chrome's channels, most stable first: bundle id, app name, and its folder under Google on Windows. */
export const CHROME_APPS = [
  { id: 'com.google.Chrome', app: 'Google Chrome.app', folder: 'Chrome' },
  { id: 'com.google.Chrome.beta', app: 'Google Chrome Beta.app', folder: 'Chrome Beta' },
  { id: 'com.google.Chrome.dev', app: 'Google Chrome Dev.app', folder: 'Chrome Dev' },
  { id: 'com.google.Chrome.canary', app: 'Google Chrome Canary.app', folder: 'Chrome SxS' },
];

export interface ChromeLocation {
  /** The .app, when it's in one. */
  app: string | null;
  /** What gets launched. */
  executable: string;
  how: 'config' | 'applications' | 'spotlight';
}

export interface FindChromeOptions {
  /** [browser] chrome from config.toml: an .app or an executable. When set, only it counts. */
  configured?: string;
  /** Default: /Applications, ~/Applications; on Windows, Program Files and your local app data. */
  dirs?: string[];
  /** The apps Spotlight knows with this bundle id. Default: mdfind. */
  spotlight?: (bundleId: string) => Promise<string[]>;
  platform?: NodeJS.Platform;
}

export async function findChrome(o: FindChromeOptions = {}): Promise<ChromeLocation | null> {
  if (o.configured) {
    const found = await resolve(o.configured);
    return found && { ...found, how: 'config' };
  }
  if ((o.platform ?? process.platform) === 'win32') return findOnWindows(o.dirs ?? windowsDirs());
  const dirs = o.dirs ?? ['/Applications', join(homedir(), 'Applications')];
  for (const { app } of CHROME_APPS) {
    for (const dir of dirs) {
      const found = await resolve(join(dir, app));
      if (found) return { ...found, how: 'applications' };
    }
  }
  const spotlight = o.spotlight ?? mdfind;
  for (const { id } of CHROME_APPS) {
    for (const path of await spotlight(id).catch(() => [])) {
      if (path.includes('/.Trash/') || isInstaller(path)) continue;
      const found = await resolve(path);
      if (found) return { ...found, how: 'spotlight' };
    }
  }
  return null;
}

const windowsDirs = () => [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((d) => !!d) as string[];

async function findOnWindows(dirs: string[]): Promise<ChromeLocation | null> {
  for (const { folder } of CHROME_APPS) {
    for (const dir of dirs) {
      const found = await resolve(join(dir, 'Google', folder, 'Application', 'chrome.exe'));
      if (found) return { ...found, how: 'applications' };
    }
  }
  return null;
}

/** An app or an executable: what to launch, or null when it isn't there. */
async function resolve(path: string): Promise<Omit<ChromeLocation, 'how'> | null> {
  const p = path.replace(/\/+$/, '');
  if (p.endsWith('.app')) {
    if (!(await isDir(p))) return null;
    const executable = join(p, 'Contents', 'MacOS', basename(p, '.app'));
    return (await isExecutable(executable)) ? { app: p, executable } : null;
  }
  if (!(await isExecutable(p))) return null;
  const inApp = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(p);
  return { app: inApp?.[1] ?? null, executable: p };
}

/** A disk image you opened to install Chrome: the volume holds Chrome and little else. */
function isInstaller(path: string): boolean {
  return /^\/Volumes\/Google Chrome[^/]*\/[^/]+\.app$/.test(path);
}

async function mdfind(bundleId: string): Promise<string[]> {
  const { stdout } = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 5_000 });
  return stdout.split('\n').filter((l) => l.endsWith('.app'));
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
