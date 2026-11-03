import { parseSecurity, type Security } from './security.ts';

// The command line (SPEC §4.2): `[security] [FUNCTION] [args...] <GO>`.

export type Command =
  | { kind: 'empty' }
  /** `3 <GO>`: open row 3 of the list in this panel. */
  | { kind: 'drill'; row: number }
  | { kind: 'go'; security?: Security; fn?: string; args: string[] }
  /** Anything that doesn't parse goes to ASK. */
  | { kind: 'ask'; text: string }
  | { kind: 'unknown'; text: string };

/**
 * A known mnemonic always wins over a ticker: `W` is the watchlist function.
 * Type `W US Equity` for the ticker.
 */
export function parseCommand(input: string, functions: ReadonlySet<string>): Command {
  const text = input.replace(/<go>/gi, ' ').trim();
  if (!text) return { kind: 'empty' };
  if (/^\d{1,4}$/.test(text)) return { kind: 'drill', row: Number(text) };

  const tokens = text.split(/\s+/);
  const isFn = (t: string | undefined) => !!t && functions.has(t.toUpperCase());
  const withSecurity = (security: Security, n: number): Command => {
    const rest = tokens.slice(n);
    if (rest.length === 0) return { kind: 'go', security, args: [] };
    if (isFn(rest[0])) return { kind: 'go', security, fn: rest[0]!.toUpperCase(), args: rest.slice(1) };
    return { kind: 'ask', text };
  };

  // A spelled-out key (`PETR4 BZ Equity`, `USDBRL Curncy`) beats everything.
  for (const n of [3, 2]) {
    const security = tokens.length >= n ? parseSecurity(tokens.slice(0, n).join(' ')) : null;
    if (security) return withSecurity(security, n);
  }
  if (isFn(tokens[0])) return { kind: 'go', fn: tokens[0]!.toUpperCase(), args: tokens.slice(1) };
  const security = parseSecurity(tokens[0]!);
  if (security) return withSecurity(security, 1);
  return tokens.length > 1 ? { kind: 'ask', text } : { kind: 'unknown', text };
}
