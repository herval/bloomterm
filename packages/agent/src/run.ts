import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { searchPath } from './detect.ts';
import type { AgentCli, AgentEvent, AgentResult, AgentRunOptions, CliDriver } from './types.ts';

export const DRIVERS: Record<AgentCli['kind'], CliDriver> = { claude, codex };

/** The environment an agent runs with: yours, minus anything that marks it as nested in another session. */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDECODE$|^CLAUDE_CODE_ENTRYPOINT$|^CODEX_THREAD_ID$/.test(k)) env[k] = v;
  // The agent starts bloomterm's MCP server with `node`, so this Node must be on its PATH.
  env.PATH = [dirname(process.execPath), ...searchPath(env)].join(':');
  return { ...env, ...extra };
}

/**
 * Runs the agent once (one turn) and streams what it does. Resolves when it finishes; a
 * failure resolves too (`ok: false`), so callers deal with one shape.
 */
export function runAgent(cli: AgentCli, o: AgentRunOptions, onEvent: (ev: AgentEvent) => void = () => {}): Promise<AgentResult> {
  const driver = DRIVERS[cli.kind];
  const parse = driver.parser();
  return new Promise((resolve) => {
    const child = spawn(cli.path, driver.args(o), { cwd: o.cwd, env: agentEnv(o.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let sessionId: string | null = o.resume ?? null;
    let text = '';
    let done: AgentResult | null = null;
    let stderr = '';
    const emit = (ev: AgentEvent) => {
      if (ev.type === 'session') sessionId = ev.id;
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'done') done = { sessionId, text: ev.text || text, ok: true, costUsd: ev.costUsd };
      if (ev.type === 'error' && !done) done = { sessionId, text, ok: false, error: ev.message };
      onEvent(ev);
    };

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return;
      }
      for (const ev of parse(json)) emit(ev);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4_000);
    });

    const kill = (why: string) => {
      if (child.exitCode !== null) return;
      if (!done) emit({ type: 'error', message: why });
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3_000).unref();
    };
    const timer = o.timeoutMs ? setTimeout(() => kill(`the agent took longer than ${Math.round(o.timeoutMs! / 1000)}s`), o.timeoutMs) : null;
    o.signal?.addEventListener('abort', () => kill('stopped'), { once: true });

    child.on('error', (err) => {
      if (!done) emit({ type: 'error', message: `couldn't start ${cli.kind}: ${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!done) {
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        emit({ type: 'error', message: `${cli.kind} exited with ${code}${tail ? `: ${tail}` : ''}` });
      }
      resolve(done!);
    });
  });
}
