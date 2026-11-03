import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where bloomterm's own files are (your data is elsewhere: bloomtermHome()). From a checkout,
// the TypeScript sources run through tsx. In the desktop app, scripts/bundle.mjs puts bt.mjs,
// mcp.mjs, the web app and the integration kit in one folder, run by the app's own Node.

export interface Layout {
  kind: 'repo' | 'bundle';
  /** The checkout, or the bundle folder. */
  root: string;
  /** Starts `bt`: the program, then the arguments that come before bt's own. */
  bt: string[];
  /** Starts `bt mcp`, straight to the file so it starts fast. */
  mcp: string[];
  /** The built web app bloomd serves. */
  web: string;
  /** The built-in integrations' sources: what EVOLVE starts from when you have no copy yet. */
  integrationsSrc: string;
  /** EVOLVE's routine (packages/integrations/EVOLVE.md), which each run gets as CLAUDE.md and AGENTS.md. */
  routine: string;
  /**
   * What an integration in your data folder is typechecked against: packages/{core,browser}/src
   * and packages/integrations/src/sdk-surface.ts, with zod, playwright-core and @types/node
   * resolvable from there, and `tsc`.
   */
  kit: { root: string; tsc: string };
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Integrations load through Node's type stripping and a vm loader flag, both still experimental
 * in Node 22, which warns about each on stderr. The desktop app starts bloomd with this too.
 */
export const NODE_FLAG = '--disable-warning=ExperimentalWarning';

/** The bundle's files sit next to each other; in a checkout this file is apps/daemon/src/layout.ts. */
export function layout(): Layout {
  if (existsSync(join(here, 'bt.mjs')) && existsSync(join(here, 'mcp.mjs'))) {
    const kit = join(here, 'kit');
    return {
      kind: 'bundle',
      root: here,
      bt: [process.execPath, NODE_FLAG, join(here, 'bt.mjs')],
      mcp: [process.execPath, NODE_FLAG, join(here, 'mcp.mjs')],
      web: join(here, 'web'),
      integrationsSrc: join(here, 'integrations-src'),
      routine: join(here, 'EVOLVE.md'),
      kit: { root: kit, tsc: join(kit, 'node_modules/typescript/bin/tsc') },
    };
  }
  const root = resolve(here, '../../..');
  return {
    kind: 'repo',
    root,
    // The symlinked path, not pnpm's versioned store path, so upgrading tsx doesn't break it.
    bt: [process.execPath, join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'apps/cli/src/main.ts')],
    mcp: [join(root, 'node_modules/.bin/tsx'), join(root, 'apps/cli/src/mcp-main.ts')],
    web: join(root, 'apps/web/dist'),
    integrationsSrc: join(root, 'packages/integrations/src'),
    routine: join(root, 'packages/integrations/EVOLVE.md'),
    kit: { root, tsc: join(root, 'node_modules/typescript/bin/tsc') },
  };
}
