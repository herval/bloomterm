import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/** macOS notification (SPEC §9.3), at most once per key per `quietMs`. */
export function macNotifier(quietMs = 30 * 60_000) {
  const last = new Map<string, number>();
  return (key: string, title: string, message: string): boolean => {
    if (platform() !== 'darwin') return false;
    const t = Date.now();
    if ((last.get(key) ?? 0) + quietMs > t) return false;
    last.set(key, t);
    const script = `display notification ${appleString(message)} with title ${appleString(title)}`;
    execFile('osascript', ['-e', script], () => {});
    return true;
  };
}

function appleString(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
}
