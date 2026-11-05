#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, for tests: no network, no model.
// It "calls" get_quotes, then streams an answer that quotes the question back and points at
// a terminal command. A question containing "fail" ends in an error.
// An EVOLVE prompt ("Integration: <id> …") instead writes a small integration into <id>/ in its
// cwd (the run's folder), plus one stray file outside it, and summarizes.
// With attached files ("[files: …") or a question about connecting an account, it starts the
// real `bt mcp` from --mcp-config and calls the chat tools, as an agent would.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const prompt = await new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8').on('data', (d) => (text += d)).on('end', () => resolve(text));
});
const session = arg('--resume') ?? 'fake-session-1';
const question = prompt.split('\n').at(-1);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', tools: [], mcp_servers: [] });
const finish = (result) => {
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id: session, total_cost_usd: 0.001 });
  process.exit(0);
};
// bloomd's one-shot writing jobs (news, the brief, why something moved): canned answers.
if (prompt.startsWith('NEWS BATCH')) {
  const items = JSON.parse(prompt.slice(prompt.indexOf('Items:\n') + 7));
  const about = (i) => /petrobras/i.test(i.headline);
  const petro = items.filter(about).map((i) => i.ref);
  const stories = [
    ...(petro.length ? [{ title: 'Petrobras output (fake agent)', summary: 'Grouped by the fake agent.', items: petro }] : []),
    ...items.filter((i) => !about(i)).map((i) => ({ title: `${i.headline} (fake agent)`, items: [i.ref] })),
  ];
  finish(JSON.stringify({ stories, tags: Object.fromEntries(items.map((i) => [i.ref, about(i) ? ['PETR4 BZ Equity', 'PETR3 BZ Equity', 'nonsense'] : []])) }));
}
if (prompt.startsWith('BRIEF for')) {
  if (process.env.FAKE_AGENT_FAIL_BRIEF) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'the model is unavailable', session_id: session });
    process.exit(1);
  }
  finish('Here is your brief:\n- Markets mixed (fake brief).\n- PETR4 led your movers (fake brief).');
}
if (prompt.startsWith('WHY did')) finish('{"why":"It moved with its market (fake agent).","news":["n1","n99"]}');
const evolve = /^Integration: ([a-z0-9-]+)/.exec(prompt);
if (evolve) {
  const id = evolve[1];
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Write', input: { file_path: `${id}/index.ts` } }] } });
  mkdirSync(id, { recursive: true });
  writeFileSync(
    `${id}/index.ts`,
    `import { defineIntegration, type NewsData } from '@bloomterm/sdk';\n\n` +
      `export default defineIntegration({\n  id: '${id}',\n  name: '${id} (fake agent)',\n  covers: 'nothing yet',\n  access: 'api',\n  status: 'draft',\n` +
      `  news: () => ({ everyMs: 3_600_000, latest: async (): Promise<NewsData[]> => [] }),\n});\n`,
  );
  writeFileSync(`${id}/README.md`, `# ${id}\n\nMapped by the fake agent.\n\n## Access\n\nNone.\n\n## Provides\n\nNothing.\n\n## Limits\n\nAll of them.\n\n## Verified\n\nNever.\n`);
  writeFileSync('stray.txt', 'outside the integration folder\n');
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } });
  const answer = `Mapped ${id}: wrote index.ts and README.md. try_dataset not run (fake).`;
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }, parent_tool_use_id: null });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, total_cost_usd: 0.002 });
  process.exit(0);
}
/** bloomterm's MCP server, as the agent CLI would start it; each call shows as a tool call. */
let stopMcp = () => {};
async function mcp() {
  const cfg = JSON.parse(readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.bloomterm;
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = ++n;
      waiting.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  stopMcp = () => child.kill();
  await rpc('initialize', {});
  return {
    async call(name, args) {
      const id = `m${n}`;
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__bloomterm__${name}`, input: args }] } });
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r.result?.content?.[0]?.text ?? r.error?.message ?? '';
      const failed = !!(r.result?.isError || r.error);
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: failed }] } });
      if (failed) throw new Error(`${name}: ${text}`);
      return JSON.parse(text);
    },
    close: () => child.kill(),
  };
}
const say = (answer) => {
  stopMcp();
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }, parent_tool_use_id: null });
  finish(answer);
};
if (prompt.includes('[files:') || /\bconnect\b/i.test(question)) {
  const tools = await mcp();
  try {
    if (/\bconnect\b/i.test(question)) {
      const r = await tools.call('connect_account', { institution: 'Banco Exemplo', url: 'https://banco.example.com/login' });
      say(`Here's a card to connect Banco Exemplo. ${r.summary}`);
    }
    const files = await tools.call('list_files', {});
    const file = files.find((f) => f.from === 'the owner');
    if (/import/i.test(question)) {
      const q = { file: file.id, columns: [{ from: 'Ticker', as: 'rawSymbol' }, { from: 'Qtd', as: 'quantity', type: 'number' }, { from: 'Valor', as: 'value', type: 'number' }], decimal: ',' };
      const t = await tools.call('query_sheet', q);
      const r = await tools.call('propose_import', {
        kind: 'positions',
        source: 'fakebank',
        title: `Positions from ${file.name}`,
        file: file.id,
        accounts: [{ externalId: 'fake-1', institution: 'Fake Bank', name: 'Fake brokerage', type: 'brokerage', currency: 'BRL' }],
        rows: t.rows.map(([rawSymbol, quantity, value]) => ({ accountExternalId: 'fake-1', rawSymbol, quantity, value, currency: 'BRL' })),
      });
      say(`Found ${t.total} positions in ${file.name}. ${r.summary}`);
    }
    const q = { file: file.id, columns: [{ from: 'Descrição', as: 'what' }, { from: 'Valor', as: 'amount', type: 'number' }], groupBy: ['what'], sum: ['amount'], sort: { column: 'what' }, decimal: ',' };
    const t = await tools.call('query_sheet', q);
    const w = await tools.call('write_file', { name: 'totals.xlsx', sheets: [{ name: 'By type', query: q }] });
    say(`Totals by type (fake agent):\n\n| What | Total | Count |\n|---|---|---|\n${t.rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n\nWrote ${w.name}.`);
  } catch (err) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err.message), session_id: session });
    process.exit(1);
  } finally {
    tools.close();
  }
}

out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__bloomterm__get_quotes', input: { securities: ['PETR4'] } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[{"key":"PETR4 BZ Equity","last":52.55}]' }] }] } });
if (question.includes('fail')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'the model is unavailable', session_id: session });
  process.exit(1);
}
const answer = `${arg('--resume') ? '(continuing) ' : ''}You asked: ${question}\n\nPETR4 last **52.55** (fake data). See \`PETR4 GP 1Y\`.\n\n| Ticker | Last | Note |\n|---|---|---|\n| PETR4 | 52.55 | A long note that has to wrap inside the chat drawer instead of pushing it sideways, the way real answers do when they explain a gap and how to fill it. |`;
for (const chunk of answer.match(/.{1,12}/gs)) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, parent_tool_use_id: null });
  await sleep(15);
}
out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, total_cost_usd: 0.001 });
