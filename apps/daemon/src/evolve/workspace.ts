import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentEnv, type AgentKind } from '@bloomterm/agent';
import type { BrowserAdapterDef } from '@bloomterm/browser';
import { checkReadme, folderFiles, importInFolder, importIntegration } from '@bloomterm/integrations';
import { layout } from '../layout.ts';

// EVOLVE's workspace (SPEC §6.11): each run gets a folder under <home>/evolve with a copy of
// one integration, the routine (CLAUDE.md, the same as AGENTS.md), the SDK's sources and the
// built-ins as examples. The agent edits only the copy; nothing in bloomterm itself changes.
// bloomd checks the copy when the agent stops, and it runs only once you approve it
// (integrations.ts).

const run = promisify(execFile);

export const INTEGRATION_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Where a run starts: your copy, the built-in's source, or nothing. */
export type EvolveFrom = { from: 'yours' | 'built-in'; dir: string } | { from: 'new' };

/** Built-ins import from bloomterm's packages; in your data folder everything comes from @bloomterm/sdk. */
const PACKAGE_IMPORT = /(from\s+|import\(\s*)'(?:\.\.\/(?:sdk|http|text)\.ts|@bloomterm\/(?:core|browser|integrations))'/g;
export const toSdkImports = (source: string) => source.replace(PACKAGE_IMPORT, "$1'@bloomterm/sdk'");

/** Copies a built-in integration's folder, its imports pointed at @bloomterm/sdk. */
export async function copyBuiltin(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true });
  for (const f of await folderFiles(dest)) {
    if (!f.endsWith('.ts')) continue;
    const p = join(dest, f);
    await writeFile(p, toSdkImports(await readFile(p, 'utf8')));
  }
}

/** Single-quoted for sh. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Makes a run's folder: `<id>/` (the copy the agent edits), CLAUDE.md and AGENTS.md (the
 * routine), `sdk/` and `examples/` (to read), and `./check`, which runs bloomd's checks.
 */
export async function createRunDir(dir: string, id: string, start: EvolveFrom, builtins: string[]): Promise<void> {
  const app = layout();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = join(dir, id);
  if (start.from === 'yours') await cp(start.dir, folder, { recursive: true });
  else if (start.from === 'built-in') await copyBuiltin(start.dir, folder);
  else await mkdir(folder);
  // Node reads .ts files here as ES modules.
  await writeFile(join(dir, 'package.json'), '{ "type": "module", "private": true }\n');
  const routine = await readFile(app.routine, 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), routine);
  await writeFile(join(dir, 'AGENTS.md'), routine);

  const kit = app.kit.root;
  await cp(join(kit, 'packages/core/src'), join(dir, 'sdk/core'), { recursive: true });
  await cp(join(kit, 'packages/browser/src'), join(dir, 'sdk/browser'), { recursive: true });
  for (const f of ['sdk-surface.ts', 'sdk.ts', 'http.ts', 'text.ts']) await cp(join(kit, 'packages/integrations/src', f), join(dir, 'sdk/integrations', f));
  await writeFile(
    join(dir, 'sdk/README.md'),
    "# @bloomterm/sdk\n\nRead-only copies of the SDK's sources, for reference. `integrations/sdk-surface.ts` is what `import … from '@bloomterm/sdk'` gives you; the rest is what it re-exports. Don't import these files.\n",
  );
  for (const b of builtins) if (b !== id) await copyBuiltin(join(app.integrationsSrc, b), join(dir, 'examples', b));

  const check = join(dir, 'check');
  await writeFile(
    check,
    `#!/bin/sh\n# bloomd's checks for ${id}/: it loads, typechecks, passes its tests, and has its README.\nexport NODE_NO_WARNINGS=1\nexec ${[...app.bt, 'check-integration', folder].map(sh).join(' ')} "$@"\n`,
  );
  await chmod(check, 0o755);
}

export interface Checks {
  /** It imports under Node, as bloomd loads it, and exports a valid integration with its folder's id. */
  load: boolean;
  /** tsc, strict, against @bloomterm/sdk; and every .ts file is TypeScript Node can strip. */
  typecheck: boolean;
  /** Its *.test.ts files, under node:test; true when there are none. */
  tests: boolean;
  /** README.md has the sections the contract asks for. */
  readme: boolean;
  ok: boolean;
  /** What failed, the end of each failing step's output. */
  output: string;
}

