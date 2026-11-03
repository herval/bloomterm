import type { Logger } from './types.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Plain stderr logger. `BLOOMTERM_LOG=debug|info|warn|error|silent`. */
export function consoleLogger(level: Level | 'silent' = (process.env.BLOOMTERM_LOG as Level) ?? 'info'): Logger {
  const min = level === 'silent' ? Infinity : (LEVELS[level] ?? LEVELS.info);
  const write = (l: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[l] < min) return;
    const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${l.padEnd(5)} ${msg}${extra}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
