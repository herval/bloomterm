import { parseCommand, RANGES, type Range } from '@bloomterm/core/web';
import { useEffect, useRef, useState } from 'react';
import { get } from '../api.ts';
import { Empty, PriceChart, useNow } from '../components.tsx';
import { useSparks } from '../data.ts';
import { isQuote, useBars, useDaemon, useDaemonEvents, useQuotes } from '../feeds.ts';
import { age, pct, price } from '../format.ts';
import { FN_SET, type ViewProps } from '../functions.ts';
import { Icon } from '../icons.tsx';
import { Markdown } from '../markdown.tsx';
import { usePins } from '../pins.ts';
import { Link, secPath } from '../router.tsx';
import { cls, Spark, ticker } from '../ui.tsx';
import { ActionCard, FileChip, type ChatAction, type ChatFile } from './Cards.tsx';
import { RunReview, type Checks } from './Review.tsx';

// ASK (SPEC §10.2): a conversation with your agent CLI about bloomterm's data. The command
// line is the input; this panel shows the conversation, streaming as the answer arrives.
// EVOLVE runs (§6.11) show here too: the agent working on a copy of an integration, which runs
// only once you review and approve it.

interface Tool {
  name: string;
  input?: unknown;
  ok?: boolean;
}
interface Message {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  tools: Tool[];
  status: 'running' | 'done' | 'error';
  error: string | null;
}
interface EvolveMeta {
  integration: string;
  /** The run's folder; runs from older bloomterms had a git branch instead. */
  dir?: string;
  from?: 'yours' | 'built-in' | 'new';
  checks?: Checks;
  approved?: { hash: string; at: string };
  branch?: string;
}
export interface Chat {
  id: string;
  title: string;
  agent: string;
  kind: 'ask' | 'evolve';
  meta: Partial<EvolveMeta>;
  updatedAt: string;
  running?: boolean;
  messages?: Message[];
  files?: ChatFile[];
  actions?: ChatAction[];
}

const short = (name: string) => name.replace(/^mcp__bloomterm__/, '').replace(/^mcp__/, '');

function toolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const vals = Object.values(input as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return vals
    .filter((v) => typeof v === 'number' || (typeof v === 'string' && /[\p{L}\p{N}]/u.test(v)))
    .join(', ')
    .slice(0, 80);
}

export default function Ask({ panel, nav, drill }: ViewProps) {
  const chatId = panel.args[0];
  return chatId ? <Conversation chatId={chatId} run={nav.run} /> : <ChatList nav={nav} drill={drill} />;
}

