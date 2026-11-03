import type { Quote } from '@bloomterm/core/web';
import { useTheme, type Theme } from './theme.ts';
import type { ReactNode } from 'react';
import { isQuote, type QuoteResult } from './feeds.ts';
import { pct, price, provenance, tone } from './format.ts';
import { Icon, type IconName } from './icons.tsx';
import { Link, secPath } from './router.tsx';

// The pieces pages are built from: cards, chips, sparklines, the heatmap.

export const ticker = (key: string) => key.split(' ')[0]!;

export function Card({ title, sub, icon, actions, children, className = '', id }: { title?: ReactNode; sub?: ReactNode; icon?: IconName; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} aria-label={typeof title === 'string' ? title : undefined} id={id}>
      {(title || actions) && (
        <header className="ch">
          {icon && <Icon name={icon} size={14} className={icon === 'spark' ? 'amber' : ''} />}
          {title && <span className="ct">{title}</span>}
          {sub && <span className="mut cs">{sub}</span>}
          {actions && <span className="ca">{actions}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="phead">
      <h1>{title}</h1>
      {sub && <span className="mut">{sub}</span>}
      {children && <div className="pactions">{children}</div>}
    </div>
  );
}

/** A sparkline of closes; colored by the move over the period unless `tone` says otherwise. */
export function Spark({ closes, height = 22, toneOf }: { closes?: number[]; height?: number; toneOf?: number }) {
  if (!closes || closes.length < 2) return <span className="spark empty" style={{ height }} />;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((v, i) => `${((i * 100) / (closes.length - 1)).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  const t = toneOf ?? closes.at(-1)! - closes[0]!;
  return (
    <svg className={`spark ${t > 0 ? 'up' : t < 0 ? 'dn' : ''}`} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}

/** A change, colored, with its provenance on hover. */
export function Chg({ q, abs }: { q: QuoteResult | undefined; abs?: boolean }) {
  if (!isQuote(q)) return <span className="m mut">—</span>;
  return (
    <span className={`m ${cls(q.changePct)}`} title={provenance(q)}>
      {abs ? signedAbs(q) : pct(q.changePct)}
    </span>
  );
}

const signedAbs = (q: Quote) => (q.change === undefined ? '—' : `${q.change > 0 ? '+' : ''}${price(q.change, q.key)}`);
export const cls = (v: number | undefined) => (tone(v) === 'down' ? 'dn' : tone(v));

/** A ticker that links to its page. */
export function SecLink({ k, children, className = '' }: { k: string; children?: ReactNode; className?: string }) {
  return (
    <Link to={secPath(k)} className={`seclink ${className}`} title={k}>
      {children ?? ticker(k)}
    </Link>
  );
}

/** A security chip with today's move, for tags on news. */
export function SecChip({ k, q }: { k: string; q?: QuoteResult }) {
  return (
    <Link to={secPath(k)} className="chip m" title={k}>
      {ticker(k)} {isQuote(q) && q.changePct !== undefined && <span className={cls(q.changePct)}>{pct(q.changePct)}</span>}
    </Link>
  );
}

export const Dot = ({ tone: t }: { tone: 'up' | 'dn' | 'amber' | 'mut' }) => <span className={`dot ${t}`} />;

// ---- heatmap: a squarified treemap, sized by weight, colored by the day's move ----

export interface HeatItem {
  key: string;
  weight: number;
  changePct?: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function squarify(items: HeatItem[], box: Rect): (HeatItem & Rect)[] {
  const total = items.reduce((a, b) => a + b.weight, 0) || 1;
  const scaled = items.map((i) => ({ ...i, area: (i.weight / total) * box.w * box.h })).sort((a, b) => b.area - a.area);
  const out: (HeatItem & Rect)[] = [];
  let rest = { ...box };
  let row: typeof scaled = [];
  const worst = (r: typeof scaled, side: number) => {
    const s = r.reduce((a, b) => a + b.area, 0);
    const max = Math.max(...r.map((x) => x.area));
    const min = Math.min(...r.map((x) => x.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const lay = (r: typeof scaled) => {
    const s = r.reduce((a, b) => a + b.area, 0);
    const horizontal = rest.w >= rest.h;
    const thick = horizontal ? s / rest.h : s / rest.w;
    let off = 0;
    for (const x of r) {
      const len = x.area / thick;
      out.push(horizontal ? { ...x, x: rest.x, y: rest.y + off, w: thick, h: len } : { ...x, x: rest.x + off, y: rest.y, w: len, h: thick });
      off += len;
    }
    rest = horizontal ? { x: rest.x + thick, y: rest.y, w: rest.w - thick, h: rest.h } : { x: rest.x, y: rest.y + thick, w: rest.w, h: rest.h - thick };
  };
  for (const item of scaled) {
    const side = Math.min(rest.w, rest.h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else {
      lay(row);
      row = [item];
    }
  }
  if (row.length) lay(row);
  return out;
}

/** Diverging color: grey at 0, full green or red at ±3%. Light keeps the grey mid-tone so white text reads. */
function heatColor(p: number | undefined, theme: Theme): string {
  const base = theme === 'dark' ? [32, 37, 45] : [134, 142, 153];
  if (p === undefined) return `rgb(${base.join(',')})`;
  const t = Math.min(Math.abs(p) / 3, 1);
  const [r, g, b] = theme === 'dark' ? (p >= 0 ? [27, 122, 84] : [168, 52, 58]) : p >= 0 ? [8, 128, 84] : [200, 45, 50];
  const mix = (a: number, z: number) => Math.round(a + (z - a) * (0.25 + 0.75 * t));
  return `rgb(${mix(base[0]!, r)},${mix(base[1]!, g)},${mix(base[2]!, b)})`;
}

export function Heatmap({ items, height = 260 }: { items: HeatItem[]; height?: number }) {
  const { theme } = useTheme();
  if (!items.length) return <div className="empty">Nothing to show yet.</div>;
  // Laid out for a box about twice as wide as it is tall, then stretched to the card.
  const W = 220;
  const cells = squarify(items.filter((i) => i.weight > 0), { x: 0, y: 0, w: W, h: 100 });
  return (
    <div className="heat" style={{ height }} role="list" aria-label="Heatmap">
      {cells.map((c) => (
        <Link
          key={c.key}
          to={secPath(c.key)}
          role="listitem"
          className="hcell"
          title={`${c.key} ${pct(c.changePct)}`}
          style={{ left: `${(c.x / W) * 100}%`, top: `${c.y}%`, width: `${(c.w / W) * 100}%`, height: `${c.h}%`, background: heatColor(c.changePct, theme) }}
        >
          {c.w * c.h > 120 && (
            <>
              <b>{ticker(c.key)}</b>
              <span className="m">{pct(c.changePct)}</span>
            </>
          )}
        </Link>
      ))}
    </div>
  );
}
