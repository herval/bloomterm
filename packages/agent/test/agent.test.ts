import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentEnv, claude, codex, runAgent, SIGN_IN_HINT, signedIn, type AgentEvent, type AgentRunOptions } from '../src/index.ts';

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fake-agent.mjs');
const mcp = { bloomterm: { command: '/x/tsx', args: ['/x/mcp.ts'], env: { BLOOMTERM_HOME: '/h' } } };
const chat: AgentRunOptions = { mode: 'chat', prompt: 'how is PETR4?', cwd: '/tmp', system: 'be brief', mcp };

const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe('claude driver', () => {
  it('runs chat on the subscription, isolated from your plugins and MCP servers, with only bloomterm tools', () => {
    const a = claude.args(chat);
    expect(a).toContain('--strict-mcp-config');
    expect(after(a, '--setting-sources')).toBe('project,local');
    expect(after(a, '--permission-mode')).toBe('dontAsk');
    expect(after(a, '--permission-prompts')).toBe('none');
    expect(after(a, '--tools')).toBe('');
    expect(after(a, '--allowedTools')).toBe('mcp__bloomterm');
    expect(JSON.parse(after(a, '--mcp-config')!).mcpServers.bloomterm).toMatchObject({ type: 'stdio', command: '/x/tsx' });
    expect(a).not.toContain('--bare'); // --bare only reads ANTHROPIC_API_KEY
    expect(a).not.toContain('--resume');
    expect(after(claude.args({ ...chat, web: true, resume: 's1' }), '--resume')).toBe('s1');
    expect(after(claude.args({ ...chat, web: true }), '--tools')).toBe('WebSearch');
  });

  it('lets evolve edit only the paths, and run only the commands, it was given', () => {
    const a = claude.args({ ...chat, mode: 'evolve', writable: ['b3/**'], bash: ['./check', 'ls'] });
    expect(a).toContain('Edit(b3/**)');
    expect(a).toContain('Write(b3/**)');
    expect(a.some((x) => x.startsWith('Edit(') && !x.includes('b3'))).toBe(false);
    expect(a.filter((x) => x.startsWith('Bash('))).toEqual(['Bash(./check:*)', 'Bash(ls:*)']);
    expect(claude.args({ ...chat, mode: 'evolve' }).some((x) => x.startsWith('Bash('))).toBe(false);
    expect(a).not.toContain('WebFetch');
    expect(after(claude.args({ ...chat, mode: 'evolve', web: true }), '--tools')).toContain('WebFetch');
  });

  it('turns stream-json into events', () => {
    const p = claude.parser();
    const ev = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }, parent_tool_use_id: null },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't', name: 'mcp__bloomterm__get_quotes', input: { securities: ['X'] } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '[]' }] }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hi', total_cost_usd: 0.01 },
    ].flatMap(p);
    expect(ev).toEqual([
      { type: 'session', id: 's1', model: 'm' },
      { type: 'text', text: 'Hi' },
      { type: 'tool', id: 't', name: 'mcp__bloomterm__get_quotes', input: { securities: ['X'] } },
      { type: 'tool_result', id: 't', ok: true, text: '[]' },
      { type: 'done', text: 'Hi', costUsd: 0.01 },
    ]);
  });
});

