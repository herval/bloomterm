import { parseCommand, parseSecurity } from '@bloomterm/core/web';
import { useTheme } from './theme.ts';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { AskPanel } from './AskPanel.tsx';
import { useNow } from './components.tsx';
import { reloadSetup, useApi, useHoldings, useSetup } from './data.ts';
import { DaemonContext, useDaemon, useDaemonState, useUiState } from './feeds.ts';
import { FN, FN_SET } from './functions.ts';
import { Icon, type IconName } from './icons.tsx';
import { DEFAULT_WATCHLISTS, type Watchlists } from './layout.ts';
import { duration, sessions } from './markets.ts';
import Markets from './pages/Markets.tsx';
import News from './pages/News.tsx';
import Security from './pages/Security.tsx';
import Setup from './pages/Setup.tsx';
import Terminal from './pages/Terminal.tsx';
import Today, { heldKeys } from './pages/Today.tsx';
import { HelpPage, JobsPage, PortfolioPage, SettingsPage, SourcesPage, viewPath } from './pages/Views.tsx';
import { Palette } from './Palette.tsx';
import { Link, navigate, useRoute, type Route } from './router.tsx';
import { ShellContext, terminalRun, type ShellApi } from './shell.ts';
import { ticker } from './ui.tsx';

// The app around every page: the top bar (search, market sessions, agent, bloomd), the
// sidebar, Ask in a drawer on the right, ⌘K, and toasts. Pages are plain components picked
// by URL; commands typed anywhere (PETR4 GP 1Y) open the page that shows the same thing.

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

const BAD = ['needs_login', 'challenge', 'blocked'];

/** What Ask is told you're looking at, from the URL. */
function contextOf(route: Route): string | undefined {
  const [first, second] = route.parts;
  switch (first) {
    case undefined:
      return 'Today page (markets, portfolio, brief, movers, news)';
    case 's': {
      const sec = parseSecurity(second ?? '');
      return sec ? `security ${sec.key}` : undefined;
    }
    case 'markets':
      return `Markets page, watchlist ${route.query.get('list') ?? 'current'}`;
    case 'portfolio':
      return 'Portfolio page';
    case 'news': {
      const story = route.query.get('story');
      const sec = route.query.get('security');
      return ['News page', sec && `filtered to ${sec}`, story && `story ${story}`].filter(Boolean).join(', ');
    }
    case 'sources':
      return 'Sources page';
    case 'jobs':
      return 'Jobs page';
    default:
      return undefined;
  }
}

const TITLES: Record<string, string> = { markets: 'Markets', portfolio: 'Portfolio', news: 'News', ask: 'Ask', terminal: 'Terminal', sources: 'Sources', settings: 'Settings', jobs: 'Jobs', help: 'Help', setup: 'Setup' };

/** Setup opens by itself once per browser, the first time Today opens while something's missing. */
const SETUP_SHOWN = 'bloomterm.setupShown';
function firstSetupVisit(): boolean {
  try {
    if (localStorage.getItem(SETUP_SHOWN)) return false;
    localStorage.setItem(SETUP_SHOWN, '1');
    return true;
  } catch {
    return false;
  }
}

