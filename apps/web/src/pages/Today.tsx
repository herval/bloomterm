import { MARKET_STRIP, parseSecurity, type NewsStory } from '@bloomterm/core/web';
import { useState } from 'react';
import { api } from '../api.ts';
import { Empty, useNow } from '../components.tsx';
import { useBrief, useHoldings, useSparks, useStories, useWhy, type Balance, type Insight, type Position } from '../data.ts';
import { isQuote, useDaemon, useQuotes, useUiState, type QuoteResult } from '../feeds.ts';
import { age, pct, price } from '../format.ts';
import { Icon } from '../icons.tsx';
import { DEFAULT_WATCHLISTS, type Watchlists } from '../layout.ts';
import { Markdown } from '../markdown.tsx';
import { usePins } from '../pins.ts';
import { Link, navigate, secPath } from '../router.tsx';
import { useShell } from '../shell.ts';
import { Card, Chg, cls, Dot, Heatmap, PageHead, SecChip, SecLink, Spark, ticker } from '../ui.tsx';
import { AnswerWidgets } from '../views/Ask.tsx';

// Today: the default page. Markets, your money, the brief, what moved and why, the news on
// what you own and watch, answers you pinned, and a heatmap of everything you follow.

const NAMES: Record<string, string> = { 'IBOV Index': 'Ibovespa', 'SPY US Equity': 'S&P 500 (SPY)', 'QQQ US Equity': 'Nasdaq 100 (QQQ)', 'USDBRL Curncy': 'USD/BRL', 'BTCUSD Crypto': 'Bitcoin' };

/** Securities you hold (that bloomterm can name) and the value in each, in its own currency. */
export function heldKeys(positions: Position[]): Map<string, { value: number; currency: string }> {
  const out = new Map<string, { value: number; currency: string }>();
  for (const p of positions) {
    const sec = parseSecurity(p.rawSymbol);
    if (!sec) continue;
    const prev = out.get(sec.key);
    out.set(sec.key, { value: (prev?.value ?? 0) + p.value, currency: p.currency });
  }
  return out;
}

export function useUsd() {
  const fx = useQuotes(['USDBRL Curncy']).get('USDBRL Curncy');
  const usdbrl = isQuote(fx) ? fx.last : undefined;
  return (v: number, ccy: string) => (ccy === 'USD' ? v : ccy === 'BRL' && usdbrl ? v / usdbrl : undefined);
}

