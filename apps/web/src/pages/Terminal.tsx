import { parseCommand } from '@bloomterm/core/web';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import { api } from '../api.ts';
import { useNow } from '../components.tsx';
import { useUiState } from '../feeds.ts';
import { FN, FN_SET, FUNCTIONS, type Nav } from '../functions.ts';
import { DEFAULT_LAYOUT, sizesOf, validLayout, type Layout, type PanelState, type View } from '../layout.ts';
import { CLOCKS, clockTime } from '../markets.ts';
import { Panel } from '../Panel.tsx';
import { terminalRun } from '../shell.ts';
import { Splitter } from '../Split.tsx';

// The terminal: four panels on one board, driven by mnemonics typed on the command line
// (PETR4 GP 1Y <GO>). It's one page of the app now; everything it shows has a page too.

type Drill = MutableRefObject<((row: number) => void) | null>;
type Msg = { text: string; kind: 'info' | 'error' } | null;

const viewOf = (p: PanelState): View => ({ fn: p.fn, security: p.security, args: p.args });
const same = (a: View, b: View) => a.fn === b.fn && a.security === b.security;

function mapPanel(l: Layout, id: number, f: (p: PanelState) => PanelState): Layout {
  return { ...l, panels: l.panels.map((p) => (p.id === id ? f(p) : p)) };
}

/** Show `view` in panel `id`. Esc returns, unless it's the same function and security. */
function openIn(l: Layout, id: number, view: View): Layout {
  return mapPanel(l, id, (p) => ({ ...p, ...view, back: same(viewOf(p), view) ? p.back : [...p.back, viewOf(p)].slice(-30) }));
}

/** Panels in the same link group follow a security change (SPEC §4.1). */
function follow(l: Layout, id: number, key: string): Layout {
  const group = l.panels.find((p) => p.id === id)?.group;
  if (!group) return l;
  return { ...l, panels: l.panels.map((p) => (p.id !== id && p.group === group && FN[p.fn]?.scope === 'security' ? { ...p, security: key } : p)) };
}

