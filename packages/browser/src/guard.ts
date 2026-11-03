import type { APIRequestContext, APIResponse, Page } from 'playwright-core';
import { MutationBlockedError } from './errors.ts';
import { operationTypes, parseGraphQLBody } from './graphql.ts';
import { matchesAnyOrigin } from './match.ts';
import type { AllowWrite, WriteRule } from './types.ts';

// Mutation guard (SPEC §6.8): a job may read anything, but a non-GET request to the
// institution's own origins must match `allowWrites`. Third-party origins pass.

export interface GuardPolicy {
  origins: readonly string[];
  allowWrites?: readonly AllowWrite[];
  allowWebSockets?: readonly RegExp[];
}

export interface GuardRequest {
  method: string;
  url: string;
  contentType?: string;
  body?: string | null;
}

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function decide(policy: GuardPolicy, req: GuardRequest): GuardDecision {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allow: true, reason: 'safe method' };
  if (!matchesAnyOrigin(policy.origins, req.url)) return { allow: true, reason: 'third-party origin' };

  for (const entry of policy.allowWrites ?? []) {
    const rule: WriteRule = entry instanceof RegExp ? { url: entry } : entry;
    if (!rule.url.test(req.url)) continue;
    if (rule.graphql !== 'queries-only') return { allow: true, reason: `allowWrites ${rule.url}` };
    return decideGraphQL(rule, req);
  }
  return { allow: false, reason: 'not in allowWrites' };
}

function decideGraphQL(rule: WriteRule, req: GuardRequest): GuardDecision {
  const payloads = parseGraphQLBody(req.contentType, req.body);
  if (!payloads || payloads.length === 0) return { allow: false, reason: 'GraphQL endpoint, but the body is not a GraphQL request' };
  for (const p of payloads) {
    if (p.query) {
      const ops = operationTypes(p.query);
      if (ops.length === 0) return { allow: false, reason: 'GraphQL document with no operation' };
      const bad = ops.find((o) => o !== 'query');
      if (bad) return { allow: false, reason: `GraphQL ${bad}${p.operationName ? ` ${p.operationName}` : ''}` };
    } else if (p.persisted && p.operationName && rule.persistedOperations?.includes(p.operationName)) {
      continue;
    } else {
      return { allow: false, reason: `persisted GraphQL operation ${p.operationName ?? '(unnamed)'} is not a known read` };
    }
  }
  return { allow: true, reason: 'GraphQL queries only' };
}

export interface Violation {
  method: string;
  url: string;
  reason: string;
}

/**
 * Routes every request of a job page through `decide`. Blocked requests are aborted
 * and reported through `onViolation`; the job then fails even if the adapter carried on.
 * `enabled()` lets the host switch the guard off while you have the window.
 */
export async function installGuard(
  page: Page,
  policy: GuardPolicy,
  onViolation: (v: Violation) => void,
  enabled: () => boolean = () => true,
): Promise<void> {
  await page.route('**/*', async (route, request) => {
    if (!enabled()) return route.fallback();
    const d = decide(policy, {
      method: request.method(),
      url: request.url(),
      contentType: request.headers()['content-type'],
      body: request.postData(),
    });
    if (d.allow) return route.fallback();
    onViolation({ method: request.method(), url: request.url(), reason: d.reason });
    return route.abort('blockedbyclient');
  });
  await page.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    const sameSite = matchesAnyOrigin(
      policy.origins.map((o) => o.replace(/^http/, 'ws')),
      url,
    );
    if (!enabled() || !sameSite || policy.allowWebSockets?.some((r) => r.test(url))) {
      ws.connectToServer();
      return;
    }
    onViolation({ method: 'WEBSOCKET', url, reason: 'WebSocket to the institution not in allowWebSockets' });
    ws.close({ code: 1008, reason: 'blocked by bloomterm' });
  });
}

/** The parts of APIRequestContext adapters may use. Writes go through `decide`. */
export interface GuardedRequest {
  get: APIRequestContext['get'];
  head: APIRequestContext['head'];
  fetch: APIRequestContext['fetch'];
  post: APIRequestContext['post'];
  put: APIRequestContext['put'];
  patch: APIRequestContext['patch'];
  delete: APIRequestContext['delete'];
}

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

export function guardRequest(
  request: APIRequestContext,
  policy: GuardPolicy,
  onViolation: (v: Violation) => void,
): GuardedRequest {
  const check = (method: string, url: string, options?: FetchOptions) => {
    const data = options?.data;
    const body = data === undefined ? null : typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString() : JSON.stringify(data);
    const contentType =
      options?.headers?.['content-type'] ?? options?.headers?.['Content-Type'] ?? (data !== undefined && typeof data === 'object' ? 'application/json' : undefined);
    const d = decide(policy, { method, url, contentType, body });
    if (!d.allow) {
      const v = { method, url, reason: d.reason };
      onViolation(v);
      throw new MutationBlockedError(method, url, d.reason);
    }
  };
  const write =
    (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', fn: (url: string, o?: FetchOptions) => Promise<APIResponse>) =>
    (url: string, options?: FetchOptions) => {
      check(method, url, options);
      return fn(url, options);
    };
  return {
    get: (url, options) => request.get(url, options),
    head: (url, options) => request.head(url, options),
    fetch: (urlOrRequest, options) => {
      const url = typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url();
      const method = options?.method ?? (typeof urlOrRequest === 'string' ? 'GET' : urlOrRequest.method());
      check(method.toUpperCase(), url, options);
      return request.fetch(urlOrRequest, options);
    },
    post: write('POST', (u, o) => request.post(u, o)),
    put: write('PUT', (u, o) => request.put(u, o)),
    patch: write('PATCH', (u, o) => request.patch(u, o)),
    delete: write('DELETE', (u, o) => request.delete(u, o)),
  };
}
