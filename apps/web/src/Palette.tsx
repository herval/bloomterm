import { COMPANIES, fold, MARKET_STRIP, parseCommand, parseSecurity } from '@bloomterm/core/web';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { isQuote, useQuotes, useUiState } from './feeds.ts';
import { pct, price } from './format.ts';
import { FN, FN_SET } from './functions.ts';
import { Icon, type IconName } from './icons.tsx';
import { DEFAULT_WATCHLISTS, type Watchlists } from './layout.ts';
import { shortcut } from './platform.ts';
import { navigate, secPath } from './router.tsx';
import { useShell } from './shell.ts';
import { setThemePref } from './theme.ts';
import { cls, ticker } from './ui.tsx';

// ⌘K: one box for everything. Tickers and company names, pages, questions for Ask, actions,
// and the terminal's mnemonics (PETR4 GP 1Y), which run as they would in a panel.

interface Item {
  id: string;
  group: 'Run' | 'Securities' | 'Go to' | 'Ask' | 'Actions';
  label: ReactNode;
  sub?: string;
  icon: IconName;
  quote?: string;
  hint?: string;
  run: () => void;
}

export const PAGES: { label: string; path: string; icon: IconName; hint?: string; words?: string }[] = [
  { label: 'Today', path: '/', icon: 'today', words: 'home brief' },
  { label: 'Markets', path: '/markets', icon: 'markets', hint: 'W', words: 'watchlist monitor heatmap' },
  { label: 'Portfolio', path: '/portfolio', icon: 'portfolio', hint: 'PORT', words: 'positions balances accounts' },
  { label: 'News', path: '/news', icon: 'news', words: 'headlines filings stories top' },
  { label: 'Ask', path: '/ask', icon: 'spark', hint: 'ASK', words: 'chat question ai' },
  { label: 'Terminal', path: '/terminal', icon: 'terminal', words: 'panels board grid' },
  { label: 'Sources', path: '/sources', icon: 'sources', hint: 'SRC', words: 'integrations login evolve feeds' },
  { label: 'Jobs', path: '/jobs', icon: 'jobs', hint: 'JOBS', words: 'runs failures' },
  { label: 'Settings', path: '/settings', icon: 'settings', hint: 'SET', words: 'api keys keychain credential manager' },
  { label: 'Setup', path: '/setup', icon: 'check', words: 'install chrome claude codex agent sign in first run' },
  { label: 'Help', path: '/help', icon: 'help', hint: 'HELP', words: 'functions keys mnemonics' },
];

const GROUPS: Item['group'][] = ['Run', 'Securities', 'Go to', 'Ask', 'Actions'];

