import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleLogger } from '@bloomterm/browser';
import { integrations as builtins } from '@bloomterm/integrations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyBuiltin, runChecks, toSdkImports } from '../src/evolve/workspace.ts';
import { LocalIntegrations } from '../src/integrations.ts';
import { layout } from '../src/layout.ts';
import { fakeMarket } from './fakes.ts';

// Your integrations folder (SPEC §6.11): only what you approved runs, exactly as approved.

const log = consoleLogger('silent');
let home: string;

/** A small news integration, as EVOLVE would write it. */
const source = (id: string, name = id, extra = '') => `import { defineIntegration } from '@bloomterm/sdk';
${extra}
export default defineIntegration({
  id: '${id}', name: '${name}', covers: 'a test', access: 'api', status: 'ready',
  news: () => ({ everyMs: 60_000, latest: async () => [] }),
});
`;
const write = async (dir: string, text: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.ts'), text);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-local-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('your integrations', () => {
  it('runs only approved folders, exactly as approved, in place of the built-in with the same id', async () => {
    const local = new LocalIntegrations({ home, builtins: [fakeMarket], log });
    const mine = join(home, 'integrations');
    await write(join(mine, 'fake'), source('fake', 'Mine'));
    await write(join(mine, 'extra'), source('extra'));

    // Nothing approved: the built-ins, as they are.
    expect((await local.load()).map((i) => [i.id, i.name])).toEqual([['fake', 'Fake market']]);
    expect((await local.list()).map((l) => [l.id, l.state])).toEqual([['extra', 'unapproved'], ['fake', 'unapproved']]);

    await local.approve('fake', join(mine, 'fake'));
    await local.approve('extra', join(mine, 'extra'));
    expect((await local.load()).map((i) => [i.id, i.name])).toEqual([['fake', 'Mine'], ['extra', 'extra']]);
    expect(await local.list()).toEqual([
      expect.objectContaining({ id: 'extra', state: 'on', running: true, replaces: false }),
      expect.objectContaining({ id: 'fake', state: 'on', running: true, replaces: true }),
    ]);
    // Approvals are yours only (Windows has no such modes).
    if (process.platform !== 'win32') expect((await import('node:fs')).statSync(join(home, 'state/integrations.json')).mode & 0o777).toBe(0o600);

    // An edit you didn't approve turns it off, and the built-in comes back.
    await writeFile(join(mine, 'fake', 'notes.md'), 'an edit\n');
    expect((await local.load()).map((i) => [i.id, i.name])).toEqual([['fake', 'Fake market'], ['extra', 'extra']]);
    expect((await local.list()).find((l) => l.id === 'fake')).toMatchObject({ state: 'changed', running: false });
    const diff = await local.diff('fake', join(mine, 'fake'));
    expect(diff).toMatchObject({ base: 'yours' });
    expect(diff.diff).toContain('+++ b/notes.md');
    expect(diff.diff).toContain('+an edit');
  });

  it("keeps what didn't load off, with the reason", async () => {
    const local = new LocalIntegrations({ home, builtins: [fakeMarket], log });
    const mine = join(home, 'integrations');
    await write(join(mine, 'broken'), source('broken', 'x', "throw new Error('boom');"));
    await write(join(mine, 'clash'), source('clash').replace("access: 'api',", "access: 'api', secrets: [{ name: 'fake-token', label: 'x', covers: 'x', signup: 'https://example.com' }],"));
    await write(join(mine, 'renamed'), source('other'));
    for (const id of ['broken', 'clash', 'renamed']) await local.approve(id, join(mine, id));
    expect((await local.load()).map((i) => i.id)).toEqual(['fake']);
    const states = Object.fromEntries((await local.list()).map((l) => [l.id, l]));
    expect(states.broken).toMatchObject({ state: 'error', error: 'boom' });
    expect(states.clash).toMatchObject({ state: 'error', error: expect.stringContaining('declared by both fake and clash') });
    expect(states.renamed).toMatchObject({ state: 'error', error: expect.stringContaining('it must be "renamed"') });
  });

  it('keeps every approved version, and your unapproved edits, when a new version comes in', async () => {
    const local = new LocalIntegrations({ home, builtins: [], log });
    const run1 = join(home, 'evolve/a/news');
    const run2 = join(home, 'evolve/b/news');
    await write(run1, source('news', 'v1'));
    await write(run2, source('news', 'v2'));
    const a = await local.approve('news', run1, { run: 'c_1' });
    expect(a).toMatchObject({ run: 'c_1', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // An edit by hand, then a run's version approved over it.
    await writeFile(join(home, 'integrations/news/index.ts'), source('news', 'by hand'));
    const b = await local.approve('news', run2);
    expect(await readFile(join(home, 'integrations/news/index.ts'), 'utf8')).toContain("name: 'v2'");
    const history = await readdir(join(home, 'integrations/.history/news'));
    const before = history.find((h) => h.startsWith('before-'))!;
    expect(history.sort()).toEqual([a.hash.slice(0, 12), b.hash.slice(0, 12), before].sort());
    expect(await readFile(join(home, 'integrations/.history/news', before, 'index.ts'), 'utf8')).toContain('by hand');

    // You approve what you looked at, not what's there now.
    await expect(local.approve('news', run1, { hash: b.hash })).rejects.toThrow('review the diff again');

    // Taking it out: gone from the folder and the approvals; its versions stay.
    await local.remove('news');
    expect(existsSync(join(home, 'integrations/news'))).toBe(false);
    expect(await local.list()).toEqual([]);
    expect(existsSync(join(home, 'integrations/.history/news', b.hash.slice(0, 12)))).toBe(true);
    await expect(local.remove('news')).rejects.toThrow('no integration "news"');
  });

  it('starts EVOLVE from your copy, then the built-in, then nothing; and diffs against the built-in as it would look in your folder', async () => {
    const rss = builtins.find((b) => b.id === 'rss')!;
    const local = new LocalIntegrations({ home, builtins: [rss], log });
    expect(local.source('rss')).toEqual({ from: 'built-in', dir: join(layout().integrationsSrc, 'rss') });
    expect(local.source('newbank')).toEqual({ from: 'new' });

    const copy = join(home, 'evolve/x/rss');
    await copyBuiltin(join(layout().integrationsSrc, 'rss'), copy);
    expect(await readFile(join(copy, 'index.ts'), 'utf8')).not.toMatch(/from '(\.\.\/|@bloomterm\/(core|browser))/);
    expect((await local.diff('rss', copy)).diff).toBe('');
    await writeFile(join(copy, 'parse.ts'), `${await readFile(join(copy, 'parse.ts'), 'utf8')}// a fix\n`);
    const d = await local.diff('rss', copy);
    expect(d).toMatchObject({ base: 'built-in' });
    expect(d.diff).toContain('+// a fix');

    await local.approve('rss', copy);
    expect(local.source('rss')).toEqual({ from: 'yours', dir: join(home, 'integrations/rss') });
  });

  it('points built-in imports at @bloomterm/sdk', () => {
    expect(toSdkImports("import { getJson } from '../http.ts';\nimport type { Bar } from '@bloomterm/core';\nimport { parseFeed } from './parse.ts';\n")).toBe(
      "import { getJson } from '@bloomterm/sdk';\nimport type { Bar } from '@bloomterm/sdk';\nimport { parseFeed } from './parse.ts';\n",
    );
  });
});

describe("bloomd's checks", () => {
  // Also proves @bloomterm/sdk exports everything the built-ins use, types included.
  it('pass on every built-in, copied into your folder the way EVOLVE copies it', { timeout: 120_000 }, async () => {
    const results = await Promise.all(
      builtins.map(async (b) => {
        await copyBuiltin(join(layout().integrationsSrc, b.id), join(home, b.id));
        return [b.id, await runChecks(join(home, b.id), b.id)] as const;
      }),
    );
    for (const [id, c] of results) expect(c, `${id}: ${c.output}`).toMatchObject({ ok: true });
  });

  it('say what failed: imports from outside, syntax Node cannot strip, types, tests and the README', { timeout: 60_000 }, async () => {
    const dir = join(home, 'bad');
    await write(dir, source('bad', 'x', "import '../elsewhere.ts';"));
    await writeFile(join(home, 'elsewhere.ts'), 'export {};\n');
    await writeFile(join(dir, 'kinds.ts'), 'export enum Kind { A }\nexport const n: number = "one";\n');
    await writeFile(join(dir, 'bad.test.ts'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 3));\n");
    const c = await runChecks(dir, 'bad');
    expect(c).toMatchObject({ ok: false, load: false, typecheck: false, tests: false, readme: false });
    expect(c.output).toContain("\"../elsewhere.ts\" is outside the integration's folder");
    expect(c.output).toContain('kinds.ts: TypeScript enum is not supported in strip-only mode');
    expect(c.output).toContain("kinds.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(c.output).toContain('✖ adds');
    expect(c.output).toContain('README.md is missing');
  });
});