export default function Terminal() {
  const [stored, setStored] = useUiState<Layout>('layout', DEFAULT_LAYOUT);
  const layout = validLayout(stored) ? stored : DEFAULT_LAYOUT;
  const latest = useRef(layout);
  latest.current = layout;
  const update = (f: (l: Layout) => Layout) => {
    const next = f(latest.current);
    latest.current = next;
    setStored(next);
  };

  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drills = useRef(new Map<number, Drill>());
  const drillFor = (id: number): Drill => {
    let d = drills.current.get(id);
    if (!d) drills.current.set(id, (d = { current: null }));
    return d;
  };
  const now = useNow(1_000);

  const navs = useMemo(() => {
    const m = new Map<number, Nav>();
    for (const p of layout.panels) {
      const id = p.id;
      m.set(id, {
        open: (view) => update((l) => openIn(l, id, view)),
        setArgs: (args) => update((l) => mapPanel(l, id, (x) => ({ ...x, args }))),
        linkSecurity: (key) =>
          update((l) => {
            const me = l.panels.find((x) => x.id === id)!;
            const linked = me.group && l.panels.some((x) => x.id !== id && x.group === me.group && FN[x.fn]?.scope === 'security');
            return linked ? follow(l, id, key) : openIn(l, id, { fn: 'OV', security: key, args: [] });
          }),
        message: (text, kind = 'info') => setMsg({ text, kind }),
        run: (command) => {
          const target = otherThan(id);
          update((l) => ({ ...l, active: target }));
          void run(command, target);
        },
      });
    }
    return m;
  }, [layout.panels.map((p) => p.id).join(',')]);

  const active = layout.panels.find((p) => p.id === layout.active) ?? layout.panels[0]!;
  // Where links in an ASK answer open: the last panel you used that isn't ASK.
  const lastOther = useRef<number | null>(null);
  if (active.fn !== 'ASK') lastOther.current = active.id;
  const otherThan = (id: number) => {
    const ps = latest.current.panels;
    if (lastOther.current !== null && lastOther.current !== id && ps.some((p) => p.id === lastOther.current)) return lastOther.current;
    const i = ps.findIndex((p) => p.id === id);
    return ps[(i + 1) % ps.length]!.id;
  };

  function back() {
    if (latest.current.maximized !== null && active.back.length === 0) {
      update((l) => ({ ...l, maximized: null }));
      return;
    }
    if (active.back.length === 0) return;
    update((l) => mapPanel(l, active.id, (p) => ({ ...p, ...p.back.at(-1)!, back: p.back.slice(0, -1) })));
  }

  /** Sends a question to ASK: the active ASK panel, else any ASK panel, else opens one here. */
  async function ask(question: string, security?: string) {
    const l = latest.current;
    const here = l.panels.find((p) => p.id === l.active) ?? l.panels[0]!;
    const target = here.fn === 'ASK' ? here : l.panels.find((p) => p.fn === 'ASK');
    const context = security ? `security ${security}` : here.fn !== 'ASK' ? [here.fn, here.security, ...here.args].filter(Boolean).join(' ') : undefined;
    try {
      const r = await api<{ chatId: string }>('POST', '/api/chats', { message: question, chatId: target?.args[0], context });
      if (target) update((x) => ({ ...mapPanel(x, target.id, (p) => (p.args[0] === r.chatId ? p : { ...p, args: [r.chatId] })), active: target.id }));
      else update((x) => openIn(x, here.id, { fn: 'ASK', args: [r.chatId], security: here.security }));
    } catch (err) {
      setMsg({ text: (err as Error).message, kind: 'error' });
    }
  }

  async function run(text: string, targetId?: number) {
    const id = targetId ?? active.id;
    const here = latest.current.panels.find((p) => p.id === id) ?? active;
    setMsg(null);
    setHistIdx(null);
    if (text.trim()) {
      update((l) => mapPanel(l, id, (p) => ({ ...p, history: p.history.at(-1) === text ? p.history : [...p.history, text].slice(-50) })));
    }
    if (text.trim().startsWith('?')) return ask(text.trim().slice(1).trim() || 'What can you tell me about what is on my screen?');
    const c = parseCommand(text, FN_SET);
    switch (c.kind) {
      case 'empty':
        return;
      case 'drill': {
        const d = drillFor(id).current;
        if (d) d(c.row);
        else setMsg({ text: `${here.fn} has no numbered rows`, kind: 'error' });
        return;
      }
      case 'ask':
        return ask(c.text);
      case 'unknown':
        if (here.fn === 'ASK') return ask(c.text);
        setMsg({ text: `Unknown security or function "${c.text}". Name search isn't built yet: type the ticker (PETR4, AAPL). HELP lists functions.`, kind: 'error' });
        return;
      case 'go': {
        const fn = c.fn ?? 'OV';
        if (fn === 'ASK') {
          if (c.args[0]?.toUpperCase() === 'STOP' && c.args.length === 1) {
            const chat = latest.current.panels.find((p) => p.fn === 'ASK' && p.args[0])?.args[0];
            if (chat) await api('POST', `/api/chats/${chat}/stop`).catch(() => {});
            return;
          }
          if (c.args.length) return ask(c.args.join(' '), c.security?.key);
          update((l) => openIn(l, id, { fn: 'ASK', args: [], security: here.security }));
          return;
        }
        if (fn === 'EVOLVE') {
          const integration = c.args[0]?.toLowerCase();
          if (!integration) {
            update((l) => openIn(l, id, { fn: 'ASK', args: [], security: here.security }));
            return;
          }
          try {
            const r = await api<{ chatId: string }>('POST', '/api/evolve', { integration, goal: c.args.slice(1).join(' ') || undefined });
            setMsg({ text: `EVOLVE ${integration} started; you review its work before it runs`, kind: 'info' });
            const target = here.fn === 'ASK' ? here : latest.current.panels.find((p) => p.fn === 'ASK');
            if (target) update((x) => ({ ...mapPanel(x, target.id, (p) => ({ ...p, args: [r.chatId] })), active: target.id }));
            else update((l) => openIn(l, id, { fn: 'ASK', args: [r.chatId], security: here.security }));
          } catch (err) {
            setMsg({ text: (err as Error).message, kind: 'error' });
          }
          return;
        }
        if (fn === 'LOGIN') {
          const source = c.args[0]?.toLowerCase();
          if (!source) return setMsg({ text: 'LOGIN <source>, e.g. LOGIN b3 (SRC lists them)', kind: 'error' });
          try {
            await api('POST', `/api/sources/${encodeURIComponent(source)}/login`);
            setMsg({ text: `Opening the ${source} sign-in window. Sign in there; it parks itself when you're done.`, kind: 'info' });
            update((l) => openIn(l, id, { fn: 'SRC', args: [], security: here.security }));
          } catch (err) {
            setMsg({ text: (err as Error).message, kind: 'error' });
          }
          return;
        }
        if (FN[fn]!.scope === 'security') {
          const key = c.security?.key ?? here.security;
          if (!key) return setMsg({ text: `${fn} needs a security, e.g. AAPL ${fn}`, kind: 'error' });
          update((l) => {
            const next = openIn(l, id, { fn, security: key, args: c.args });
            return c.security ? follow(next, id, key) : next;
          });
          return;
        }
        update((l) => openIn(l, id, { fn, args: c.args, security: here.security }));
      }
    }
  }

  // ⌘K and links elsewhere in the app run here, in the active panel, while this page is open.
  useEffect(() => {
    terminalRun.current = (command) => void run(command);
    return () => void (terminalRun.current = null);
  });

  function onInputKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input;
      setInput('');
      void run(text);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (input) setInput('');
      else back();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const h = active.history;
      if (!h.length) return;
      let i = histIdx ?? h.length;
      i = e.key === 'ArrowUp' ? Math.max(0, i - 1) : i + 1;
      if (i >= h.length) {
        setHistIdx(null);
        setInput('');
      } else {
        setHistIdx(i);
        setInput(h[i]!);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const parts = input.split(/\s+/);
      const last = (parts.at(-1) ?? '').toUpperCase();
      if (!last) return;
      const hits = FUNCTIONS.map((f) => f.mnemonic).filter((m) => m.startsWith(last));
      if (hits.length === 1) setInput([...parts.slice(0, -1), hits[0]].join(' ') + ' ');
      else if (hits.length > 1) setMsg({ text: hits.join('  '), kind: 'info' });
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inCmd = t === inputRef.current;
      const inField = !inCmd && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const id = Number(e.key);
        if (latest.current.panels.some((p) => p.id === id)) update((l) => ({ ...l, active: id, maximized: l.maximized === null ? null : id }));
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        update((l) => ({ ...l, maximized: l.maximized === null ? l.active : null }));
        e.preventDefault();
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        void run(`HELP ${active.fn}`);
        return;
      }
      if (inField || inCmd) return;
      if (e.key === 'Escape') {
        back();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        // Typing anywhere goes to the command line; `/` just focuses it.
        e.preventDefault();
        if (e.key !== '/') setInput((v) => v + e.key);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Two columns: panels 1, 3 on the left and 2, 4 on the right. A maximized panel hides the
  // others with CSS, so they stay mounted and come back without reloading.
  const sizes = sizesOf(layout);
  const columns = [layout.panels.filter((_, i) => i % 2 === 0), layout.panels.filter((_, i) => i % 2 === 1)].filter((c) => c.length > 0);

  return (
    <div className={`terminal ${layout.maximized !== null ? 'maxed' : ''}`}>
        <div className="top">
          <label className="prompt" htmlFor="cmd">
            {active.id}&gt;
          </label>
          <input
            id="cmd"
            ref={inputRef}
            className="cmd"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setHistIdx(null);
            }}
            onKeyDown={onInputKey}
            placeholder="AAPL GP 1Y <GO> · HELP"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <div className="clocks">
            {CLOCKS.map((c) => (
              <span key={c.label}>
                <span className="lbl">{c.label}</span> {clockTime(c.tz, new Date(now))}
              </span>
            ))}
          </div>
        </div>
        <div className={`msg ${msg?.kind ?? ''}`}>{msg?.text ?? ''}</div>
        <main className="panels" style={{ '--col': sizes.col } as CSSProperties}>
          {columns.map((col, c) => (
            <Fragment key={c}>
              {c > 0 && <Splitter dir="col" onChange={(col) => update((l) => ({ ...l, sizes: { ...sizesOf(l), col } }))} />}
              <div className={`pcol ${col.some((p) => p.id === layout.maximized) ? 'has-max' : ''}`} style={{ '--row': sizes.rows[c] ?? 0.5 } as CSSProperties}>
                {col.map((p, i) => (
                  <Fragment key={p.id}>
                    {i === 1 && (
                      <Splitter
                        dir="row"
                        onChange={(row) =>
                          update((l) => {
                            const s = sizesOf(l);
                            s.rows[c] = row;
                            return { ...l, sizes: s };
                          })
                        }
                      />
                    )}
                    <Panel
                      panel={p}
                      active={p.id === active.id}
                      maximized={layout.maximized === p.id}
                      nav={navs.get(p.id)!}
                      drill={drillFor(p.id)}
                      onFocus={() => p.id !== latest.current.active && update((l) => ({ ...l, active: p.id }))}
                      onGroup={(group) => update((l) => mapPanel(l, p.id, (x) => ({ ...x, group })))}
                      // Phones stack the panels in their numbered order.
                      style={{ '--order': layout.panels.indexOf(p) } as CSSProperties}
                    />
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </main>
    </div>
  );
}
