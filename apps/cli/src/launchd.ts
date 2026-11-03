import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { layout, LAUNCHD_LABEL, launchdPlist } from '@bloomterm/daemon';

const run = promisify(execFile);
export const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

export function buildPlist(home: string): string {
  const app = layout();
  const missing = app.bt.find((p) => p.startsWith('/') && !existsSync(p));
  if (missing) throw new Error(`${missing} not found${app.kind === 'repo' ? '; run pnpm install' : ''}`);
  return launchdPlist({
    // Pinned to this Node (the app's own, or the one you run bt with); from a checkout,
    // re-run `bt daemon install` after switching Node versions.
    program: [...app.bt, 'daemon'],
    workingDirectory: app.root,
    logFile: join(home, 'logs', 'bloomd.log'),
    path: [dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    home: process.env.BLOOMTERM_HOME,
  });
}

const domain = () => `gui/${userInfo().uid}`;

export async function install(home: string): Promise<string> {
  const file = plistPath();
  await mkdir(dirname(file), { recursive: true });
  await mkdir(join(home, 'logs'), { recursive: true, mode: 0o700 });
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {});
  await writeFile(file, buildPlist(home), { mode: 0o644 });
  await run('launchctl', ['bootstrap', domain(), file]);
  return file;
}

export async function uninstall(): Promise<string> {
  const file = plistPath();
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {});
  await rm(file, { force: true });
  return file;
}
