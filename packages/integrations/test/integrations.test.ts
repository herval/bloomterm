import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSecurity } from '@bloomterm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brapiFeed } from '../src/brapi/index.ts';
import { getJson } from '../src/http.ts';
import { defineIntegration, integrations, marketProviders } from '../src/index.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('the integration contract', () => {
  it('has a README per integration that names what it covers and how it gets in', async () => {
    for (const i of integrations) {
      const readme = await readFile(join(src, i.id, 'README.md'), 'utf8');
      expect(readme, i.id).toMatch(new RegExp(`^# ${i.id}\\b`, 'm'));
      expect(readme, i.id).toMatch(/^## Access/m);
    }
  });

  it('gives each integration only the secrets it declares', async () => {
    const asked: string[] = [];
    const [feed] = marketProviders(
      [defineIntegration({ id: 'nosy', name: 'Nosy', covers: 'x', access: 'api', status: 'ready', secrets: [{ name: 'nosy-key', label: 'k', covers: 'x', signup: 'x' }], market: ({ secret }) => ({ quoteTtlMs: 1, supports: () => true, quote: async () => { await secret('nosy-key'); await secret('brapi'); throw new Error('unreachable'); }, bars: async () => ({ bars: [] }) }) })],
      async (name) => (asked.push(name), 'value'),
    );
    await expect(feed!.quote(parseSecurity('AAPL')!)).rejects.toThrow('nosy asked for the secret "brapi", which it doesn\'t declare');
    expect(asked).toEqual(['nosy-key']);
  });

  it('refuses malformed integrations', () => {
    expect(() => defineIntegration({ id: 'Bad Id', name: 'x', covers: 'x', access: 'api', status: 'ready', market: () => ({}) as any })).toThrow('kebab-case');
    expect(() => defineIntegration({ id: 'empty', name: 'x', covers: 'x', access: 'api', status: 'ready' })).toThrow('provides nothing');
  });
});

describe('providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends brapi one request at a time and retries once after a 429', async () => {
    let inFlight = 0;
    let most = 0;
    let n = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      // The very first call is rate limited, like brapi's free tier under load.
      if (n++ === 0) return new Response('{"error":true,"message":"RATE_LIMITED"}', { status: 429 });
      const ticker = decodeURIComponent(url.split('/quote/')[1]!.split('?')[0]!);
      return Response.json({ results: [{ symbol: ticker, regularMarketPrice: 10, currency: 'BRL', regularMarketTime: 1_761_660_000 }] });
    });
    const b = brapiFeed(async () => null);
    const out = await Promise.all(['PETR4', 'VALE3', 'ITUB4'].map((t) => b.quote(parseSecurity(t)!)));
    expect(out.map((q) => q.symbol)).toEqual(['PETR4', 'VALE3', 'ITUB4']);
    expect(most).toBe(1);
    expect(n).toBe(4);
  });

  it('turns error bodies into short messages', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":true,"message":"Ticker not found"}', { status: 400 }));
    await expect(getJson('brapi', 'https://x')).rejects.toThrow('brapi answered 400: Ticker not found');
    vi.stubGlobal('fetch', async () => new Response('{"error":true,"code":"RATE_LIMITED","concurrencyLimit":1}', { status: 429 }));
    await expect(getJson('brapi', 'https://x')).rejects.toThrow('brapi is rate-limiting us (HTTP 429); retrying shortly');
  });
});
