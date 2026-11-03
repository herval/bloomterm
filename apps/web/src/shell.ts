import { createContext, useContext } from 'react';

/** What any page can ask of the app around it. */
export interface ShellApi {
  /** Sends a question to Ask (the drawer opens). `fresh` starts a new conversation. */
  ask(question: string, o?: { fresh?: boolean; context?: string }): Promise<void>;
  /** Opens the Ask drawer, on a conversation or the list. */
  openAsk(chatId?: string | null): void;
  /** Runs a command (`PETR4 GP 1Y`, `W`, `EVOLVE b3`): mnemonics still work everywhere. */
  run(command: string): void;
  toast(text: string, kind?: 'info' | 'error'): void;
  openPalette(text?: string): void;
}

export const ShellContext = createContext<ShellApi>({
  ask: async () => {},
  openAsk: () => {},
  run: () => {},
  toast: () => {},
  openPalette: () => {},
});

export const useShell = () => useContext(ShellContext);

/** While the terminal page is open, commands run in its active panel instead of opening pages. */
export const terminalRun: { current: ((command: string) => void) | null } = { current: null };
