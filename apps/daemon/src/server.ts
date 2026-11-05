import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { parseSecurity, RANGES } from '@bloomterm/core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Daemon } from './daemon.ts';
import { ProviderError } from '@bloomterm/integrations';
import { MAX_UPLOAD } from './files/service.ts';
import { localDay } from './insights.ts';
import { NoSourceError } from './market/service.ts';
import { tokensEqual } from './token.ts';

// bloomd's API (SPEC §8.1). Localhost only, and every /api route but health and the UI
// sign-in needs the bearer token. The Host header must name this machine, which stops
// DNS-rebinding pages, and a browser request from any other origin is refused.
// The UI's files are public: they hold no data and no token.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RunBody = z.object({ force: z.boolean().optional() }).default({});
const OpenBody = z.object({ url: z.url().optional(), record: z.boolean().optional() }).default({});
const WipeBody = z.object({ confirm: z.literal(true) });
const UiSessionBody = z.object({ code: z.string().regex(/^[0-9a-f]{48}$/, 'malformed code') });
const UiKey = z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/, 'bad key');
const UiStateBody = z.object({ value: z.unknown() });
const SecretBody = z.object({ value: z.string().trim() });
const QuotesQuery = z.object({ keys: z.string().min(1) });
const FileId = z.string().regex(/^f_[0-9a-f]{12}$/, 'bad file id');
const AskBody = z.object({
  message: z.string().trim().max(4_000).optional(),
  chatId: z.string().max(40).optional(),
  context: z.string().max(500).optional(),
  files: z.array(FileId).max(10).optional(),
});
const ActionStep = z.enum(['apply', 'open', 'evolve', 'fetch', 'dismiss']);
const BarsQuery = z.object({ key: z.string().min(1), range: z.enum(RANGES).default('1Y') });
const IntegrationId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'integration ids are lowercase, like "xp" or "banco-do-brasil"');
const EvolveBody = z.object({ integration: IntegrationId, goal: z.string().trim().max(2_000).optional() });
const RecordingQuery = z.object({ index: z.coerce.number().int().min(0).optional(), match: z.string().max(200).optional() });
const CaptureBody = z.object({ integration: IntegrationId, url: z.string().max(2_000), profile: z.string().max(40).optional(), waitMs: z.number().int().min(0).max(30_000).optional() });
const TryBody = z.object({ run: z.string().max(40), dataset: z.string().max(60) });
/** What you approve: the files' hash you reviewed, so a later edit isn't approved with them. */
const ApproveBody = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'the hash of the files you reviewed (from the diff)') });
const DiffQuery = z.object({ run: z.string().max(40).optional() });

