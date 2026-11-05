// bloomd only listens on 127.0.0.1, so the browser showing this is on the machine bloomd runs on,
// and the words for that machine can come from here.

export const isWindows = /^win/i.test(navigator.platform);

/** A shortcut as this keyboard has it: ⌘K on a Mac, Ctrl+K on Windows. The handlers take either. */
export const shortcut = (key: string) => (isWindows ? `Ctrl+${key}` : `⌘${key}`);

export const thisComputer = isWindows ? 'this PC' : 'this Mac';
export const shellApp = isWindows ? 'PowerShell' : 'Terminal';
export const trayMenu = isWindows ? 'the tray menu' : 'the menu bar';
export const systemName = isWindows ? 'Windows' : 'macOS';

/** Where API keys live (market/secrets.ts in the daemon). */
export const vault = isWindows ? 'Credential Manager' : 'Keychain';

/** What ends the Chrome a profile opened in. On a Mac, closing its window leaves it running. */
export const quitChrome = isWindows ? 'close it' : 'quit it (⌘Q)';
