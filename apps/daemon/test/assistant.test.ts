import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@bloomterm/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Config } from '../src/config.ts';
import { Daemon, type DaemonEvent } from '../src/daemon.ts';
import { evolveSystem } from '../src/evolve/workspace.ts';
import { memoryStore } from '../src/market/secrets.ts';
import { fakeMarket } from './fakes.ts';

const FAKE_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fake-agent.mjs');

let home: string;
let daemon: Daemon;
let token: string;
const events: DaemonEvent[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

const answered = (chatId: string, seq: number, timeout = 10_000) =>
  expect.poll(() => events.some((e) => e.type === 'chat_done' && e.chatId === chatId && e.seq === seq), { timeout }).toBe(true);
// An EVOLVE run typechecks the integration and runs its tests, which takes a while on a busy machine.
const EVOLVED = 30_000;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-ask-'));
  daemon = new Daemon({
    home,
    port: 0,
    integrations: [fakeMarket],
    config: Config.parse({}),
    host: { profiles: {} },
    secrets: memoryStore(),
    agent: { kind: 'claude', path: FAKE_AGENT, version: 'fake' },
    notify: false,
    log: consoleLogger('silent'),
  });
  await daemon.start();
  daemon.subscribe((e) => events.push(e));
  token = (await readFile(join(home, 'token'), 'utf8')).trim();
});

afterAll(async () => {
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
});