describe('codex driver', () => {
  it('runs chat read-only, without your config, with bloomterm tools pre-approved', () => {
    const a = codex.args(chat);
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a).toContain('--ignore-user-config');
    expect(a).toContain('sandbox_mode="read-only"');
    expect(a).toContain('web_search="disabled"');
    expect(a).toContain('mcp_servers.bloomterm.command="/x/tsx"');
    expect(a).toContain('mcp_servers.bloomterm.default_tools_approval_mode="approve"');
    expect(a).toContain('mcp_servers.bloomterm.env={"BLOOMTERM_HOME" = "/h"}');
    expect(a.at(-1)).toBe('be brief\n\n---\n\nhow is PETR4?');
    const resumed = codex.args({ ...chat, resume: 't1' });
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(resumed.at(-1)).toBe('how is PETR4?');
    expect(codex.args({ ...chat, mode: 'evolve' })).toContain('sandbox_mode="workspace-write"');
    expect(codex.args({ ...chat, mode: 'evolve', web: true })).toContain('web_search="live"');
  });

  it('turns exec --json into events', () => {
    const p = codex.parser();
    const ev = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'bloomterm', tool: 'get_quotes', arguments: { securities: ['X'] }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'bloomterm', tool: 'get_quotes', status: 'completed', result: { content: [{ type: 'text', text: '[1]' }] } } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'First.' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Second.' } },
      { type: 'turn.completed', usage: {} },
    ].flatMap(p);
    expect(ev).toEqual([
      { type: 'session', id: 't1' },
      { type: 'tool', id: 'i1', name: 'mcp__bloomterm__get_quotes', input: { securities: ['X'] } },
      { type: 'tool_result', id: 'i1', ok: true, text: '[1]' },
      { type: 'text', text: 'First.' },
      { type: 'text', text: '\n\nSecond.' },
      { type: 'done', text: 'Second.' },
    ]);
  });
});

describe('runAgent', () => {
  const cli = { kind: 'claude' as const, path: FAKE, version: 'fake' };

  it('streams a run and returns its answer and session', async () => {
    const events: AgentEvent[] = [];
    const r = await runAgent(cli, { ...chat, cwd: tmpdir() }, (e) => events.push(e));
    expect(r).toMatchObject({ ok: true, sessionId: 'fake-session-1', costUsd: 0.001 });
    expect(r.text).toContain('You asked: how is PETR4?');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(3);
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'mcp__bloomterm__get_quotes' });
  });

  it('reports failures, stops on abort, and never inherits a parent session', async () => {
    expect(await runAgent(cli, { ...chat, cwd: tmpdir(), prompt: 'please fail' })).toMatchObject({ ok: false, error: 'the model is unavailable' });

    const dir = await mkdtemp(join(tmpdir(), 'bt-agent-'));
    const slow = join(dir, 'claude');
    await writeFile(slow, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'s'}));\nsetTimeout(() => {}, 60000);\n`);
    await chmod(slow, 0o755);
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    const run = runAgent({ ...cli, path: slow }, { ...chat, cwd: dir, signal: ac.signal, env: {} }, (e) => events.push(e));
    await expect.poll(() => events.length, { timeout: 10_000 }).toBe(1); // Node starting, slow under load
    ac.abort();
    expect(await run).toMatchObject({ ok: false, error: 'stopped', sessionId: 's' });

    process.env.CLAUDECODE = '1';
    try {
      const env = agentEnv({ X: '1' });
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.PATH!.split(':')[0]).toBe(dirname(process.execPath));
      expect(env.X).toBe('1');
    } finally {
      delete process.env.CLAUDECODE;
    }
  });
});

describe('signedIn', () => {
  /** A stand-in CLI that answers its sign-in question with `body` (a shell snippet). */
  async function cli(kind: 'claude' | 'codex', body: string) {
    const dir = await mkdtemp(join(tmpdir(), 'bt-auth-'));
    const path = join(dir, kind);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return { kind, path, version: 'fake' };
  }

  it('asks Claude Code, and keeps only whether it is signed in', async () => {
    const yes = await cli('claude', `[ "$1 $2 $3" = "auth status --json" ] && echo '{"loggedIn":true,"email":"me@example.com"}' && exit 0; exit 2`);
    expect(await signedIn(yes)).toBe(true);
    const no = await cli('claude', `echo '{"loggedIn":false}'; exit 1`);
    expect(await signedIn(no)).toBe(false);
    const old = await cli('claude', `echo "error: unknown command 'auth'" >&2; exit 1`);
    expect(await signedIn(old)).toBeNull();
    expect(SIGN_IN_HINT.claude).toBe('claude auth login');
  });

  it('asks Codex', async () => {
    expect(await signedIn(await cli('codex', `[ "$1 $2" = "login status" ] && echo "Logged in using ChatGPT" && exit 0; exit 2`))).toBe(true);
    expect(await signedIn(await cli('codex', `echo "Not logged in"; exit 1`))).toBe(false);
    expect(await signedIn(await cli('codex', `echo "unrecognized subcommand 'status'" >&2; exit 2`))).toBeNull();
  });
});
