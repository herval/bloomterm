import type { AgentEvent, AgentRunOptions, CliDriver } from './types.ts';

// Codex non-interactive (`codex exec --json`), on your ChatGPT sign-in. `--ignore-user-config`
// keeps your own MCP servers and settings out (auth still comes from ~/.codex); bloomterm's
// MCP server is added with -c. Codex reads AGENTS.md from the working directory, which is
// where bloomterm's instructions go, so `system` is prepended to the first prompt only.

const toml = (v: unknown): string => JSON.stringify(v); // strings and string arrays are valid TOML as JSON
const tomlTable = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')}}`;

export const codex: CliDriver = {
  args(o: AgentRunOptions): string[] {
    const a = ['exec'];
    if (o.resume) a.push('resume', o.resume);
    a.push('--json', '--skip-git-repo-check', '--ignore-user-config', '--color', 'never');
    a.push('-c', `sandbox_mode=${toml(o.mode === 'chat' ? 'read-only' : 'workspace-write')}`, '-c', 'approval_policy="never"');
    // ASK searches the web; EVOLVE uses it to look for the institution's API docs.
    a.push('-c', `web_search=${toml(o.web ? 'live' : 'disabled')}`);
    for (const [name, s] of Object.entries(o.mcp ?? {})) {
      a.push('-c', `mcp_servers.${name}.command=${toml(s.command)}`, '-c', `mcp_servers.${name}.args=${toml(s.args)}`);
      // bloomterm's servers are ours and read-only (chat) or scoped by bloomd (evolve): no per-call approval.
      a.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`);
      if (s.env && Object.keys(s.env).length) a.push('-c', `mcp_servers.${name}.env=${tomlTable(s.env)}`);
    }
    if (o.model) a.push('-m', o.model);
    a.push('-'); // the prompt comes on stdin
    return a;
  },

  input: (o) => (o.system && !o.resume ? `${o.system}\n\n---\n\n${o.prompt}` : o.prompt),

  files: () => ({}),

  parser() {
    const messages: string[] = [];
    const started = new Set<string>();
    return (line: any): AgentEvent[] => {
      const item = line?.item;
      switch (line?.type) {
        case 'thread.started':
          return [{ type: 'session', id: line.thread_id }];
        case 'item.started': {
          const ev = item ? toolStart(item) : [];
          if (ev.length) started.add(item.id);
          return ev;
        }
        case 'item.completed': {
          if (!item) return [];
          if (item.type === 'agent_message') {
            const text = (messages.length ? '\n\n' : '') + String(item.text ?? '');
            messages.push(String(item.text ?? ''));
            return [{ type: 'text', text }];
          }
          if (item.type === 'error') return [{ type: 'error', message: String(item.message) }];
          const tool = toolStart(item);
          if (!tool.length) return [];
          const ok = item.status !== 'failed' && !item.error && (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0);
          const result: AgentEvent = { type: 'tool_result', id: item.id, ok, text: resultText(item).slice(0, 500) };
          // Some items (file changes) only ever arrive completed.
          return started.delete(item.id) ? [result] : [...tool, result];
        }
        case 'turn.completed':
          // The last message is the answer; the ones before it narrate the work (as with Claude's result).
          return [{ type: 'done', text: messages.at(-1) ?? '' }];
        case 'turn.failed':
          return [{ type: 'error', message: String(line.error?.message ?? 'the agent failed') }];
        case 'error':
          return [{ type: 'error', message: String(line.message ?? 'the agent failed') }];
        default:
          return [];
      }
    };
  },
};

function resultText(item: any): string {
  if (item.error) return String(item.error.message ?? item.error);
  if (typeof item.aggregated_output === 'string') return item.aggregated_output;
  const content = item.result?.content;
  return Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('') : '';
}

function toolStart(item: any): AgentEvent[] {
  switch (item.type) {
    case 'mcp_tool_call':
      return [{ type: 'tool', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments }];
    case 'command_execution':
      return [{ type: 'tool', id: item.id, name: 'shell', input: { command: item.command } }];
    case 'file_change':
      return [{ type: 'tool', id: item.id, name: 'edit', input: { files: (item.changes ?? []).map((c: any) => c.path) } }];
    case 'web_search':
      return [{ type: 'tool', id: item.id, name: 'web_search', input: { query: item.query } }];
    default:
      return [];
  }
}
