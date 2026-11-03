import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BrowserHost, GuardPolicy } from '@bloomterm/browser';
import { homePaths } from '@bloomterm/core';
import { HttpError } from '../server.ts';

// What EVOLVE shows the agent about a site's traffic (SPEC §6.11). Credentials never reach
// it: cookie, token and auth header values are replaced by their length, and so are body
// fields named like passwords, tokens or tax ids. Everything else comes as a sample, unless
// you turned portfolio sharing off ([agent] share_portfolio = false); then bodies come as
// shapes (keys and types) and long digit runs in URLs and text are masked.

export type BodyMode = 'sample' | 'shape';

const SECRET_HEADER = /cookie|authorization|token|secret|session|csrf|xsrf|api[-_]?key|auth|signature|otp/i;
const SECRET_KEY = /^pass(word|wd)?$|password|^pin$|otp|token|secret|^cpf$|cnpj|ssn|tax.?id|card.?number|cvv|security.?code/i;
const MAX_STRING = 300;
const MAX_ITEMS = 5;

const hidden = (s: string) => `‹redacted, ${s.length} chars›`;
export const maskDigits = (s: string) => s.replace(/\d{6,}/g, (d) => `${'•'.repeat(d.length - 4)}${d.slice(-4)}`);

export function redactHeaders(headers: readonly { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name.startsWith(':')) continue;
    out[name] = SECRET_HEADER.test(name) ? hidden(h.value) : h.value.slice(0, MAX_STRING);
  }
  return out;
}

/** Cookie names from a Cookie header; the values stay out. */
export const cookieNames = (header: string | undefined) => (header ?? '').split(';').map((c) => c.split('=')[0]!.trim()).filter(Boolean);

/** A JSON value as the agent may see it. */
export function sanitize(v: unknown, mode: BodyMode, depth = 0): unknown {
  if (depth > 10) return '…';
  if (Array.isArray(v)) {
    if (mode === 'shape') return v.length ? [sanitize(v[0], mode, depth + 1), `… ${v.length} items`] : [];
    const head = v.slice(0, MAX_ITEMS).map((x) => sanitize(x, mode, depth + 1));
    return v.length > MAX_ITEMS ? [...head, `… ${v.length - MAX_ITEMS} more`] : head;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x !== null && typeof x !== 'object' ? hidden(String(x)) : sanitize(x, mode, depth + 1);
    return out;
  }
  if (mode === 'shape') return v === null ? null : typeof v;
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length} chars)` : v;
  return v;
}

/** A response or request body: JSON gets `sanitize`d, anything else is cut short. */
export function sanitizeBody(text: string | undefined, mime: string, mode: BodyMode, max = 4_000): unknown {
  if (!text) return null;
  if (/json|graphql/i.test(mime) || /^\s*[[{]/.test(text)) {
    try {
      return sanitize(JSON.parse(text), mode);
    } catch {
      // not JSON after all
    }
  }
  if (mode === 'shape') return `‹${mime || 'body'}, ${text.length} chars›`;
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

const showUrl = (url: string, mode: BodyMode) => (mode === 'shape' ? maskDigits(url) : url);

// ---- HAR recordings (`bt record <profile> [url]`) ----

const STATIC = /^(image|font|audio|video)\/|css|javascript|ecmascript|wasm|octet-stream/i;
const STATIC_EXT = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|css|js|mjs|map)(\?|$)/i;

function recordingPath(home: string, file: string): string {
  const name = basename(file);
  if (name !== file || !name.endsWith('.har')) throw new HttpError(400, `"${file}" isn't a recording name (see list_recordings)`);
  return join(homePaths(home).records, name);
}

async function loadHar(home: string, file: string): Promise<any[]> {
  const path = recordingPath(home, file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new HttpError(404, `no recording ${file}`);
  }
  return (JSON.parse(text)?.log?.entries ?? []) as any[];
}