export default function Shell() {
  const daemon = useDaemonState();
  const route = useRoute();
  const [askOpen, setAskOpen] = useState(false);
  const [askChat, setAskChat] = useState<string | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lists] = useUiState<Watchlists>('watchlists', DEFAULT_WATCHLISTS);
  const { positions } = useHoldings();
  const held = useMemo(() => new Set(heldKeys(positions).keys()), [positions]);
  const followed = useMemo(() => [...new Set([...held, ...Object.values(lists.lists).flat()])], [held, lists]);
  const onAskPage = route.parts[0] === 'ask';
  const context = contextOf(route);
  const setup = useSetup();
  // A restarted bloomd may have found an agent CLI.
  const startedAt = daemon.status?.startedAt as string | undefined;
  const firstStart = useRef(startedAt);
  useEffect(() => {
    if (startedAt && firstStart.current && startedAt !== firstStart.current) reloadSetup();
    firstStart.current ??= startedAt;
  }, [startedAt]);
  useEffect(() => {
    if (setup && !setup.ready && route.parts.length === 0 && firstSetupVisit()) navigate('/setup', { replace: true });
    // Only when setup first arrives, not on every page change.
  }, [setup?.ready]);
  const latest = useRef({ route, askChat, context, onAskPage });
  latest.current = { route, askChat, context, onAskPage };

  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), kind === 'error' ? 9_000 : 5_000);
  }, []);

  const showChat = useCallback((chatId: string | null) => {
    if (latest.current.onAskPage) return navigate(chatId ? `/ask/${chatId}` : '/ask');
    setAskChat(chatId);
    setAskOpen(true);
  }, []);

  const shell = useMemo<ShellApi>(() => {
    const ask: ShellApi['ask'] = async (question, o = {}) => {
      const { askChat: current, context: here, onAskPage: page, route: r } = latest.current;
      const chatId = o.fresh ? undefined : page ? r.parts[1] : (current ?? undefined);
      try {
        const res = await api<{ chatId: string }>('POST', '/api/chats', { message: question, chatId, context: o.context ?? here });
        showChat(res.chatId);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    };
    const run = (text: string) => {
      if (terminalRun.current) return terminalRun.current(text);
      const t = text.trim();
      if (t.startsWith('?')) return void ask(t.slice(1).trim() || 'What can you tell me about this page?', { fresh: true });
      const c = parseCommand(t, FN_SET);
      const r = latest.current.route;
      const here = r.parts[0] === 's' ? parseSecurity(r.parts[1] ?? '')?.key : undefined;
      switch (c.kind) {
        case 'empty':
          return;
        case 'drill':
          return toast('Row numbers (3 <GO>) work in the terminal’s panels.', 'error');
        case 'ask':
          return void ask(c.text, { fresh: true });
        case 'unknown':
          return toast(`Unknown security or function "${c.text}". Try a ticker (PETR4, AAPL), or ⌘K to search.`, 'error');
        case 'go': {
          const fn = c.fn ?? 'OV';
          const security = c.security?.key ?? here;
          if (fn === 'ASK') {
            if (c.args[0]?.toUpperCase() === 'STOP' && c.args.length === 1) {
              const chat = latest.current.askChat;
              if (chat) void api('POST', `/api/chats/${chat}/stop`).catch(() => {});
              return;
            }
            if (c.args.length) return void ask(c.args.join(' '), { fresh: true, context: c.security ? `security ${c.security.key}` : undefined });
            return showChat(null);
          }
          if (fn === 'EVOLVE') {
            const integration = c.args[0]?.toLowerCase();
            if (!integration) return showChat(null);
            void api<{ chatId: string }>('POST', '/api/evolve', { integration, goal: c.args.slice(1).join(' ') || undefined }).then(
              (res) => {
                toast(`EVOLVE ${integration} started; you review its work before it runs`);
                showChat(res.chatId);
              },
              (err) => toast((err as Error).message, 'error'),
            );
            return;
          }
          if (fn === 'LOGIN') {
            const source = c.args[0]?.toLowerCase();
            if (!source) return toast('LOGIN <source>, e.g. LOGIN b3. Sources lists them.', 'error');
            void api('POST', `/api/sources/${encodeURIComponent(source)}/login`).then(
              () => {
                toast(`Opening the ${source} sign-in window. Sign in there; it parks itself when you're done.`);
                navigate('/sources');
              },
              (err) => toast((err as Error).message, 'error'),
            );
            return;
          }
          if (FN[fn]!.scope === 'security' && !security) return toast(`${fn} needs a security, e.g. AAPL ${fn}`, 'error');
          return navigate(viewPath({ fn, security, args: c.args }));
        }
      }
    };
    return { ask, run, toast, openAsk: (chatId) => showChat(chatId ?? null), openPalette: (text = '') => setPalette(text) };
  }, [toast, showChat]);

  // The desktop app's menu bar (apps/desktop) sends `bloomterm:desktop` with a page to go to,
  // or to open Ask.
  useEffect(() => {
    const onMenu = (e: Event) => {
      const { go, ask } = (e as CustomEvent<{ go?: string; ask?: boolean }>).detail ?? {};
      if (go) navigate(go);
      if (ask && !latest.current.onAskPage) setAskOpen(true);
    };
    window.addEventListener('bloomterm:desktop', onMenu);
    return () => window.removeEventListener('bloomterm:desktop', onMenu);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'k') {
        e.preventDefault();
        setPalette((p) => (p === null ? '' : null));
        return;
      }
      if (mod && k === 'j') {
        e.preventDefault();
        if (latest.current.onAskPage) return;
        setAskOpen((o) => !o);
        return;
      }
      // Outside the terminal, start typing anywhere to search; the terminal sends keys to its command line.
      if (terminalRun.current || palette !== null || mod || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (e.key === '/' || (e.key.length === 1 && /[a-z0-9?]/i.test(e.key))) {
        e.preventDefault();
        setPalette(e.key === '/' ? '' : e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette]);

  const title = route.parts[0] === 's' ? ticker(parseSecurity(route.parts[1] ?? '')?.key ?? route.parts[1] ?? '') : (TITLES[route.parts[0] ?? ''] ?? 'Today');
  useEffect(() => void (document.title = `${title} · bloomterm`), [title]);

  let page: ReactNode;
  switch (route.parts[0]) {
    case undefined:
      page = <Today />;
      break;
    case 's':
      page = <Security key={route.parts[1]} route={route} />;
      break;
    case 'markets':
      page = <Markets route={route} />;
      break;
    case 'portfolio':
      page = <PortfolioPage />;
      break;
    case 'news':
      page = <News route={route} />;
      break;
    case 'ask':
      page = <AskPanel full chatId={route.parts[1] ?? null} onChat={(id) => navigate(id ? `/ask/${id}` : '/ask')} />;
      break;
    case 'terminal':
      page = <Terminal />;
      break;
    case 'sources':
      page = <SourcesPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'jobs':
      page = <JobsPage route={route} />;
      break;
    case 'help':
      page = <HelpPage route={route} />;
      break;
    case 'setup':
      page = <Setup />;
      break;
    default:
      page = (
        <div className="empty">
          Nothing at {route.path}. <Link to="/">Go to Today</Link>
        </div>
      );
  }
  const flush = route.parts[0] === 'terminal' || onAskPage;
  const drawer = askOpen && !onAskPage;

  return (
    <DaemonContext.Provider value={daemon}>
      <ShellContext.Provider value={shell}>
        <div className={`shell ${drawer ? 'with-ask' : ''}`}>
          <TopBar setupDone={setup?.ready !== false} onSearch={() => setPalette('')} onAsk={() => (onAskPage ? undefined : setAskOpen((o) => !o))} />
          <Sidebar route={route} lists={lists} askOpen={drawer} onAsk={() => setAskOpen((o) => !o)} />
          <main className={`page ${flush ? 'flush' : ''}`} id="main">
            {page}
          </main>
          {drawer && (
            <aside className="drawer" aria-label="Ask">
              <AskPanel chatId={askChat} onChat={setAskChat} context={context} onClose={() => setAskOpen(false)} />
            </aside>
          )}
          <TabBar route={route} onAsk={() => (onAskPage ? undefined : setAskOpen((o) => !o))} />
        </div>
        {palette !== null && <Palette initial={palette} onClose={() => setPalette(null)} followed={followed} held={held} />}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
              {t.text}
            </div>
          ))}
        </div>
      </ShellContext.Provider>
    </DaemonContext.Provider>
  );
}

