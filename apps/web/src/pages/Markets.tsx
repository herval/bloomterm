import { MARKET_STRIP, parseSecurity } from '@bloomterm/core/web';
import { useState } from 'react';
import { Empty, useNow } from '../components.tsx';
import { useSparks } from '../data.ts';
import { isQuote, useQuotes, useUiState } from '../feeds.ts';
import { age, compact, delayLabel, price, provenance, signed } from '../format.ts';
import { Icon } from '../icons.tsx';
import { DEFAULT_WATCHLISTS, type Watchlists } from '../layout.ts';
import { isOld } from '../markets.ts';
import { Link, secPath, setQuery, type Route } from '../router.tsx';
import { useShell } from '../shell.ts';
import { Card, Chg, Heatmap, PageHead, Spark, ticker } from '../ui.tsx';

// Markets: your watchlists as tables you can edit, a heatmap of the current list, and the
// markets strip. Lists are kept in bloomd, shared with the terminal's W.

export default function Markets({ route }: { route: Route }) {
  const shell = useShell();
  const [lists, setLists] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const name = route.query.get('list') && lists.lists[route.query.get('list')!] ? route.query.get('list')! : lists.current;
  const keys = lists.lists[name] ?? [];
  const quotes = useQuotes([...keys, ...MARKET_STRIP]);
  const spark = useSparks(keys);
  const now = useNow(10_000);
  const [adding, setAdding] = useState('');

  const save = (next: string[], list = name) => setLists({ ...lists, current: list, lists: { ...lists.lists, [list]: next } });
  const add = () => {
    const sec = parseSecurity(adding);
    if (!sec) return shell.toast(`Can't tell which security "${adding}" is. Type a ticker: PETR4, AAPL, BTC, USDBRL.`, 'error');
    if (keys.includes(sec.key)) return shell.toast(`${ticker(sec.key)} is on ${name} already`);
    save([...keys, sec.key]);
    setAdding('');
  };
  const move = (i: number, d: number) => {
    const next = [...keys];
    const [x] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, x!);
    save(next);
  };
  const [naming, setNaming] = useState<string | null>(null);
  const newList = (n: string) => {
    setNaming(null);
    if (!n.trim() || lists.lists[n.trim()]) return;
    setLists({ current: n.trim(), lists: { ...lists.lists, [n.trim()]: [] } });
    setQuery({ list: n.trim() });
  };

  return (
    <div className="marketspage">
      <PageHead title="Markets" sub="your watchlists">
        <span className="seg" role="tablist" aria-label="Watchlists">
          {Object.keys(lists.lists).map((n) => (
            <button
              key={n}
              role="tab"
              aria-selected={n === name}
              className={n === name ? 'on' : ''}
              onClick={() => {
                setLists({ ...lists, current: n });
                setQuery({ list: n === lists.current ? null : n });
              }}
            >
              {n} <span className="mut">{lists.lists[n]!.length}</span>
            </button>
          ))}
        </span>
        {naming === null ? (
          <button className="btn" onClick={() => setNaming('')}>
            <Icon name="plus" size={14} /> List
          </button>
        ) : (
          <form
            className="addform"
            onSubmit={(e) => {
              e.preventDefault();
              newList(naming);
            }}
          >
            <input autoFocus aria-label="New list name" placeholder="Name the list" value={naming} onChange={(e) => setNaming(e.target.value)} onBlur={() => !naming && setNaming(null)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
          </form>
        )}
      </PageHead>
      <div className="cols">
        <Card
          title={name}
          className="grow2 wl"
          actions={
            <form
              className="addform"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <input aria-label="Add a security" placeholder="Add: PETR4, AAPL, BTC…" value={adding} onChange={(e) => setAdding(e.target.value)} />
              <button className="btn sm" type="submit">
                Add
              </button>
            </form>
          }
        >
          {keys.length === 0 ? (
            <Empty>Empty. Add a ticker above.</Empty>
          ) : (
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Security</th>
                    <th className="hide-s">1M</th>
                    <th className="r">Last</th>
                    <th className="r">Chg</th>
                    <th className="r">Chg %</th>
                    <th className="r hide-s">Volume</th>
                    <th className="r hide-s">Source</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k, i) => {
                    const q = quotes.get(k);
                    const old = isQuote(q) && isOld(q, parseSecurity(k));
                    return (
                      <tr key={k}>
                        <td>
                          <Link to={secPath(k)} className="tk">
                            {ticker(k)}
                          </Link>{' '}
                          <span className="mut small name">{isQuote(q) ? q.name ?? '' : q && 'error' in q ? q.error : ''}</span>
                        </td>
                        <td className="hide-s sparkcell">
                          <Spark closes={spark(k)} height={20} />
                        </td>
                        <td className={`r m ${old ? 'mut' : ''}`} title={isQuote(q) ? provenance(q) : undefined}>
                          {isQuote(q) ? price(q.last, k) : '—'}
                        </td>
                        <td className="r">{isQuote(q) ? <span className={`m ${q.change! > 0 ? 'up' : q.change! < 0 ? 'dn' : ''}`}>{signed(q.change, k.endsWith('Curncy') ? 4 : 2)}</span> : ''}</td>
                        <td className="r">
                          <Chg q={q} />
                        </td>
                        <td className="r m hide-s">{isQuote(q) ? compact(q.volume) : ''}</td>
                        <td className="r mut small hide-s">{isQuote(q) ? (old ? `${age(q.asOf, now)} ago` : delayLabel(q)) : ''}</td>
                        <td className="r rowtools">
                          <button className="btn xs ghost" aria-label={`Move ${ticker(k)} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                            ↑
                          </button>
                          <button className="btn xs ghost" aria-label={`Remove ${ticker(k)}`} onClick={() => save(keys.filter((x) => x !== k))}>
                            <Icon name="close" size={11} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="seccol side">
          <Card title="Heatmap" sub={`${name} · today`}>
            <Heatmap items={keys.filter((k) => isQuote(quotes.get(k))).map((k) => ({ key: k, weight: 1, changePct: (quotes.get(k) as any).changePct }))} height={240} />
          </Card>
          <Card title="Markets">
            <div className="rows">
              {MARKET_STRIP.map((k) => {
                const q = quotes.get(k);
                return (
                  <Link key={k} to={secPath(k)} className="row">
                    <span className="tk">{ticker(k)}</span>
                    <span className="mut small grow">{isQuote(q) ? q.name ?? '' : ''}</span>
                    <span className="m num">{isQuote(q) ? price(q.last, k) : '—'}</span>
                    <span className="num">
                      <Chg q={q} />
                    </span>
                  </Link>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
