import type { Page } from 'playwright-core';
import { CredentialFirewallError, DeniedActionError } from './errors.ts';
import type { GuardedRequest } from './guard.ts';

// Credential firewall and click deny-list (SPEC §6.8).
//
// Adapters get Playwright objects wrapped in proxies. Typing into or reading a
// password / one-time-code field throws, and so does clicking anything named like
// a money-moving action. This stops mistakes in adapter code; it is not a sandbox
// against hostile code (`page.evaluate` can still read the DOM), which is why only
// adapters from this repo are ever loaded.

export const DEFAULT_DENIED_CLICKS =
  /\b(buy|sell|trade|transfer|withdraw|submit order|place order|confirm|pay|comprar|vender|transferir|resgatar|aplicar|investir|pagar|confirmar|pix)\b/i;

export interface FirewallOptions {
  deniedClicks?: RegExp;
  allowClickNames?: RegExp;
  request: GuardedRequest;
}

// Functions passed to evaluate() run in the page, so they must be self-contained.
const isSensitiveFn = (el: Element) => {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  return type === 'password' || /current-password|new-password|one-time-code/.test(ac);
};

const nameFn = (el: Element) =>
  (
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    (el as HTMLElement).innerText ||
    (el as HTMLInputElement).value ||
    ''
  )
    .trim()
    .slice(0, 200);

const activeIsSensitiveFn = () => {
  const el = document.activeElement;
  if (!el) return false;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  return type === 'password' || /current-password|new-password|one-time-code/.test(ac);
};

const INPUT_ACTIONS = new Set(['fill', 'type', 'pressSequentially', 'press', 'inputValue', 'clear', 'selectText']);
const CLICK_ACTIONS = new Set(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'dispatchEvent']);
/** Page/Frame methods that take a selector as their first argument. */
const SELECTOR_ACTIONS = new Set([...INPUT_ACTIONS, ...CLICK_ACTIONS].filter((m) => m !== 'pressSequentially' && m !== 'clear' && m !== 'selectText'));
const BLOCKED_PAGE_METHODS = new Set(['context', 'route', 'unroute', 'unrouteAll', 'routeFromHAR', 'routeWebSocket']);
const BLOCKED_PROPS = new Set(['mouse', 'touchscreen']);

type Kind = 'Page' | 'Frame' | 'Locator' | 'FrameLocator' | 'ElementHandle' | 'Keyboard' | 'APIRequestContext';

/**
 * Playwright's client classes aren't exported as values and their names are mangled
 * by its bundler (`_Page`, `Keyboard2`), so take the constructors from a live page.
 */
function kindsOf(page: Page): Map<unknown, Kind> {
  return new Map<unknown, Kind>([
    [page.constructor, 'Page'],
    [page.mainFrame().constructor, 'Frame'],
    [page.locator('html').constructor, 'Locator'],
    [page.frameLocator('iframe').constructor, 'FrameLocator'],
    [page.keyboard.constructor, 'Keyboard'],
    [page.request.constructor, 'APIRequestContext'],
  ]);
}

const isElementHandle = (v: any) => typeof v.asElement === 'function' && typeof v.ownerFrame === 'function' && typeof v.contentFrame === 'function';

export function firewallPage(page: Page, options: FirewallOptions): Page {
  const denied = options.deniedClicks ?? DEFAULT_DENIED_CLICKS;
  const cache = new WeakMap<object, object>();
  const kinds = kindsOf(page);

  const wrap = (value: unknown, owner: Page): unknown => {
    if (value instanceof Promise) return value.then((v) => wrap(v, owner));
    if (Array.isArray(value)) return value.map((v) => wrap(v, owner));
    if (!value || typeof value !== 'object') return value;
    const kind: Kind | undefined = kinds.get(value.constructor) ?? (isElementHandle(value) ? 'ElementHandle' : undefined);
    if (!kind) return value;
    if (kind === 'APIRequestContext') return options.request;
    const hit = cache.get(value);
    if (hit) return hit;
    const p = proxy(value, kind, kind === 'Page' ? (value as Page) : owner);
    cache.set(value, p);
    return p;
  };

  // Locator.evaluate waits for exactly one element, like the action that follows would.
  const assertNotSensitive = async (target: any) => {
    if (await target.evaluate(isSensitiveFn)) {
      throw new CredentialFirewallError('adapters must not type into or read password / one-time-code fields');
    }
  };

  const assertClickAllowed = async (target: any) => {
    const name: string = await target.evaluate(nameFn);
    if (denied.test(name) && !(options.allowClickNames?.test(name) ?? false)) {
      throw new DeniedActionError(`refusing to click "${name}": it looks like an action that moves money or changes the account`);
    }
  };

  const proxy = (target: any, kind: Kind, owner: Page): object =>
    new Proxy(target, {
      get(t, prop, _receiver) {
        if (typeof prop === 'string' && BLOCKED_PROPS.has(prop)) {
          throw new CredentialFirewallError(`page.${prop} is disabled for adapters; use locators`);
        }
        const value = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return wrap(value, owner);
        if (typeof prop !== 'string') return value.bind(t);

        if ((kind === 'Page' || kind === 'Frame') && BLOCKED_PAGE_METHODS.has(prop)) {
          return () => {
            throw new CredentialFirewallError(`${kind.toLowerCase()}.${prop}() is not available to adapters`);
          };
        }
        if (kind === 'Keyboard') {
          return async (...args: unknown[]) => {
            if (await owner.evaluate(activeIsSensitiveFn)) {
              throw new CredentialFirewallError('adapters must not type into password / one-time-code fields');
            }
            return value.apply(t, args);
          };
        }
        if ((kind === 'Page' || kind === 'Frame') && SELECTOR_ACTIONS.has(prop)) {
          return (selector: string, ...rest: unknown[]) => {
            const loc = wrap(t.locator(selector), owner) as any;
            return loc[prop](...rest);
          };
        }
        if ((kind === 'Locator' || kind === 'ElementHandle') && INPUT_ACTIONS.has(prop)) {
          return async (...args: unknown[]) => {
            await assertNotSensitive(t);
            return value.apply(t, args);
          };
        }
        if ((kind === 'Locator' || kind === 'ElementHandle') && CLICK_ACTIONS.has(prop)) {
          return async (...args: unknown[]) => {
            if (prop !== 'dispatchEvent' || args[0] === 'click') await assertClickAllowed(t);
            return value.apply(t, args);
          };
        }
        return (...args: unknown[]) => wrap(value.apply(t, args), owner);
      },
    });

  return wrap(page, page) as Page;
}
