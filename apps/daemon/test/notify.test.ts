import { describe, expect, it, vi } from 'vitest';
import { desktopNotifier, toast } from '../src/notify.ts';

describe('desktop notifications', () => {
  it('says each thing once in a while', () => {
    const show = vi.fn();
    const notify = desktopNotifier(60_000, show);
    expect(notify('b3:expired', 'bloomterm', 'Sign in to B3')).toBe(true);
    expect(notify('b3:expired', 'bloomterm', 'Sign in to B3')).toBe(false);
    expect(notify('cvm:expired', 'bloomterm', 'Sign in to CVM')).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith('bloomterm', 'Sign in to CVM');
  });

  it.runIf(process.platform === 'win32')('shows a toast, whatever the text says', async () => {
    expect(await toast(`"; Write-Error 'injected'; "`, `$(Write-Error 'injected') <b>&'\nline two`)).toEqual({ ok: true, output: '' });
  }, 30_000);
});
