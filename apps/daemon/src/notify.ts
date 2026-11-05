import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { system32 } from '@bloomterm/agent';

// Desktop notifications (SPEC §9.3): at most one per key per `quietMs`. Nothing you can say to
// one (a title from a site, say) reaches a script: macOS's are quoted, Windows' come in through
// the environment.

type Show = (title: string, message: string) => unknown;

function macNotification(title: string, message: string): void {
  execFile('osascript', ['-e', `display notification ${appleString(message)} with title ${appleString(title)}`], () => {});
}

function appleString(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
}

/** The app's id, which its installer gives the Start menu shortcut: Windows shows toasts under the app it belongs to. */
const APP_ID = 'app.bloomterm.desktop';

const TOAST = `$ErrorActionPreference = 'Stop'
$manager = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = $manager::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:BLOOMTERM_TOAST_TITLE))
[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:BLOOMTERM_TOAST_MESSAGE))
$manager::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/**
 * A Windows toast. Windows PowerShell, by its full path: PowerShell 7 can't reach the toast API.
 * The script goes in on stdin, as `-EncodedCommand` is what security software looks for.
 */
export function toast(title: string, message: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      env: { ...process.env, BLOOMTERM_TOAST_TITLE: title, BLOOMTERM_TOAST_MESSAGE: message.slice(0, 1_000) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.stdin.on('error', () => {});
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0 && !output.trim(), output }));
    child.stdin.end(TOAST);
  });
}

const SHOW: Partial<Record<NodeJS.Platform, Show>> = { darwin: macNotification, win32: toast };

export function desktopNotifier(quietMs = 30 * 60_000, show = SHOW[platform()]) {
  const last = new Map<string, number>();
  return (key: string, title: string, message: string): boolean => {
    if (!show) return false;
    const t = Date.now();
    if ((last.get(key) ?? 0) + quietMs > t) return false;
    last.set(key, t);
    show(title, message);
    return true;
  };
}
