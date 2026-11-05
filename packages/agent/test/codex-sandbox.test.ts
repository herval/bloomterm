import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAgents } from '../src/detect.ts';
import { runCli } from '../src/launch.ts';

// A real Codex, without a model: does its sandbox stop a command writing where it shouldn't? EVOLVE
// and Ask lean on it, and it's a different sandbox on each system. This needs Codex installed, so it
// runs only when asked, as the Windows job does:
//   BLOOMTERM_CODEX_SANDBOX=1 pnpm vitest run --project unit packages/agent/test/codex-sandbox.test.ts

describe.runIf(process.env.BLOOMTERM_CODEX_SANDBOX)('the Codex sandbox', () => {
  /** Tries to write `file` under a permission profile. True if the file is there afterwards. */
  async function write(profile: string, cwd: string, file: string): Promise<boolean> {
    const codex = (await findAgents()).find((a) => a.kind === 'codex');
    if (!codex) throw new Error('Codex is not installed');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x')`;
    await runCli(codex.path, ['sandbox', '--permission-profile', profile, '-C', cwd, '--', process.execPath, '-e', script], { cwd, timeout: 60_000 }).catch(() => {});
    return existsSync(file);
  }

  it('lets a workspace run write only inside its folder', async () => {
    const work = await mkdtemp(join(tmpdir(), 'bt-sandbox-'));
    const outside = join(homedir(), `bt-sandbox-probe-${process.pid}.txt`);
    try {
      expect(await write(':workspace', work, join(work, 'inside.txt'))).toBe(true);
      expect(await write(':workspace', work, outside)).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('lets a read-only run write nothing', async () => {
    const work = await mkdtemp(join(tmpdir(), 'bt-sandbox-'));
    try {
      expect(await write(':read-only', work, join(work, 'inside.txt'))).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
