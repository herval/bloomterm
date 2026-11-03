export type OperationType = 'query' | 'mutation' | 'subscription';

/**
 * Lists the operation types defined in a GraphQL document, without a full parser.
 * Strings and comments are stripped first so `"mutation"` inside a literal
 * doesn't count. The `{ ... }` shorthand counts as a query; fragments count as nothing.
 */
export function operationTypes(document: string): OperationType[] {
  const src = stripStringsAndComments(document);
  const ops: OperationType[] = [];
  let braces = 0;
  let parens = 0;
  let expectingDefinition = true;
  const token = /\$?[_A-Za-z][_0-9A-Za-z]*|[{}()]/g;
  for (const [t] of src.matchAll(token)) {
    if (t === '{') {
      if (braces === 0 && parens === 0 && expectingDefinition) {
        ops.push('query');
        expectingDefinition = false;
      }
      braces++;
    } else if (t === '}') {
      braces = Math.max(0, braces - 1);
      // A `}` that closes an object default inside `( ... )` doesn't end the definition.
      if (braces === 0 && parens === 0) expectingDefinition = true;
    } else if (t === '(') {
      parens++;
    } else if (t === ')') {
      parens = Math.max(0, parens - 1);
    } else if (braces === 0 && parens === 0 && expectingDefinition) {
      if (t === 'query' || t === 'mutation' || t === 'subscription') ops.push(t);
      expectingDefinition = false;
    }
  }
  return ops;
}

function stripStringsAndComments(doc: string): string {
  let out = '';
  let i = 0;
  while (i < doc.length) {
    if (doc.startsWith('"""', i)) {
      const end = doc.indexOf('"""', i + 3);
      i = end === -1 ? doc.length : end + 3;
      out += ' ';
    } else if (doc[i] === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
    } else if (doc[i] === '#') {
      while (i < doc.length && doc[i] !== '\n') i++;
    } else {
      out += doc[i];
      i++;
    }
  }
  return out;
}

export interface GraphQLPayload {
  query?: string;
  operationName?: string;
  persisted: boolean;
}

/** Pulls GraphQL operations out of a request body (JSON object, JSON batch, or application/graphql). */
export function parseGraphQLBody(contentType: string | undefined, body: string | null | undefined): GraphQLPayload[] | null {
  if (!body) return null;
  if (contentType?.includes('application/graphql')) return [{ query: body, persisted: false }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const payloads: GraphQLPayload[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const { query, operationName, extensions } = item as Record<string, unknown>;
    payloads.push({
      query: typeof query === 'string' ? query : undefined,
      operationName: typeof operationName === 'string' ? operationName : undefined,
      persisted: !!(extensions && typeof extensions === 'object' && 'persistedQuery' in extensions),
    });
  }
  return payloads;
}
