#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findAgents } from '@bloomterm/agent';
import { bloomtermHome } from '@bloomterm/core';
import { checkIntegration, checksLine, runDaemon, testIntegration } from '@bloomterm/daemon';
import { Client } from './client.ts';
import { buildPlist, install, plistPath, uninstall } from './launchd.ts';
import { serveMcp } from './mcp.ts';

// `bt`: a thin client of bloomd (SPEC §8.1). Only bloomd opens the browser profiles.

const HELP = `bt — bloomterm

  bt daemon                       run bloomd in the foreground
  bt daemon install [--print]     run bloomd at login (launchd); --print shows the plist only
  bt daemon uninstall

  bt ui [--print]                 open the terminal in your browser (--print shows the link instead)
  bt ask "<question>" [--chat id] ask about your markets and accounts; your Claude Code or Codex answers
  bt evolve <integration> [goal]  your agent builds or fixes a copy of an integration, for you to review and approve
  bt evolve                       recent EVOLVE runs and where each one stands
  bt integrations                 yours, in $BLOOMTERM_HOME/integrations, and whether each runs
  bt integrations diff <id> [--run <chat>]     what approving a run's copy (or your folder as it is) would change
  bt integrations approve <id> [--run <chat>]  approve it, after bloomd's checks; it runs after a restart
  bt integrations remove <id>     take yours out (the built-in, if any, comes back)
  bt check-integration <folder>   bloomd's checks of an integration folder: loads, typechecks, tests, README
  bt restart                      restart bloomd (when launchd or the desktop app runs it)
  bt agent                        which agent CLI bloomterm uses (it needs Claude Code or Codex)
  bt mcp                          bloomterm's read-only tools as an MCP server (stdio), for any agent
  bt status                       is bloomd up, what's running, session states
  bt sources                      sources, sessions, datasets, next scheduled run
  bt login <source>               open the sign-in window and wait for you
  bt probe <source>               check whether the source is still signed in
  bt run <source> <dataset>       fetch now (--json prints the data, --force ignores session state, --no-wait)
  bt jobs [--source s] [--status st] [--limit n]
  bt job <id>                     one job, with its result
  bt positions [--source s] [--json]
  bt balances [--source s] [--json]

  bt profile open <name> [url]    open a profile in plain Chrome to browse or sign in by hand; quit it (⌘Q) when done
  bt profile wipe <name> --yes    delete a profile (signs you out of everything in it)
  bt record <profile> [url]       like "profile open", but records a HAR for writing an adapter
  bt doctor                       launch each profile, park its window, report

Data lives in $BLOOMTERM_HOME (default ~/.bloomterm).`;


