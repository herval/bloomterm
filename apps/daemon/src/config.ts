import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

// config.toml (SPEC §8.4). Everything is optional; this is the whole format today:
//
//   [daemon]
//   port = 4320
//   concurrency = 4
//
//   [notify]
//   macos = true
//   windows = true
//
//   [profiles.finance]
//   mode = "parked"            # or "headless"
//
//   [browser]
//   chrome = "/Applications/Google Chrome.app"   # optional; bloomterm finds Chrome by itself
//
//   [agent]                    # the AI (SPEC §10): your Claude Code or Codex, on your subscription
//   cli = "auto"               # or "claude" / "codex"
//   model = "sonnet"           # optional; passed to the CLI
//   web = true                 # ASK may search the web (the query leaves your machine)
//   share_portfolio = true     # ASK may read your positions and balances
//
//   [brief]                    # the morning brief (SPEC §10.3), written by the agent
//   cron = "0 7 * * 1-5"       # when; on this machine's clock unless tz is set
//   enabled = true
//
//   [news]
//   ai = true                  # the agent groups headlines into stories and tags them
//
//   [schedules."b3.positions"]
//   cron = "0 9 * * 1-5"
//   tz = "America/Sao_Paulo"
//   # enabled = false         # turns an adapter's built-in schedule off

const Schedule = z.object({
  cron: z.string().optional(),
  tz: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const Config = z
  .object({
    daemon: z
      .object({
        port: z.number().int().min(0).max(65535).default(4320),
        concurrency: z.number().int().min(1).max(16).default(4),
      })
      .prefault({}),
    notify: z.object({ macos: z.boolean().default(true), windows: z.boolean().default(true) }).prefault({}),
    agent: z
      .object({
        cli: z.enum(['auto', 'claude', 'codex']).default('auto'),
        model: z.string().optional(),
        web: z.boolean().default(true),
        share_portfolio: z.boolean().default(true),
      })
      .prefault({}),
    brief: z
      .object({
        enabled: z.boolean().default(true),
        cron: z.string().default('0 7 * * 1-5'),
        tz: z.string().optional(),
      })
      .prefault({}),
    news: z.object({ ai: z.boolean().default(true) }).prefault({}),
    browser: z.object({ chrome: z.string().min(1).optional() }).prefault({}),
    profiles: z
      .record(
        z.string(),
        z.object({
          mode: z.enum(['parked', 'headless']).optional(),
          maxTabs: z.number().int().min(1).max(8).optional(),
          useSystemKeychain: z.boolean().optional(),
          keepSessionCookies: z.boolean().optional(),
        }),
      )
      .default({}),
    schedules: z.record(z.string().regex(/^[a-z][a-z0-9-]*\.[A-Za-z][\w-]*$/, 'use "<source>.<dataset>"'), Schedule).default({}),
  })
  .strict();
export type Config = z.infer<typeof Config>;

export async function loadConfig(home: string): Promise<Config> {
  const file = join(home, 'config.toml');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return Config.parse({});
    throw err;
  }
  const parsed = Config.safeParse(parse(text));
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
