import { benchmarkOf, parseSecurity, RANGES, type NewsItem, type Range } from '@bloomterm/core/web';
import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Empty, PriceChart, Tick, useNow, type ChartMarker } from '../components.tsx';
import { useHoldings, useNews, useWhy, type Insight } from '../data.ts';
import { isQuote, useChartBars, useQuotes, useUiState } from '../feeds.ts';
import { age, clock, compact, delayLabel, money, pct, price, provenance, signed } from '../format.ts';
import { Icon } from '../icons.tsx';
import { DEFAULT_WATCHLISTS, type Watchlists } from '../layout.ts';
import { isOld } from '../markets.ts';
import { Link, setQuery, type Route } from '../router.tsx';
import { useShell } from '../shell.ts';
import { Card, Chg, cls, SecChip, ticker } from '../ui.tsx';

// A security's page (/s/PETR4): price and chart with the news on it, why it moved today,
// your position, key stats, and its news and filings.

const BASIS = { prev_close: 'vs prev close', '24h': 'vs 24h ago', prev_fixing: 'vs prev fixing' } as const;
// 1D needs no change of its own: it's today's, beside the price.
const PERIOD: Record<Exclude<Range, '1D'>, string> = {
  '5D': 'past 5 days',
  '1M': 'past month',
  '3M': 'past 3 months',
  '6M': 'past 6 months',
  YTD: 'year to date',
  '1Y': 'past year',
  '5Y': 'past 5 years',
  MAX: 'all time',
};