async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      yes: { type: 'boolean' },
      print: { type: 'boolean' },
      'no-wait': { type: 'boolean' },
      source: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'string' },
      port: { type: 'string' },
      chat: { type: 'string' },
      run: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || v.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const home = bloomtermHome();

  if (cmd === 'daemon') {
    const sub = args[0];
    if (!sub) {
      await runDaemon({ port: v.port ? Number(v.port) : undefined });
      return -1; // keep running
    }
    if (sub === 'install') {
      if (v.print) {
        console.log(buildPlist(home));
        return 0;
      }
      console.log(`installed ${await install(home)}; bloomd starts now and at every login. Logs: ${home}/logs/bloomd.log`);
      return 0;
    }
    if (sub === 'uninstall') {
      console.log(`removed ${await uninstall()}`);
      return 0;
    }
    throw new Error('bt daemon [install|uninstall]');
  }

  if (cmd === 'mcp') {
    serveMcp();
    return -1;
  }
  if (cmd === 'agent') {
    const found = await findAgents();
    for (const a of found) console.log(`${a.kind.padEnd(7)} ${a.version}  ${a.path}`);
    if (!found.length) console.log('none found: install Claude Code (npm i -g @anthropic-ai/claude-code) or Codex (npm i -g @openai/codex)');
    const using = await Client.connect(home)
      .then((c) => c.call('GET', '/api/agent'))
      .catch(() => null);
    if (using) console.log(`bloomd uses: ${using.cli ? `${using.cli.kind} (${using.cli.path})` : 'none'}`);
    return found.length ? 0 : 1;
  }

  // EVOLVE's `./check` runs this, and so does bloomd, in a process of its own.
  if (cmd === 'check-integration') {
    const folder = resolve(need(args[0], 'bt check-integration <folder> [--json]'));
    const checks = await checkIntegration(folder, basename(folder));
    if (v.json) {
      console.log(JSON.stringify(checks));
      return 0;
    }
    console.log(`${basename(folder)}: ${checksLine(checks)}${checks.ok ? '' : `\n\n${checks.output}`}`);
    return checks.ok ? 0 : 1;
  }
  if (cmd === 'test-integration') {
    await testIntegration(resolve(need(args[0], 'bt test-integration <folder>')));
    return -1; // node:test runs the tests as the process ends, and sets its exit code
  }

  const c = await Client.connect(home);
  const q = (o: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries(o).filter(([, x]) => x !== undefined) as [string, string][]).toString();
    return s ? `?${s}` : '';
  };

  switch (cmd) {
    case 'ui': {
      // The link holds a one-time code that expires in a minute; the page trades it for the token.
      const { code } = await c.call('POST', '/api/ui/code');
      const url = `${c.base}/#code=${code}`;
      if (v.print) console.log(url);
      else {
        execFile('open', [url]);
        console.log(`opened ${c.base}`);
      }
      return 0;
    }
    case 'ask': {
      const message = need(args.join(' ').trim() || undefined, 'bt ask "<question>" [--chat <id>]');
      const r = await stream(c, () => c.call('POST', '/api/chats', { message, chatId: v.chat }));
      dimErr(`(chat ${r.chatId}; follow up with: bt ask --chat ${r.chatId} "…")`);
      return r.ok ? 0 : 1;
    }
    case 'evolve': {
      if (!args[0]) {
        const runs = await c.call<any[]>('GET', '/api/chats?kind=evolve');
        if (!runs.length) console.log('No EVOLVE runs yet. Start one: bt evolve <integration> [goal]');
        for (const r of runs) console.log(`${r.updatedAt.slice(0, 16)}  ${r.id}  ${runState(r.meta).padEnd(12)}  ${r.title}`);
        return 0;
      }
      const r = await stream(c, () => c.call('POST', '/api/evolve', { integration: args[0], goal: args.slice(1).join(' ') || undefined }));
      const m = (await c.call<any>('GET', `/api/chats/${r.chatId}`)).meta;
      console.log('');
      if (m.checks) console.log(`bloomd's checks: ${checksLine(m.checks)}${m.checks.ok ? '' : `\n${m.checks.output}`}`);
      console.log(`Review:  bt integrations diff ${m.integration} --run ${r.chatId}`);
      if (m.checks?.ok) console.log(`Approve: bt integrations approve ${m.integration} --run ${r.chatId}   (it runs after a restart)`);
      dimErr(`(the copy is in ${m.dir}/${m.integration}; follow up with: bt ask --chat ${r.chatId} "…")`);
      return r.ok ? 0 : 1;
    }
    case 'integrations': {
      const [sub, id] = args;
      if (!sub) {
        const mine = await c.call<any[]>('GET', '/api/integrations/local');
        if (!mine.length) console.log(`None yet. EVOLVE makes them (bt evolve <id>), in ${home}/integrations.`);
        for (const l of mine) console.log(`${l.id.padEnd(16)} ${localState(l)}`);
        return 0;
      }
      const target = need(id, `bt integrations ${sub} <id>`);
      const run = v.run ? `?run=${encodeURIComponent(v.run)}` : '';
      if (sub === 'diff') {
        const d = await c.call<any>('GET', `/api/integrations/${target}/diff${run}`);
        console.log(d.diff || `(no changes against ${d.base === 'none' ? 'nothing' : d.base === 'yours' ? 'your approved version' : 'the built-in'})`);
        return 0;
      }
      if (sub === 'approve') {
        const d = await c.call<any>('GET', `/api/integrations/${target}/diff${run}`);
        const files = d.diff.split('\n').filter((l: string) => l.startsWith('diff ')).map((l: string) => l.split(' b/').at(-1));
        dimErr(`approving ${target} (${d.hash.slice(0, 12)}): ${files.length ? files.join(', ') : 'no changes'}`);
        const r = v.run
          ? await c.call<any>('POST', `/api/evolve/${encodeURIComponent(v.run)}/approve`, { hash: d.hash })
          : await c.call<any>('POST', `/api/integrations/${target}/approve`, { hash: d.hash });
        console.log(`Approved ${target}. ${r.supervised ? 'Restart bloomd to run it: bt restart' : 'It runs after you restart bloomd.'}`);
        return 0;
      }
      if (sub === 'remove') {
        const r = await c.call<any>('DELETE', `/api/integrations/${target}`);
        console.log(`Removed your ${target} (its versions stay in ${home}/integrations/.history). ${r.supervised ? 'bt restart' : 'Restart bloomd'} to finish.`);
        return 0;
      }
      throw new Error('bt integrations [diff|approve|remove] <id>');
    }
    case 'restart': {
      await c.call('POST', '/api/restart');
      console.log('bloomd is restarting.');
      return 0;
    }
    case 'status': {
      const s = await c.call('GET', '/api/status');
      console.log(`bloomd pid ${s.pid} on ${c.base}, up ${Math.round(s.uptimeS / 60)} min, ${s.queued} queued`);
      for (const j of s.running) console.log(`  running: ${j.kind} ${j.source}${j.dataset ? `.${j.dataset}` : ''} (${j.id})`);
      for (const x of s.sessions) console.log(`  ${x.source}: ${x.state}`);
      for (const p of s.profiles) console.log(`  profile ${p.name}: ${p.running ? 'chrome running' : 'idle'}`);
      return 0;
    }
    case 'sources': {
      const sources = await c.call<any[]>('GET', '/api/sources');
      console.table(
        sources.flatMap((s) =>
          s.datasets.map((d: any) => ({
            source: s.id,
            status: s.status,
            session: s.session.state,
            dataset: d.name,
            lastOk: d.lastOk ?? '',
            next: d.next ?? (s.status === 'draft' ? '(draft: not scheduled)' : ''),
          })),
        ),
      );
      return 0;
    }
    case 'login': {
      const id = need(args[0], 'bt login <source>');
      const job = await c.call('POST', `/api/sources/${id}/login`);
      console.error(`Sign in to ${id} in the Chrome window bloomd just opened. Waiting (up to 10 min)…`);
      const done = await c.wait(job.id, 11 * 60_000);
      console.log(`${id}: ${done.result?.state ?? done.status}${done.error ? ` (${done.error})` : ''}`);
      return done.status === 'ok' ? 0 : 1;
    }
    case 'probe': {
      const id = need(args[0], 'bt probe <source>');
      const done = await c.wait((await c.call('POST', `/api/sources/${id}/probe`)).id, 2 * 60_000);
      console.log(`${id}: ${done.result?.state ?? done.error}`);
      return done.result?.state === 'ok' ? 0 : 1;
    }
    case 'run': {
      const id = need(args[0], 'bt run <source> <dataset>');
      const dataset = need(args[1], 'bt run <source> <dataset>');
      const job = await c.call('POST', `/api/sources/${id}/datasets/${dataset}/run`, { force: !!v.force });
      if (v['no-wait']) {
        console.log(job.id);
        return 0;
      }
      let announced = false;
      const done = await c.wait(job.id, 15 * 60_000, (j) => {
        if (!announced && j.status === 'queued' && Date.now() - Date.parse(j.createdAt) > 3_000) {
          console.error('queued behind other jobs…');
          announced = true;
        }
      });
      if (done.status !== 'ok') {
        console.error(`${id}.${dataset}: ${done.status}: ${done.error}`);
        if (done.rawDir) console.error(`raw: ${done.rawDir}`);
        return 1;
      }
      if (v.json) {
        const persisted = done.result?.persisted;
        const data = persisted && persisted !== 'accounts' ? await c.call('GET', `/api/${persisted}${q({ source: id })}`) : done.result;
        console.log(JSON.stringify(data, null, 2));
      } else {
        const what = done.result?.persisted ? `${done.result.rows} ${done.result.persisted} stored` : Array.isArray(done.result) ? `${done.result.length} rows` : 'ok';
        console.log(`${id}.${dataset}: ${what} via ${done.method} in ${done.durationMs}ms`);
        console.log(`raw: ${done.rawDir}`);
      }
      return 0;
    }
    case 'jobs': {
      const jobs = await c.call<any[]>('GET', `/api/jobs${q({ source: v.source, status: v.status, limit: v.limit })}`);
      if (!jobs.length) {
        console.log('no jobs yet');
        return 0;
      }
      console.table(
        jobs.map((j) => ({
          id: j.id,
          created: j.createdAt.slice(0, 19),
          kind: j.kind,
          what: `${j.source}${j.dataset ? `.${j.dataset}` : ''}`,
          trigger: j.trigger,
          status: j.status,
          ms: j.durationMs ?? '',
          note: (j.error ?? j.method ?? '').slice(0, 60),
        })),
      );
      return 0;
    }
    case 'job': {
      console.log(JSON.stringify(await c.call('GET', `/api/jobs/${need(args[0], 'bt job <id>')}`), null, 2));
      return 0;
    }
    case 'positions':
    case 'balances': {
      const rows = await c.call<any[]>('GET', `/api/${cmd}${q({ source: v.source })}`);
      if (v.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) console.log(`no ${cmd} yet`);
      else
        console.table(
          rows.map((r) =>
            cmd === 'positions'
              ? { source: r.source, account: r.accountExternalId, symbol: r.rawSymbol, qty: r.quantity, value: r.value, ccy: r.currency, via: r.method, fetched: r.fetchedAt.slice(0, 16) }
              : { source: r.source, account: r.accountExternalId, total: r.total, cash: r.cash ?? '', ccy: r.currency, due: r.dueDate ?? '', via: r.method, fetched: r.fetchedAt.slice(0, 16) },
          ),
        );
      return 0;
    }
    case 'profile': {
      const [sub, name, url] = args;
      if (sub === 'open') {
        await c.call('POST', `/api/profiles/${need(name, 'bt profile open <name> [url]')}/open`, { url });
        console.log(`Opened profile "${name}" in Chrome. Quit it (⌘Q) when you're done; jobs on it wait until then.`);
        return 0;
      }
      if (sub === 'wipe') {
        need(name, 'bt profile wipe <name> --yes');
        if (!v.yes) {
          console.error(`This deletes the "${name}" profile and signs you out of every site in it. Re-run with --yes.`);
          return 1;
        }
        console.log(`deleted ${(await c.call('POST', `/api/profiles/${name}/wipe`, { confirm: true })).deleted}`);
        return 0;
      }
      throw new Error('bt profile open|wipe <name>');
    }
    case 'record': {
      const res = await c.call('POST', `/api/profiles/${need(args[0], 'bt record <profile> [url]')}/open`, { url: args[1], record: true });
      console.log(`Recording profile "${args[0]}". Sign in, click through to the data, then close the tab.`);
      console.log(`The HAR (cookies and account data; stays on this machine) will be at:\n${res.har}`);
      return 0;
    }
    case 'doctor': {
      for (const p of await c.call<any[]>('POST', '/api/doctor')) {
        console.log(
          p.error
            ? `${p.profile}: ERROR ${p.error}`
            : `${p.profile}: chrome ${p.chrome}, mode ${p.mode}, parked as ${p.parkedAs ?? 'n/a'}, window ${p.window ? JSON.stringify(p.window) : 'n/a'}`,
        );
      }
      return 0;
    }
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}

