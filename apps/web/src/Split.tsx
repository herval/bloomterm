import { useRef, type PointerEvent } from 'react';

const MIN_PX = 120;

/**
 * The divider between two panels. Dragging it moves a CSS variable on its parent (`--col` on
 * the panel grid, `--row` on a column), so the panels resize without re-rendering; the new
 * share is saved when you let go. Double-click evens it out.
 */
export function Splitter({ dir, onChange }: { dir: 'col' | 'row'; onChange(share: number): void }) {
  const prop = dir === 'col' ? '--col' : '--row';
  const moved = useRef(false);
  // The share of the space the two sides split: inside the parent's padding, without the divider.
  const share = (e: PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement!;
    const box = parent.getBoundingClientRect();
    const cs = getComputedStyle(parent);
    const me = e.currentTarget.getBoundingClientRect();
    const [start, pad, total, own] =
      dir === 'col'
        ? [box.left + parseFloat(cs.paddingLeft), parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), box.width, me.width]
        : [box.top + parseFloat(cs.paddingTop), parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), box.height, me.height];
    const size = total - pad - own;
    const pos = (dir === 'col' ? e.clientX : e.clientY) - start - own / 2;
    const min = Math.min(0.4, MIN_PX / size);
    return Math.min(1 - min, Math.max(min, pos / size));
  };
  return (
    <div
      className={`split ${dir}`}
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      title="Drag to resize · double-click to even out"
      onPointerDown={(e) => {
        e.preventDefault();
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
        document.body.classList.add(`resizing-${dir}`);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        moved.current = true;
        e.currentTarget.parentElement!.style.setProperty(prop, String(share(e)));
      }}
      onPointerUp={(e) => {
        // A click without a drag leaves it where it is (and lets a double-click land).
        if (e.currentTarget.hasPointerCapture(e.pointerId) && moved.current) onChange(share(e));
      }}
      onLostPointerCapture={(e) => {
        e.currentTarget.classList.remove('dragging');
        document.body.classList.remove(`resizing-${dir}`);
      }}
      onDoubleClick={(e) => {
        e.currentTarget.parentElement!.style.setProperty(prop, '0.5');
        onChange(0.5);
      }}
    />
  );
}
