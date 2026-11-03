import { Component, type ComponentType, type CSSProperties, type ErrorInfo, type MutableRefObject, type ReactNode } from 'react';
import { FN, type Nav, type ViewProps } from './functions.ts';
import { nextGroup, type PanelState } from './layout.ts';
import Ask from './views/Ask.tsx';
import Graph from './views/Graph.tsx';
import Help from './views/Help.tsx';
import Jobs from './views/Jobs.tsx';
import Overview from './views/Overview.tsx';
import Portfolio from './views/Portfolio.tsx';
import Settings from './views/Settings.tsx';
import Sources from './views/Sources.tsx';
import Watchlist from './views/Watchlist.tsx';

const VIEWS: Record<string, ComponentType<ViewProps>> = {
  OV: Overview,
  GP: Graph,
  W: Watchlist,
  ASK: Ask,
  PORT: Portfolio,
  SRC: Sources,
  JOBS: Jobs,
  SET: Settings,
  HELP: Help,
};

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  override componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(err, info.componentStack);
  }
  override render() {
    return this.state.error ? <div className="empty err">This panel crashed: {this.state.error}. Esc goes back.</div> : this.props.children;
  }
}

export function Panel(props: {
  panel: PanelState;
  active: boolean;
  maximized: boolean;
  nav: Nav;
  drill: MutableRefObject<((row: number) => void) | null>;
  onFocus(): void;
  onGroup(group: PanelState['group']): void;
  style?: CSSProperties;
}) {
  const { panel, active, nav, drill } = props;
  const def = FN[panel.fn];
  const View = VIEWS[panel.fn] ?? Help;
  // A view only drills while it's mounted.
  drill.current = null;
  return (
    <section className={`panel ${active ? 'active' : ''} ${props.maximized ? 'max' : ''}`} style={props.style} onMouseDown={props.onFocus} data-panel={panel.id}>
      <header className="ph">
        <span className="pn">{panel.id}</span>
        <span className="pfn">{panel.fn}</span>
        {def?.scope === 'security' && <span className="psec">{panel.security}</span>}
        <span className="ptitle">{def?.title}</span>
        <span className="spacer" />
        {panel.back.length > 0 && <span className="muted hint">Esc ←</span>}
        <button
          className={`grp grp-${panel.group ?? 'none'}`}
          title="Link group: panels in the same group load the same security. Click to change."
          onClick={(e) => {
            e.stopPropagation();
            props.onGroup(nextGroup(panel.group));
          }}
        >
          {panel.group ?? '·'}
        </button>
      </header>
      <div className="pb">
        <Boundary key={`${panel.fn}|${panel.security}`}>
          <View panel={panel} active={active} nav={nav} drill={drill} />
        </Boundary>
      </div>
    </section>
  );
}
