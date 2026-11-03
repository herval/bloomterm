import type { AgentEvent, AgentRunOptions, CliDriver } from './types.ts';

// Claude Code in print mode (`claude -p`), streaming JSON. It runs on your Claude
// subscription: no ANTHROPIC_API_KEY (which is also why `--bare`, which only reads that key,
// isn't used). Isolation instead comes from:
//   --setting-sources project,local   no user settings, so none of your plugins or hooks
//   --strict-mcp-config               only bloomterm's MCP server, none of yours
//   --permission-mode dontAsk + --permission-prompts none
//                                     anything not allowed below is refused, never asked

export const claude: CliDriver = {
  args(o: AgentRunOptions): string[] {
    const a = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    a.push('--setting-sources', 'project,local', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none');
    if (o.mcp && Object.keys(o.mcp).length) {
      const servers = Object.fromEntries(Object.entries(o.mcp).map(([name, s]) => [name, { type: 'stdio', command: s.command, args: s.args, env: s.env ?? {} }]));
      a.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
    }
    const mcpAllow = Object.keys(o.mcp ?? {}).map((name) => `mcp__${name}`);
    if (o.mode === 'chat') {
      a.push('--tools', o.web ? 'WebSearch' : '');
      a.push('--allowedTools', ...mcpAllow, ...(o.web ? ['WebSearch'] : []));
    } else {
      const writable = o.writable ?? [];
      // With web on, it can look for the institution's API docs.
      const web = o.web ? ['WebSearch', 'WebFetch'] : [];
      a.push('--tools', ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', ...web].join(','));
      a.push(
        '--allowedTools',
        ...mcpAllow,
        ...web,
        'Read(./**)',
        'Glob',
        'Grep',
        ...writable.flatMap((p) => [`Edit(${p})`, `Write(${p})`]),
        ...(o.bash ?? []).map((c) => `Bash(${c}:*)`),
      );
    }
    if (o.system) a.push('--append-system-prompt', o.system);
    if (o.resume) a.push('--resume', o.resume);
    if (o.model) a.push('--model', o.model);
    return a;
  },

  parser() {
    const tools = new Map<string, string>();
    return (line: any): AgentEvent[] => {
      switch (line?.type) {
        case 'system':
          return line.subtype === 'init' ? [{ type: 'session', id: line.session_id, model: line.model }] : [];
        case 'stream_event': {
          const e = line.event;
          return e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !line.parent_tool_use_id ? [{ type: 'text', text: e.delta.text }] : [];
        }
        case 'assistant': {
          // Text already came as deltas; take only the tool calls.
          const out: AgentEvent[] = [];
          for (const b of line.message?.content ?? []) {
            if (b.type !== 'tool_use' || line.parent_tool_use_id) continue;
            tools.set(b.id, b.name);
            out.push({ type: 'tool', id: b.id, name: b.name, input: b.input });
          }
          return out;
        }
        case 'user': {
          const out: AgentEvent[] = [];
          for (const b of line.message?.content ?? []) {
            if (b.type !== 'tool_result' || !tools.has(b.tool_use_id)) continue;
            out.push({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, text: flatten(b.content).slice(0, 500) });
          }
          return out;
        }
        case 'result':
          if (line.is_error || line.subtype !== 'success') return [{ type: 'error', message: String(line.result || line.subtype || 'the agent failed') }];
          return [{ type: 'done', text: String(line.result ?? ''), costUsd: line.total_cost_usd }];
        default:
          return [];
      }
    };
  },
};

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('');
  return '';
}