export const checksLine = (c: Checks) =>
  [`loads ${c.load ? 'ok' : 'FAILS'}`, `typecheck ${c.typecheck ? 'passes' : 'FAILS'}`, `tests ${c.tests ? 'pass' : 'FAIL'}`, `README ${c.readme ? 'ok' : 'INCOMPLETE'}`].join(', ');

async function exitOf(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd: o.cwd, env: { ...agentEnv(), NODE_NO_WARNINGS: '1', ...o.env }, timeout: o.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err: any) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.killed ? '\n(timed out)' : ''}` || String(err.message) };
  }
}

/** tsc for one folder, with @bloomterm/sdk mapped to the kit's sources and bloomterm's own strict options. */
async function typecheck(folder: string): Promise<{ ok: boolean; output: string }> {
  const { kit } = layout();
  const tmp = await mkdtemp(join(tmpdir(), 'bt-check-'));
  try {
    const src = (p: string) => [join(kit.root, p)];
    const tsconfig = {
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023', 'DOM'],
        types: ['node'],
        typeRoots: [join(kit.root, 'node_modules/@types')],
        strict: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        paths: {
          '@bloomterm/sdk': src('packages/integrations/src/sdk-surface.ts'),
          '@bloomterm/core': src('packages/core/src/index.ts'),
          '@bloomterm/browser': src('packages/browser/src/index.ts'),
        },
      },
      include: [join(folder, '**/*.ts')],
    };
    await writeFile(join(tmp, 'tsconfig.json'), JSON.stringify(tsconfig));
    // From the folder, so tsc names its files relative to it.
    const r = await exitOf(process.execPath, [kit.tsc, '-p', join(tmp, 'tsconfig.json'), '--pretty', 'false'], { cwd: folder, timeoutMs: 2 * 60_000 });
    const strip = await strippable(folder);
    return { ok: r.ok && strip.ok, output: [r.ok ? '' : r.output, strip.output].filter(Boolean).join('\n') };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * bloomd runs these files with Node's type stripping, which refuses enums, namespaces and
 * parameter properties. tsc can't check that for the folder alone (the SDK uses them), so
 * each file goes through Node's own stripper.
 */
async function strippable(folder: string): Promise<{ ok: boolean; output: string }> {
  const bad: string[] = [];
  for (const f of (await folderFiles(folder)).filter((f) => f.endsWith('.ts'))) {
    try {
      stripTypeScriptTypes(await readFile(join(folder, f), 'utf8'));
    } catch (err) {
      bad.push(`${f}: ${(err as Error).message}`);
    }
  }
  return { ok: !bad.length, output: bad.join('\n') };
}

/**
 * bloomd's checks of an integration folder: the same whether the agent runs `./check`, bloomd
 * runs them after a run, or you approve a folder you edited. It imports the code, so run it in
 * its own process (`bt check-integration`), as `runChecks` does.
 */
export async function checkIntegration(dir: string, id: string): Promise<Checks> {
  // Its real path, so tsc names files relative to it (macOS's /tmp is a symlink).
  const folder = existsSync(dir) ? realpathSync(dir) : dir;
  const failed: string[] = [];
  const tail = (s: string) => s.trim().split('\n').slice(-25).join('\n');
  const step = async (name: string, fn: () => Promise<{ ok: boolean; output: string } | void>): Promise<boolean> => {
    try {
      const r = await fn();
      if (r && !r.ok) failed.push(`${name}:\n${tail(r.output)}`);
      return r ? r.ok : true;
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
      return false;
    }
  };
  if (!existsSync(join(folder, 'index.ts'))) {
    return { load: false, typecheck: false, tests: false, readme: false, ok: false, output: `${id}/index.ts doesn't exist yet` };
  }
  const load = await step('load', async () => void (await importIntegration(folder, id)));
  const types = await step('typecheck', () => typecheck(folder));
  const tests = await step('tests', async () => {
    const files = (await folderFiles(folder)).filter((f) => f.endsWith('.test.ts'));
    if (!files.length) return;
    const [cmd, ...args] = layout().bt;
    return exitOf(cmd!, [...args, 'test-integration', folder], { env: { NODE_OPTIONS: '--test-reporter=spec' }, timeoutMs: 3 * 60_000 });
  });
  const readme = await step('README', () => checkReadme(folder, id));
  const ok = load && types && tests && readme;
  return { load, typecheck: types, tests, readme, ok, output: failed.join('\n\n') };
}

