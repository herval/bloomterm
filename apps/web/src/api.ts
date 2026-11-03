// Talks to bloomd. The token lives in this origin's localStorage (127.0.0.1:<port> only);
// `bt ui` hands it over with a one-time code in the URL fragment.

const TOKEN_KEY = 'bloomterm.token';

/** In the desktop app, whose shell (apps/desktop) sets this before the page loads. */
export const desktop = (globalThis as { __BLOOMTERM_DESKTOP__?: boolean }).__BLOOMTERM_DESKTOP__ === true;

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private window: the session lasts until reload
  }
}

let token: string | null = readToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Trades `#code=…` for the token, if the URL has one. Returns an error message on failure. */
export async function signInFromUrl(): Promise<string | null> {
  const m = location.hash.match(/code=([0-9a-f]{48})/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  const res = await fetch('/api/ui/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) return body.error ?? `sign-in failed (HTTP ${res.status})`;
  token = body.token;
  writeToken(token);
  return null;
}

export const hasToken = () => token !== null;

export function signOut(): void {
  token = null;
  writeToken(null);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token ?? ''}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (res.status === 401 && path !== '/api/ui/session') {
    signOut();
    window.dispatchEvent(new Event('bloomterm:signed-out'));
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T = unknown>(path: string) => api<T>('GET', path);

/** Sends a file as it is; bloomd replies with what it read of it. */
export async function upload<T = unknown>(file: File): Promise<T> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/**
 * Fetches a file with the token (a plain link can't carry it) and hands it to the browser to
 * save. The desktop app's web view can't save it, so there bloomd puts it in Downloads, and
 * this returns where.
 */
export async function download(id: string, name: string): Promise<string | null> {
  if (desktop) return (await api<{ path: string }>('POST', `/api/files/${id}/save`)).path;
  const res = await fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${token ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as any)?.error ?? `HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

/** bloomd's event stream, reconnecting with backoff. */
export function connectEvents(onEvent: (ev: any) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (closed || !token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/events?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      delay = 1_000;
      onState(true);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onState(false);
      if (closed) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
