import { originMatches } from './match.ts';
import type { BrowserAdapterDef } from './types.ts';

/** Declares a browser adapter (SPEC §6.5). Validates the parts that are easy to get wrong. */
export function defineBrowserAdapter<const A extends BrowserAdapterDef>(def: A): A {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`adapter id must be kebab-case: ${def.id}`);
  if (def.origins.length === 0) throw new Error(`${def.id}: origins must list the institution's domains`);
  for (const o of def.origins) originMatches(o, 'https://example.invalid'); // throws on malformed patterns
  if (Object.keys(def.datasets).length === 0) throw new Error(`${def.id}: no datasets`);
  for (const [name, ds] of Object.entries(def.datasets)) {
    if (ds.strategies.length === 0) throw new Error(`${def.id}.${name}: no strategies`);
  }
  return def;
}