/** Flips light and dark (Settings has System too). */
function ThemeButton() {
  const { theme, setPref } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="btn xs ghost themebtn" onClick={() => setPref(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
    </button>
  );
}

function TopBar({ setupDone, onSearch, onAsk }: { setupDone: boolean; onSearch: () => void; onAsk: () => void }) {
  const now = useNow(15_000);
  const { connected, status, sources, jobs } = useDaemon();
  const urgent = sources.find((s) => BAD.includes(s.session.state));
  const failed = jobs.find((j) => j.status === 'failed' && now - Date.parse(j.finishedAt ?? j.createdAt) < 3_600_000);
  const agent = status?.agent as { kind: string; path: string } | null | undefined;
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="bloomterm, Today">
        <span className="mark" aria-hidden="true" />
        bloomterm
      </Link>
      <button className="searchbox" onClick={onSearch} aria-label="Search or ask (⌘K)">
        <Icon name="search" size={14} />
        <span className="grow">Search tickers, pages, or ask…</span>
        <kbd>⌘K</kbd>
      </button>
      <span className="spacer" />
      {!setupDone ? (
        <Link to="/setup" className="chip warnchip">
          <span className="dot amber" /> Finish setup
        </Link>
      ) : urgent ? (
        <Link to="/sources" className="chip warnchip" title={urgent.session.lastError ?? undefined}>
          <span className="dot amber" /> {urgent.name || urgent.id}: sign in
        </Link>
      ) : failed ? (
        <Link to={`/jobs/${failed.id}`} className="chip warnchip hide-s">
          <span className="dot dn" /> {failed.kind === 'run' ? `${failed.source}.${failed.dataset}` : `${failed.kind} ${failed.source}`} failed
        </Link>
      ) : null}
      {sessions(new Date(now)).map((s) => (
        <span key={s.label} className="chip hide-s" title={`Regular hours (no holiday calendar yet). ${s.open ? 'Closes' : 'Opens'} in ${duration(s.minutes)}.`}>
          <span className={`dot ${s.open ? 'up' : 'mut'}`} />
          {s.label} <span className="mut">{s.open ? `open · ${duration(s.minutes)}` : 'closed'}</span>
        </span>
      ))}
      <button className={`chip agentchip ${setupDone ? '' : 'hide-s'}`} onClick={agent ? onAsk : () => navigate('/setup')} title={agent ? `Ask runs on ${agent.path}` : 'No agent CLI: Setup says how to add one'}>
        <Icon name="spark" size={12} className={agent ? 'amber' : 'mut'} />
        {agent ? agent.kind : 'no agent'}
      </button>
      <ThemeButton />
      <span className={`dot ${connected ? 'up' : 'dn'}`} title={connected ? 'Connected to bloomd' : 'Not connected to bloomd. Is it running? (pnpm bt daemon start)'} role="img" aria-label={connected ? 'bloomd connected' : 'bloomd not connected'} />
    </header>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  match: (r: Route) => boolean;
}

const MAIN: NavItem[] = [
  { to: '/', label: 'Today', icon: 'today', match: (r) => r.parts.length === 0 },
  { to: '/markets', label: 'Markets', icon: 'markets', match: (r) => r.parts[0] === 'markets' && !r.query.get('list') },
  { to: '/portfolio', label: 'Portfolio', icon: 'portfolio', match: (r) => r.parts[0] === 'portfolio' },
  { to: '/news', label: 'News', icon: 'news', match: (r) => r.parts[0] === 'news' },
];

function Sidebar({ route, lists, askOpen, onAsk }: { route: Route; lists: Watchlists; askOpen: boolean; onAsk: () => void }) {
  const { sources } = useDaemon();
  const feeds = useApi<{ error: string | null }[]>('/api/news/feeds', { refreshOn: (ev) => ev.type === 'news', everyMs: 120_000 });
  const trouble = sources.filter((s) => BAD.includes(s.session.state)).length + (feeds.data ?? []).filter((f) => f.error).length;
  const item = (n: NavItem, badge?: ReactNode) => (
    <Link key={n.to} to={n.to} className={`nav ${n.match(route) ? 'on' : ''}`} aria-current={n.match(route) ? 'page' : undefined}>
      <Icon name={n.icon} size={16} />
      <span className="grow">{n.label}</span>
      {badge}
    </Link>
  );
  return (
    <nav className="sidebar" aria-label="Pages">
      {MAIN.map((n) => item(n))}
      <div className="lbl">Watchlists</div>
      {Object.entries(lists.lists).map(([name, keys]) => (
        <Link key={name} to={`/markets?list=${encodeURIComponent(name)}`} className={`nav sub ${route.parts[0] === 'markets' && route.query.get('list') === name ? 'on' : ''}`}>
          <span className="hash">#</span>
          <span className="grow ellipsis">{name}</span>
          <span className="count">{keys.length}</span>
        </Link>
      ))}
      <div className="lbl">Boards</div>
      {item({ to: '/terminal', label: 'Terminal', icon: 'terminal', match: (r) => r.parts[0] === 'terminal' })}
      <span className="spacer" />
      <button className={`nav ${askOpen || route.parts[0] === 'ask' ? 'on' : ''}`} onClick={() => (route.parts[0] === 'ask' ? undefined : onAsk())}>
        <Icon name="spark" size={16} className="amber" />
        <span className="grow">Ask</span>
        <kbd>⌘J</kbd>
      </button>
      {item({ to: '/sources', label: 'Sources', icon: 'sources', match: (r) => r.parts[0] === 'sources' }, trouble > 0 ? <span className="badge" title={`${trouble} need attention`}>{trouble}</span> : null)}
      {item({ to: '/jobs', label: 'Jobs', icon: 'jobs', match: (r) => r.parts[0] === 'jobs' })}
      {item({ to: '/settings', label: 'Settings', icon: 'settings', match: (r) => r.parts[0] === 'settings' })}
      {item({ to: '/help', label: 'Help', icon: 'help', match: (r) => r.parts[0] === 'help' })}
    </nav>
  );
}

/** Phones: the sidebar becomes a tab bar. */
function TabBar({ route, onAsk }: { route: Route; onAsk: () => void }) {
  const tabs: NavItem[] = [...MAIN.slice(0, 2), MAIN[3]!, MAIN[2]!];
  return (
    <nav className="tabbar" aria-label="Pages">
      {tabs.map((n) => (
        <Link key={n.to} to={n.to} className={n.match(route) ? 'on' : ''}>
          <Icon name={n.icon} size={18} />
          {n.label}
        </Link>
      ))}
      <button onClick={onAsk}>
        <Icon name="spark" size={18} className="amber" />
        Ask
      </button>
    </nav>
  );
}
