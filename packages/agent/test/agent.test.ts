import { chmod, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentEnv, claude, codex, findAgents, installCommands, launch, runAgent, signedIn, signInHint, type AgentEvent, type AgentRunOptions } from '../src/index.ts';

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fake-agent.mjs');
const mcp = { bloomterm: { command: '/x/tsx', args: ['/x/mcp.ts'], env: { BLOOMTERM_HOME: '/h' } } };
const chat: AgentRunOptions = { mode: 'chat', prompt: 'how is PETR4?', cwd: '/tmp', system: 'be brief', mcp };

const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
const RUN = join('/run');
const claudeArgs = (o: AgentRunOptions) => claude.args(o, RUN);
const codexArgs = (o: AgentRunOptions) => codex.args(o, RUN);
const windows = process.platform === 'win32';

describe('claude driver', () => {
  it('runs chat on the subscription, isolated from your plugins and MCP servers, with only bloomterm tools', () => {
    const a = claudeArgs(chat);
    expect(a).toContain('--strict-mcp-config');
    expect(after(a, '--setting-sources')).toBe('project,local');
    expect(after(a, '--permission-mode')).toBe('dontAsk');
    expect(after(a, '--permission-prompts')).toBe('none');
    expect(after(a, '--tools')).toBe('');
    expect(after(a, '--allowedTools')).toBe('mcp__bloomterm');
    expect(after(a, '--mcp-config')).toBe(join(RUN, 'mcp.json'));
    expect(JSON.parse(claude.files(chat)['mcp.json']!).mcpServers.bloomterm).toMatchObject({ type: 'stdio', command: '/x/tsx' });
    expect(a).not.toContain('--bare'); // --bare only reads ANTHROPIC_API_KEY
    expect(a).not.toContain('--resume');
    expect(after(claudeArgs({ ...chat, web: true, resume: 's1' }), '--resume')).toBe('s1');
    expect(after(claudeArgs({ ...chat, web: true }), '--tools')).toBe('WebSearch');
  });

  it('keeps the prompt, the instructions and the MCP config off the command line', () => {
    const a = claudeArgs(chat);
    expect(claude.input(chat)).toBe('how is PETR4?');
    expect(after(a, '--append-system-prompt-file')).toBe(join(RUN, 'system.md'));
    expect(claude.files(chat)['system.md']).toBe('be brief');
    expect(a.join(' ')).not.toMatch(/PETR4|be brief|BLOOMTERM_HOME/);
    const bare: AgentRunOptions = { mode: 'chat', prompt: 'hi', cwd: '/tmp' };
    expect(claude.files(bare)).toEqual({});
    expect(claudeArgs(bare).join(' ')).not.toMatch(/--mcp-config|--append-system-prompt/);
  });

  it('lets evolve edit only the paths it was given, with no shell', () => {
    const a = claudeArgs({ ...chat, mode: 'evolve', writable: ['b3/**'] });
    expect(a).toContain('Edit(b3/**)');
    expect(a).toContain('Write(b3/**)');
    expect(a.some((x) => x.startsWith('Edit(') && !x.includes('b3'))).toBe(false);
    expect(a.join(' ')).not.toContain('Bash');
    expect(a).not.toContain('WebFetch');
    expect(after(claudeArgs({ ...chat, mode: 'evolve', web: true }), '--tools')).toContain('WebFetch');
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
    const a = codexArgs(chat);
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a).toContain('--ignore-user-config');
    expect(a).toContain('sandbox_mode="read-only"');
    expect(a).toContain('web_search="disabled"');
    expect(a).toContain('mcp_servers.bloomterm.command="/x/tsx"');
    expect(a).toContain('mcp_servers.bloomterm.default_tools_approval_mode="approve"');
    expect(a).toContain('mcp_servers.bloomterm.tool_timeout_sec=420');
    expect(a).toContain('mcp_servers.bloomterm.env={"BLOOMTERM_HOME" = "/h"}');
    expect(a.at(-1)).toBe('-');
    expect(a.join(' ')).not.toMatch(/PETR4|be brief/);
    expect(codex.input(chat)).toBe('be brief\n\n---\n\nhow is PETR4?');
    const resumed = codexArgs({ ...chat, resume: 't1' });
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(resumed.at(-1)).toBe('-');
    expect(codex.input({ ...chat, resume: 't1' })).toBe('how is PETR4?');
    expect(codexArgs({ ...chat, mode: 'evolve' })).toContain('sandbox_mode="workspace-write"');
    expect(codexArgs({ ...chat, mode: 'evolve', web: true })).toContain('web_search="live"');
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

  it('takes a prompt far longer than a Windows command line', async () => {
    const r = await runAgent(cli, { ...chat, cwd: tmpdir(), prompt: `${'x'.repeat(100_000)}\nhow is PETR4?` });
    expect(r.text).toContain('You asked: how is PETR4?');
  });

  it("reports an agent that can't start, and a run stopped before it did", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-agent-'));
    const events: AgentEvent[] = [];
    const notAProgram = join(dir, 'claude.txt');
    await writeFile(notAProgram, 'hello');
    const r = await runAgent({ ...cli, path: notAProgram }, { ...chat, cwd: dir }, (e) => events.push(e));
    expect(r).toMatchObject({ ok: false, sessionId: null });
    expect(r.error).toMatch(/couldn't start claude/);
    expect(events.map((e) => e.type)).toEqual(['error']);

    const ac = new AbortController();
    ac.abort();
    expect(await runAgent(cli, { ...chat, cwd: dir, signal: ac.signal })).toMatchObject({ ok: false, error: 'stopped' });
  });

  it.runIf(windows)('stops what the agent started, too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-agent-'));
    const pidFile = join(dir, 'pid');
    const agent = join(dir, 'claude.mjs');
    await writeFile(
      agent,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));
setTimeout(() => {}, 60000);
`,
    );
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    const run = runAgent({ ...cli, path: agent }, { ...chat, cwd: dir, signal: ac.signal, env: {} }, (e) => events.push(e));
    await expect.poll(() => events.length, { timeout: 10_000 }).toBe(1);
    const pid = Number(await readFile(pidFile, 'utf8'));
    ac.abort();
    await run;
    const alive = () => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 10_000 }).toBe(false);
  });

  it('reports failures, stops on abort, and never inherits a parent session', async () => {
    expect(await runAgent(cli, { ...chat, cwd: tmpdir(), prompt: 'please fail' })).toMatchObject({ ok: false, error: 'the model is unavailable' });

    const dir = await mkdtemp(join(tmpdir(), 'bt-agent-'));
    const slow = join(dir, 'claude.mjs');
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
      expect(env.PATH!.split(delimiter)[0]).toBe(dirname(process.execPath));
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
      expect(env.X).toBe('1');
    } finally {
      delete process.env.CLAUDECODE;
    }
  });
});

// As npm and pnpm write them, trimmed to what matters.
const NPM_SHIM = (target: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*
`;
const PNPM_SHIM = (target: string) => `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${target}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\${target}" %*
)
`;

describe('launch', () => {
  it('starts anything itself on a Mac', () => {
    expect(launch('/x/claude', ['-p'], 'darwin')).toEqual({ file: '/x/claude', args: ['-p'] });
    expect(launch('/x/claude.mjs', ['-p'], 'linux')).toEqual({ file: '/x/claude.mjs', args: ['-p'] });
  });

  it('on Windows, starts a .exe itself and a Node script through Node', () => {
    expect(launch('C:/x/claude.exe', ['-p'], 'win32')).toEqual({ file: 'C:/x/claude.exe', args: ['-p'] });
    expect(launch('C:/x/codex.js', ['exec'], 'win32')).toEqual({ file: process.execPath, args: ['C:/x/codex.js', 'exec'] });
  });

  it('on Windows, follows what npm and pnpm leave instead of going through cmd.exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-shim-'));
    const shim = async (name: string, text: string) => {
      await writeFile(join(dir, name), text);
      return join(dir, name);
    };
    const js = await shim('codex.cmd', NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'));
    expect(launch(js, ['exec'], 'win32')).toEqual({ file: process.execPath, args: [join(dir, 'node_modules/@openai/codex/bin/codex.js'), 'exec'] });
    const exe = await shim('claude.cmd', NPM_SHIM('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
    expect(launch(exe, ['-p'], 'win32')).toEqual({ file: join(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'), args: ['-p'] });
    const pnpm = await shim('pnpm.cmd', PNPM_SHIM('..\\global\\cli.mjs'));
    expect(launch(pnpm, [], 'win32')).toEqual({ file: process.execPath, args: [resolve(dir, '../global/cli.mjs')] });
    const odd = await shim('odd.cmd', '@echo hello %*\r\n');
    expect(() => launch(odd, [], 'win32')).toThrow(/can't tell what/);
  });
});

describe('findAgents', () => {
  const version = `#!/usr/bin/env node\nconsole.log('1.2.3 (fake)');\n`;

  it('finds a CLI where its installer left it, and skips one that does not run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-find-'));
    if (windows) {
      await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 1\n'); // npm leaves this too
      await writeFile(join(dir, 'claude.mjs'), version);
      await writeFile(join(dir, 'claude.cmd'), NPM_SHIM('claude.mjs'));
      await writeFile(join(dir, 'codex.cmd'), '@echo nothing to follow\r\n');
    } else {
      await writeFile(join(dir, 'claude'), version);
      await chmod(join(dir, 'claude'), 0o755);
      await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 1\n');
      await chmod(join(dir, 'codex'), 0o755);
    }
    expect(await findAgents([dir])).toEqual([{ kind: 'claude', path: join(dir, windows ? 'claude.cmd' : 'claude'), version: '1.2.3 (fake)' }]);
  });

  it.runIf(windows)('prefers a real claude.exe to an npm launcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-find-'));
    await copyFile(process.execPath, join(dir, 'claude.exe')); // any program with a --version
    await writeFile(join(dir, 'claude.cmd'), NPM_SHIM('claude.mjs'));
    expect(await findAgents([dir])).toEqual([{ kind: 'claude', path: join(dir, 'claude.exe'), version: process.version }]);
  });
});