export async function listRecordings(home: string) {
  const dir = homePaths(home).records;
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.har'));
  const out = await Promise.all(names.map(async (file) => ({ file, bytes: (await stat(join(dir, file))).size, recordedAt: (await stat(join(dir, file))).mtime.toISOString() })));
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

const operationName = (postData: string | undefined): string | undefined => {
  if (!postData) return undefined;
  try {
    const p = JSON.parse(postData);
    return (Array.isArray(p) ? p : [p]).map((x) => x?.operationName).filter(Boolean).join(',') || undefined;
  } catch {
    return undefined;
  }
};

/** The requests in a recording that carry data (no images, scripts or styles). */
export async function harSummary(home: string, file: string, opts: { match?: string; mode: BodyMode }) {
  const entries = await loadHar(home, file);
  const re = opts.match ? new RegExp(opts.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i') : null;
  const rows = [];
  for (const [i, e] of entries.entries()) {
    const url: string = e.request?.url ?? '';
    const mime: string = e.response?.content?.mimeType ?? '';
    if (re ? !re.test(url) : STATIC.test(mime) || STATIC_EXT.test(url)) continue;
    const headers: { name: string; value: string }[] = e.request?.headers ?? [];
    rows.push({
      index: i,
      method: e.request?.method,
      url: showUrl(url, opts.mode),
      status: e.response?.status,
      mime,
      bytes: e.response?.content?.size ?? null,
      requestHeaders: headers.map((h) => h.name.toLowerCase()).filter((n) => !n.startsWith(':') && n !== 'cookie'),
      cookies: cookieNames(headers.find((h) => h.name.toLowerCase() === 'cookie')?.value),
      graphql: operationName(e.request?.postData?.text),
    });
  }
  return { file, entries: entries.length, shown: rows.length, requests: rows.slice(0, 300) };
}

/** One request of a recording, with its response body. */
export async function harEntry(home: string, file: string, index: number, mode: BodyMode) {
  const e = (await loadHar(home, file))[index];
  if (!e) throw new HttpError(404, `${file} has no entry ${index}`);
  const content = e.response?.content ?? {};
  const body = content.encoding === 'base64' && content.text ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
  const reqHeaders: { name: string; value: string }[] = e.request?.headers ?? [];
  return {
    index,
    method: e.request?.method,
    url: showUrl(e.request?.url ?? '', mode),
    status: e.response?.status,
    request: {
      headers: redactHeaders(reqHeaders.filter((h) => h.name.toLowerCase() !== 'cookie')),
      cookies: cookieNames(reqHeaders.find((h) => h.name.toLowerCase() === 'cookie')?.value),
      body: sanitizeBody(e.request?.postData?.text, e.request?.postData?.mimeType ?? '', mode),
    },
    response: {
      headers: redactHeaders((e.response?.headers ?? []).filter((h: any) => h.name.toLowerCase() !== 'set-cookie')),
      mime: content.mimeType ?? '',
      body: sanitizeBody(body, content.mimeType ?? '', mode, 20_000),
    },
  };
}

// ---- The live site, through the signed-in profile ----

/** Exploring may read anything; writes to the site are refused, GraphQL queries aside. */
export function explorePolicy(origins: readonly string[]): GuardPolicy {
  return { origins, allowWrites: [{ url: /graphql/i, graphql: 'queries-only' }] };
}

export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `"${raw}" isn't a URL`);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new HttpError(400, 'only https URLs (http for localhost)');
  return url;
}

const DATA_TYPES = new Set(['xhr', 'fetch', 'document']);

/** Opens `url` in the profile and reports the data requests the page made, and what it shows. */
export async function capturePage(host: BrowserHost, o: { profile: string; origins: readonly string[]; url: URL; waitMs: number; mode: BodyMode }) {
  return host.explore(o.profile, explorePolicy(o.origins), async (page, _request, violations) => {
    const requests: Promise<unknown>[] = [];
    page.on('response', (res) => {
      const req = res.request();
      if (!DATA_TYPES.has(req.resourceType()) || requests.length >= 100) return;
      requests.push(
        (async () => {
          const mime = res.headers()['content-type'] ?? '';
          const headers = await req.headersArray().catch(() => []);
          const text = /json|graphql|text\/plain/i.test(mime) ? await res.text().catch(() => undefined) : undefined;
          return {
            type: req.resourceType(),
            method: req.method(),
            url: showUrl(req.url(), o.mode),
            status: res.status(),
            mime,
            requestHeaders: headers.map((h) => h.name.toLowerCase()).filter((n) => !n.startsWith(':') && n !== 'cookie'),
            cookies: cookieNames(headers.find((h) => h.name.toLowerCase() === 'cookie')?.value),
            graphql: operationName(req.postData() ?? undefined),
            body: text === undefined ? undefined : sanitizeBody(text, mime, o.mode, 6_000),
          };
        })(),
      );
    });
    const res = await page.goto(o.url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
      throw new HttpError(502, `couldn't open ${o.url.href}: ${(err as Error).message.split('\n')[0]}`);
    });
    await page.waitForLoadState('networkidle', { timeout: o.waitMs }).catch(() => {});
    const view = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 4_000),
      links: Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 60), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href.startsWith(location.origin))
        .slice(0, 60),
    }));
    return {
      url: showUrl(o.url.href, o.mode),
      finalUrl: showUrl(page.url(), o.mode),
      status: res?.status() ?? null,
      title: view.title,
      text: o.mode === 'shape' ? maskDigits(view.text.slice(0, 1_000)) : view.text,
      links: view.links.map((l) => ({ text: l.text, href: showUrl(l.href, o.mode) })),
      requests: await Promise.all(requests),
      blocked: violations,
    };
  });
}

/** A GET through the profile's cookies, as a `request` strategy would make it. */
export async function fetchAs(host: BrowserHost, o: { profile: string; origins: readonly string[]; url: URL; mode: BodyMode }) {
  return host.explore(o.profile, explorePolicy(o.origins), async (_page, request) => {
    const res = await request.get(o.url.href, { timeout: 30_000, maxRedirects: 5, failOnStatusCode: false });
    const mime = res.headers()['content-type'] ?? '';
    return {
      url: showUrl(res.url(), o.mode),
      status: res.status(),
      mime,
      headers: redactHeaders(res.headersArray().filter((h) => h.name.toLowerCase() !== 'set-cookie')),
      body: sanitizeBody(await res.text().catch(() => ''), mime, o.mode, 20_000),
    };
  });
}