export function Palette({ initial, onClose, followed, held }: { initial: string; onClose: () => void; followed: string[]; held: Set<string> }) {
  const shell = useShell();
  const [text, setText] = useState(initial);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [lists, setLists] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const t = text.trim();
  const folded = fold(t);

  const secs = useMemo(() => {
    if (!t) return followed.slice(0, 5);
    const T = t.toUpperCase();
    const pool = [...new Set([...followed, ...MARKET_STRIP, ...COMPANIES.flatMap((c) => c.keys)])];
    const named = (k: string) => COMPANIES.find((c) => c.keys.includes(k))?.name ?? '';
    const hits = pool.filter((k) => ticker(k).startsWith(T.split(' ')[0]!) || (folded.length > 2 && fold(named(k)).includes(folded)));
    hits.sort((a, b) => Number(followed.includes(b)) - Number(followed.includes(a)) || Number(ticker(b) === T) - Number(ticker(a) === T));
    // What the text parses to (any ticker reads as a US stock) comes after the known matches, so "petr" finds PETR4 first.
    const exact = parseSecurity(t.split(/\s+/).slice(0, 3).join(' ')) ?? parseSecurity(t.split(/\s+/)[0]!);
    const out = exact && !hits.includes(exact.key) ? (hits.length ? [...hits.slice(0, 5), exact.key] : [exact.key]) : hits;
    return out.slice(0, 6);
  }, [t, followed.join(',')]);
  const quotes = useQuotes(secs);

  const items = useMemo(() => {
    const out: Item[] = [];
    const c = parseCommand(t, FN_SET);
    if (c.kind === 'go' && (c.fn || (c.security && t.includes(' ')))) {
      out.push({ id: 'run', group: 'Run', label: <span className="m">{t.toUpperCase()}</span>, sub: c.fn ? FN[c.fn]?.title : 'Open', icon: 'terminal', hint: '↵', run: () => shell.run(t) });
    }
    if (/^evolve\s+[a-z]/i.test(t)) {
      out.push({ id: 'evolve', group: 'Run', label: `Evolve ${t.split(/\s+/)[1]}`, sub: t.split(/\s+/).slice(2).join(' ') || 'build or fix this integration, for you to approve', icon: 'spark', run: () => shell.run(t) });
    }
    for (const k of secs) {
      const q = quotes.get(k);
      const name = (isQuote(q) && q.name) || COMPANIES.find((x) => x.keys.includes(k))?.name || k;
      out.push({ id: `s:${k}`, group: 'Securities', label: <b>{ticker(k)}</b>, sub: `${name}${held.has(k) ? ' · you own it' : followed.includes(k) ? ' · watching' : ''}`, icon: 'markets', quote: k, run: () => navigate(secPath(k)) });
    }
    const top = secs[0] && t ? secs[0] : null;
    if (top) {
      out.push({ id: 'chart', group: 'Go to', label: `${ticker(top)} chart`, sub: 'price, news on the chart', icon: 'markets', hint: 'GP', run: () => navigate(secPath(top, { range: '1Y' })) });
      out.push({ id: 'news', group: 'Go to', label: `${ticker(top)} news`, sub: 'stories and filings tagged with it', icon: 'news', run: () => navigate(`/news?security=${encodeURIComponent(top)}`) });
    }
    for (const p of PAGES) {
      if (!t || fold(p.label).includes(folded) || (folded.length > 2 && (p.words ?? '').includes(folded)) || p.hint === t.toUpperCase()) {
        out.push({ id: `p:${p.path}`, group: 'Go to', label: p.label, icon: p.icon, hint: p.hint, run: () => navigate(p.path) });
      }
    }
    if (t && !/^evolve\b/i.test(t)) {
      out.push({ id: 'ask', group: 'Ask', label: t.endsWith('?') ? t : `${t}`, sub: 'ask your agent', icon: 'spark', hint: shortcut('↵'), run: () => void shell.ask(t, { fresh: true }) });
    }
    if (top) {
      out.push({ id: 'why', group: 'Ask', label: `Why did ${ticker(top)} move today?`, icon: 'spark', run: () => void shell.ask(`Why did ${top} move today?`, { fresh: true }) });
      const cur = lists.lists[lists.current] ?? [];
      if (!cur.includes(top)) {
        out.push({ id: 'watch', group: 'Actions', label: `Add ${ticker(top)} to ${lists.current}`, icon: 'star', run: () => (setLists({ ...lists, lists: { ...lists.lists, [lists.current]: [...cur, top] } }), shell.toast(`Added ${ticker(top)} to ${lists.current}`)) });
      }
    }
    const action = (id: string, label: string, icon: IconName, run: () => void, words: string) => {
      if (!t || fold(label).includes(folded) || words.includes(folded)) out.push({ id, group: 'Actions', label, icon, run });
    };
    action('brief', 'Write the brief now', 'spark', () => void api('POST', '/api/brief').then(() => navigate('/'), (e) => shell.toast((e as Error).message, 'error')), 'brief morning regenerate');
    action('feeds', 'Check the news feeds now', 'refresh', () => void api('POST', '/api/news/refresh').then(() => shell.toast('Checked every news feed'), (e) => shell.toast((e as Error).message, 'error')), 'news refresh feeds');
    action('evolve-help', 'Evolve an integration…', 'spark', () => setText('EVOLVE '), 'evolve integration build fix source');
    const other = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    action('theme', `Switch to ${other} theme`, other === 'dark' ? 'moon' : 'sun', () => setThemePref(other), 'theme dark light mode appearance colors');
    return out;
  }, [t, secs, quotes, lists]);

  useEffect(() => setSel(0), [t]);
  useEffect(() => input.current?.focus(), []);
  const choose = (i: Item) => {
    onClose();
    i.run();
  };

  const ordered = GROUPS.flatMap((g) => items.filter((i) => i.group === g));
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search and commands"
        onMouseDown={(e) => {
          e.stopPropagation();
          // Its keys work only from the box, so a click in here leaves the focus there.
          if (e.target !== input.current) e.preventDefault();
        }}
      >
        <div className="pinput">
          <Icon name="search" size={16} />
          <input
            ref={input}
            aria-label="Search or ask"
            placeholder="Search tickers, pages, or ask anything"
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return onClose();
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => (ordered.length ? (s + (e.key === 'ArrowDown' ? 1 : -1) + ordered.length) % ordered.length : 0));
              }
              if (e.key === 'Tab') {
                e.preventDefault();
                if (secs[0] && t) setText(`${ticker(secs[0])} `);
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                if ((e.metaKey || e.ctrlKey) && t) {
                  onClose();
                  void shell.ask(t, { fresh: true });
                } else if (ordered[sel]) choose(ordered[sel]!);
              }
            }}
          />
          <span className="chip m xs">esc</span>
        </div>
        <div className="presults" role="listbox">
          {GROUPS.map((g) => {
            const group = items.filter((i) => i.group === g);
            if (!group.length) return null;
            return (
              <div key={g}>
                <div className="lbl">{g}</div>
                {group.map((i) => {
                  const idx = ordered.indexOf(i);
                  const q = i.quote ? quotes.get(i.quote) : undefined;
                  return (
                    <button
                      key={i.id}
                      role="option"
                      aria-selected={idx === sel}
                      className={`pitem ${idx === sel ? 'sel' : ''}`}
                      onMouseEnter={() => setSel(idx)}
                      onClick={() => choose(i)}
                    >
                      <Icon name={i.icon} size={14} className={i.icon === 'spark' ? 'amber' : ''} />
                      <span className="pl">{i.label}</span>
                      {i.sub && <span className="mut ps">{i.sub}</span>}
                      {isQuote(q) && (
                        <>
                          <span className="m small">{price(q.last, q.key)}</span>
                          <span className={`m small pq ${cls(q.changePct)}`}>{pct(q.changePct)}</span>
                        </>
                      )}
                      {i.hint && <span className="chip m xs">{i.hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {!items.length && <div className="empty">Nothing matches. {shortcut('↵')} asks your agent.</div>}
        </div>
        <div className="pfoot">
          <span>
            <span className="chip m xs">↑↓</span> move
          </span>
          <span>
            <span className="chip m xs">↵</span> open
          </span>
          <span>
            <span className="chip m xs">⇥</span> complete
          </span>
          <span>
            <span className="chip m xs">{shortcut('↵')}</span> ask
          </span>
          <span className="spacer" />
          <span>
            Mnemonics work too: <span className="m amber">PETR4 GP 1Y</span>
          </span>
        </div>
      </div>
    </div>
  );
}
