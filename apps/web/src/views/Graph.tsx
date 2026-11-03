import { RANGES, type Range } from '@bloomterm/core/web';
import { Empty, PriceChart, Tick } from '../components.tsx';
import { isQuote, useChartBars, useQuotes } from '../feeds.ts';
import { age, delayLabel, pct, price, provenance, signed, tone } from '../format.ts';
import type { ViewProps } from '../functions.ts';

export default function Graph({ panel, nav }: ViewProps) {
  const key = panel.security!;
  const arg = panel.args[0]?.toUpperCase();
  const range: Range = (RANGES as readonly string[]).includes(arg ?? '') ? (arg as Range) : '1Y';
  const q = useQuotes([key]).get(key);
  const { series, bars, error, loading, older } = useChartBars(key, range);

  return (
    <div className="gp">
      <div className="gp-head">
        {isQuote(q) ? (
          <>
            <Tick value={q.last} className="val" title={provenance(q)}>
              {price(q.last, key)}
            </Tick>
            <span className={tone(q.change)}>
              {signed(q.change, key.endsWith('Curncy') ? 4 : 2)} {pct(q.changePct)}
            </span>
            <span className="badge" title={provenance(q)}>
              {delayLabel(q)}
            </span>
          </>
        ) : (
          <span className="muted">{q?.error ?? '…'}</span>
        )}
        <span className="spacer" />
        {series && (
          <span className="muted" title={`fetched ${new Date(series.fetchedAt).toLocaleString()}`}>
            {bars.length} {series.interval === '5m' ? '5-min bars' : 'bars'} · {series.source} · {age(series.fetchedAt)}
            {series.stale && ' ↯'}
          </span>
        )}
      </div>
      <div className="gp-chart">
        {series && bars.length > 1 ? (
          <PriceChart bars={bars} mode="candles" smas={[50, 200]} intraday={series.interval === '5m'} onOlder={older} viewKey={`${series.key}|${series.range}`} />
        ) : (
          <Empty>{loading ? `Loading ${key} ${range}…` : (error ?? 'no bars for this range')}</Empty>
        )}
      </div>
      <div className="ranges">
        {RANGES.map((r) => (
          <button key={r} className={r === range ? 'on' : ''} onClick={() => nav.setArgs([r])}>
            {r}
          </button>
        ))}
        <span className="spacer" />
        <span className="legend">
          <i style={{ background: 'var(--link)' }} /> SMA50 <i style={{ background: 'var(--violet)' }} /> SMA200
        </span>
      </div>
    </div>
  );
}
