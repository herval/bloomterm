import { parseSecurity } from '@bloomterm/core/web';
import { AgeChip, Empty, PriceChart, Tick } from '../components.tsx';
import { isQuote, useBars, useQuotes } from '../feeds.ts';
import { clock, compact, delayLabel, pct, price, provenance, signed, tone } from '../format.ts';
import type { ViewProps } from '../functions.ts';
import { isOld } from '../markets.ts';

const BASIS = { prev_close: 'vs prev close', '24h': 'vs 24h ago', prev_fixing: 'vs prev fixing' } as const;

export default function Overview({ panel }: ViewProps) {
  const key = panel.security!;
  const sec = parseSecurity(key);
  const q = useQuotes([key]).get(key);
  const { series } = useBars(key, '6M');

  if (!q) return <Empty>Loading {key}…</Empty>;
  if (!isQuote(q)) return <Empty>{q.error}</Empty>;
  const old = isOld(q, sec);

  return (
    <div className="ov">
      <div className="ov-head">
        <div className="ov-name">{q.name ?? q.symbol}</div>
        <div className="ov-quote">
          <Tick value={q.last} className={`big ${old ? 'dim' : ''}`} title={provenance(q)}>
            {price(q.last, key)}
          </Tick>
          <span className={`big-chg ${tone(q.change)}`}>
            {signed(q.change, key.endsWith('Curncy') ? 4 : 2)} {pct(q.changePct)}
          </span>
          <span className="muted">{q.changeBasis ? BASIS[q.changeBasis] : ''}</span>
          <span className="spacer" />
          <span className="badge" title={provenance(q)}>
            {delayLabel(q)} {q.stale && '↯'}
          </span>
          {old && <AgeChip iso={q.asOf} stale={q.stale} />}
        </div>
      </div>
      <dl className="kv">
        <dt>Open</dt>
        <dd>{price(q.open, key)}</dd>
        <dt>High</dt>
        <dd>{price(q.high, key)}</dd>
        <dt>Low</dt>
        <dd>{price(q.low, key)}</dd>
        <dt>Prev</dt>
        <dd>{price(q.prevClose, key)}</dd>
        <dt>Volume</dt>
        <dd>{compact(q.volume)}</dd>
        <dt>Currency</dt>
        <dd>{q.currency ?? '—'}</dd>
        <dt>As of</dt>
        <dd>{clock(q.asOf)}</dd>
        <dt>Fetched</dt>
        <dd>{clock(q.fetchedAt)}</dd>
      </dl>
      {q.stale && <div className="warn">↯ {q.error}</div>}
      <div className="ov-chart">{series && series.bars.length > 1 ? <PriceChart bars={series.bars} mode="area" /> : <Empty>no history</Empty>}</div>
    </div>
  );
}
