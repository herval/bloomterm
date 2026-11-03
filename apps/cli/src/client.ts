import { readFile } from 'node:fs/promises';
import { layout, readToken, stateFile, type DaemonInfo } from '@bloomterm/daemon';

export class NotRunningError extends Error {
  constructor() {
    super(
      layout().kind === 'bundle'
        ? "bloomd isn't running. Open bloomterm.app, which runs it, or run `bt daemon`."
        : "bloomd isn't running. Start it with `pnpm bt daemon`, or `pnpm bt daemon install` to run it at login.",
    );
  }
}

/** Talks to a running bloomd over its localhost API. */
export class Client {
  private constructor(
    readonly base: string,
    readonly token: string,
  ) {}

  static async connect(home: string): Promise<Client> {
    let info: DaemonInfo;
    try {
      info = JSON.parse(await readFile(stateFile(home), 'utf8'));
    } catch {
      throw new NotRunningError();
    }
    const base = `http://127.0.0.1:${info.port}`;
    try {
      // Another server can hold the port once bloomd is gone; bloomd says its name.
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok || ((await res.json()) as { name?: string }).name !== 'bloomd') throw new Error();
    } catch {
      throw new NotRunningError();
    }
    const token = await readToken(home);
    if (!token) throw new Error(`no API token in ${home}/token; restart bloomd to create one`);
    return new Client(base, token);
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  /** Polls a job until it finishes. */
  async wait(id: string, timeoutMs: number, onTick?: (job: any) => void): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.call('GET', `/api/jobs/${id}`);
      onTick?.(job);
      if (['ok', 'failed', 'cancelled'].includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${id} is still ${job.status}; check later with: bt job ${id}`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
