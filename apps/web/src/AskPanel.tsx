import { useEffect, useRef, useState } from 'react';
import { api, upload } from './api.ts';
import { Empty, useNow } from './components.tsx';
import { useApi } from './data.ts';
import { useDaemon, useDaemonEvents } from './feeds.ts';
import { age } from './format.ts';
import { Icon } from './icons.tsx';
import { Link } from './router.tsx';
import { useShell } from './shell.ts';
import { Conversation, type Chat } from './views/Ask.tsx';
import { size, type ChatFile } from './views/Cards.tsx';

// Ask, as a drawer beside any page and as its own page: your agent CLI answering from
// bloomterm's data. It knows which page you're on. Answers that name securities show them
// as live widgets, and any answer can be pinned to Today. Attach spreadsheets (the clip,
// drop, or paste) and it reads them, writes files back, and proposes imports you confirm.

const ACCEPT = '.xlsx,.xlsm,.xls,.ods,.csv,.tsv';

interface Attached {
  key: number;
  name: string;
  size: number;
  file?: ChatFile;
  error?: string;
}
let attachKeys = 0;

const SUGGESTIONS = ['How is my portfolio doing today, and what drove it?', 'Summarize the news on what I hold.', 'Why did PETR4 move this week?', 'Compare NVDA and AAPL over the last year.', 'Connect my bank account.'];

/** Whether a chat is answering right now, kept current by bloomd's events. */
function useRunning(chatId: string | null): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setRunning(false);
    if (!chatId) return;
    void api<Chat>('GET', `/api/chats/${chatId}`).then((c) => setRunning(!!c.running), () => {});
  }, [chatId]);
  useDaemonEvents((ev) => {
    if (ev.chatId !== chatId) return;
    if (ev.type === 'chat_event') setRunning(true);
    if (ev.type === 'chat_done') setRunning(false);
  });
  return running;
}

