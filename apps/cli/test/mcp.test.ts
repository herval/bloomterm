import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@bloomterm/browser';
import { Config, Daemon, memoryStore } from '@bloomterm/daemon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeMarket } from '../../daemon/test/fakes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let home: string;
let daemon: Daemon;

/** Starts `bt mcp` the way an agent does, and talks JSON-RPC to it. */
function mcp(env: Record<string, string> = {}, args: string[] = []) {
  // Node itself, not node_modules/.bin/tsx: that's a .cmd on Windows, and a wrapper around a second process.
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'apps/cli/src/mcp-main.ts'), ...args], { cwd: ROOT, env: { ...process.env, BLOOMTERM_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<any>((res) => {
      const id = ++n;
      waiting.set(id, res);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = async (name: string, args: unknown = {}) => {
    const r = (await call('tools/call', { name, arguments: args })).result;
    return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  return { call, tool, close: () => child.kill() };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bt-mcp-'));
  daemon = new Daemon({ home, port: 0, integrations: [fakeMarket], config: Config.parse({}), host: { profiles: {} }, secrets: memoryStore(), notify: false, log: consoleLogger('silent') });
  await daemon.start();
});

afterAll(async () => {
  await daemon?.stop();
  await rm(home, { recursive: true, force: true });
});

describe('bt mcp', () => {
  it('lists read-only tools and answers from bloomd', async () => {
    const m = mcp();
    try {
      const init = await m.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'bloomterm' }, capabilities: { tools: {} } });
      const names = (await m.call('tools/list')).result.tools.map((t: any) => t.name);
      expect(names).toEqual(['resolve_security', 'get_quotes', 'get_price_history', 'get_watchlist', 'get_portfolio', 'get_sources', 'get_news', 'get_jobs']);

      const quotes = await m.tool('get_quotes', { securities: ['aapl', 'BTC'] });
      expect(quotes.data.map((q: any) => [q.key, q.last, q.source])).toEqual([
        ['AAPL US Equity', 40.5, 'fake'],
        ['BTCUSD Crypto', 60.5, 'fake'],
      ]);
      const hist = await m.tool('get_price_history', { security: 'AAPL', range: '1Y' });
      expect(hist.data).toMatchObject({ key: 'AAPL US Equity', bars: 260, first: { close: 101 }, last: { close: 360 }, sma50: 335.5 });
      expect(hist.data.closes.length).toBeLessThanOrEqual(61);
      expect((await m.tool('get_sources')).data.integrations[0]).toMatchObject({ id: 'fake', access: 'api', provides: ['market'] });
      expect((await m.tool('get_portfolio')).data).toEqual({ positions: [], balances: [], accounts: [] });
      expect((await m.tool('get_news', { mine: true })).data).toEqual([]);
      expect((await m.tool('get_news', { securities: ['petr4'], query: 'petrobras' })).data).toEqual([]);
      expect(await m.tool('get_quotes', { securities: ['not a ticker!!'] })).toMatchObject({ isError: true });
      expect((await m.call('tools/call', { name: 'place_order', arguments: {} })).error.message).toBe('unknown tool place_order');
    } finally {
      m.close();
    }
  });

  it('adds EVOLVE tools with --evolve, scoped to the run', async () => {
    const m = mcp({ BLOOMTERM_EVOLVE_ID: 'newbank', BLOOMTERM_EVOLVE_RUN: 'c_nope' }, ['--evolve']);
    try {
      await m.call('initialize', {});
      const names = (await m.call('tools/list')).result.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(['get_quotes', 'list_recordings', 'har_summary', 'har_entry', 'browser_capture', 'browser_fetch', 'check', 'try_dataset']));
      expect((await m.tool('list_recordings')).data).toEqual([]);
      expect(await m.tool('try_dataset', { dataset: 'positions' })).toEqual({ isError: true, data: 'no EVOLVE run c_nope' });
      expect(await m.tool('check')).toEqual({ isError: true, data: 'no EVOLVE run c_nope' });
      expect((await m.tool('har_summary', { file: 'nope.har' })).data).toBe('no recording nope.har');
    } finally {
      m.close();
    }
    const plain = mcp();
    try {
      await plain.call('initialize', {});
      expect((await plain.call('tools/list')).result.tools.map((t: any) => t.name)).not.toContain('try_dataset');
    } finally {
      plain.close();
    }
  });

  it('keeps the portfolio to itself when sharing is off', async () => {
    const m = mcp({ BLOOMTERM_MCP_PORTFOLIO: 'off' });
    try {
      await m.call('initialize', {});
      expect(await m.tool('get_portfolio')).toEqual({ isError: true, data: 'portfolio sharing is off ([agent] share_portfolio = false in config.toml)' });
    } finally {
      m.close();
    }
  });
});
