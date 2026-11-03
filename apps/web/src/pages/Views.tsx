import { useMemo, useRef, type ComponentType } from 'react';
import { useTheme, type ThemePref } from '../theme.ts';
import { api } from '../api.ts';
import { Empty, useNow } from '../components.tsx';
import { useApi } from '../data.ts';
import { age } from '../format.ts';
import type { Nav, ViewProps } from '../functions.ts';
import { Icon } from '../icons.tsx';
import type { View } from '../layout.ts';
import { navigate, secPath, type Route } from '../router.tsx';
import { useShell } from '../shell.ts';
import { Card, PageHead } from '../ui.tsx';
import Help from '../views/Help.tsx';
import Jobs from '../views/Jobs.tsx';
import Portfolio from '../views/Portfolio.tsx';
import Settings from '../views/Settings.tsx';
import Sources from '../views/Sources.tsx';

// Pages that show one of the terminal's views full size: Portfolio, Sources, Jobs, Settings,
// Help. The view runs as it does in a panel; its navigation becomes page navigation.

/** The page that shows what a terminal view shows. */
export function viewPath(v: View): string {
  const args = v.args.map(encodeURIComponent).join('/');
  switch (v.fn) {
    case 'OV':
      return v.security ? secPath(v.security) : '/';
    case 'GP':
      return v.security ? secPath(v.security, v.args[0] ? { range: v.args[0].toUpperCase() } : undefined) : '/';
    case 'W':
      return '/markets';
    case 'PORT':
      return '/portfolio';
    case 'SRC':
      return '/sources';
    case 'JOBS':
      return `/jobs${args ? `/${args}` : ''}`;
    case 'SET':
      return '/settings';
    case 'HELP':
      return `/help${args ? `/${args}` : ''}`;
    case 'ASK':
      return `/ask${v.args[0] ? `/${encodeURIComponent(v.args[0])}` : ''}`;
    default:
      return '/';
  }
}

function usePageNav(fn: string): Nav {
  const shell = useShell();
  return useMemo(
    () => ({
      open: (view) => navigate(viewPath(view)),
      setArgs: (args) => navigate(viewPath({ fn, args })),
      linkSecurity: (key) => navigate(secPath(key)),
      message: (text, kind) => shell.toast(text, kind),
      run: (cmd) => shell.run(cmd),
    }),
    [fn, shell],
  );
}

function ViewBody({ fn, args, View }: { fn: string; args: string[]; View: ComponentType<ViewProps> }) {
  const nav = usePageNav(fn);
  const drill = useRef<((row: number) => void) | null>(null);
  return (
    <div className="viewbody">
      <View panel={{ id: 0, fn, args, back: [], history: [], group: null }} active nav={nav} drill={drill} />
    </div>
  );
}

export function PortfolioPage() {
  return (
    <div>
      <PageHead title="Portfolio" sub="positions and cash from your accounts · totals in USD at the PTAX rate" />
      <Card>
        <ViewBody fn="PORT" args={[]} View={Portfolio} />
      </Card>
    </div>
  );
}

export function JobsPage({ route }: { route: Route }) {
  return (
    <div>
      <PageHead title="Jobs" sub="what ran, when, and why it failed" />
      <Card>
        <ViewBody fn="JOBS" args={route.parts.slice(1)} View={Jobs} />
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { pref, setPref } = useTheme();
  return (
    <div>
      <PageHead title="Settings" sub="API keys live in your macOS Keychain; bloomterm never shows them again" />
      <Card title="Appearance" icon="sun" actions={<ThemeSwitch pref={pref} setPref={setPref} />}>
        <p className="mut small pad">Light is the default. System follows macOS. This browser remembers the choice.</p>
      </Card>
      <Card>
        <ViewBody fn="SET" args={[]} View={Settings} />
      </Card>
    </div>
  );
}

function ThemeSwitch({ pref, setPref }: { pref: ThemePref; setPref: (p: ThemePref) => void }) {
  return (
    <span className="seg" role="radiogroup" aria-label="Theme">
      {(['light', 'dark', 'system'] as const).map((p) => (
        <button key={p} role="radio" aria-checked={pref === p} className={pref === p ? 'on' : ''} onClick={() => setPref(p)}>
          {p[0]!.toUpperCase() + p.slice(1)}
        </button>
      ))}
    </span>
  );
}

export function HelpPage({ route }: { route: Route }) {
  return (
    <div>
      <PageHead title="Help" sub="⌘K finds anything; the terminal's mnemonics work there too" />
      <Card>
        <ViewBody fn="HELP" args={route.parts.slice(1)} View={Help} />
      </Card>
    </div>
  );
}

interface Feed {
  id: string;
  name: string;
  everyMs: number;
  lastTry: string | null;
  lastOk: string | null;
  error: string | null;
  added: number;
}

export function SourcesPage() {
  const shell = useShell();
  const now = useNow(30_000);
  const feeds = useApi<Feed[]>('/api/news/feeds', { refreshOn: (ev) => ev.type === 'news', everyMs: 30_000 });
  const refresh = () => void api('POST', '/api/news/refresh').then(() => shell.toast('Checked every news feed'), (err) => shell.toast((err as Error).message, 'error'));
  return (
    <div>
      <PageHead title="Sources" sub="where bloomterm's data comes from, and whether it's flowing">
        <button className="btn" onClick={() => shell.openPalette('EVOLVE ')} title="Your agent builds or fixes an integration, for you to review and approve">
          <Icon name="spark" size={14} className="amber" /> Evolve an integration
        </button>
      </PageHead>
      <div className="cols">
        <Card className="grow2">
          <ViewBody fn="SRC" args={[]} View={Sources} />
        </Card>
        <Card
          title="News feeds"
          actions={
            <button className="btn xs" onClick={refresh}>
              <Icon name="refresh" size={12} /> Check now
            </button>
          }
        >
          {!feeds.data?.length && <Empty>No news feeds loaded.</Empty>}
          <div className="rows">
            {feeds.data?.map((f) => (
              <div key={f.id} className="row feedrow" title={f.error ?? undefined}>
                <span className={`dot ${f.error ? 'amber' : f.lastOk ? 'up' : 'mut'}`} />
                <span className="grow">
                  {f.name}
                  {f.error && <span className="small amber block">{f.error}</span>}
                </span>
                <span className="mut small">{f.lastOk ? `${age(f.lastOk, now)} ago` : f.lastTry ? 'failing' : 'not yet'}</span>
                <span className="mut small">every {Math.round(f.everyMs / 60_000)}m</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