/** Runs `checkIntegration` in a process of its own, so the folder's code never runs in bloomd. */
export async function runChecks(folder: string, id: string): Promise<Checks> {
  const [cmd, ...args] = layout().bt;
  const r = await exitOf(cmd!, [...args, 'check-integration', folder, '--json'], { timeoutMs: 6 * 60_000 });
  // Its last line is the JSON; Node may print warnings around it.
  const line = r.output.split('\n').findLast((l) => l.startsWith('{"load":'));
  if (line) return JSON.parse(line) as Checks;
  return { load: false, typecheck: false, tests: false, readme: false, ok: false, output: r.output.split('\n').slice(-40).join('\n') };
}

/** Imports a folder's `*.test.ts` files; node:test runs them as the process ends, and sets its exit code. */
export async function testIntegration(folder: string): Promise<void> {
  for (const f of (await folderFiles(folder)).filter((f) => f.endsWith('.test.ts'))) await importInFolder(folder, f);
}

/**
 * Loads a run's copy of a browser integration for a try run, as it is on disk now. This runs
 * the agent's code inside bloomd: the same trust as running its tests.
 */
export async function loadCandidate(folder: string, id: string): Promise<BrowserAdapterDef> {
  if (!existsSync(join(folder, 'index.ts'))) throw new Error(`${id}/index.ts doesn't exist yet`);
  const def = await importIntegration(folder, id);
  if (!def.browser?.datasets || !def.browser.login) throw new Error(`${id}/index.ts must default-export a browser integration (defineIntegration with browser: defineBrowserAdapter(…))`);
  return def.browser;
}

/** How each agent CLI works in the run's folder; the rest of the instructions are the same for both. */
const TOOL_NOTES: Record<AgentKind, string> = {
  claude:
    "Tools: read files with Read, Glob and Grep (not cat or head); edit with Edit and Write. The shell runs only `./check` and `ls`. A refused command isn't on that list: use one that is.",
  codex:
    'Tools: your shell is sandboxed to this folder. Read with cat, sed, rg and ls; edit with apply_patch. Writes outside this folder fail. Reach sites only through the bloomterm MCP tools.',
};

export function evolveSystem(kind: AgentKind): string {
  return `You are EVOLVE, bloomterm's integration engineer. bloomterm is a personal, keyboard-first market terminal; its data comes from integrations, one folder each. You're in a folder made for this run, changing one integration: its copy in the folder named after it.

Before anything else, read CLAUDE.md here (AGENTS.md is the same file) and follow it: it is the routine, and its rules are hard limits.

- ${TOOL_NOTES[kind]}
- Edit only the integration's folder. Everything else here (sdk/, examples/, ./check) is for reading or running, and isn't kept.
- Import only from '@bloomterm/sdk', node: modules and the integration's own files. sdk/ has the SDK's sources; examples/ has bloomterm's built-in integrations, written the same way.
- Before you stop, run \`./check\` and fix what fails: it loads the integration the way bloomd will, typechecks it, runs its tests and checks its README. bloomd runs it again when you stop.
- Nothing you write runs in bloomterm until its owner reads the diff and approves it. Don't try to install it.
- The bloomterm MCP tools are how you see the site: recordings (list_recordings, har_summary, har_entry), the signed-in browser (browser_capture, browser_fetch) and try_dataset, which runs your code against the live site. Every one is read-only, and the mutation guard blocks writes.
- Never ask for, type, store or print a password, one-time code or cookie value. If the site wants a sign-in, stop and say so: the owner signs in with \`bt login <id>\`.
- Fixtures must be scrubbed: no names, account or document numbers, emails, addresses or real balances.
- End with a short summary: what changed, what you verified with try_dataset, and what's still missing.`;
}

const FROM_LINE: Record<EvolveFrom['from'], string> = {
  yours: 'yours; change it',
  'built-in': "bloomterm's built-in, copied here; change it",
  new: 'new; create it',
};

export function evolvePrompt(o: { id: string; goal: string; from: EvolveFrom['from'] }): string {
  return [`Integration: ${o.id} (${FROM_LINE[o.from]})`, `Goal: ${o.goal}`, '', `Follow CLAUDE.md. Work in ${o.id}/, and run ./check before you stop.`].join('\n');
}
