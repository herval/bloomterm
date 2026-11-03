import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Raw capture for one job (SPEC §6.7): `raw/<source>/<yyyy-mm-dd>/<job-id>/`.
 * These files hold account data, so directories are 0700 and files 0600.
 */
export class RawCapture {
  readonly dir: string;
  private ready: Promise<void> | null = null;
  private seq = 0;

  constructor(rawRoot: string, source: string, jobId: string, now: Date) {
    this.dir = join(rawRoot, source, now.toISOString().slice(0, 10), jobId);
  }

  ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => chmod(this.dir, 0o700));
    return this.ready;
  }

  /** Saves `data` as `<seq>-<name>`; objects become pretty JSON. Returns the path. */
  async save(name: string, data: string | Buffer | Uint8Array | object): Promise<string> {
    await this.ensureDir();
    const file = join(this.dir, `${String(++this.seq).padStart(3, '0')}-${safeName(name)}`);
    const body = typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 2);
    await writeFile(file, body, { mode: 0o600 });
    return file;
  }

  /** A path inside the job dir for something else to write (downloads). */
  async pathFor(name: string): Promise<string> {
    await this.ensureDir();
    return join(this.dir, `${String(++this.seq).padStart(3, '0')}-${safeName(name)}`);
  }
}

export function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
}
