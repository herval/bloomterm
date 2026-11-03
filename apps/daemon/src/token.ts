import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Every API request (UI, CLI, MCP) carries this bearer token (SPEC §12).

export const tokenFile = (home: string) => join(home, 'token');

export async function ensureToken(home: string): Promise<string> {
  const file = tokenFile(home);
  try {
    const t = (await readFile(file, 'utf8')).trim();
    if (t.length >= 32) {
      await chmod(file, 0o600);
      return t;
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const t = randomBytes(32).toString('hex');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${t}\n`, { mode: 0o600 });
  return t;
}

export async function readToken(home: string): Promise<string | null> {
  try {
    return (await readFile(tokenFile(home), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