const Keys = z.string().max(2_000);
const NewsQuery = z.object({
  security: Keys.optional(),
  for: z.literal('me').optional(),
  story: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  kind: z.enum(['news', 'filing']).optional(),
  since: z.string().max(40).optional(),
  before: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const StoriesQuery = z.object({
  security: Keys.optional(),
  for: z.literal('me').optional(),
  hours: z.coerce.number().min(1).max(24 * 30).default(48),
  rank: z.enum(['latest', 'top']).default('top'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const WhyQuery = z.object({ keys: Keys.min(1) });
const WhyBody = z.object({ key: z.string().min(1).max(60) });

const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const JobsQuery = z.object({
  status: z.enum(['queued', 'running', 'ok', 'failed', 'cancelled']).optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function buildServer(daemon: Daemon, token: string, webRoot?: string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  const allowedHost = (host: string | undefined) => {
    if (!host) return false;
    const port = daemon.port;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
  };

  const allowedOrigin = (origin: string) => {
    const port = daemon.port;
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase());
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowedHost(req.headers.host)) return reply.code(403).send({ error: 'bad Host header' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin)) return reply.code(403).send({ error: 'cross-origin request refused' });
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || path === '/api/health' || path === '/api/ui/session') return;
    const header = req.headers.authorization ?? '';
    const fromQuery = req.url.startsWith('/api/events') ? new URL(req.url, 'http://x').searchParams.get('token') : null;
    const given = header.startsWith('Bearer ') ? header.slice(7) : fromQuery;
    if (!given || !tokensEqual(given, token)) return reply.code(401).send({ error: 'missing or wrong token' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CSP);
    reply.header('referrer-policy', 'no-referrer');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof NoSourceError) return reply.code(404).send({ error: err.message });
    if (err instanceof ProviderError) return reply.code(502).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err) });
    const status = (err as any)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    daemon.log.error('api error', { error: String(err) });
    return reply.code(500).send({ error: 'internal error' });
  });

  // Uploads (SPEC §10.5) come as raw bytes, the name in x-file-name.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

  app.register(websocket);
  app.register(async (scoped) => {
    scoped.get('/api/events', { websocket: true }, (socket) => {
      const off = daemon.subscribe((ev) => socket.send(JSON.stringify(ev)));
      socket.on('close', off);
      socket.send(JSON.stringify({ type: 'hello', pid: process.pid }));
    });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'bloomd' }));

  app.get('/api/status', async () => daemon.status());

  app.get('/api/sources', async () => daemon.sources());

  app.post<{ Params: { id: string } }>('/api/sources/:id/login', async (req, reply) => {
    reply.code(202);
    return daemon.enqueue({ kind: 'login', source: req.params.id });
  });

  app.post<{ Params: { id: string } }>('/api/sources/:id/probe', async (req, reply) => {
    reply.code(202);
    return daemon.enqueue({ kind: 'probe', source: req.params.id });
  });

  app.post<{ Params: { id: string; dataset: string } }>('/api/sources/:id/datasets/:dataset/run', async (req, reply) => {
    const body = RunBody.parse(req.body ?? {});
    reply.code(202);
    return daemon.enqueue({ kind: 'run', source: req.params.id, dataset: req.params.dataset, force: body.force });
  });

  app.get('/api/jobs', async (req) => daemon.store.jobs.list(JobsQuery.parse(req.query)));

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const job = daemon.store.jobs.get(req.params.id, { withResult: true });
    if (!job) throw new HttpError(404, `no job ${req.params.id}`);
    return job;
  });

  app.get<{ Querystring: { source?: string } }>('/api/positions', async (req) => daemon.store.holdings.currentPositions(req.query.source));
  app.get<{ Querystring: { source?: string } }>('/api/balances', async (req) => daemon.store.holdings.currentBalances(req.query.source));
  app.get('/api/accounts', async () => daemon.store.holdings.accounts());

  app.post<{ Params: { name: string } }>('/api/profiles/:name/open', async (req, reply) => {
    const body = OpenBody.parse(req.body ?? {});
    reply.code(202);
    return daemon.openProfile(req.params.name, body);
  });

  app.post<{ Params: { name: string } }>('/api/profiles/:name/wipe', async (req) => {
    WipeBody.parse(req.body);
    return daemon.wipeProfile(req.params.name);
  });

  app.post('/api/doctor', async () => daemon.doctor());

  // The UI (SPEC §8.1). `bt ui` gets a one-time code and opens /#code=…; the page trades it
  // for the token and keeps that in its own origin's storage. (A cookie would also reach
  // every other server on 127.0.0.1, since cookies ignore ports.)
  app.post('/api/ui/code', async () => daemon.createUiCode());
  app.post('/api/ui/session', async (req) => {
    const { code } = UiSessionBody.parse(req.body ?? {});
    if (!daemon.redeemUiCode(code)) throw new HttpError(401, 'this link has expired or was used already; run `bt ui` again');
    return { token };
  });
  app.get<{ Params: { key: string } }>('/api/ui/state/:key', async (req) => daemon.store.ui.get(UiKey.parse(req.params.key)) ?? { value: null });
  app.put<{ Params: { key: string } }>('/api/ui/state/:key', async (req) => {
    const { value } = UiStateBody.parse(req.body ?? {});
    return daemon.store.ui.set(UiKey.parse(req.params.key), value);
  });

  // SET (SPEC §5): API keys go into the Keychain. Values are write-only over the API.
  const secretName = (name: string) => {
    if (!daemon.secretNames().includes(name)) throw new HttpError(400, `no integration uses a key called "${name}"`);
    return name;
  };
  app.get('/api/integrations', async () => daemon.integrationList());
  // Yours, in <home>/integrations (SPEC §6.11): each runs only once you approve its files.
  app.get('/api/integrations/local', async () => daemon.local.list());
  app.get<{ Params: { id: string } }>('/api/integrations/:id/diff', async (req) => daemon.integrationDiff(IntegrationId.parse(req.params.id), DiffQuery.parse(req.query).run));
  app.post<{ Params: { id: string } }>('/api/integrations/:id/approve', async (req) => daemon.approveIntegration(IntegrationId.parse(req.params.id), ApproveBody.parse(req.body ?? {})));
  app.delete<{ Params: { id: string } }>('/api/integrations/:id', async (req) => daemon.removeIntegration(IntegrationId.parse(req.params.id)));
  // Setup: what bloomterm needs on this computer (setup.ts). Checking again restarts bloomd when an
  // agent CLI was installed since it started.
  app.get('/api/setup', async () => daemon.setup.get());
  app.post('/api/setup/check', async () => daemon.checkSetup());
  app.post('/api/restart', async (_req, reply) => {
    reply.code(202);
    return daemon.restart();
  });
  // How the desktop app stops bloomd on Windows, where a signal can only kill it outright.
  app.post('/api/shutdown', async (_req, reply) => {
    reply.code(202);
    return daemon.shutdown();
  });
  app.get('/api/settings/secrets', async () => daemon.secretStatus());
  app.put<{ Params: { name: string } }>('/api/settings/secrets/:name', async (req) => {
    const name = secretName(req.params.name);
    const { value } = SecretBody.parse(req.body ?? {});
    try {
      await daemon.secrets.set(name, value);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    daemon.log.info('api key saved', { name });
    return { name, from: await daemon.secrets.source(name) };
  });
  app.delete<{ Params: { name: string } }>('/api/settings/secrets/:name', async (req) => {
    const name = secretName(req.params.name);
    await daemon.secrets.remove(name);
    daemon.log.info('api key removed', { name });
    return { name, from: await daemon.secrets.source(name) };
  });

  // ASK (SPEC §10.2): answers stream over /api/events as chat_event, then chat_done.
  app.get('/api/agent', async () => ({ cli: daemon.assistant.status() }));
  app.get<{ Querystring: { kind?: string } }>('/api/chats', async (req) => daemon.store.chats.list(50, req.query.kind === 'evolve' || req.query.kind === 'ask' ? req.query.kind : undefined));
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    const chat = daemon.store.chats.get(req.params.id);
    if (!chat) throw new HttpError(404, `no chat ${req.params.id}`);
    return {
      ...chat,
      running: daemon.assistant.isRunning(chat.id),
      messages: daemon.store.chats.messages(chat.id),
      files: daemon.store.files.list(chat.id),
      actions: daemon.store.actions.list(chat.id),
    };
  });
  app.post('/api/chats', async (req, reply) => {
    const body = AskBody.parse(req.body ?? {});
    const { chat, seq } = await daemon.assistant.ask(body);
    reply.code(202);
    return { chatId: chat.id, seq };
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/stop', async (req) => ({ stopped: daemon.assistant.stop(req.params.id) }));
  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (req) => daemon.deleteChat(req.params.id));

  // Files (SPEC §10.5): you upload, then send the ids with a question. The agent's tools
  // (`bt mcp`, scoped to its conversation) read them and write files back while it answers.
  app.post('/api/files', { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'send the file as application/octet-stream');
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    if (!name) throw new HttpError(400, 'name the file in x-file-name');
    reply.code(201);
    return daemon.files.upload(name, req.body);
  });
  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const { file, bytes } = await daemon.files.download(FileId.parse(req.params.id));
    return reply
      .type(file.mime)
      .header('content-disposition', `attachment; filename="${file.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(bytes);
  });
  app.post<{ Params: { id: string } }>('/api/files/:id/save', async (req) => daemon.files.saveToDownloads(FileId.parse(req.params.id)));
  const answering = (id: string) => {
    const chat = daemon.store.chats.get(id);
    if (!chat || chat.kind !== 'ask') throw new HttpError(404, `no conversation ${id}`);
    return daemon.assistant.answering(id);
  };
  app.get<{ Params: { id: string } }>('/api/chats/:id/files', async (req) => daemon.files.list(req.params.id));
  app.post<{ Params: { id: string } }>('/api/chats/:id/files/read', async (req) => daemon.files.read(req.params.id, req.body ?? {}));
  app.post<{ Params: { id: string } }>('/api/chats/:id/files/query', async (req) => daemon.files.query(req.params.id, req.body ?? {}));
  app.post<{ Params: { id: string } }>('/api/chats/:id/files/write', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const file = await daemon.files.write(req.params.id, answering(req.params.id), req.body ?? {});
    reply.code(201);
    return { id: file.id, name: file.name, size: file.size, sheets: file.sheets, note: 'the owner sees a download link under your answer' };
  });
  // What the agent proposes; a card under its answer, carried out only when you click.
  app.post<{ Params: { id: string } }>('/api/chats/:id/actions', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { action, summary } = daemon.actions.propose(req.params.id, answering(req.params.id), (req.body ?? {}) as any);
    reply.code(201);
    return { id: action.id, kind: action.kind, status: action.status, summary };
  });
  app.post<{ Params: { id: string; step: string } }>('/api/actions/:id/:step', async (req) => daemon.actions.step(req.params.id, ActionStep.parse(req.params.step)));

  // EVOLVE (SPEC §6.11): runs are chats of kind "evolve". The other routes are the agent's
  // read-only view of the sites (via `bt mcp --evolve`); credentials are redacted.
  app.post('/api/evolve', async (req, reply) => {
    const body = EvolveBody.parse(req.body ?? {});
    const { chat, seq, dir } = await daemon.assistant.evolve(body);
    reply.code(202);
    return { chatId: chat.id, seq, dir };
  });
  app.post<{ Params: { run: string } }>('/api/evolve/:run/check', async (req) => daemon.assistant.checkRun(req.params.run));
  app.post<{ Params: { run: string } }>('/api/evolve/:run/approve', async (req) => daemon.approveRun(req.params.run, ApproveBody.parse(req.body ?? {})));
  app.get('/api/evolve/recordings', async () => daemon.recordings());
  app.get<{ Params: { file: string } }>('/api/evolve/recordings/:file', async (req) => daemon.recording(req.params.file, RecordingQuery.parse(req.query)));
  app.post('/api/evolve/capture', async (req) => daemon.capture(CaptureBody.parse(req.body ?? {})));
  app.post('/api/evolve/fetch', async (req) => daemon.fetchAs(CaptureBody.omit({ waitMs: true }).parse(req.body ?? {})));
  app.post('/api/evolve/try', async (req) => {
    const { run, dataset } = TryBody.parse(req.body ?? {});
    return daemon.tryDataset(run, dataset);
  });

  /** `for=me`: what you hold and watch; `security`: keys or tickers, comma-separated. */
  const securitiesOf = (q: { security?: string; for?: 'me' }) =>
    q.for === 'me' ? daemon.followed().map((s) => s.key) : q.security ? q.security.split(',').flatMap((k) => parseSecurity(k)?.key ?? []) : undefined;

  app.get('/api/news', async (req) => {
    const q = NewsQuery.parse(req.query);
    return daemon.store.news.list({ ...q, securities: securitiesOf(q) });
  });
  app.get('/api/news/stories', async (req) => {
    const q = StoriesQuery.parse(req.query);
    return daemon.store.news.stories({ since: new Date(Date.now() - q.hours * 3_600_000).toISOString(), securities: securitiesOf(q), rank: q.rank, limit: q.limit });
  });
  app.get('/api/news/feeds', async () => daemon.news.feeds());
  app.post('/api/news/refresh', async () => daemon.news.poll());

  app.get('/api/brief', async () => ({ brief: daemon.insights.latestBrief(), agent: daemon.assistant.status() }));
  app.post('/api/brief', async (_req, reply) => {
    void daemon.insights.brief().catch(() => {});
    return reply.code(202).send(daemon.insights.latestBrief());
  });
  app.get('/api/why', async (req) => {
    const day = localDay(new Date());
    const keys = WhyQuery.parse(req.query).keys.split(',').flatMap((k) => parseSecurity(k)?.key ?? []);
    return Object.fromEntries(keys.slice(0, 60).map((k) => [k, daemon.insights.get('why', `${day}|${k}`)]));
  });
  app.post('/api/why', async (req, reply) => {
    const { key } = WhyBody.parse(req.body ?? {});
    void daemon.insights.why(key).catch(() => {});
    const sec = parseSecurity(key)!;
    return reply.code(202).send(daemon.insights.get('why', `${localDay(new Date())}|${sec.key}`));
  });

  app.get('/api/market/quotes', async (req) => {
    const { keys } = QuotesQuery.parse(req.query);
    const list = [...new Set(keys.split(',').map((k) => k.trim()).filter(Boolean))];
    if (list.length > 60) throw new HttpError(400, 'at most 60 keys per request');
    return daemon.market.quoteMany(list);
  });
  app.get('/api/market/bars', async (req) => {
    const { key, range } = BarsQuery.parse(req.query);
    return daemon.market.bars(key, range);
  });

  if (webRoot && existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot, index: ['index.html'] });
    // The UI's pages have their own URLs (/s/PETR4, /news…): any GET that isn't the API or a file gets the app.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+(\?|$)/i.test(req.url)) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/plain').send(`The UI isn't built yet. Run: pnpm --filter @bloomterm/web build (looked in ${webRoot})\n`),
    );
  }

  return app;
}
