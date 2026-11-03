/**
 * Origin patterns look like `https://www.bank.example`, `https://*.bank.example`
 * or `http://127.0.0.1:4100`. `*.` matches the apex and any subdomain.
 * A pattern without a port only matches the scheme's default port.
 */
export function originMatches(pattern: string, url: string | URL): boolean {
  let target: URL;
  try {
    target = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const m = /^(https?|wss?):\/\/(\*\.)?([^/:]+)(?::(\d+))?\/?$/i.exec(pattern.trim());
  if (!m) throw new Error(`invalid origin pattern: ${pattern}`);
  const [, scheme, wildcard, host, port] = m;
  if (target.protocol !== `${scheme!.toLowerCase()}:`) return false;
  if ((target.port || '') !== (port ?? '')) return false;
  const h = target.hostname.toLowerCase();
  const base = host!.toLowerCase();
  if (wildcard) return h === base || h.endsWith(`.${base}`);
  return h === base;
}

export function matchesAnyOrigin(patterns: readonly string[], url: string | URL): boolean {
  return patterns.some((p) => originMatches(p, url));
}