function ChatList({ nav, drill }: Pick<ViewProps, 'nav' | 'drill'>) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const { status } = useDaemon();
  const now = useNow(30_000);
  useEffect(() => {
    void get<Chat[]>('/api/chats').then(setChats, () => setChats([]));
  }, []);
  drill.current = (row) => {
    const c = chats?.[row - 1];
    if (c) nav.setArgs([c.id]);
  };
  const agent = status?.agent;
  return (
    <div className="scroll ask">
      <div className="section">Ask</div>
      <p className="muted">
        Type a question in the command line and press Enter{agent ? ` (answered by ${agent.kind} ${agent.version.split(' ')[0]})` : ''}. It reads bloomterm's own data:
        quotes, history, your watchlist, positions and source health. Start with <b>?</b> to force a question.
        <br />
        <b>EVOLVE</b> &lt;source&gt; [goal] has it build or fix an integration, which runs once you approve it, e.g. <code>EVOLVE b3</code>.
      </p>
      {chats && chats.length > 0 && (
        <table className="grid">
          <tbody>
            {chats.map((c, i) => (
              <tr key={c.id} onClick={() => nav.setArgs([c.id])}>
                <td className="n">{i + 1}</td>
                <td>
                  {c.kind === 'evolve' && <span className="tag">EVOLVE {c.meta.integration}</span>}
                  {c.kind === 'evolve' ? c.title.replace(/^EVOLVE [^:]+: /, '') : c.title}
                </td>
                <td className="r muted">{c.agent}</td>
                <td className="r muted">{age(c.updatedAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * One conversation, streaming as the answer arrives. `pinnable` adds Pin to Today under
 * each answer; answers that name securities as commands show them as quote tiles and a chart.
 */
export function Conversation({ chatId, run, pinnable, foot = 'terminal' }: { chatId: string; run: (cmd: string) => void; pinnable?: boolean; foot?: 'terminal' | 'none' }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ seq: number; text: string; tools: Tool[] } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = () =>
    get<Chat>(`/api/chats/${chatId}`).then(
      (c) => {
        setChat(c);
        setError(null);
        const running = c.messages?.find((m) => m.status === 'running');
        setLive((l) => (running ? (l?.seq === running.seq ? l : { seq: running.seq, text: '', tools: [] }) : null));
      },
      (err) => setError((err as Error).message),
    );

  useEffect(() => {
    setChat(null);
    setLive(null);
    void load();
  }, [chatId]);

  useDaemonEvents((ev) => {
    if (ev.chatId !== chatId) return;
    if (ev.type === 'chat_done' || ev.type === 'chat_file' || ev.type === 'chat_action') return void load();
    if (ev.type !== 'chat_event') return;
    const e = ev.event;
    setLive((l) => {
      // A new question started somewhere else (the command line): pick it up.
      const cur = l && l.seq === ev.seq ? l : { seq: ev.seq, text: '', tools: [] };
      if (e.type === 'text') return { ...cur, text: cur.text + e.text };
      if (e.type === 'tool') return { ...cur, tools: [...cur.tools, { name: e.name, input: e.input }] };
      if (e.type === 'tool_result') {
        const tools = [...cur.tools];
        const i = tools.map((t) => t.ok).lastIndexOf(undefined);
        if (i >= 0) tools[i] = { ...tools[i]!, ok: e.ok };
        return { ...cur, tools };
      }
      return cur;
    });
    if (!chat?.messages?.some((m) => m.seq === ev.seq)) void load();
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages?.length, live?.text.length, live?.tools.length]);

  if (error) return <Empty>{error}</Empty>;
  if (!chat) return <Empty>Loading…</Empty>;
  const evolve = chat.kind === 'evolve' ? (chat.meta as EvolveMeta) : null;
  return (
    <div className="scroll ask">
      {evolve && (
        <div className="evolve-head">
          <span className="tag">EVOLVE {evolve.integration}</span>{' '}
          <span className="muted">{evolve.from === 'yours' ? 'your copy' : evolve.from === 'built-in' ? "a copy of bloomterm's built-in" : evolve.from === 'new' ? 'new' : `old run, on ${evolve.branch}`}</span>
        </div>
      )}
      {chat.messages?.map((m) => {
        const files = chat.files?.filter((f) => f.seq === m.seq) ?? [];
        if (m.role === 'user') {
          return (
            <div key={m.seq} className="qwrap">
              {files.length > 0 && (
                <div className="qfiles">
                  {files.map((f) => (
                    <FileChip key={f.id} file={f} />
                  ))}
                </div>
              )}
              <div className="q">
                <span className="prompt-mark">?</span> {m.text}
              </div>
            </div>
          );
        }
        const actions = chat.actions?.filter((x) => x.seq === m.seq) ?? [];
        const running = m.status === 'running';
        const text = running && live?.seq === m.seq ? live.text : m.text;
        const tools = running && live?.seq === m.seq ? live.tools : m.tools;
        return (
          <div key={m.seq} className="a">
            {tools.map((t, i) => (
              <div key={i} className="tool">
                ↳ {short(t.name)} <span className="muted">{toolArgs(t.input)}</span> {t.ok === undefined ? <span className="muted">…</span> : t.ok ? <span className="up">✓</span> : <span className="down">✗</span>}
              </div>
            ))}
            {text && <Markdown text={text} run={run} />}
            {files.map((f) => (
              <FileChip key={f.id} file={f} big />
            ))}
            {actions.map((x) => (
              <ActionCard key={x.id} action={x} files={chat.files ?? []} />
            ))}
            {running && <div className="muted thinking">{text ? '' : 'thinking'}▍</div>}
            {m.status === 'error' && <div className="err">✗ {m.error}</div>}
            {m.status === 'done' && !evolve && pinnable && <AnswerWidgets text={m.text} />}
            {m.status === 'done' && !evolve && pinnable && <PinButton chatId={chatId} seq={m.seq} question={chat.messages?.find((x) => x.seq === m.seq - 1)?.text ?? chat.title} text={m.text} />}
          </div>
        );
      })}
      <div ref={bottom} />
      {evolve && !chat.running && <EvolveFoot chatId={chatId} meta={evolve} onChange={() => void load()} />}
      {foot === 'terminal' && (
        <div className="muted ask-foot">
          {chat.agent} · {chat.running ? 'working — ASK STOP to stop' : 'type a follow-up in the command line'}
        </div>
      )}
    </div>
  );
}

function PinButton({ chatId, seq, question, text }: { chatId: string; seq: number; question: string; text: string }) {
  const pins = usePins();
  const pinned = pins.isPinned(chatId, seq);
  return (
    <div className="answer-actions">
      <button className={`btn sm ${pinned ? 'on' : ''}`} onClick={() => (pinned ? pins.remove(pins.pins.find((p) => p.chatId === chatId && p.seq === seq)!.id) : pins.add({ title: question.replace(/^\[context:[^\]]*\]\s*/, ''), text, chatId, seq }))}>
        <Icon name="pin" size={13} /> {pinned ? 'Pinned to Today' : 'Pin to Today'}
      </button>
    </div>
  );
}

/** The securities an answer names as commands (`PETR4 GP 1Y`), and the chart it points at. */
export function answerRefs(text: string): { keys: string[]; chart?: { key: string; range: Range } } {
  const keys: string[] = [];
  let chart: { key: string; range: Range } | undefined;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const c = parseCommand(m[1]!, FN_SET);
    if (c.kind !== 'go' || !c.security) continue;
    if (!keys.includes(c.security.key)) keys.push(c.security.key);
    const range = c.args.map((a) => a.toUpperCase()).find((a): a is Range => (RANGES as readonly string[]).includes(a));
    if (!chart && c.fn === 'GP') chart = { key: c.security.key, range: range ?? '1Y' };
  }
  return { keys: keys.slice(0, 4), chart };
}

/** An answer's securities as live widgets: the same tiles and chart the pages use. */
export function AnswerWidgets({ text }: { text: string }) {
  const { keys, chart } = answerRefs(text);
  const quotes = useQuotes(keys);
  const spark = useSparks(keys);
  if (!keys.length) return null;
  return (
    <div className="widgets">
      {chart && <MiniChart k={chart.key} range={chart.range} />}
      <div className="tiles">
        {keys.map((k) => {
          const q = quotes.get(k);
          return (
            <Link key={k} to={secPath(k)} className="tile">
              <span className="tt">{ticker(k)}</span>
              <span className="m">{isQuote(q) ? price(q.last, k) : '—'}</span>
              <span className={`m ${isQuote(q) ? cls(q.changePct) : 'mut'}`}>{isQuote(q) ? pct(q.changePct) : ''}</span>
              <Spark closes={spark(k)} height={20} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function MiniChart({ k, range }: { k: string; range: Range }) {
  const { series } = useBars(k, range);
  return (
    <Link to={secPath(k, { range })} className="minichart" title={`${k} · ${range}`}>
      <span className="mut">
        {ticker(k)} · {range}
      </span>
      <div className="mc">{series && series.bars.length > 1 ? <PriceChart bars={series.bars} mode="area" intraday={series.interval === '5m'} /> : null}</div>
    </Link>
  );
}

/** Where an EVOLVE run's work stands: bloomd's checks, then your review and approval. */
function EvolveFoot({ chatId, meta, onChange }: { chatId: string; meta: EvolveMeta; onChange: () => void }) {
  if (!meta.dir) {
    return (
      <div className="evolve-foot muted">
        This run is from an older bloomterm, on the git branch {meta.branch}. Start a new one with <code>EVOLVE {meta.integration}</code>.
      </div>
    );
  }
  return (
    <div className="evolve-foot">
      <RunReview chatId={chatId} integration={meta.integration} checks={meta.checks} approved={meta.approved} onChange={onChange} />
    </div>
  );
}
