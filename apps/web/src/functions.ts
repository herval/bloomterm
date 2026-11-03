import type { MutableRefObject } from 'react';
import type { PanelState, View } from './layout.ts';

// The UI's function catalog (SPEC §5): one entry per mnemonic. Views live in views/.

export interface Nav {
  /** Show a view in this panel; Esc comes back. */
  open(view: View): void;
  /** Replace this panel's args in place (e.g. a chart range), without a back step. */
  setArgs(args: string[]): void;
  /** Load a security into the panels linked to this one, or open it here if none are. */
  linkSecurity(key: string): void;
  message(text: string, kind?: 'info' | 'error'): void;
  /** Run a command in another panel (the one you were in before), e.g. a link in an ASK answer. */
  run(command: string): void;
}

export interface ViewProps {
  panel: PanelState;
  active: boolean;
  nav: Nav;
  /** A view with numbered rows sets this so `3 <GO>` opens row 3. */
  drill: MutableRefObject<((row: number) => void) | null>;
}

export interface FnDef {
  mnemonic: string;
  title: string;
  /** `security` functions act on the panel's security (SPEC §4.2). */
  scope: 'global' | 'security';
  usage: string;
  help: string;
  phase: 'P0' | 'P1' | 'P2';
}

export const FUNCTIONS: FnDef[] = [
  {
    mnemonic: 'OV',
    title: 'Overview',
    scope: 'security',
    usage: 'PETR4 OV',
    help: 'Quote, day range, previous close, and a 6-month chart. Typing just a security opens this.',
    phase: 'P0',
  },
  {
    mnemonic: 'GP',
    title: 'Price graph',
    scope: 'security',
    usage: 'AAPL GP 1Y',
    help: 'Candles with volume and SMA 50/200; scroll back for older ones. Ranges: 1D (5-minute bars) 5D 1M 3M 6M YTD 1Y 5Y MAX.',
    phase: 'P0',
  },
  {
    mnemonic: 'W',
    title: 'Monitor',
    scope: 'global',
    usage: 'W · W ADD petr4 · W DEL 3',
    help: 'Your watchlist, with live quotes. `3 <GO>` loads row 3 into the panels linked to this one.',
    phase: 'P0',
  },
  {
    mnemonic: 'ASK',
    title: 'Ask',
    scope: 'global',
    usage: 'how is PETR4 doing? · PETR4 ASK why down · ? W · ASK · ASK STOP',
    help: 'Questions in plain words, answered by your Claude Code or Codex from bloomterm\'s own data. Anything that isn\'t a command is a question; start with ? to force one. Commands in answers are clickable. ASK alone lists past chats.',
    phase: 'P0',
  },
  {
    mnemonic: 'PORT',
    title: 'Portfolio',
    scope: 'global',
    usage: 'PORT',
    help: 'Positions and balances from your accounts, with where and when each was fetched. Totals in USD at the BCB PTAX rate.',
    phase: 'P1',
  },
  {
    mnemonic: 'SRC',
    title: 'Sources',
    scope: 'global',
    usage: 'SRC',
    help: 'Each source: session state, last good fetch, next scheduled run. `3 <GO>` shows its jobs.',
    phase: 'P0',
  },
  {
    mnemonic: 'JOBS',
    title: 'Jobs',
    scope: 'global',
    usage: 'JOBS · JOBS b3',
    help: 'What ran, when, and why it failed. `3 <GO>` opens job 3.',
    phase: 'P0',
  },
  {
    mnemonic: 'LOGIN',
    title: 'Sign in',
    scope: 'global',
    usage: 'LOGIN b3',
    help: 'Opens the sign-in window for a browser source. You type your password there; bloomterm never sees it.',
    phase: 'P0',
  },
  {
    mnemonic: 'EVOLVE',
    title: 'Evolve an integration',
    scope: 'global',
    usage: 'EVOLVE b3 · EVOLVE xp map the positions page · EVOLVE',
    help: "Your agent builds or fixes an integration: it finds the site's API (or its own JSON calls) through your signed-in browser, writes the code and tests, checks them against the live site, and commits to a git branch for you to merge. Read-only, and it never sees your passwords. EVOLVE alone lists runs.",
    phase: 'P0',
  },
  {
    mnemonic: 'SET',
    title: 'Settings',
    scope: 'global',
    usage: 'SET',
    help: 'API keys (stored in your macOS Keychain) and what bloomd is running.',
    phase: 'P0',
  },
  {
    mnemonic: 'HELP',
    title: 'Help',
    scope: 'global',
    usage: 'HELP · HELP GP',
    help: 'Functions, keys and the command grammar.',
    phase: 'P0',
  },
];

export const FN = Object.fromEntries(FUNCTIONS.map((f) => [f.mnemonic, f])) as Record<string, FnDef>;
export const FN_SET: ReadonlySet<string> = new Set(FUNCTIONS.map((f) => f.mnemonic));