const sessionDay = (bars: { t: number }[]) =>
  bars.length ? new Date(bars.at(-1)!.t * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'no trades yet';

export default function Security({ route }: { route: Route }) {
  const sec = parseSecurity(route.parts[1] ?? '');
  if (!sec) return <Empty>Can't tell which security "{route.parts[1]}" is. Try a ticker like PETR4 or AAPL.</Empty>;
  return <SecurityPage key={sec.key} k={sec.key} route={route} />;
}

function SecurityPage({ k, route }: { k: string; route: Route }) {
  const sec = parseSecurity(k)!;
  const shell = useShell();
  const range = (RANGES as readonly string[]).includes(route.query.get('range') ?? '') ? (route.query.get('range') as Range) : '6M';
  const [mode, setMode] = useState<'candles' | 'line'>('candles');
  const [smas, setSmas] = useState(false);
  const [showNews, setShowNews] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);
  const bench = benchmarkOf(k);
  const quotes = useQuotes(bench ? [k, bench] : [k]);
  const q = quotes.get(k);
  const { series, bars, loading, error, older } = useChartBars(k, range);
  const intraday = range === '1D';
  const news = useNews({ security: k, limit: '120' });
  const [lists, setLists] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const watched = Object.values(lists.lists).some((l) => l.includes(k));
  const current = lists.lists[lists.current] ?? [];
  const toggleWatch = () => {
    const next = watched
      ? Object.fromEntries(Object.entries(lists.lists).map(([n, l]) => [n, l.filter((x) => x !== k)]))
      : { ...lists.lists, [lists.current]: [...current, k] };
    setLists({ ...lists, lists: next });
    shell.toast(watched ? `Removed ${ticker(k)} from your watchlists` : `Added ${ticker(k)} to ${lists.current}`);
  };

  const markers: ChartMarker[] = useMemo(
    () => (showNews ? (news.data ?? []).map((n) => ({ id: n.id, t: Date.parse(n.ts) / 1000, kind: n.kind, label: n.headline })) : []),
    [showNews, news.data],
  );
  const old = isQuote(q) ? isOld(q, sec) : false;
  // The change over the chart's range: from the first bar's open (about where it stood when the
  // range began) to the latest price.
  const first = series?.range === range && range !== '1D' ? series.bars[0] : undefined;
  const base = first ? first.o || first.c : undefined;
  const periodChange = isQuote(q) && base ? q.last - base : undefined;
  const decimals = k.endsWith('Curncy') ? 4 : 2;

  return (
    <div className="secpage">
      <div className="sechead">
        <div className="sh-left">
          <div className="sh-title">
            <h1>{ticker(k)}</h1>
            <span className="mut">{isQuote(q) ? q.name ?? '' : ''}</span>
            <span className="chip">{sec.market ? `${sec.market === 'BZ' ? 'B3' : 'US'} · ${sec.sector}` : sec.sector}</span>
            {isQuote(q) && (
              <span className="chip m" title={provenance(q)}>
                {delayLabel(q)}
                {q.stale ? ' · stale' : ''}
              </span>
            )}
          </div>
          {isQuote(q) ? (
            <div className="sh-price">
              <Tick value={q.last} className={`m huge ${old ? 'mut' : ''}`} title={provenance(q)}>
                {price(q.last, k)}
              </Tick>
              <span className={`m ${cls(q.change)}`}>
                {signed(q.change, decimals)} ({pct(q.changePct)})
              </span>
              <span className="mut small">
                {q.changeBasis ? BASIS[q.changeBasis] : ''} · {old ? `as of ${age(q.asOf)} ago` : clock(q.asOf)}
              </span>
              {periodChange !== undefined && base !== undefined && (
                <span className="sh-period" aria-label="Change over the range">
                  <span className={`m ${cls(periodChange)}`}>
                    {signed(periodChange, decimals)} ({pct((periodChange / base) * 100)})
                  </span>
                  <span className="mut small">{PERIOD[range as Exclude<Range, '1D'>]}</span>
                </span>
              )}
            </div>
          ) : (
            <div className="sh-price mut">{q ? q.error : 'Loading…'}</div>
          )}
        </div>
        <div className="pactions">
          <button className={`btn ${watched ? 'on' : ''}`} onClick={toggleWatch}>
            <Icon name="star" size={14} /> {watched ? 'Watching' : 'Watch'}
          </button>
          <button className="btn" onClick={() => void shell.ask(`Tell me about ${k}: how it's doing, and what's driving it.`, { fresh: true })}>
            <Icon name="spark" size={14} className="amber" /> Ask about {ticker(k)}
          </button>
        </div>
      </div>

      <div className="secgrid">
        <div className="seccol">
          <Card
            title="Price"
            className="chartcard"
            actions={
              <>
                <span className="seg" role="group" aria-label="Range">
                  {RANGES.map((r) => (
                    <button key={r} className={r === range ? 'on' : ''} onClick={() => setQuery({ range: r === '6M' ? null : r })}>
                      {r}
                    </button>
                  ))}
                </span>
                <span className="seg" role="group" aria-label="Chart">
                  <button className={mode === 'candles' ? 'on' : ''} onClick={() => setMode('candles')}>
                    Candles
                  </button>
                  <button className={mode === 'line' ? 'on' : ''} onClick={() => setMode('line')}>
                    Line
                  </button>
                </span>
                {!intraday && (
                  <button className={`btn xs ${smas ? 'on' : ''}`} onClick={() => setSmas(!smas)} title="Moving averages, 50 and 200 days">
                    SMA
                  </button>
                )}
                <button className={`btn xs ${showNews ? 'on' : ''}`} onClick={() => setShowNews(!showNews)} title="News and filings on the chart">
                  News
                </button>
              </>
            }
          >
            <div className="bigchart">
              {series && bars.length > 1 ? (
                <PriceChart
                  bars={bars}
                  mode={mode}
                  smas={smas ? [50, 200] : []}
                  markers={markers}
                  onMarker={(id) => setFocus(id)}
                  intraday={series.interval === '5m'}
                  onOlder={older}
                  viewKey={`${series.key}|${series.range}`}
                />
              ) : (
                <Empty>{loading ? 'Loading…' : error ?? 'No history for this range.'}</Empty>
              )}
            </div>
            <div className="legend">
              {smas && !intraday && (
                <>
                  <span>
                    <i className="sw blue" /> SMA 50
                  </span>
                  <span>
                    <i className="sw violet" /> SMA 200
                  </span>
                </>
              )}
              {showNews && (
                <>
                  <span>
                    <i className="sw dotb" /> news
                  </span>
                  <span>
                    <i className="sw sqv" /> filing
                  </span>
                </>
              )}
              {series && (
                <span className="mut">
                  {series.source} · {series.interval === '5m' ? `5-min bars, ${sessionDay(series.bars)}` : `${bars.length} days`}
                </span>
              )}
            </div>
          </Card>
          <NewsList items={news.data ?? []} loading={news.loading} focus={focus} k={k} />
        </div>
        <div className="seccol side">
          <Why k={k} bench={bench} benchQ={bench ? quotes.get(bench) : undefined} />
          <YourPosition k={k} />
          <Card title="Key stats">
            {isQuote(q) ? (
              <dl className="stats">
                <dt>Open</dt>
                <dd className="m">{price(q.open, k)}</dd>
                <dt>Day high</dt>
                <dd className="m">{price(q.high, k)}</dd>
                <dt>Day low</dt>
                <dd className="m">{price(q.low, k)}</dd>
                <dt>Prev close</dt>
                <dd className="m">{price(q.prevClose, k)}</dd>
                <dt>Volume</dt>
                <dd className="m">{compact(q.volume)}</dd>
                <dt>Currency</dt>
                <dd>{q.currency ?? '—'}</dd>
                <dt>Source</dt>
                <dd title={provenance(q)}>
                  {q.source} · {q.method}
                </dd>
                <dt>Fetched</dt>
                <dd className="m">{clock(q.fetchedAt)}</dd>
              </dl>
            ) : (
              <Empty>No quote.</Empty>
            )}
            {isQuote(q) && q.stale && <div className="warnline">Stale: {q.error}</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Why({ k, bench, benchQ }: { k: string; bench: string | null; benchQ: ReturnType<ReturnType<typeof useQuotes>['get']> }) {
  const { data } = useWhy([k]);
  const shell = useShell();
  const w = data?.[k] as Insight | null | undefined;
  const go = () => void api('POST', '/api/why', { key: k }).catch((err) => shell.toast((err as Error).message, 'error'));
  return (
    <Card
      title="Why it moved"
      icon="spark"
      className="whycard"
      actions={
        <button className="btn xs" onClick={go} disabled={w?.status === 'running'}>
          {w ? 'Again' : 'Explain'}
        </button>
      }
    >
      <div className="pad">
        {!w && <span className="mut">Your agent reads today's news on {ticker(k)} and compares it with {bench ? ticker(bench) : 'the market'}.</span>}
        {w?.status === 'running' && <span className="mut thinking">Looking at the news and the market▍</span>}
        {w?.status === 'error' && <span className="err">{w.error}</span>}
        {w?.status === 'done' && <p>{w.text}</p>}
        {bench && (
          <div className="mut small">
            {ticker(bench)} today <Chg q={benchQ} />
          </div>
        )}
      </div>
    </Card>
  );
}

function YourPosition({ k }: { k: string }) {
  const { positions } = useHoldings();
  const mine = positions.filter((p) => parseSecurity(p.rawSymbol)?.key === k);
  if (!mine.length) return null;
  const qty = mine.reduce((a, p) => a + p.quantity, 0);
  const value = mine.reduce((a, p) => a + p.value, 0);
  const cost = mine.every((p) => p.costBasis !== undefined) ? mine.reduce((a, p) => a + p.costBasis!, 0) : undefined;
  const ccy = mine[0]!.currency;
  return (
    <Card title="Your position" sub={`${mine.length} account${mine.length > 1 ? 's' : ''}`}>
      <dl className="stats">
        <dt>Quantity</dt>
        <dd className="m">{qty.toLocaleString('en-US')}</dd>
        <dt>Value</dt>
        <dd className="m">{money(value, ccy)}</dd>
        {cost !== undefined && (
          <>
            <dt>Cost</dt>
            <dd className="m">{money(cost, ccy)}</dd>
            <dt>Gain</dt>
            <dd className={`m ${cls(value - cost)}`}>
              {money(value - cost, ccy)} ({pct(cost ? ((value - cost) / cost) * 100 : undefined)})
            </dd>
          </>
        )}
        {mine.map((p) => (
          <FragmentRow key={`${p.source}|${p.accountExternalId}`} label={p.source} value={`${p.quantity.toLocaleString('en-US')} · ${age(p.fetchedAt)} ago`} />
        ))}
      </dl>
    </Card>
  );
}

const FragmentRow = ({ label, value }: { label: string; value: string }) => (
  <>
    <dt className="mut">{label}</dt>
    <dd className="mut small">{value}</dd>
  </>
);

function NewsList({ items, loading, focus, k }: { items: NewsItem[]; loading: boolean; focus: string | null; k: string }) {
  const now = useNow(60_000);
  const shown = focus ? [...items.filter((i) => i.id === focus), ...items.filter((i) => i.id !== focus)] : items;
  const others = [...new Set(items.flatMap((i) => i.tags.map((t) => t.security)))].filter((x) => x !== k).slice(0, 12);
  const quotes = useQuotes(others);
  return (
    <Card title="News and filings" sub={`tagged ${ticker(k)}`} actions={<Link to={`/news?security=${encodeURIComponent(k)}`} className="lnk">Open in News</Link>}>
      {loading && !items.length && <Empty>Loading…</Empty>}
      {!loading && !items.length && <Empty>Nothing tagged {ticker(k)} yet. News arrives every few minutes from the feeds in Sources.</Empty>}
      {shown.slice(0, 30).map((n) => (
        <div key={n.id} className={`newsrow ${n.id === focus ? 'sel' : ''}`}>
          <span className="meta">
            <span className="m">{age(n.ts, now)}</span>
            {n.kind === 'filing' && <Icon name="filing" size={12} className="violet" />}
            <span>{n.outlet}</span>
          </span>
          <a className="st" href={n.url} target="_blank" rel="noreferrer noopener">
            {n.headline} <Icon name="external" size={11} className="mut" />
          </a>
          {n.tags.length > 1 && (
            <span className="chips">
              {n.tags
                .filter((t) => t.security !== k)
                .slice(0, 3)
                .map((t) => (
                  <SecChip key={t.security} k={t.security} q={quotes.get(t.security)} />
                ))}
            </span>
          )}
        </div>
      ))}
    </Card>
  );
}

