import { findAgents, INSTALL_HINT, pickAgent } from '@bloomterm/agent';
import { consoleLogger } from '@bloomterm/browser';
import { bloomtermHome } from '@bloomterm/core';
import { integrations } from '@bloomterm/integrations';
import { loadConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { LocalIntegrations } from './integrations.ts';
import { keychainStore } from './market/secrets.ts';

// bloomd entry point: `bt daemon`, from a shell, launchd (`bt daemon install`) or the desktop app.

/**
 * The exit code that asks for a restart. launchd (KeepAlive unless the exit was clean) and
 * the desktop app, which set BLOOMTERM_SUPERVISED=1, start bloomd again after it.
 */
export const RESTART_EXIT = 75;

export async function runDaemon(opts: { port?: number } = {}): Promise<void> {
  // Everything bloomd writes (DB, captures, profiles, token) is private to you.
  process.umask(0o077);
  const home = bloomtermHome();
  const config = await loadConfig(home);
  const log = consoleLogger();
  // bloomterm's AI is your coding agent (SPEC §10). Without one bloomd starts anyway, so the
  // web app's Setup page can say what to install; Ask, the brief and EVOLVE wait for it.
  const found = await findAgents();
  const agent = pickAgent(found, config.agent.cli);
  if (!agent) {
    const which = config.agent.cli === 'auto' ? '' : ` ([agent] cli = "${config.agent.cli}" in config.toml, but it isn't installed)`;
    log.warn(`no agent CLI: ${INSTALL_HINT}${which}`);
  }
  // The built-ins, with the integrations you approved in <home>/integrations in place.
  const local = new LocalIntegrations({ home, builtins: integrations, log });
  const loaded = await local.load();
  let stopping = false;
  const stop = async (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    daemon.log.info('stopping', { reason });
    await daemon.stop().catch((err) => daemon.log.error('stop failed', { error: String(err) }));
    process.exit(code);
  };
  const supervised = process.env.BLOOMTERM_SUPERVISED === '1';
  const daemon = new Daemon({
    integrations: loaded,
    local,
    port: opts.port,
    secrets: keychainStore(),
    config,
    agent,
    log,
    restart: supervised ? () => void stop('restart', RESTART_EXIT) : undefined,
    shutdown: () => void stop('shutdown', 0),
  });
  await daemon.start();
  process.on('SIGINT', () => void stop('SIGINT', 0));
  process.on('SIGTERM', () => void stop('SIGTERM', 0));
}
