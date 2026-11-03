import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@bloomterm/browser';
import { openStore } from '@bloomterm/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ActionService, type ActionDeps } from '../src/actions.ts';
import { Config } from '../src/config.ts';
import { Daemon, type DaemonEvent } from '../src/daemon.ts';
import { parseNumber, parseSpreadsheet, runQuery } from '../src/files/sheets.ts';
import { memoryStore } from '../src/market/secrets.ts';
import { fakeMarket } from './fakes.ts';

// Files and cards in ASK (SPEC §10.5), end to end: the fake agent starts the real `bt mcp`
// and calls its chat tools against this bloomd.

const FAKE_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fake-agent.mjs');

let home: string;
let daemon: Daemon;
let token: string;
const events: DaemonEvent[] = [];
const opened: { name: string; url: string }[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

const upload = async (name: string, bytes: Buffer) => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const answered = (chatId: string, seq: number) =>
  expect.poll(() => events.find((e) => e.type === 'chat_done' && e.chatId === chatId && e.seq === seq), { timeout: 20_000 }).toBeTruthy();

// A Brazilian bank's export: Latin-1, semicolons, a title above the header, "1.234,56".
const STATEMENT = Buffer.from('Extrato Conta Corrente\n\nData;Descrição;Valor\n01/10/2026;PIX recebido;1.234,56\n02/10/2026;Cartão;-89,90\n02/10/2026;Cartão;-10,10\n', 'latin1');
const POSITIONS = Buffer.from('Ticker;Qtd;Valor\nPETR4;100;5.255,00\nVALE3;50;3.100,50\n', 'utf8');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-files-'));
  daemon = new Daemon({
    home,
    port: 0,
    integrations: [fakeMarket],
    config: Config.parse({}),
    host: { profiles: {} },
    secrets: memoryStore(),
    agent: { kind: 'claude', path: FAKE_AGENT, version: 'fake' },
    // The checks have their own tests (assistant.test.ts).
    evolve: { checks: false },
    downloads: join(home, 'Downloads'),
    notify: false,
    newsTickMs: 0,
    briefTickMs: 0,
    log: consoleLogger('silent'),
  });
  await daemon.start();
  // No windows in tests: record what "Open sign-in" would have opened.
  daemon.openProfile = async (name, o) => {
    opened.push({ name, url: o.url! });
    return { profile: name };
  };
  daemon.subscribe((e) => events.push(e));
  token = (await readFile(join(home, 'token'), 'utf8')).trim();
});

afterAll(async () => {
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
});

describe('spreadsheets', () => {
  it('reads Brazilian numbers and dates, and sums exactly', () => {
    const sheets = parseSpreadsheet('extrato.csv', STATEMENT);
    expect(sheets[0]!.rows[2]).toEqual(['Data', 'Descrição', 'Valor']);
    const t = runQuery(sheets, { file: 'x', columns: [{ from: 'data', type: 'date' }, { from: 'VALOR', as: 'amount', type: 'number' }], decimal: ',' });
    expect(t.headerRow).toBe(3);
    expect(t.rows).toEqual([
      ['2026-10-01', 1234.56],
      ['2026-10-02', -89.9],
      ['2026-10-02', -10.1],
    ]);
    const g = runQuery(sheets, { file: 'x', columns: [{ from: 'Descrição', as: 'what' }, { from: 'Valor', as: 'amount', type: 'number' }], groupBy: ['what'], sum: ['amount'], where: [{ column: 'amount', op: 'lt', value: 0 }], decimal: ',' });
    expect(g.rows).toEqual([['Cartão', -100, 2]]);
    expect([parseNumber('R$ -1.234,56'), parseNumber('(12.50)'), parseNumber('1.234'), parseNumber('1.234', ','), parseNumber('n/a')]).toEqual([-1234.56, -12.5, 1.234, 1234, null]);
  });

  it('takes uploads, refuses what it cannot read, and names columns it does not know', async () => {
    expect((await upload('notes.exe', Buffer.from('MZ'))).status).toBe(415);
    const r = await upload('../../etc/extrato.csv', STATEMENT);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'extrato.csv', origin: 'upload', chatId: null, sheets: [{ name: 'Sheet1', rows: 6, cols: 3 }] });
    expect(existsSync(join(home, 'files', r.body.id))).toBe(true);
    const sheets = parseSpreadsheet('x.csv', STATEMENT);
    expect(() => runQuery(sheets, { file: 'x', columns: [{ from: 'Saldo' }] })).toThrow(/no column "Saldo".*Data \| Descrição \| Valor/);
  });
});

