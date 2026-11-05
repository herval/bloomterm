import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';

// Parking (SPEC §6.2): the profile's Chrome is a real, headed window kept off-screen.
// When you're needed, the window comes back on-screen via CDP; afterwards it's parked again.

const OFFSCREEN = -10_000;

export type ParkResult = 'offscreen' | 'minimized';

interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

async function withWindow<T>(page: Page, fn: (send: (method: string, params?: object) => Promise<any>, windowId: number, bounds: WindowBounds) => Promise<T>): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    const send = (method: string, params?: object) => session.send(method as any, params as any);
    const { windowId, bounds } = await send('Browser.getWindowForTarget');
    return await fn(send, windowId, bounds);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function getWindowBounds(page: Page): Promise<WindowBounds> {
  return withWindow(page, async (_send, _id, bounds) => bounds);
}

/**
 * Moves the page's window off-screen. If the OS clamps it back on-screen, minimizes it
 * instead. macOS always clamps (it keeps a ~40px strip visible), so there the window ends
 * up minimized, with that strip as its restore position: a new tab un-minimizes the
 * window, and when it does, only the strip shows.
 */
export async function park(page: Page): Promise<ParkResult> {
  return withWindow(page, async (send, windowId, bounds) => {
    if (bounds.windowState !== 'normal') await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: OFFSCREEN, top: OFFSCREEN, width: bounds.width ?? 1280, height: bounds.height ?? 900 },
    });
    const after: WindowBounds = (await send('Browser.getWindowBounds', { windowId })).bounds;
    if ((after.left ?? 0) <= OFFSCREEN / 2 || (after.top ?? 0) <= OFFSCREEN / 2) return 'offscreen';
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    return 'minimized';
  });
}

/** Brings the page's window back on-screen, centered, with this tab in front. */
export async function unpark(page: Page, size = { width: 1280, height: 900 }): Promise<void> {
  const screen = await page
    .evaluate(() => ({ w: window.screen.availWidth, h: window.screen.availHeight, l: (window.screen as any).availLeft ?? 0, t: (window.screen as any).availTop ?? 0 }))
    .catch(() => ({ w: 1440, h: 900, l: 0, t: 0 }));
  const width = Math.min(size.width, screen.w);
  const height = Math.min(size.height, screen.h);
  await withWindow(page, async (send, windowId, bounds) => {
    if (bounds.windowState !== 'normal') await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: screen.l + Math.round((screen.w - width) / 2), top: screen.t + Math.round((screen.h - height) / 2), width, height },
    });
  });
  await page.bringToFront();
}

const run = promisify(execFile);

// macOS focus handling. Launching Chrome makes it the frontmost app even though its
// window is parked, so your typing would go to an invisible window. The runtime notes
// which app was in front before a launch and hands focus back afterwards.
// All best effort: without Automation permission for System Events these do nothing.

/** PID of the frontmost app (macOS), or null. */
export async function frontmostPid(): Promise<number | null> {
  if (platform() !== 'darwin') return null;
  try {
    const { stdout } = await run('osascript', ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true']);
    const pid = Number(stdout.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function activatePid(pid: number): Promise<void> {
  if (platform() !== 'darwin') return;
  try {
    await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
  } catch {
    // ignore
  }
}

/** The main Chrome process for a profile dir (not its helpers), for handing focus back (macOS). */
export async function profileAppPid(profileDir: string): Promise<number | null> {
  if (platform() !== 'darwin') return null;
  try {
    const { stdout } = await run('pgrep', ['-f', `--user-data-dir=${profileDir}`]);
    for (const pid of stdout.split('\n').filter(Boolean)) {
      const { stdout: cmd } = await run('ps', ['-o', 'command=', '-p', pid]);
      if (!cmd.includes('--type=')) return Number(pid);
    }
  } catch {
    // none running
  }
  return null;
}

/** Brings this profile's Chrome to the front, so the window it just showed isn't hidden behind another app. */
export async function activateProfileApp(profileDir: string): Promise<void> {
  const pid = await profileAppPid(profileDir);
  if (pid) await activatePid(pid);
}