const dimErr = (s: string) => process.stderr.write(`${process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s}\n`);

/** Starts an agent run and streams it to the terminal: text on stdout, tool calls dimmed on stderr. */
async function stream(c: Client, start: () => Promise<{ chatId: string; seq: number }>): Promise<{ chatId: string; ok: boolean }> {
  const ws = new WebSocket(`${c.base.replace('http', 'ws')}/api/events?token=${encodeURIComponent(c.token)}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't open bloomd's event stream"));
  });
  // Events can arrive before the POST answers with the chat id; hold them until it does.
  const early: any[] = [];
  let handle: (ev: any) => void = (ev) => void early.push(ev);
  ws.onmessage = (m) => handle(JSON.parse(String(m.data)));
  const started = await start();
  // A tool line after text that didn't end its line goes on the next one.
  let midLine = false;
  const status = await new Promise<string>((resolve) => {
    handle = (ev) => {
      if (ev.chatId !== started.chatId || ev.seq !== started.seq) return;
      if (ev.type === 'chat_done') return resolve(ev.status);
      const e = ev.event;
      if (e.type === 'text') {
        process.stdout.write(e.text);
        midLine = !String(e.text).endsWith('\n');
        return;
      }
      const line =
        e.type === 'tool'
          ? `↳ ${String(e.name).replace(/^mcp__bloomterm__/, '')} ${JSON.stringify(e.input ?? {}).slice(0, 200)}`
          : e.type === 'tool_result' && !e.ok
            ? `  ✗ ${String(e.text ?? '').slice(0, 300)}`
            : e.type === 'error'
              ? `✗ ${e.message}`
              : null;
      if (line === null) return;
      if (midLine) process.stdout.write('\n');
      midLine = false;
      if (e.type === 'error') process.stderr.write(`${line}\n`);
      else dimErr(line);
    };
    for (const ev of early.splice(0)) handle(ev);
  });
  ws.close();
  process.stdout.write('\n');
  return { chatId: started.chatId, ok: status === 'done' };
}

/** Where an EVOLVE run stands. Runs from older bloomterms had a git branch instead. */
function runState(m: any): string {
  if (m.approved) return 'approved';
  if (m.checks) return m.checks.ok ? 'checks pass' : 'checks fail';
  return m.branch ? `old: ${m.branch}` : '-';
}

function localState(l: any): string {
  const what = l.replaces ? 'replaces the built-in' : 'new';
  if (l.state === 'on') return `${what}; ${l.running ? 'running' : 'approved, runs after a restart'}`;
  if (l.state === 'changed') return `${what}; OFF: changed since you approved it (bt integrations diff ${l.id})`;
  if (l.state === 'unapproved') return `${what}; OFF: not approved (bt integrations diff ${l.id})`;
  return `${what}; OFF: didn't load: ${l.error}`;
}

function need(x: string | undefined, usage: string): string {
  if (!x) throw new Error(`usage: ${usage}`);
  return x;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

