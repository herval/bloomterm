// Panels, link groups and back stacks (SPEC §4.1). bloomd keeps the layout, so it
// survives reloads and follows you across browsers.

export type Group = 'A' | 'B' | 'C' | null;

export interface View {
  fn: string;
  /** Security key, for security functions (and remembered by global ones for Esc). */
  security?: string;
  args: string[];
}

export interface PanelState extends View {
  id: number;
  group: Group;
  /** Esc pops this. */
  back: View[];
  /** Commands typed in this panel, newest last. */
  history: string[];
}

/** How the panel grid is split, as shares of the space (0–1). */
export interface Sizes {
  /** The left column's share of the width. */
  col: number;
  /** The top panel's share of each column's height. */
  rows: [number, number];
}

export interface Layout {
  version: 1;
  panels: PanelState[];
  active: number;
  maximized: number | null;
  /** Missing in layouts saved before panels could be resized. */
  sizes?: Sizes;
}

const share = (x: unknown) => (typeof x === 'number' && x > 0.05 && x < 0.95 ? x : 0.5);
export function sizesOf(l: Layout): Sizes {
  return { col: share(l.sizes?.col), rows: [share(l.sizes?.rows?.[0]), share(l.sizes?.rows?.[1])] };
}

const panel = (id: number, view: View, group: Group): PanelState => ({ id, ...view, group, back: [], history: [] });

export const DEFAULT_LAYOUT: Layout = {
  version: 1,
  panels: [
    panel(1, { fn: 'GP', security: 'PETR4 BZ Equity', args: ['1Y'] }, 'A'),
    panel(2, { fn: 'W', args: [] }, 'A'),
    panel(3, { fn: 'OV', security: 'PETR4 BZ Equity', args: [] }, 'A'),
    panel(4, { fn: 'SRC', args: [] }, null),
  ],
  active: 2,
  maximized: null,
};

export function validLayout(x: unknown): x is Layout {
  const l = x as Layout;
  return !!l && l.version === 1 && Array.isArray(l.panels) && l.panels.length > 0 && l.panels.every((p) => typeof p.fn === 'string' && Array.isArray(p.args));
}

export const GROUPS: Group[] = ['A', 'B', 'C', null];
export const nextGroup = (g: Group): Group => GROUPS[(GROUPS.indexOf(g) + 1) % GROUPS.length]!;

export { DEFAULT_WATCHLISTS, type Watchlists } from '@bloomterm/core/web';
