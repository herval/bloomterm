// bloomterm's AI runs on the coding agent you already have: Claude Code (`claude`) or
// Codex (`codex`), driven headless, on your own subscription. No API keys (SPEC §10).

export type AgentKind = 'claude' | 'codex';

export interface AgentCli {
  kind: AgentKind;
  path: string;
  version: string;
}

/** A local stdio MCP server the agent may use. Only these are loaded, never your own MCP servers. */
export interface McpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * What the agent may do.
 * - `chat`: answer questions. Read-only bloomterm tools (MCP), optional web search; no shell,
 *   no file access.
 * - `evolve`: build or repair an integration. Reads its folder, edits only `writable` paths, runs
 *   only the `bash` commands (its checks); plus bloomterm's tools for the browser.
 */
export type AgentMode = 'chat' | 'evolve';

export interface AgentRunOptions {
  mode: AgentMode;
  prompt: string;
  cwd: string;
  /** Extra instructions for this kind of run (appended to the CLI's own system prompt). */
  system?: string;
  /** Continue an earlier conversation (the id from its `session` event). */
  resume?: string;
  mcp?: Record<string, McpServer>;
  /** chat: allow web search (the query leaves your machine). */
  web?: boolean;
  /** evolve: path globs, relative to cwd, the agent may edit. */
  writable?: string[];
  /** evolve: command prefixes the agent's shell may run, where the CLI has an allowlist (Claude Code). */
  bash?: string[];
  model?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** What a run reports as it goes, the same for both CLIs. */
export type AgentEvent =
  | { type: 'session'; id: string; model?: string }
  /** More of the answer. */
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; input?: unknown }
  | { type: 'tool_result'; id?: string; ok: boolean; text?: string }
  | { type: 'done'; text: string; costUsd?: number }
  | { type: 'error'; message: string };

export interface AgentResult {
  sessionId: string | null;
  text: string;
  ok: boolean;
  error?: string;
  costUsd?: number;
}

/** How one CLI is driven: its arguments, and how its output lines map to events. */
export interface CliDriver {
  args(o: AgentRunOptions): string[];
  /** One stdout line (JSON) → zero or more events. Keeps its own state across lines. */
  parser(): (line: unknown) => AgentEvent[];
}
