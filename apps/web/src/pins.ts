import { useUiState } from './feeds.ts';

// Answers from Ask you pinned to Today. Kept in bloomd with the rest of the UI state.

export interface Pin {
  id: string;
  /** The question. */
  title: string;
  text: string;
  chatId?: string;
  seq?: number;
  at: string;
}

export function usePins() {
  const [pins, setPins] = useUiState<Pin[]>('pins', []);
  const list = Array.isArray(pins) ? pins : [];
  return {
    pins: list,
    isPinned: (chatId: string, seq: number) => list.some((p) => p.chatId === chatId && p.seq === seq),
    add: (p: Omit<Pin, 'id' | 'at'>) => setPins([{ ...p, id: `p${Date.now().toString(36)}`, at: new Date().toISOString() }, ...list.filter((x) => !(x.chatId === p.chatId && x.seq === p.seq))].slice(0, 24)),
    remove: (id: string) => setPins(list.filter((p) => p.id !== id)),
  };
}
