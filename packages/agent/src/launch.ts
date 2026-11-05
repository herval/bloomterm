import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * How to start an agent CLI. Mac and Linux start anything with a shebang. Windows starts only .exe
 * files, so a Node script goes through Node, and an npm launcher (a .cmd) through what it points at.
 * Never through cmd.exe: it would parse the arguments again, and they hold your questions and news.
 */
export function launch(path: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: path, args };
  const target = extname(path).toLowerCase() === '.cmd' ? shimTarget(path) : path;
  return /\.[cm]?js$/i.test(target) ? { file: process.execPath, args: [target, ...args] } : { file: target, args };
}

/**
 * What an npm or pnpm launcher starts: the path just before its `%*`, relative to the launcher.
 *   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *   "%~dp0\node.exe"  "%~dp0\..\@openai\codex\bin\codex.js" %*
 */
export function shimTarget(shim: string): string {
  const target = /"%~?dp0%?\\([^"]+)"\s+%\*/.exec(readFileSync(shim, 'utf8'))?.[1];
  if (!target) throw new Error(`can't tell what ${shim} starts`);
  return resolve(dirname(shim), target.replaceAll('\\', '/'));
}

/** Runs a CLI once. Hidden: a console program started from the desktop app would open a window of its own. */
/** Windows' own programs by their full path: an agent's PATH can hold anything. */
export const system32 = (...path: string[]) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...path);

export async function runCli(path: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const l = launch(path, args);
  return exec(l.file, l.args, { ...opts, windowsHide: true, encoding: 'utf8' });
}

/**
 * Stops a running CLI. On Windows kill() ends only that process, and would leave its MCP server and
 * shells running with their files locked, so taskkill takes the whole tree.
 */
export function stopCli(child: ChildProcess): void {
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3_000).unref();
    return;
  }
  spawn(system32('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
}
