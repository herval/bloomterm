import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretLookup } from '@bloomterm/integrations';

const run = promisify(execFile);

/** API keys are short tokens; anything with spaces or quotes is a paste mistake. */
export const SECRET_VALUE = /^[A-Za-z0-9._~+/=-]{8,256}$/;

export interface SecretStore {
  get: SecretLookup;
  /** Where a key comes from, without reading it out. */
  source(name: string): Promise<'env' | 'keychain' | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const envName = (name: string) => `BLOOMTERM_SECRET_${name.toUpperCase().replace(/-/g, '_')}`;

/**
 * API keys live in the macOS Keychain under service `bloomterm` (SPEC §8.4).
 * `BLOOMTERM_SECRET_<NAME>` (e.g. BLOOMTERM_SECRET_ALPACA_KEY_ID) overrides it.
 * A missing key is looked up again after a minute, so adding one by hand doesn't need a restart.
 */
export function keychainStore(): SecretStore {
  const found = new Map<string, string>();
  const missingUntil = new Map<string, number>();

  async function read(name: string): Promise<string | null> {
    try {
      const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', 'bloomterm', '-a', name, '-w'], { timeout: 5_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async function get(name: string): Promise<string | null> {
    const env = process.env[envName(name)];
    if (env) return env;
    const hit = found.get(name);
    if (hit) return hit;
    if ((missingUntil.get(name) ?? 0) > Date.now()) return null;
    const value = await read(name);
    if (value) found.set(name, value);
    else missingUntil.set(name, Date.now() + 60_000);
    return value;
  }

  return {
    get,
    async source(name) {
      if (process.env[envName(name)]) return 'env';
      return (await get(name)) ? 'keychain' : null;
    },
    async set(name, value) {
      if (!SECRET_VALUE.test(value)) throw new Error('that doesn\'t look like an API key (no spaces or quotes, 8–256 characters)');
      // Through `security -i` on stdin, so the key never shows up in the process list.
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain refused the key: ${stderr.trim() || `exit ${code}`}`))));
        child.stdin.end(`add-generic-password -U -s bloomterm -a ${name} -l bloomterm-${name} -w ${value}\n`);
      });
      // Trust, but read it back.
      if ((await read(name)) !== value) throw new Error('the key was written but reads back differently; try again');
      found.set(name, value);
      missingUntil.delete(name);
    },
    async remove(name) {
      await run('/usr/bin/security', ['delete-generic-password', '-s', 'bloomterm', '-a', name], { timeout: 5_000 }).catch(() => {});
      found.delete(name);
      missingUntil.delete(name);
    },
  };
}

/** For tests and for anything that must never touch the Keychain. */
export function memoryStore(initial: Record<string, string> = {}): SecretStore {
  const m = new Map(Object.entries(initial));
  return {
    get: async (name) => m.get(name) ?? null,
    source: async (name) => (m.has(name) ? 'keychain' : null),
    async set(name, value) {
      if (!SECRET_VALUE.test(value)) throw new Error('that doesn\'t look like an API key (no spaces or quotes, 8–256 characters)');
      m.set(name, value);
    },
    async remove(name) {
      m.delete(name);
    },
  };
}
