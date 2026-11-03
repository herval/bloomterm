import { parseSecurity } from '@bloomterm/core/web';
import { useEffect } from 'react';
import { AgeChip, Tick } from '../components.tsx';
import { isQuote, useQuotes, useUiState } from '../feeds.ts';
import { delayLabel, pct, price, provenance, signed, tone } from '../format.ts';
import type { ViewProps } from '../functions.ts';
import { DEFAULT_WATCHLISTS, type Watchlists } from '../layout.ts';
import { isOld } from '../markets.ts';

export default function Watchlist({ panel, nav, drill }: ViewProps) {
  const [wl, setWl, loaded] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const name = wl.current;
  const keys = wl.lists[name] ?? [];
  const quotes = useQuotes(keys);

  // `W ADD petr4`, `W DEL 3`: run once per command, then drop the args.
  const [verb, ...rest] = panel.args;
  useEffect(() => {
    if (!loaded || !verb) return;
    const v = verb.toUpperCase();
    if (v === 'ADD' && rest.length) {
      const sec = parseSecurity(rest.join(' '));
      if (!sec) nav.message(`"${rest.join(' ')}" isn't a security`, 'error');
      else if (keys.includes(sec.key)) nav.message(`${sec.key} is already on ${name}`);
      else {
        setWl({ ...wl, lists: { ...wl.lists, [name]: [...keys, sec.key] } });
        nav.message(`added ${sec.key} to ${name}`);
      }
    } else if (v === 'DEL' && rest.length) {
      const n = Number(rest[0]);
      const key = keys[n - 1];
      if (!key) nav.message(`no row ${rest[0]}`, 'error');
      else {
        setWl({ ...wl, lists: { ...wl.lists, [name]: keys.filter((_, i) => i !== n - 1) } });
        nav.message(`removed ${key}`);
      }
    } else nav.message('W ADD <security> · W DEL <row>', 'error');
    nav.setArgs([]);
  }, [loaded, panel.args.join(' ')]);

  drill.current = (row) => {
    const key = keys[row - 1];
    if (key) nav.linkSecurity(key);
    else nav.message(`no row ${row}`, 'error');
  };

  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="n">#</th>
          <th>Security</th>
          <th className="r">Last</th>
          <th className="r">Chg</th>
          <th className="r">Chg%</th>
          <th className="r">Src</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key, i) => {
          const q = quotes.get(key);
          const sec = parseSecurity(key);
          if (!isQuote(q)) {
            return (
              <tr key={key} onClick={() => nav.linkSecurity(key)}>
                <td className="n">{i + 1}</td>
                <td className="sec">{key}</td>
                <td colSpan={4} className="err" title={q?.error}>
                  {q ? q.error : '…'}
                </td>
              </tr>
            );
          }
          const old = isOld(q, sec);
          return (
            <tr key={key} onClick={() => nav.linkSecurity(key)} className={old ? 'dim' : ''}>
              <td className="n">{i + 1}</td>
              <td className="sec" title={q.name}>
                {key}
              </td>
              <td className="r">
                <Tick value={q.last} title={provenance(q)}>
                  {price(q.last, key)}
                </Tick>
              </td>
              <td className={`r ${tone(q.change)}`}>{signed(q.change, key.endsWith('Curncy') ? 4 : 2)}</td>
              <td className={`r ${tone(q.change)}`}>{pct(q.changePct)}</td>
              <td className="r src" title={provenance(q)}>
                {old ? <AgeChip iso={q.asOf} stale={q.stale} /> : delayLabel(q)}
              </td>
            </tr>
          );
        })}
        {keys.length === 0 && (
          <tr>
            <td colSpan={6} className="muted">
              Empty. Add one: W ADD aapl
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
