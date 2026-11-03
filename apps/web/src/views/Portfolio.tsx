import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { Empty } from '../components.tsx';
import { isQuote, useDaemon, useQuotes } from '../feeds.ts';
import { age, clock, money } from '../format.ts';
import type { ViewProps } from '../functions.ts';

interface Pos {
  source: string;
  accountExternalId: string;
  rawSymbol: string;
  name?: string;
  quantity: number;
  price?: number;
  value: number;
  currency: string;
  asOf?: string;
  method: string;
  fetchedAt: string;
}
interface Bal {
  source: string;
  accountExternalId: string;
  cash?: number;
  total: number;
  currency: string;
  method: string;
  fetchedAt: string;
}

/** PORT (SPEC §5, §7.6): values in their own currency, totals in USD at the PTAX fixing. */
export default function Portfolio({ nav }: ViewProps) {
  const { jobs } = useDaemon();
  const [positions, setPositions] = useState<Pos[] | null>(null);
  const [balances, setBalances] = useState<Bal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastFinished = jobs.find((j) => j.status === 'ok')?.id;
  useEffect(() => {
    get<Pos[]>('/api/positions').then(setPositions, (e) => setError((e as Error).message));
    get<Bal[]>('/api/balances').then(setBalances, () => {});
  }, [lastFinished]);
  const fx = useQuotes(['USDBRL Curncy']).get('USDBRL Curncy');
  const usdbrl = isQuote(fx) ? fx.last : undefined;
  const toUsd = (v: number, ccy: string) => (ccy === 'USD' ? v : ccy === 'BRL' && usdbrl ? v / usdbrl : undefined);

  if (error) return <Empty>{error}</Empty>;
  if (!positions) return <Empty>Loading positions…</Empty>;
  if (positions.length === 0 && balances.length === 0) {
    return (
      <Empty>
        No positions yet. Accounts arrive as their sources are built and signed in: see SRC, then LOGIN &lt;source&gt;.
      </Empty>
    );
  }

  const byCcy = new Map<string, number>();
  for (const p of positions) byCcy.set(p.currency, (byCcy.get(p.currency) ?? 0) + p.value);
  for (const b of balances) byCcy.set(b.currency, (byCcy.get(b.currency) ?? 0) + (b.cash ?? 0));
  let usdTotal = 0;
  let unconverted = false;
  for (const [ccy, v] of byCcy) {
    const u = toUsd(v, ccy);
    if (u === undefined) unconverted = true;
    else usdTotal += u;
  }

  return (
    <div className="scroll">
      <div className="port-total">
        <span className="muted">Total</span> <span className="big">{money(usdTotal, 'USD')}</span>
        {unconverted && <span className="warn-t"> (some currencies not converted)</span>}
        {usdbrl && isQuote(fx) && (
          <span className="muted" title={`BCB PTAX fixing ${clock(fx.asOf)}`}>
            {' '}
            · USDBRL {usdbrl.toFixed(4)} PTAX {clock(fx.asOf)}
          </span>
        )}
        {[...byCcy].map(([ccy, v]) => (
          <span key={ccy} className="muted">
            {' '}
            · {money(v, ccy)}
          </span>
        ))}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Source</th>
            <th>Account</th>
            <th>Symbol</th>
            <th className="r">Qty</th>
            <th className="r">Price</th>
            <th className="r">Value</th>
            <th className="r">USD</th>
            <th className="r">As of</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => (
            <tr key={i} title={`${p.source} via ${p.method}, fetched ${new Date(p.fetchedAt).toLocaleString()}`} onClick={() => nav.message(p.name ?? p.rawSymbol)}>
              <td className="muted">{p.source}</td>
              <td className="muted">{p.accountExternalId}</td>
              <td className="sec">{p.rawSymbol}</td>
              <td className="r">{p.quantity.toLocaleString('en-US')}</td>
              <td className="r">{p.price !== undefined ? p.price.toFixed(2) : '—'}</td>
              <td className="r">{money(p.value, p.currency)}</td>
              <td className="r">{money(toUsd(p.value, p.currency))}</td>
              <td className="r muted">{p.asOf ? clock(p.asOf) : age(p.fetchedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