export function AskPanel({ chatId, onChat, context, onClose, full }: { chatId: string | null; onChat: (id: string | null) => void; context?: string; onClose?: () => void; full?: boolean }) {
  const shell = useShell();
  const { status } = useDaemon();
  const running = useRunning(chatId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const uploading = attached.some((a) => !a.file && !a.error);
  const ready = attached.flatMap((a) => (a.file ? [a.file.id] : []));

  const attach = (list: FileList | File[] | null) => {
    for (const f of Array.from(list ?? []).slice(0, 10)) {
      const key = ++attachKeys;
      setAttached((xs) => [...xs, { key, name: f.name, size: f.size }]);
      void upload<ChatFile>(f).then(
        (file) => setAttached((xs) => xs.map((x) => (x.key === key ? { ...x, file } : x))),
        (err) => setAttached((xs) => xs.map((x) => (x.key === key ? { ...x, error: (err as Error).message } : x))),
      );
    }
    box.current?.focus();
  };
  const chats = useApi<Chat[]>('/api/chats', { refreshOn: (ev) => ev.type === 'chat_done' });
  const current = chats.data?.find((c) => c.id === chatId);
  useEffect(() => box.current?.focus(), [chatId]);

  const send = async (message: string) => {
    if ((!message.trim() && !ready.length) || busy || uploading) return;
    setBusy(true);
    try {
      const r = await api<{ chatId: string }>('POST', '/api/chats', { message: message.trim() || undefined, chatId: chatId ?? undefined, context, files: ready.length ? ready : undefined });
      setText('');
      setAttached([]);
      onChat(r.chatId);
      chats.reload();
    } catch (err) {
      shell.toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const agent = status?.agent;
  const kind = chatId ? current?.kind : 'ask';
  return (
    <div
      className={`askpanel ${full ? 'full' : ''} ${drag ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!agent || kind === 'evolve' || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
      }}
      onDrop={(e) => {
        if (!drag) return;
        e.preventDefault();
        setDrag(false);
        attach(e.dataTransfer.files);
      }}
    >
      {drag && (
        <div className="dropzone">
          <Icon name="sheet" size={22} />
          Drop a spreadsheet to attach it
          <span className="mut small">.xlsx .xls .csv .ods · up to 25 MB</span>
        </div>
      )}
      <header className="askhead">
        <Icon name="spark" size={14} className="amber" />
        <span className="ct">{current ? (current.kind === 'evolve' ? `EVOLVE ${current.meta.integration}` : current.title) : 'Ask'}</span>
        <span className="spacer" />
        {chatId && (
          <button className="btn xs" onClick={() => onChat(null)} title="New conversation">
            <Icon name="plus" size={12} /> New
          </button>
        )}
        {!full && (
          <Link to={chatId ? `/ask/${chatId}` : '/ask'} className="btn xs" title="Open as a page" onClick={onClose}>
            <Icon name="expand" size={12} />
          </Link>
        )}
        {onClose && (
          <button className="btn xs" onClick={onClose} aria-label="Close Ask">
            <Icon name="close" size={12} />
          </button>
        )}
      </header>
      <div className="askbody">
        {chatId ? (
          <Conversation chatId={chatId} run={shell.run} pinnable foot="none" />
        ) : (
          <div className="askintro">
            {!agent && (
              <Empty>
                Ask runs on your Claude Code or Codex. <Link to="/setup">Setup</Link> says how to add one.
              </Empty>
            )}
            {agent && (
              <>
                <p className="mut">
                  Answers come from bloomterm's own data: quotes, history, your watchlists and positions, news and filings, source health. Nothing can trade.
                </p>
                <div className="suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="sugg" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {chats.data && chats.data.length > 0 && <RecentChats chats={chats.data} onOpen={onChat} />}
          </div>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        {context && <span className="ctx chip">on: {context}</span>}
        {attached.length > 0 && (
          <div className="attached" aria-label="Attached files">
            {attached.map((a) => (
              <span key={a.key} className={`chip fchip ${a.error || a.file?.error ? 'warnchip' : ''}`} title={a.error ?? a.file?.error ?? undefined}>
                <Icon name="sheet" size={12} />
                {a.name}
                <span className="mut">{a.error ? 'failed' : !a.file ? 'uploading…' : a.file.error ? "can't read" : `${a.file.sheets.reduce((n, x) => n + x.rows, 0)} rows · ${size(a.size)}`}</span>
                <button type="button" className="x" aria-label={`Remove ${a.name}`} onClick={() => setAttached((xs) => xs.filter((x) => x.key !== a.key))}>
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="cbox">
          {kind !== 'evolve' && (
            <>
              <input ref={picker} type="file" accept={ACCEPT} multiple hidden aria-label="Attach spreadsheets" onChange={(e) => (attach(e.target.files), (e.target.value = ''))} />
              <button type="button" className="btn sm ghost attachbtn" title="Attach a spreadsheet (.xlsx .xls .csv)" aria-label="Attach a file" disabled={!agent} onClick={() => picker.current?.click()}>
                <Icon name="attach" size={14} />
              </button>
            </>
          )}
          <textarea
            ref={box}
            aria-label="Ask a question"
            rows={2}
            placeholder={attached.length ? 'Ask about the file, or just send it…' : chatId ? 'Follow up…' : 'Ask about your money, a ticker, the news…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length && kind !== 'evolve') {
                e.preventDefault();
                attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
              if (e.key === 'Escape' && onClose) onClose();
            }}
          />
          {running ? (
            <button type="button" className="btn sm" onClick={() => void api('POST', `/api/chats/${chatId}/stop`).catch(() => {})}>
              <Icon name="stop" size={12} /> Stop
            </button>
          ) : (
            <button type="submit" className="btn sm primary" disabled={(!text.trim() && !ready.length) || uploading || busy || !agent} aria-label="Send">
              <Icon name="send" size={13} />
            </button>
          )}
        </div>
        <span className="mut small">{agent ? `${agent.kind} · read-only tools · attach .xlsx/.csv · Enter sends, Shift+Enter for a new line` : 'no agent CLI'}</span>
      </form>
    </div>
  );
}

function RecentChats({ chats, onOpen }: { chats: Chat[]; onOpen: (id: string) => void }) {
  const now = useNow(30_000);
  return (
    <div className="recent">
      <div className="lbl">Recent</div>
      {chats.slice(0, 20).map((c) => (
        <button key={c.id} className="recentrow" onClick={() => onOpen(c.id)}>
          {c.kind === 'evolve' && <span className="chip xs amber">EVOLVE {c.meta.integration}</span>}
          <span className="grow ellipsis">{c.kind === 'evolve' ? c.title.replace(/^EVOLVE [^:]+: /, '') : c.title}</span>
          <span className="mut small">{age(c.updatedAt, now)}</span>
        </button>
      ))}
    </div>
  );
}
