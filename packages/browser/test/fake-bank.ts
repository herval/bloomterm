import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

// A tiny "bank" for browser tests: a login form, a session cookie, JSON APIs,
// a CSV export, a GraphQL endpoint, and a Buy button that must never fire.

export const POSITIONS = [
  { accountExternalId: 'A1', rawSymbol: 'PETR4', quantity: 100, value: 3812, currency: 'BRL' },
  { accountExternalId: 'A1', rawSymbol: 'AAPL', quantity: 10, value: 2314.2, currency: 'USD' },
];

export interface FakeBank {
  url: string;
  hits: Record<string, number>;
  close(): Promise<void>;
}

export async function startFakeBank(): Promise<FakeBank> {
  const hits: Record<string, number> = {};
  const authed = (req: IncomingMessage) => /(?:^|;\s*)sid=valid/.test(req.headers.cookie ?? '');
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => resolve(s));
    });

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const key = `${req.method} ${path}`;
    hits[key] = (hits[key] ?? 0) + 1;
    const html = (s: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${s}</body></html>`);
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

    switch (key) {
      case 'GET /login':
        return html(`<form method="post" action="/login">
          <label>Username <input name="u"></label>
          <label>Password <input type="password" name="p"></label>
          <button type="submit">Sign in</button></form>`);
      case 'POST /login':
        await body(req);
        // A session cookie (no Max-Age), like most banks set.
        return res.writeHead(302, { 'set-cookie': 'sid=valid; Path=/; HttpOnly', location: '/summary' }).end();
      case 'GET /summary':
        if (!authed(req)) return res.writeHead(302, { location: '/login' }).end();
        return html(`<h1>Summary</h1>
          <table id="positions"><tr><th>Symbol</th><th>Qty</th><th>Value</th><th>Ccy</th></tr>
          ${POSITIONS.map((p) => `<tr><td>${p.rawSymbol}</td><td>${p.quantity}</td><td>${p.value}</td><td>${p.currency}</td></tr>`).join('')}
          </table>
          <a href="/positions.csv" download>Download CSV</a>
          <button id="buy" onclick="fetch('/api/trade', { method: 'POST' })">Buy</button>
          <button id="refresh">Refresh</button>
          <script>fetch('/api/positions').then(r => r.json()).then(d => { document.title = 'loaded ' + d.length; });</script>`);
      case 'GET /challenge':
        return html('<h1>Verify it\'s you</h1><p>Enter the code we sent.</p>');
      case 'GET /api/me':
        return authed(req) ? json(200, { user: 'h' }) : json(401, { error: 'unauthorized' });
      case 'GET /api/positions':
        return authed(req) ? json(200, POSITIONS) : json(401, { error: 'unauthorized' });
      case 'GET /api/broken':
        return json(500, { error: 'boom' });
      case 'GET /positions.csv':
        if (!authed(req)) return json(401, {});
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="positions.csv"' });
        return res.end(['account,symbol,qty,value,ccy', ...POSITIONS.map((p) => [p.accountExternalId, p.rawSymbol, p.quantity, p.value, p.currency].join(','))].join('\n'));
      case 'POST /api/trade':
        await body(req);
        return json(200, { ok: true });
      case 'POST /graphql': {
        const b = await body(req);
        return json(200, { data: { echo: b.length, positions: POSITIONS } });
      }
      default:
        return json(404, { error: 'not found' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