describe('signedIn', () => {
  /** A stand-in CLI that answers `asked` with `out`, and anything else with exit code 2. */
  async function cli(kind: 'claude' | 'codex', asked: string, out: { stdout?: string; stderr?: string; code?: number }) {
    const dir = await mkdtemp(join(tmpdir(), 'bt-auth-'));
    const path = join(dir, `${kind}.mjs`);
    const script = `if (process.argv.slice(2).join(' ') !== ${JSON.stringify(asked)}) process.exit(2);
const out = ${JSON.stringify(out)};
if (out.stdout) console.log(out.stdout);
if (out.stderr) console.error(out.stderr);
process.exitCode = out.code ?? 0;`;
    await writeFile(path, `#!/usr/bin/env node\n${script}\n`);
    await chmod(path, 0o755);
    return { kind, path, version: 'fake' };
  }

  it('asks Claude Code, and keeps only whether it is signed in', async () => {
    const asked = 'auth status --json';
    expect(await signedIn(await cli('claude', asked, { stdout: '{"loggedIn":true,"email":"me@example.com"}' }))).toBe(true);
    expect(await signedIn(await cli('claude', asked, { stdout: '{"loggedIn":false}', code: 1 }))).toBe(false);
    expect(await signedIn(await cli('claude', asked, { stderr: "error: unknown command 'auth'", code: 1 }))).toBeNull();
  });

  it('asks Codex', async () => {
    const asked = 'login status';
    expect(await signedIn(await cli('codex', asked, { stdout: 'Logged in using ChatGPT' }))).toBe(true);
    expect(await signedIn(await cli('codex', asked, { stdout: 'Not logged in', code: 1 }))).toBe(false);
    expect(await signedIn(await cli('codex', asked, { stderr: "unrecognized subcommand 'status'", code: 2 }))).toBeNull();
  });

  it('says how to sign in', () => {
    const agent = (kind: 'claude' | 'codex', path: string) => ({ kind, path, version: '1.0' });
    expect(signInHint(agent('claude', '/opt/homebrew/bin/claude'), 'darwin')).toBe('claude auth login');
    expect(signInHint(agent('codex', '/opt/homebrew/bin/codex'), 'darwin')).toBe('codex login');
    // Windows: the whole path, because Claude Code's installer leaves it off PATH, and a stock
    // PowerShell refuses npm's codex.ps1.
    expect(signInHint(agent('claude', String.raw`C:\Users\a friend\.local\bin\claude.exe`), 'win32')).toBe(String.raw`& "C:\Users\a friend\.local\bin\claude.exe" auth login`);
    expect(signInHint(agent('codex', String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`), 'win32')).toBe(String.raw`& "C:\Users\me\AppData\Roaming\npm\codex.cmd" login`);
  });

  it('says how to install, without Node or && on Windows', () => {
    for (const command of Object.values(installCommands('win32'))) {
      expect(command).toMatch(/^(irm|powershell) .*install\.ps1/);
      expect(command).not.toMatch(/npm|&&/);
    }
    expect(installCommands('darwin').claude).toBe('npm i -g @anthropic-ai/claude-code && claude');
  });
});
