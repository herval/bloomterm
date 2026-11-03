import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin, registerHooks, stripTypeScriptTypes } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants, Script } from 'node:vm';
import { sdk } from './sdk-surface.ts';
import type { Integration } from './sdk.ts';

// Integrations in your data folder (SPEC §6.11) run on Node's own TypeScript support, which
// strips types (so only erasable syntax: no enums, no parameter properties), and import
// everything from `@bloomterm/sdk`. These hooks answer that import with bloomd's own `sdk`,
// and keep each integration's other imports to node: modules and its own folder.

const SDK_URL = 'bloomterm:sdk';
const LOAD = 'bloomterm-load';
/** Each load's tag, and the folder its files must stay in. */
const roots = new Map<string, string>();
let installed = false;
let loads = 0;

const tagOf = (url: string | undefined) => (url?.startsWith('file:') ? new URL(url).searchParams.get(LOAD) : null);

export function installSdk(): void {
  if (installed) return;
  installed = true;
  (globalThis as any)[Symbol.for('bloomterm.sdk')] = sdk;
  const source = `const s = globalThis[Symbol.for('bloomterm.sdk')];\nexport const { ${Object.keys(sdk).join(', ')} } = s;\nexport default s;\n`;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@bloomterm/sdk') return { url: SDK_URL, shortCircuit: true };
      // The file a load starts from carries the tag itself; the files it imports get it from their parent.
      const entry = specifier.startsWith('file:') && tagOf(specifier) !== null;
      const tag = entry ? tagOf(specifier) : tagOf(context.parentURL);
      const root = tag ? roots.get(tag) : undefined;
      if (!root) return next(specifier, context);
      if (!entry && !/^\.\.?\//.test(specifier)) {
        if (isBuiltin(specifier)) return next(specifier, context);
        throw new Error(`"${specifier}": an integration imports only @bloomterm/sdk, node: modules and its own files`);
      }
      // Its own files are resolved here, as Node resolves relative imports (the exact path,
      // extension and all), not by whatever else hooks the loader: tsx would make them CommonJS.
      let path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`"${specifier}" doesn't exist (imports name the file, with its .ts extension)`);
      path = realpathSync(path);
      if (!path.startsWith(root)) throw new Error(`"${specifier}" is outside the integration's folder`);
      // Each load gets its own module graph: the load's tag rides along on its files.
      const url = pathToFileURL(path);
      url.searchParams.set(LOAD, tag!);
      return { url: url.href, shortCircuit: true };
    },
    load(url, context, next) {
      if (url === SDK_URL) return { format: 'module', source, shortCircuit: true };
      // An integration's .ts files are ES modules, with their types stripped by Node itself,
      // the same under tsx, vitest or the desktop app's plain Node, whatever package.json is above.
      if (tagOf(url) && new URL(url).pathname.endsWith('.ts')) {
        const ts = readFileSync(fileURLToPath(url), 'utf8');
        return { format: 'module', source: stripTypeScriptTypes(ts, { mode: 'strip', sourceUrl: url }), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

// Node's own import(), outside any bundler's or test runner's module graph (vitest runs code in
// a vm of its own), so the hooks apply.
const nativeImport = new Script('(url) => import(url)', { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInThisContext() as (url: string) => Promise<any>;

/** Imports `file` (relative to `dir`) as it is on disk now, with its imports kept inside `dir`. */
export async function importInFolder(dir: string, file: string): Promise<any> {
  installSdk();
  const tag = String(++loads);
  // Node resolves symlinks (macOS's /tmp is one), so the folder is compared as its real path.
  roots.set(tag, realpathSync(dir) + sep);
  const url = pathToFileURL(join(dir, file));
  url.searchParams.set(LOAD, tag);
  return nativeImport(url.href);
}

/** Imports `<dir>/index.ts`; its default export must be `defineIntegration({...})`, with the id `id` if given. */
export async function importIntegration(dir: string, id?: string): Promise<Integration> {
  const mod = await importInFolder(dir, 'index.ts');
  const def = mod.default;
  if (!def || typeof def !== 'object' || typeof def.id !== 'string') throw new Error('index.ts must default-export defineIntegration({...})');
  if (id && def.id !== id) throw new Error(`index.ts exports "${def.id}"; it must be "${id}", like its folder`);
  return def as Integration;
}

/** Every file under `dir`, relative and sorted; macOS's .DS_Store files don't count. */
export async function folderFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name !== '.DS_Store')
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** What you approve: a hash of every file's path and contents. */
export async function folderHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of await folderFiles(dir)) {
    h.update(`${f}\0${createHash('sha256').update(await readFile(join(dir, f))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

/** The README the contract asks for (EVOLVE.md): `# <id>` and the sections. */
export async function checkReadme(dir: string, id: string): Promise<void> {
  const readme = await readFile(join(dir, 'README.md'), 'utf8').catch(() => null);
  if (readme === null) throw new Error('README.md is missing');
  if (!new RegExp(`^# ${id}\\b`, 'm').test(readme)) throw new Error(`README.md must start with "# ${id}"`);
  const missing = ['Access', 'Provides', 'Limits', 'Verified'].filter((s) => !new RegExp(`^## ${s}`, 'm').test(readme));
  if (missing.length) throw new Error(`README.md has no ${missing.map((s) => `## ${s}`).join(', ')}`);
}
