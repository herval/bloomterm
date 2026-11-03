import type { Frame, Page } from 'playwright-core';

export type InteractiveOutcome = 'ok' | 'confirmed' | 'timeout' | 'closed';

export interface WaitOptions {
  timeoutMs: number;
  /** Fallback poll; checks mostly run right after the page navigates. */
  slowPollMs: number;
  /** Resolves when you click "I'm signed in" on the banner. */
  confirmed?: Promise<void>;
}

/**
 * Waits for you to finish signing in (or clear a challenge) in `page`, without ever
 * navigating that tab. `isSignedIn` runs after each main-frame navigation (debounced),
 * on a slow poll, and when you click the banner button.
 *
 * Outcomes: `ok` (the check passed), `confirmed` (you clicked the button but the check
 * didn't pass, which happens with draft adapters), `timeout`, or `closed` (tab closed).
 */
export function waitForSignIn(page: Page, isSignedIn: () => Promise<boolean>, opts: WaitOptions): Promise<InteractiveOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let again = false;
    let debounce: NodeJS.Timeout | undefined;

    const finish = (o: InteractiveOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(slow);
      clearTimeout(deadline);
      clearTimeout(debounce);
      page.off('framenavigated', onNav);
      page.off('close', onClose);
      resolve(o);
    };
    const check = async (): Promise<boolean> => {
      if (checking) {
        again = true;
        return false;
      }
      checking = true;
      try {
        const ok = await isSignedIn().catch(() => false);
        if (ok) finish('ok');
        return ok;
      } finally {
        checking = false;
        if (again && !settled) {
          again = false;
          void check();
        }
      }
    };
    const onNav = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void check(), 1_000);
    };
    const onClose = () => {
      // You may have signed in and then closed the tab; give the check one last go.
      void isSignedIn()
        .catch(() => false)
        .then((ok) => finish(ok ? 'ok' : 'closed'));
    };

    page.on('framenavigated', onNav);
    page.on('close', onClose);
    const slow = setInterval(() => void check(), opts.slowPollMs);
    const deadline = setTimeout(() => finish('timeout'), opts.timeoutMs);
    opts.confirmed?.then(async () => {
      if (!(await check()) && !settled) finish('confirmed');
    });
  });
}

/** A small bloomterm pill, re-added if the page's own scripts remove it. */
export function bannerScript(message: string): string {
  return `(() => {
  const MESSAGE = ${JSON.stringify(message)};
  const add = () => {
    if (!document.body || document.getElementById('__bloomterm_banner')) return;
    const box = document.createElement('div');
    box.id = '__bloomterm_banner';
    Object.assign(box.style, {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: '2147483647',
      background: '#0b0b0b', color: '#FFA028', border: '1px solid #FFA028',
      font: '12px ui-monospace, Menlo, monospace', padding: '8px 10px',
      display: 'flex', gap: '10px', alignItems: 'center', maxWidth: '520px',
    });
    const text = document.createElement('span');
    text.textContent = MESSAGE;
    const btn = document.createElement('button');
    btn.textContent = "I'm signed in";
    Object.assign(btn.style, { font: 'inherit', background: '#FFA028', color: '#000', border: '0', padding: '4px 8px', cursor: 'pointer' });
    btn.addEventListener('click', () => { if (window.__bloomtermDone) window.__bloomtermDone(); btn.textContent = 'checking…'; });
    box.append(text, btn);
    document.body.appendChild(box);
  };
  document.addEventListener('DOMContentLoaded', add);
  setInterval(add, 2000);
  add();
})();`;
}
