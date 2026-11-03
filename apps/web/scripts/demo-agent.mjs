#!/usr/bin/env node
// The agent CLI for the README screenshot (scripts/screenshot.ts): canned answers to bloomd's
// writing jobs (news, the brief, why something moved), for the demo data. No network, no model.
const argv = process.argv.slice(2);
const prompt = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : '';
const session = 'demo-session';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const finish = (result) => {
  out({ type: 'system', subtype: 'init', session_id: session, model: 'demo', tools: [], mcp_servers: [] });
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id: session, total_cost_usd: 0 });
  process.exit(0);
};

if (prompt.startsWith('NEWS BATCH')) {
  const items = JSON.parse(prompt.slice(prompt.indexOf('Items:\n') + 7));
  const tags = { chip: ['NVDA US Equity'], crude: ['PETR4 BZ Equity'], iron: ['VALE3 BZ Equity'], bitcoin: ['BTCUSD Crypto'] };
  const tagsOf = (h) => Object.entries(tags).flatMap(([word, keys]) => (h.toLowerCase().includes(word) ? keys : []));
  finish(JSON.stringify({ stories: items.map((i) => ({ title: i.headline, items: [i.ref] })), tags: Object.fromEntries(items.map((i) => [i.ref, tagsOf(i.headline)])) }));
}
if (prompt.startsWith('BRIEF for')) {
  finish(
    [
      '- Chipmakers led US stocks higher: NVDA rose 3.4% and SPY 0.4%.',
      '- In São Paulo the IBOV slipped 0.2% as PETR4 fell with crude; VALE3 gained on firmer iron ore.',
      '- Your portfolio is up 1.4% today, mostly from NVDA and crypto.',
      '- BTC is up 2.3% over 24 hours, and the real weakened 0.5% against the dollar.',
    ].join('\n'),
  );
}
if (prompt.startsWith('WHY did')) {
  const key = /^WHY did (\S+ \S+ \S+)/.exec(prompt)?.[1] ?? '';
  const why = {
    'NVDA US Equity': 'Chipmakers rallied across the board, and NVDA rose more than SPY.',
    'PETR4 BZ Equity': 'It fell with crude; there was no company news.',
    'VALE3 BZ Equity': 'Iron ore futures firmed in Asia overnight.',
  };
  finish(JSON.stringify({ why: why[key] ?? 'It moved with its market; there was no company news.', news: [] }));
}
finish('This is the demo agent: it only writes the brief, the news and why things moved.');