describe('files in ASK', () => {
  it('sends files with a question; the agent queries them and writes one back', async () => {
    const up = (await upload('extrato.csv', STATEMENT)).body;
    const r = await api('POST', '/api/chats', { message: 'what did I spend on the card?', files: [up.id] });
    expect(r.status).toBe(202);
    await answered(r.body.chatId, r.body.seq);

    const chat = (await api('GET', `/api/chats/${r.body.chatId}`)).body;
    const answer = chat.messages.at(-1);
    expect(answer.status).toBe('done');
    expect(answer.text).toContain('| Cartão | -100 | 2 |');
    expect(answer.tools.map((t: any) => t.name)).toEqual(['mcp__bloomterm__list_files', 'mcp__bloomterm__query_sheet', 'mcp__bloomterm__write_file']);
    expect(chat.files.map((f: any) => [f.name, f.origin, f.seq])).toEqual([
      ['extrato.csv', 'upload', 1],
      ['totals.xlsx', 'agent', 2],
    ]);
    expect(events.some((e) => e.type === 'chat_file' && e.chatId === r.body.chatId)).toBe(true);

    // What you download is a real workbook with the query's rows.
    const out = chat.files[1];
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/files/${out.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.headers.get('content-disposition')).toContain('totals.xlsx');
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(wb.Sheets['By type']!, { header: 1 })).toEqual([
      ['what', 'sum of amount', 'count'],
      ['Cartão', -100, 2],
      ['PIX recebido', 1234.56, 1],
    ]);

    // The desktop app saves into Downloads instead, without overwriting.
    const saved = [(await api('POST', `/api/files/${out.id}/save`)).body.path, (await api('POST', `/api/files/${out.id}/save`)).body.path];
    expect(saved).toEqual([join(home, 'Downloads/totals.xlsx'), join(home, 'Downloads/totals (2).xlsx')]);
    expect(await readFile(saved[1])).toEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${daemon.port}/api/files/${out.id}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer()));
    expect((await api('POST', '/api/files/f_000000000000/save')).status).toBe(404);

    // An upload goes with one question only.
    expect((await api('POST', '/api/chats', { message: 'again', files: [up.id] })).status).toBe(409);
  });

  it("keeps the agent's tools inside its own conversation, and only while it answers", async () => {
    const mine = (await upload('extrato.csv', STATEMENT)).body;
    const r = await api('POST', '/api/chats', { message: 'look', files: [mine.id] });
    await answered(r.body.chatId, r.body.seq);
    const other = (await api('POST', '/api/chats', { message: 'something else' })).body;
    await answered(other.chatId, other.seq);
    expect((await api('POST', `/api/chats/${other.chatId}/files/read`, { file: mine.id })).status).toBe(404);
    expect((await api('POST', `/api/chats/${r.body.chatId}/files/read`, { file: mine.id, match: 'cartao' })).body).toMatchObject({ total: 2, rows: [[5, '02/10/2026', 'Cartão', '-89,90'], [6, '02/10/2026', 'Cartão', '-10,10']] });
    expect((await api('POST', `/api/chats/${r.body.chatId}/files/write`, { name: 'x.csv', sheets: [{ rows: [[1]] }] })).status).toBe(409);
    expect((await api('POST', `/api/chats/${r.body.chatId}/actions`, { kind: 'connect', institution: 'X' })).status).toBe(409);
  });

  it('deletes a conversation with its files, and clears uploads never sent', async () => {
    const up = (await upload('extrato.csv', STATEMENT)).body;
    const r = await api('POST', '/api/chats', { message: 'look', files: [up.id] });
    await answered(r.body.chatId, r.body.seq);
    const files = (await api('GET', `/api/chats/${r.body.chatId}`)).body.files;
    await api('DELETE', `/api/chats/${r.body.chatId}`);
    for (const f of files) expect(existsSync(join(home, 'files', f.id))).toBe(false);

    const stray = (await upload('extrato.csv', STATEMENT)).body;
    expect(await daemon.files.sweep(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThan(0);
    expect(existsSync(join(home, 'files', stray.id))).toBe(false);
    expect((await api('GET', `/api/files/${stray.id}`)).status).toBe(404);
  });
});

describe('imports', () => {
  it('saves positions only when you click Import', async () => {
    const up = (await upload('carteira.csv', POSITIONS)).body;
    const r = await api('POST', '/api/chats', { message: 'import these positions', files: [up.id] });
    await answered(r.body.chatId, r.body.seq);
    const chat = (await api('GET', `/api/chats/${r.body.chatId}`)).body;
    expect(chat.messages.at(-1).text).toContain('Nothing is saved until they click Import');
    const [action] = chat.actions;
    expect(action).toMatchObject({ kind: 'import', status: 'pending', seq: 2, data: { source: 'fakebank', kind: 'positions', totals: { BRL: 8355.5 }, replaces: null } });
    expect((await api('GET', '/api/positions?source=fakebank')).body).toEqual([]);

    const done = await api('POST', `/api/actions/${action.id}/apply`);
    expect(done.body).toMatchObject({ status: 'done', result: { saved: 2 } });
    const positions = (await api('GET', '/api/positions?source=fakebank')).body;
    expect(positions.map((p: any) => [p.rawSymbol, p.quantity, p.value, p.method, p.confidence])).toEqual([
      ['PETR4', 100, 5255, 'manual', 'manual'],
      ['VALE3', 50, 3100.5, 'manual', 'manual'],
    ]);
    expect((await api('GET', '/api/accounts')).body).toContainEqual(expect.objectContaining({ source: 'fakebank', externalId: 'fake-1', name: 'Fake brokerage' }));
    expect((await api('POST', `/api/actions/${action.id}/apply`)).status).toBe(409);
    expect(events.some((e) => e.type === 'chat_action' && e.action.id === action.id && e.action.status === 'done')).toBe(true);
  });

  it('refuses rows that break the schema, and account numbers', () => {
    const chat = daemon.store.chats.create({ title: 't', agent: 'claude' });
    const row = { accountExternalId: 'xp', rawSymbol: 'PETR4', quantity: 1, value: 1, currency: 'BRL' };
    const propose = (body: Record<string, unknown>) => () => daemon.actions.propose(chat.id, 2, { kind: 'positions', source: 'xp', title: 't', rows: [row], ...body });
    expect(propose({ rows: [{ ...row, value: 'lots' }] })).toThrow(/positions schema/);
    expect(propose({ rows: [{ ...row, accountExternalId: '0123-4567890' }] })).toThrow(/account numbers/);
    expect(propose({ source: 'Not An Id' })).toThrow(/lowercase id/);
    expect(propose({})().action.data.replaces).toBeNull();
  });
});

