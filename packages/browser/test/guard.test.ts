import { describe, expect, it } from 'vitest';
import { decide, type GuardPolicy } from '../src/guard.ts';
import { operationTypes } from '../src/graphql.ts';
import { originMatches } from '../src/match.ts';

describe('originMatches', () => {
  it('matches exact hosts, wildcards and ports', () => {
    expect(originMatches('https://www.bank.example', 'https://www.bank.example/a')).toBe(true);
    expect(originMatches('https://www.bank.example', 'https://api.bank.example/a')).toBe(false);
    expect(originMatches('https://*.bank.example', 'https://api.bank.example/a')).toBe(true);
    expect(originMatches('https://*.bank.example', 'https://bank.example/')).toBe(true);
    expect(originMatches('https://*.bank.example', 'https://evilbank.example/')).toBe(false);
    expect(originMatches('https://*.bank.example', 'http://api.bank.example/')).toBe(false);
    expect(originMatches('http://127.0.0.1:4100', 'http://127.0.0.1:4100/x')).toBe(true);
    expect(originMatches('http://127.0.0.1:4100', 'http://127.0.0.1:4101/x')).toBe(false);
    expect(originMatches('https://www.bank.example', 'https://www.bank.example:8443/')).toBe(false);
    expect(originMatches('wss://*.bank.example', 'wss://push.bank.example/s')).toBe(true);
  });

  it('rejects malformed patterns', () => {
    expect(() => originMatches('bank.example', 'https://bank.example')).toThrow(/invalid origin/);
  });
});

describe('operationTypes', () => {
  it('finds named, anonymous and multiple operations', () => {
    expect(operationTypes('query Positions { positions { id } }')).toEqual(['query']);
    expect(operationTypes('{ me { id } }')).toEqual(['query']);
    expect(operationTypes('mutation Pay($a: Int) { pay(a: $a) { ok } }')).toEqual(['mutation']);
    expect(operationTypes('query A { a } mutation B { b }')).toEqual(['query', 'mutation']);
    expect(operationTypes('subscription S { s }')).toEqual(['subscription']);
  });

  it('ignores fragments, strings, comments and object defaults', () => {
    expect(operationTypes('fragment F on T { x } query Q { ...F }')).toEqual(['query']);
    expect(operationTypes('query Q { search(q: "mutation { x }") { id } }')).toEqual(['query']);
    expect(operationTypes('# mutation X { y }\nquery Q { a }')).toEqual(['query']);
    expect(operationTypes('query Q($f: In = { a: 1 }) { a(f: $f) }')).toEqual(['query']);
    expect(operationTypes('query Q { a(s: """ mutation """) }')).toEqual(['query']);
  });
});

describe('decide', () => {
  const policy: GuardPolicy = {
    origins: ['https://*.bank.example'],
    allowWrites: [/\/session\/keepalive$/, { url: /\/graphql$/, graphql: 'queries-only', persistedOperations: ['AccountSummary'] }],
  };
  const post = (url: string, body?: unknown, contentType = 'application/json') => ({
    method: 'POST',
    url,
    contentType,
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
  });

  it('lets reads and third-party writes through', () => {
    expect(decide(policy, { method: 'GET', url: 'https://www.bank.example/transfer' }).allow).toBe(true);
    expect(decide(policy, post('https://analytics.example/collect', {})).allow).toBe(true);
  });

  it('blocks writes to the institution unless allowed', () => {
    expect(decide(policy, post('https://www.bank.example/api/transfer', { to: 'x' }))).toMatchObject({ allow: false, reason: 'not in allowWrites' });
    expect(decide(policy, { method: 'DELETE', url: 'https://api.bank.example/payee/1' }).allow).toBe(false);
    expect(decide(policy, post('https://www.bank.example/session/keepalive')).allow).toBe(true);
  });

  it('allows GraphQL queries and blocks mutations, including inside batches', () => {
    const gql = 'https://api.bank.example/graphql';
    expect(decide(policy, post(gql, { query: 'query Q { accounts { id } }' })).allow).toBe(true);
    expect(decide(policy, post(gql, { query: 'mutation T { transfer(amount: 1) { id } }', operationName: 'T' }))).toMatchObject({
      allow: false,
      reason: 'GraphQL mutation T',
    });
    expect(decide(policy, post(gql, [{ query: '{ a }' }, { query: 'mutation { b }' }])).allow).toBe(false);
    expect(decide(policy, post(gql, 'query Q { a }', 'application/graphql')).allow).toBe(true);
    expect(decide(policy, post(gql, 'not json')).allow).toBe(false);
  });

  it('only allows persisted operations that are listed as reads', () => {
    const gql = 'https://api.bank.example/graphql';
    const persisted = (operationName: string) => ({ operationName, extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } });
    expect(decide(policy, post(gql, persisted('AccountSummary'))).allow).toBe(true);
    expect(decide(policy, post(gql, persisted('SendPix'))).allow).toBe(false);
  });
});
