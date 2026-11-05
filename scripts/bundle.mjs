#!/usr/bin/env node
// Builds bloomd without the checkout: one folder the desktop app runs with its own Node.
//
//   node scripts/bundle.mjs [out]      (default: dist/bundle; `pnpm build:web` first)
//
// The folder (apps/daemon/src/layout.ts finds its files by these names):
//   bt.mjs, mcp.mjs     bt and `bt mcp`, bundled by esbuild
//   node_modules/       better-sqlite3 (a native addon) and playwright-core (it reads its own files);
//                       on Windows, @napi-rs/keyring too (a native addon, for Credential Manager)
//   web/                the built web app
//   integrations-src/   the built-ins' sources, what EVOLVE starts from
//   EVOLVE.md           EVOLVE's routine
//   kit/                what integrations in your data folder are typechecked against: the SDK's
//                       sources, zod, @types/node and TypeScript

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'dist/bundle'));

/** Packages left out of the bundle, copied whole into node_modules/. */
const EXTERNAL = ['better-sqlite3', 'playwright-core', '@napi-rs/keyring'];
/** ws's optional speedups, which it does without. */
const OPTIONAL = ['bufferutil', 'utf-8-validate'];

const web = join(root, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) {
  console.error('bundle: no web app in apps/web/dist; run `pnpm build:web` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { bt: join(root, 'apps/cli/src/main.ts'), mcp: join(root, 'apps/cli/src/mcp-main.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [...EXTERNAL, ...OPTIONAL],
  // Some dependencies are CommonJS and call require(); an ES module has none of its own.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

/** Where a package is installed, as Node finds it from the package that depends on it. */
function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return realpathSync(p);
    if (dir === dirname(dir)) throw new Error(`bundle: ${name} isn't installed (from ${from})`);
  }
}

const copy = (from, to, filter) => cpSync(from, to, { recursive: true, dereference: true, filter });
/** `path` relative to `dir`, with / on every system. */
const inside = (dir, path) => path.slice(dir.length + 1).replaceAll('\\', '/');

// better-sqlite3 needs only lib/ and the prebuilt addon for this machine (it picks
// prebuilds/<platform>-<arch>.node).
const sqlite = packageDir('better-sqlite3', join(root, 'packages/store'));
const addon = `${process.platform}-${process.arch}.node`;
copy(sqlite, join(out, 'node_modules/better-sqlite3'), (p) => {
  const rel = inside(sqlite, p);
  if (rel === '' || rel === 'package.json' || rel === 'LICENSE') return true;
  if (rel === 'lib' || rel.startsWith('lib/')) return true;
  return rel === 'prebuilds' || rel === `prebuilds/${addon}`;
});
if (!existsSync(join(out, 'node_modules/better-sqlite3/prebuilds', addon))) throw new Error(`better-sqlite3 has no prebuilt addon for ${addon}`);
copy(packageDir('playwright-core', join(root, 'packages/browser')), join(out, 'node_modules/playwright-core'));
if (process.platform === 'win32') {
  const keyring = packageDir('@napi-rs/keyring', join(root, 'apps/daemon'));
  const addon = `@napi-rs/keyring-win32-${process.arch}-msvc`;
  copy(keyring, join(out, 'node_modules/@napi-rs/keyring'));
  copy(packageDir(addon, keyring), join(out, 'node_modules', addon));
}

copy(web, join(out, 'web'));
copy(join(root, 'packages/integrations/EVOLVE.md'), join(out, 'EVOLVE.md'));
// bloomterm's license, and the notices the software it redistributes asks for.
for (const f of ['LICENSE', 'NOTICE']) copy(join(root, f), join(out, f));

// The built-ins: each folder of packages/integrations/src with an index.ts.
const src = join(root, 'packages/integrations/src');
const builtins = readdirSync(src).filter((d) => statSync(join(src, d)).isDirectory() && existsSync(join(src, d, 'index.ts')));
for (const id of builtins) copy(join(src, id), join(out, 'integrations-src', id));

// The kit: the SDK's sources at the paths they have in the checkout, so their relative imports
// work, and what they import. playwright-core resolves from the bundle's node_modules, above.
const kit = join(out, 'kit');
copy(join(root, 'packages/core/src'), join(kit, 'packages/core/src'));
copy(join(root, 'packages/browser/src'), join(kit, 'packages/browser/src'));
for (const f of ['sdk-surface.ts', 'sdk.ts', 'http.ts', 'text.ts']) copy(join(src, f), join(kit, 'packages/integrations/src', f));
const types = packageDir('@types/node', root);
for (const [name, from] of [['zod', join(root, 'packages/core')], ['@types/node', root], ['undici-types', types]]) {
  copy(packageDir(name, from), join(kit, 'node_modules', name));
}
// TypeScript, only what `tsc` runs: bin/tsc, lib/tsc.js and _tsc.js, and the lib.*.d.ts files.
const ts = packageDir('typescript', root);
copy(ts, join(kit, 'node_modules/typescript'), (p) => {
  const rel = inside(ts, p);
  return ['', 'package.json', 'LICENSE.txt', 'bin', 'bin/tsc', 'lib', 'lib/tsc.js', 'lib/_tsc.js'].includes(rel) || /^lib\/lib\..*\.d\.ts$/.test(rel);
});

writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'bloomterm-bundle', private: true, type: 'module' }, null, 2)}\n`);

// `bt` for your shell: link it onto your PATH, or on Windows add this folder to it. In the app it
// runs on the app's Node.
writeFileSync(
  join(out, 'bt'),
  `#!/bin/sh
# bt, from bloomterm.app: ln -s /Applications/bloomterm.app/Contents/Resources/bundle/bt /usr/local/bin/bt
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
node="$here/../../MacOS/node"
[ -x "$node" ] || node=node
exec "$node" --disable-warning=ExperimentalWarning "$here/bt.mjs" "$@"
`,
  { mode: 0o755 },
);
writeFileSync(
  join(out, 'bt.cmd'),
  ['@echo off', 'setlocal', 'set "node=%~dp0..\\node.exe"', 'if not exist "%node%" set "node=node"', '"%node%" --disable-warning=ExperimentalWarning "%~dp0bt.mjs" %*', ''].join('\r\n'),
);

const size = (dir) => readdirSync(dir, { recursive: true }).reduce((n, f) => {
  const s = statSync(join(dir, f));
  return s.isFile() ? n + s.size : n;
}, 0);
console.log(`bundle: ${out} (${(size(out) / 1e6).toFixed(0)} MB; built-ins: ${builtins.join(', ')})`);