export default function Today() {
  const now = useNow(30_000);
  const [lists] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const { positions, balances } = useHoldings();
  const held = heldKeys(positions);
  const listKeys = lists.lists[lists.current] ?? [];
  const followed = [...new Set([...held.keys(), ...Object.values(lists.lists).flat()])];
  const quotes = useQuotes([...MARKET_STRIP, ...followed]);
  const spark = useSparks([...MARKET_STRIP, ...followed]);
  const day = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="today">
      <PageHead title="Today" sub={`${day} · ${new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`} />
      <section className="strip" aria-label="Markets at a glance">
        {MARKET_STRIP.map((k) => {
          const q = quotes.get(k);
          return (
            <Link key={k} to={secPath(k)} className="card stat">
              <span className="lbl">{NAMES[k] ?? ticker(k)}</span>
              <span className="sv">
                <span className="m big">{isQuote(q) ? price(q.last, k) : '—'}</span>
                <Chg q={q} />
              </span>
              <Spark closes={spark(k)} height={26} />
            </Link>
          );
        })}
      </section>
      <div className="cols">
        <NetWorth positions={positions} balances={balances} now={now} />
        <Brief known={new Set([...MARKET_STRIP, ...followed].map(ticker))} />
      </div>
      <div className="cols three">
        <Movers keys={followed} quotes={quotes} held={held} spark={spark} />
        <NewsForYou quotes={quotes} />
        <Pinned />
      </div>
      <div className="cols">
        <Card title="Heatmap" sub="what you follow · size by holding, color by today's move" className="grow2">
          <Heatmap items={followed.filter((k) => isQuote(quotes.get(k))).map((k) => ({ key: k, weight: held.get(k)?.value ? Math.sqrt(held.get(k)!.value) : 40, changePct: (quotes.get(k) as any)?.changePct }))} />
        </Card>
        <Card title={`Watchlist: ${lists.current}`} sub={`${listKeys.length}`} actions={<Link to="/markets" className="lnk">Markets</Link>}>
          <div className="rows">
            {listKeys.map((k) => {
              const q = quotes.get(k);
              return (
                <Link key={k} to={secPath(k)} className="row">
                  <span className="tk">{ticker(k)}</span>
                  <Spark closes={spark(k)} />
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
      <SourcesLine />
    </div>
  );
}

function NetWorth({ positions, balances, now }: { positions: Position[]; balances: Balance[]; now: number }) {
  const toUsd = useUsd();
  const quotes = useQuotes(positions.flatMap((p) => parseSecurity(p.rawSymbol)?.key ?? []));
  if (!positions.length && !balances.length) {
    return (
      <Card title="Net worth" className="networth">
        <Empty>
          No accounts yet. Add them in <Link to="/sources">Sources</Link>: bloomterm reads them through your own signed-in browser, read-only.
        </Empty>
      </Card>
    );
  }
  let total = 0;
  let day = 0;
  let missing = false;
  const bySource = new Map<string, { usd: number; at: string }>();
  for (const p of positions) {
    const usd = toUsd(p.value, p.currency);
    if (usd === undefined) {
      missing = true;
      continue;
    }
    total += usd;
    const sec = parseSecurity(p.rawSymbol);
    const q = sec ? quotes.get(sec.key) : undefined;
    if (isQuote(q) && q.changePct !== undefined) day += (usd * q.changePct) / (100 + q.changePct);
    const s = bySource.get(p.source) ?? { usd: 0, at: p.fetchedAt };
    bySource.set(p.source, { usd: s.usd + usd, at: s.at < p.fetchedAt ? s.at : p.fetchedAt });
  }
  for (const b of balances) {
    const usd = toUsd(b.cash ?? 0, b.currency);
    if (usd === undefined) missing = true;
    else total += usd;
  }
  return (
    <Card title="Net worth" sub="all accounts · USD" className="networth">
      <div className="nw">
        <div className="m huge">${Math.round(total).toLocaleString('en-US')}</div>
        <div className={`m ${cls(day)}`}>
          {day >= 0 ? '+' : '−'}${Math.abs(Math.round(day)).toLocaleString('en-US')} ({pct(total ? (day / (total - day)) * 100 : undefined)}) today
        </div>
        {missing && <div className="mut small">Some holdings aren't in USD or BRL, or USD/BRL has no quote: left out.</div>}
      </div>
      <div className="alloc" aria-label="By account">
        {[...bySource].map(([src, s], i) => (
          <span key={src} className={`seg c${i % 5}`} style={{ flex: s.usd }} title={`${src}: $${Math.round(s.usd).toLocaleString('en-US')}`} />
        ))}
      </div>
      <div className="chips">
        {[...bySource].map(([src, s], i) => (
          <span key={src} className="chip">
            <span className={`dot c${i % 5}`} />
            {src} <span className="m mut">{age(s.at, now)}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function Brief({ known }: { known: Set<string> }) {
  const { data, error } = useBrief();
  const shell = useShell();
  const now = useNow(60_000);
  const b = data?.brief;
  const regenerate = () => void api('POST', '/api/brief').catch((err) => shell.toast((err as Error).message, 'error'));
  const today = new Date(now).toLocaleDateString('en-CA');
  return (
    <Card
      title="Brief"
      icon="spark"
      className="brief grow2"
      sub={b ? `${b.key === today ? '' : `${b.key} · `}written ${new Date(b.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}${b.agent ? ` by ${b.agent}` : ''}` : undefined}
      actions={
        <>
          {b?.status === 'done' && (
            <button className="btn sm" onClick={() => void shell.ask(`About today's brief:\n${b.text}\n\nWhat should I look at first, and why?`, { fresh: true })}>
              Follow up
            </button>
          )}
          <button className="btn sm" onClick={regenerate} disabled={b?.status === 'running' || !data?.agent} title={data?.agent ? 'Write it again now' : 'Needs Claude Code or Codex'}>
            <Icon name="refresh" size={13} /> {b ? 'Regenerate' : 'Write it now'}
          </button>
        </>
      }
    >
      <div className="brief-body">
        {error && <Empty>{error}</Empty>}
        {!error && !data?.agent && <Empty>The brief is written by your Claude Code or Codex. Install one and restart bloomd.</Empty>}
        {data?.agent && !b && <Empty>No brief yet. It's written at 07:00 on weekdays, or now if you ask.</Empty>}
        {b?.status === 'running' && <div className="mut thinking">{b.text ? 'Rewriting…' : 'Writing the brief…'}▍</div>}
        {b?.text && <Markdown text={linkTickers(b.text, known)} run={shell.run} />}
        {b?.status === 'error' && <div className="err small">Last try failed: {b.error}</div>}
      </div>
    </Card>
  );
}

/** Tickers you follow, in the agent's prose, become links: PETR4 → `PETR4`, which Markdown renders as a link. */
export function linkTickers(text: string, known: Set<string>): string {
  return text.replace(/(^|[\s(])([A-Z][A-Z0-9.]{1,7})(?=[\s,.;:)]|$)/g, (m, pre: string, t: string) => (known.has(t) ? `${pre}\`${t}\`` : m));
}

function Movers({ keys, quotes, held, spark }: { keys: string[]; quotes: ReadonlyMap<string, QuoteResult>; held: Map<string, { value: number; currency: string }>; spark: (k: string) => number[] | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  const toUsd = useUsd();
  const shell = useShell();
  const movers = keys
    .flatMap((k) => {
      const q = quotes.get(k);
      if (!isQuote(q) || q.changePct === undefined) return [];
      const h = held.get(k);
      const usd = h ? toUsd(h.value, h.currency) : undefined;
      const impact = usd !== undefined ? (usd * q.changePct) / (100 + q.changePct) : undefined;
      return [{ k, q, impact }];
    })
    .sort((a, b) => (b.impact !== undefined || a.impact !== undefined ? Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0) : 0) || Math.abs(b.q.changePct!) - Math.abs(a.q.changePct!))
    .slice(0, 7);
  const why = useWhy(movers.map((m) => m.k));
  const ask = (k: string) =>
    void api('POST', '/api/why', { key: k }).catch((err) => shell.toast((err as Error).message, 'error'));
  return (
    <Card title="Movers" sub="what you hold and watch">
      {movers.length === 0 && <Empty>No quotes yet.</Empty>}
      {movers.map(({ k, q, impact }) => {
        const w = why.data?.[k] as Insight | null | undefined;
        const isOpen = open === k;
        return (
          <div key={k} className="mover">
            <div className="row">
              <SecLink k={k} className="tk" />
              <Spark closes={spark(k)} />
              <span className={`m num ${cls(q.changePct)}`}>{pct(q.changePct)}</span>
              <span className={`m num ${cls(impact)}`}>{impact !== undefined ? `${impact >= 0 ? '+' : '−'}$${Math.abs(Math.round(impact)).toLocaleString('en-US')}` : ''}</span>
              <button
                className={`btn xs why ${isOpen ? 'on' : ''}`}
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? null : k);
                  if (!isOpen && !w) ask(k);
                }}
              >
                Why?
              </button>
            </div>
            {isOpen && (
              <div className="whybox">
                <Icon name="spark" size={12} className="amber" />
                <div>
                  {!w || w.status === 'running' ? <span className="mut thinking">Looking at the news and the market▍</span> : null}
                  {w?.status === 'error' && (
                    <span className="err">
                      {w.error}{' '}
                      <button className="btn xs" onClick={() => ask(k)}>
                        Try again
                      </button>
                    </span>
                  )}
                  {w?.status === 'done' && (
                    <>
                      {w.text}
                      {Array.isArray(w.data.cites) && w.data.cites.length > 0 && (
                        <Link to={`/news?security=${encodeURIComponent(k)}`} className="lnk small">
                          {' '}
                          {w.data.cites.length} source{w.data.cites.length > 1 ? 's' : ''}
                        </Link>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function NewsForYou({ quotes }: { quotes: ReadonlyMap<string, QuoteResult> }) {
  const { data, loading } = useStories({ for: 'me', hours: '48', rank: 'latest', limit: '8' });
  return (
    <Card title="News for you" sub="what you hold and watch" actions={<Link to="/news?f=me" className="lnk">All news</Link>}>
      {loading && !data && <Empty>Loading…</Empty>}
      {data && data.length === 0 && <Empty>No news on what you follow in the last two days.</Empty>}
      {data?.map((s) => <StoryRow key={s.id} s={s} quotes={quotes} />)}
    </Card>
  );
}

export function StoryRow({ s, quotes, selected, onSelect }: { s: NewsStory; quotes: ReadonlyMap<string, QuoteResult>; selected?: boolean; onSelect?: () => void }) {
  const now = useNow(60_000);
  const filing = s.items.every((i) => i.kind === 'filing');
  const go = onSelect ?? (() => navigate(`/news?story=${encodeURIComponent(s.id)}`));
  return (
    <div className={`story ${selected ? 'sel' : ''}`} role="button" tabIndex={0} onClick={go} onKeyDown={(e) => e.key === 'Enter' && go()}>
      <span className="meta">
        <span className="m">{age(s.lastTs, now)}</span>
        {filing && <Icon name="filing" size={12} className="violet" />}
        <span>
          {s.outlets[0]}
          {s.outlets.length > 1 ? ` +${s.outlets.length - 1}` : ''}
        </span>
        {s.by === 'agent' && <Icon name="spark" size={10} className="amber" />}
      </span>
      <span className="st">{s.title}</span>
      {s.tags.length > 0 && (
        <span className="chips" onClick={(e) => e.stopPropagation()}>
          {s.tags.slice(0, 4).map((t) => (
            <SecChip key={t} k={t} q={quotes.get(t)} />
          ))}
        </span>
      )}
    </div>
  );
}

function Pinned() {
  const { pins, remove } = usePins();
  const shell = useShell();
  return (
    <Card title="Pinned" icon="pin" sub="answers from Ask">
      {pins.length === 0 && (
        <Empty>
          Pin an answer from Ask and it stays here. Try <button className="lnkbtn" onClick={() => void shell.ask('How did my portfolio do this week, and what drove it?', { fresh: true })}>how did my portfolio do this week?</button>
        </Empty>
      )}
      {pins.map((p) => (
        <div key={p.id} className="pin">
          <div className="pin-h">
            <span className="pt">{p.title}</span>
            <button className="btn xs" title="Ask it again, fresh" onClick={() => void shell.ask(p.title, { fresh: true })}>
              <Icon name="refresh" size={12} />
            </button>
            <button className="btn xs" title="Unpin" onClick={() => remove(p.id)}>
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="pin-b">
            <Markdown text={p.text} run={shell.run} />
            <AnswerWidgets text={p.text} />
          </div>
        </div>
      ))}
    </Card>
  );
}

function SourcesLine() {
  const { sources, status, connected } = useDaemon();
  const bad = sources.filter((s) => ['needs_login', 'challenge', 'blocked'].includes(s.session.state));
  const ok = sources.filter((s) => s.session.state === 'ok').length;
  return (
    <footer className="pagefoot">
      <span>
        <Dot tone="up" /> {ok} source{ok === 1 ? '' : 's'} signed in
      </span>
      {bad.map((s) => (
        <Link key={s.id} to="/sources" className="amber">
          <Dot tone="amber" /> {s.name}: sign-in needed
        </Link>
      ))}
      <span>Jobs: {status?.running?.length ?? 0} running</span>
      <span className="spacer" />
      <span className={connected ? 'mut' : 'dn'}>{connected ? 'bloomd · localhost' : 'bloomd unreachable'}</span>
    </footer>
  );
}