describe('ASK', () => {
  it('answers through the agent, streaming, and keeps the conversation', async () => {
    expect((await api('GET', '/api/agent')).body.cli).toMatchObject({ kind: 'claude', version: 'fake' });
    const r = await api('POST', '/api/chats', { message: 'how is PETR4 doing?', context: 'GP PETR4 BZ Equity 1Y' });
    expect(r.status).toBe(202);
    const { chatId, seq } = r.body;
    await answered(chatId, seq);
    expect(events.filter((e) => e.type === 'chat_event' && e.event.type === 'text').length).toBeGreaterThan(3);

    const chat = (await api('GET', `/api/chats/${chatId}`)).body;
    expect(chat).toMatchObject({ title: 'how is PETR4 doing?', agent: 'claude', sessionId: 'fake-session-1', running: false });
    expect(chat.messages.map((m: any) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
    expect(chat.messages[1].text).toContain('You asked: how is PETR4 doing?');
    expect(chat.messages[1].tools).toEqual([{ name: 'mcp__bloomterm__get_quotes', input: { securities: ['PETR4'] }, ok: true }]);

    // A follow-up resumes the agent's own session.
    const next = await api('POST', '/api/chats', { message: 'and VALE3?', chatId });
    await answered(chatId, next.body.seq);
    const after = (await api('GET', `/api/chats/${chatId}`)).body;
    expect(after.messages).toHaveLength(4);
    expect(after.messages[3].text).toContain('(continuing) You asked: and VALE3?');
    expect((await api('GET', '/api/chats')).body[0].id).toBe(chatId);
  });

  it('records a failed answer, and one question at a time per chat', async () => {
    const r = await api('POST', '/api/chats', { message: 'please fail' });
    expect((await api('POST', '/api/chats', { message: 'again', chatId: r.body.chatId })).status).toBe(409);
    await answered(r.body.chatId, r.body.seq);
    const chat = (await api('GET', `/api/chats/${r.body.chatId}`)).body;
    expect(chat.messages[1]).toMatchObject({ status: 'error', error: 'the model is unavailable' });
    expect((await api('POST', '/api/chats', { message: '   ' })).status).toBe(400);
    expect((await api('POST', '/api/chats', { message: 'hi', chatId: 'c_nope' })).status).toBe(404);
  });
});

describe('EVOLVE', () => {
  it('works on a copy in a folder of its own, checks it, and runs nothing until you approve it', { timeout: 120_000 }, async () => {
    const r = await api('POST', '/api/evolve', { integration: 'newbank', goal: 'map the positions page' });
    expect(r.status).toBe(202);
    const { chatId, seq, dir } = r.body;
    expect(relative(home, dir)).toMatch(/^evolve[\\/]newbank-\d{14}$/);
    await answered(chatId, seq, EVOLVED);

    const chat = (await api('GET', `/api/chats/${chatId}`)).body;
    expect(chat).toMatchObject({ kind: 'evolve', title: 'EVOLVE newbank: map the positions page' });
    expect(chat.meta).toMatchObject({ integration: 'newbank', dir, from: 'new', checks: { ok: true, load: true, typecheck: true, tests: true, readme: true } });
    const answer = chat.messages.at(-1);
    expect(answer).toMatchObject({ status: 'done', text: expect.stringContaining('Mapped newbank') });
    expect(answer.tools.map((t: any) => [t.name, t.ok])).toEqual([
      ['prepare', true],
      ['Write', true],
      ['check', true],
    ]);
    // The run's folder: the routine, and the SDK and the examples to read.
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'sdk/integrations/sdk-surface.ts', 'newbank/index.ts']) expect(existsSync(join(dir, f)), f).toBe(true);
    // The agent's `check` tool, the same checks as above.
    expect((await api('POST', `/api/evolve/${chatId}/check`)).body).toMatchObject({ load: true, typecheck: true, tests: true, readme: true, ok: true });
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('# EVOLVE');

    expect((await api('GET', '/api/chats?kind=evolve')).body.map((c: any) => c.id)).toEqual([chatId]);
    expect((await api('GET', '/api/chats?kind=ask')).body.map((c: any) => c.id)).not.toContain(chatId);

    // Nothing of it is in your integrations yet. The diff shows what approving would add; the stray file isn't in it.
    expect((await api('GET', '/api/integrations/local')).body).toEqual([]);
    const diff = (await api('GET', `/api/integrations/newbank/diff?run=${chatId}`)).body;
    expect(diff).toMatchObject({ base: 'none', hash: chat.meta.hash });
    expect(diff.diff).toContain('+++ b/index.ts');
    expect(diff.diff).toContain('+++ b/README.md');
    expect(diff.diff).not.toContain('stray.txt');

    // You approve exactly what you reviewed.
    const wrong = await api('POST', `/api/evolve/${chatId}/approve`, { hash: 'f'.repeat(64) });
    expect(wrong).toMatchObject({ status: 409, body: { error: expect.stringContaining('review the diff again') } });
    const ok = await api('POST', `/api/evolve/${chatId}/approve`, { hash: diff.hash });
    expect(ok).toMatchObject({ status: 200, body: { approved: { hash: diff.hash, run: chatId }, supervised: false } });
    expect(await readFile(join(home, 'integrations/newbank/index.ts'), 'utf8')).toContain("id: 'newbank'");
    expect((await api('GET', '/api/integrations/local')).body).toEqual([expect.objectContaining({ id: 'newbank', state: 'on', running: false, replaces: false })]);
    expect((await api('GET', `/api/chats/${chatId}`)).body.meta.approved).toMatchObject({ hash: diff.hash });
    // It runs after a restart, which a bloomd started from a terminal can't do by itself.
    expect((await api('POST', '/api/restart')).status).toBe(409);

    // A follow-up resumes the run in the same folder.
    const f = await api('POST', '/api/chats', { chatId, message: 'anything left?' });
    expect(f.status).toBe(202);
    await answered(chatId, f.body.seq, EVOLVED);
    expect((await api('GET', `/api/chats/${chatId}`)).body.messages.at(-1).text).toContain('(continuing)');

    // A second run starts from your approved copy; taking yours out leaves nothing to start from.
    const again = await api('POST', '/api/evolve', { integration: 'newbank' });
    await answered(again.body.chatId, again.body.seq, EVOLVED);
    expect((await api('GET', `/api/chats/${again.body.chatId}`)).body.meta.from).toBe('yours');
    expect((await api('DELETE', '/api/integrations/newbank')).body).toMatchObject({ removed: 'newbank' });
    expect((await api('GET', '/api/integrations/local')).body).toEqual([]);
    expect((await api('DELETE', '/api/integrations/newbank')).status).toBe(404);
  });

  it('tells each CLI how its own tools work (Codex has no Read tool; Claude has no shell)', () => {
    expect(evolveSystem('claude')).toContain('Read, Glob and Grep');
    expect(evolveSystem('codex')).not.toContain('Read, Glob');
    expect(evolveSystem('codex')).toContain('apply_patch');
    for (const k of ['claude', 'codex'] as const) {
      expect(evolveSystem(k)).toContain('read CLAUDE.md here');
      expect(evolveSystem(k)).toContain('`check` tool');
    }
  });

  it('refuses bad integration ids, and approvals of runs that are unknown or still going', async () => {
    expect((await api('POST', '/api/evolve', { integration: '../etc' })).status).toBe(400);
    expect((await api('POST', '/api/evolve', { integration: 'Bank' })).status).toBe(400);
    expect((await api('POST', '/api/evolve/c_nope/approve', { hash: 'f'.repeat(64) })).status).toBe(404);
    expect((await api('POST', '/api/evolve/c_nope/approve', { hash: 'nope' })).status).toBe(400);
    // A run from before EVOLVE worked in your data folder had a git branch; it can't be approved.
    const old = daemon.store.chats.create({ title: 'EVOLVE oldbank: x', agent: 'claude', kind: 'evolve', meta: { integration: 'oldbank', branch: 'evolve/oldbank-1', worktree: '/nope' } });
    expect((await api('POST', `/api/evolve/${old.id}/approve`, { hash: 'f'.repeat(64) })).status).toBe(410);
    expect((await api('POST', '/api/chats', { chatId: old.id, message: 'again?' })).status).toBe(410);
  });

  it("shows recordings to the agent without credentials", async () => {
    const dir = join(home, 'raw', '_records');
    await mkdir(dir, { recursive: true });
    const entry = (url: string, mime: string, body: string, extra: any = {}) => ({
      request: {
        method: extra.method ?? 'GET',
        url,
        headers: [
          { name: 'Cookie', value: 'sid=SECRET-SESSION; theme=dark' },
          { name: 'Authorization', value: 'Bearer SECRET-TOKEN' },
          { name: 'Accept', value: 'application/json' },
        ],
        postData: extra.postData,
      },
      response: { status: 200, headers: [{ name: 'Set-Cookie', value: 'sid=SECRET-SESSION' }], content: { mimeType: mime, size: body.length, text: body } },
    });
    const har = {
      log: {
        entries: [
          entry('https://bank.example/app.js', 'application/javascript', 'var x;'),
          entry('https://bank.example/logo.png', 'image/png', ''),
          entry('https://bank.example/api/positions', 'application/json', JSON.stringify({ accountNumber: '12345678', positions: [{ symbol: 'PETR4', qty: 100 }], password: 'hunter2' })),
          entry('https://bank.example/graphql', 'application/json', '{"data":{}}', {
            method: 'POST',
            postData: { mimeType: 'application/json', text: JSON.stringify({ operationName: 'Portfolio', query: 'query Portfolio { x }' }) },
          }),
        ],
      },
    };
    await writeFile(join(dir, 'finance-1.har'), JSON.stringify(har));

    expect((await api('GET', '/api/evolve/recordings')).body).toEqual([expect.objectContaining({ file: 'finance-1.har' })]);
    const summary = (await api('GET', '/api/evolve/recordings/finance-1.har')).body;
    expect(summary.requests.map((r: any) => r.url)).toEqual(['https://bank.example/api/positions', 'https://bank.example/graphql']);
    expect(summary.requests[0]).toMatchObject({ index: 2, cookies: ['sid', 'theme'], requestHeaders: ['authorization', 'accept'] });
    expect(summary.requests[1].graphql).toBe('Portfolio');

    const one = await api('GET', '/api/evolve/recordings/finance-1.har?index=2');
    const text = JSON.stringify(one.body);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('hunter2');
    expect(one.body.request.headers.authorization).toMatch(/redacted/);
    expect(one.body.response.body).toMatchObject({ accountNumber: '12345678', positions: [{ symbol: 'PETR4', qty: 100 }] });

    expect([400, 404]).toContain((await api('GET', '/api/evolve/recordings/..%2Ftoken')).status);
    expect((await api('GET', '/api/evolve/recordings/token')).status).toBe(400);
    expect((await api('GET', '/api/evolve/recordings/nope.har')).status).toBe(404);
  });
});
