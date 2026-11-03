// What every API integration uses to call its source: an honest User-Agent, a timeout,
// and errors that read well in the UI.

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const USER_AGENT = 'bloomterm/0.1 (personal market terminal)';

export async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}, timeoutMs = 10_000, init: { method?: string; body?: string } = {}): Promise<T> {
  const text = await getText(provider, url, { accept: 'application/json', ...headers }, timeoutMs, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, `${provider} sent something that isn't JSON`);
  }
}

/** A GET (or `init.method`) that returns the body as text: feeds, pages. Same errors as getJson. */
export async function getText(provider: string, url: string, headers: Record<string, string> = {}, timeoutMs = 10_000, init: { method?: string; body?: string } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? 'GET', body: init.body, headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderError(provider, `${provider} unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 429) throw new ProviderError(provider, `${provider} is rate-limiting us (HTTP 429); retrying shortly`, 429);
    let detail = text.slice(0, 160);
    try {
      const body = JSON.parse(text);
      detail = String(body?.message ?? body?.error ?? detail);
    } catch {
      // not JSON
    }
    throw new ProviderError(provider, `${provider} answered ${res.status}: ${detail}`, res.status);
  }
  return text;
}

export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