describe('connecting an account', () => {
  it("opens the bank's sign-in on your click, then EVOLVE maps it, for you to approve", async () => {
    const r = await api('POST', '/api/chats', { message: 'connect my bank account' });
    await answered(r.body.chatId, r.body.seq);
    const chat = (await api('GET', `/api/chats/${r.body.chatId}`)).body;
    expect(chat.messages.at(-1).text).toContain('sign in there themselves');
    const [action] = chat.actions;
    expect(action).toMatchObject({ kind: 'connect', status: 'pending', data: { mode: 'new', integration: 'banco-exemplo', host: 'banco.example.com', profile: 'finance' } });
    expect(opened).toEqual([]);

    expect((await api('POST', `/api/actions/${action.id}/open`)).body.result.openedAt).toBeTruthy();
    expect(opened).toEqual([{ name: 'finance', url: 'https://banco.example.com/login' }]);

    const evolved = (await api('POST', `/api/actions/${action.id}/evolve`)).body;
    expect(evolved).toMatchObject({ status: 'done', result: { evolve: { chatId: expect.any(String) } } });
    const run = evolved.result.evolve.chatId;
    await expect.poll(() => events.some((e) => e.type === 'chat_done' && e.chatId === run), { timeout: 20_000 }).toBe(true);
    const evolve = (await api('GET', `/api/chats/${run}`)).body;
    expect(evolve.title).toContain('Build the Banco Exemplo integration');
    expect(evolve.meta).toMatchObject({ integration: 'banco-exemplo', from: 'new' });
    expect(existsSync(join(evolve.meta.dir, 'banco-exemplo/index.ts'))).toBe(true);
    // Approving stays yours.
    expect((await api('GET', '/api/integrations/local')).body).toEqual([]);
  });

  it('finds integrations bloomterm has: sign in and fetch, or an API key in Settings', async () => {
    const store = openStore(':memory:');
    const calls: string[] = [];
    const deps: ActionDeps = {
      store,
      log: consoleLogger('silent'),
      emit: () => {},
      integrations: () => [{ id: 'coinbase', name: 'Coinbase', access: 'api', secrets: ['coinbase-key'], provides: ['market'] }],
      browser: () => [{ id: 'itau', name: 'Itaú', profile: 'finance', loginUrl: 'https://www.itau.com.br', datasets: [{ name: 'balances', persist: 'balances' }, { name: 'raw', persist: null }] }],
      session: () => 'needs_login',
      openProfile: async () => calls.push('open'),
      enqueue: (i) => (calls.push(`${i.kind}:${i.source}${i.dataset ? `.${i.dataset}` : ''}`), { id: `j${calls.length}` }),
      evolve: async () => ({ chat: { id: 'c' }, branch: 'b' }),
    };
    const svc = new ActionService(deps);
    const chat = store.chats.create({ title: 't', agent: 'claude' });
    const itau = svc.propose(chat.id, 2, { kind: 'connect', institution: 'Itaú Unibanco' }).action;
    expect(itau.data).toMatchObject({ mode: 'existing', integration: 'itau' });
    await svc.step(itau.id, 'open');
    expect((await svc.step(itau.id, 'fetch')).result).toMatchObject({ jobs: ['j2'] });
    expect(calls).toEqual(['login:itau', 'run:itau.balances']);

    const cb = svc.propose(chat.id, 2, { kind: 'connect', institution: 'coinbase' });
    expect(cb.action.data).toMatchObject({ mode: 'api', secrets: ['coinbase-key'] });
    expect(cb.summary).toContain('API key');
    await expect(svc.step(cb.action.id, 'open')).rejects.toThrow(/Settings/);
    expect(() => svc.propose(chat.id, 2, { kind: 'connect', institution: 'Banco Novo' })).toThrow(/sign-in page as `url`/);
    expect(() => svc.propose(chat.id, 2, { kind: 'connect', institution: 'Banco Novo', url: 'http://banco.example.com' })).toThrow(/https/);
    store.close();
  });
});
