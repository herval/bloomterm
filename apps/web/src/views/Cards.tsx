import { useState } from 'react';
import { api, download } from '../api.ts';
import { useApi } from '../data.ts';
import { age, money } from '../format.ts';
import { Icon } from '../icons.tsx';
import { vault } from '../platform.ts';
import { Link } from '../router.tsx';
import { useShell } from '../shell.ts';
import type { Chat } from './Ask.tsx';

// What the agent hands back in Ask (SPEC §10.5): files to download, and cards proposing
// something only you can do. A card does nothing until you click it.

export interface ChatFile {
  id: string;
  seq: number | null;
  origin: 'upload' | 'agent';
  name: string;
  size: number;
  sheets: { name: string; rows: number; cols: number }[];
  error: string | null;
}

export interface ChatAction {
  id: string;
  seq: number;
  kind: 'import' | 'connect';
  status: 'pending' | 'done' | 'dismissed' | 'failed';
  data: any;
  result: any;
  error: string | null;
  updatedAt: string;
}

export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const sheetsLine = (f: ChatFile) => (f.error ? "couldn't be read" : f.sheets.length === 1 ? `${f.sheets[0]!.rows} rows` : `${f.sheets.length} sheets`);

/** A file in the conversation; click to download it. */
export function FileChip({ file, big }: { file: ChatFile; big?: boolean }) {
  const shell = useShell();
  const save = () =>
    void download(file.id, file.name)
      .then((path) => path && shell.toast(`Saved to ${path.replace(/^\/Users\/[^/]+\//, '~/')}`))
      .catch((err) => shell.toast((err as Error).message, 'error'));
  if (big) {
    return (
      <button className="fileout" onClick={save} title={`Download ${file.name}`} aria-label={`Download ${file.name}`}>
        <Icon name="sheet" size={18} className="amber" />
        <span className="grow">
          <b>{file.name}</b>
          <span className="mut small">
            {size(file.size)} · {file.sheets.map((s) => `${s.name}: ${s.rows} rows`).join(', ')}
          </span>
        </span>
        <span className="btn xs">
          <Icon name="download" size={12} /> Download
        </span>
      </button>
    );
  }
  return (
    <button className={`chip fchip ${file.error ? 'warnchip' : ''}`} onClick={save} title={file.error ?? `Download ${file.name}`} aria-label={`Download ${file.name}`}>
      <Icon name="sheet" size={12} />
      {file.name}
      <span className="mut">{sheetsLine(file)}</span>
    </button>
  );
}

function useStep(a: ChatAction) {
  const shell = useShell();
  const [busy, setBusy] = useState<string | null>(null);
  const step = async (s: 'apply' | 'open' | 'evolve' | 'fetch' | 'dismiss') => {
    setBusy(s);
    try {
      await api('POST', `/api/actions/${a.id}/${s}`);
    } catch (err) {
      shell.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return { busy, step };
}

export function ActionCard({ action, files }: { action: ChatAction; files: ChatFile[] }) {
  return action.kind === 'import' ? <ImportCard a={action} files={files} /> : <ConnectCard a={action} />;
}

const STATUS = { pending: 'waiting for you', done: 'done', dismissed: 'discarded', failed: 'failed' } as const;

function ImportCard({ a, files }: { a: ChatAction; files: ChatFile[] }) {
  const { busy, step } = useStep(a);
  const d = a.data;
  const positions = d.kind === 'positions';
  const rows: any[] = d.rows;
  const file = files.find((f) => f.id === d.file);
  const cols = positions
    ? (['accountExternalId', 'rawSymbol', 'quantity', 'value', 'currency'] as const)
    : (['accountExternalId', 'total', 'cash', 'currency'] as const);
  const label: Record<string, string> = { accountExternalId: 'Account', rawSymbol: 'Symbol', quantity: 'Qty', value: 'Value', currency: '', total: 'Total', cash: 'Cash' };
  const num = (k: string) => k === 'quantity' || k === 'value' || k === 'total' || k === 'cash';
  return (
    <div className={`acard ${a.status}`} aria-label={`Import ${rows.length} ${d.kind}`}>
      <div className="ah">
        <Icon name="portfolio" size={14} className="amber" />
        <b>
          Import {rows.length} {d.kind}
        </b>
        <span className="chip xs m">{d.source} · manual</span>
        <span className="spacer" />
        <span className={`small ${a.status === 'done' ? 'up' : a.status === 'failed' ? 'down' : 'mut'}`}>{STATUS[a.status]}</span>
      </div>
      <div className="mut small">
        {d.title}
        {file && !String(d.title).includes(file.name) ? ` · from ${file.name}` : ''}
      </div>
      <table className="md-table">
        <thead>
          <tr>{cols.map((c) => <th key={c} className={num(c) ? 'r' : ''}>{label[c]}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={num(c) ? 'r m' : ''}>
                  {num(c) ? (c === 'quantity' ? r[c]?.toLocaleString('en-US') : money(r[c])) : (r[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {rows.length > 8 && (
            <tr>
              <td colSpan={cols.length} className="mut">
                and {rows.length - 8} more
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="small">
        Total{' '}
        {Object.entries(d.totals as Record<string, number>)
          .map(([ccy, v]) => money(v, ccy))
          .join(' · ')}
      </div>
      {d.replaces && a.status === 'pending' && (
        <div className="warn-t small">
          Replaces the {d.replaces.rows} {d.kind} bloomterm has from {d.source} ({d.replaces.method}, {age(d.replaces.fetchedAt)} old).
        </div>
      )}
      {a.status === 'pending' && (
        <div className="arow">
          <button className="btn sm primary" disabled={!!busy} onClick={() => void step('apply')}>
            <Icon name="check" size={12} /> Import
          </button>
          <button className="btn sm" disabled={!!busy} onClick={() => void step('dismiss')}>
            Discard
          </button>
          <span className="mut small">Nothing is saved until you click Import.</span>
        </div>
      )}
      {a.status === 'done' && (
        <div className="up small">
          <Icon name="check" size={12} /> Imported {a.result.saved} {d.kind} · <Link to="/portfolio">see Portfolio</Link>
        </div>
      )}
      {a.status === 'failed' && <div className="err">{a.error}</div>}
    </div>
  );
}

function ConnectCard({ a }: { a: ChatAction }) {
  const { busy, step } = useStep(a);
  const d = a.data;
  const pending = a.status === 'pending';
  if (d.mode === 'api') {
    return (
      <div className={`acard ${a.status}`} aria-label={`Connect ${d.name}`}>
        <div className="ah">
          <Icon name="bank" size={14} className="amber" />
          <b>Connect {d.name}</b>
          <span className="chip xs">API key</span>
        </div>
        <div className="small">
          {d.name} connects with an API key, not a sign-in. Paste it in <Link to="/settings">Settings</Link>; it goes to your {vault}.
        </div>
      </div>
    );
  }
  const opened = a.result.openedAt as string | undefined;
  const evolve = a.result.evolve as { chatId: string } | undefined;
  return (
    <div className={`acard ${a.status}`} aria-label={`Connect ${d.name}`}>
      <div className="ah">
        <Icon name="bank" size={14} className="amber" />
        <b>Connect {d.name}</b>
        <span className="chip xs">{d.mode === 'new' ? 'no integration yet' : 'integration ready'}</span>
        <span className="spacer" />
        {a.status === 'dismissed' && <span className="mut small">dismissed</span>}
      </div>
      <ol className="steps">
        <li className={opened ? 'did' : ''}>
          <div>
            <b>Sign in</b>{' '}
            {d.mode === 'new' ? (
              <>
                at <span className="m">{d.host}</span> in bloomterm's {d.profile} browser.
              </>
            ) : (
              <>to {d.name} in its own browser window.</>
            )}
          </div>
          <div className="mut small">
            <Icon name="lock" size={11} /> You type your password and codes there yourself. bloomterm and the agent never see them.
          </div>
          {pending && (
            <button className="btn sm primary" disabled={!!busy} onClick={() => void step('open')}>
              {opened ? 'Open it again' : d.mode === 'new' ? 'Open sign-in window' : 'Sign in'}
            </button>
          )}
          {opened && <span className="up small"> <Icon name="check" size={11} /> opened {age(opened)} ago</span>}
        </li>
        {d.mode === 'new' ? (
          <>
            <li className={evolve ? 'did' : ''}>
              <div>
                <b>Map it</b>: EVOLVE reads the site read-only (writes are blocked) and writes the <span className="m">{d.integration}</span> integration, in a folder of its own.
              </div>
              {pending && (
                <button className="btn sm" disabled={!!busy} onClick={() => void step('evolve')}>
                  <Icon name="spark" size={12} /> Map it with EVOLVE
                </button>
              )}
              {evolve && <EvolveLink run={evolve} />}
            </li>
            <li>
              <div>
                <b>Review and approve</b> its work yourself, in the EVOLVE run. Nothing of it runs until you do.
              </div>
            </li>
          </>
        ) : (
          <li className={a.result.jobs ? 'did' : ''}>
            <div>
              <b>Fetch</b> your accounts, balances and positions.
            </div>
            {pending && (
              <button className="btn sm" disabled={!!busy} onClick={() => void step('fetch')}>
                Fetch now
              </button>
            )}
            {a.result.jobs && (
              <span className="up small">
                <Icon name="check" size={11} /> {a.result.jobs.length} fetches queued · <Link to="/jobs">Jobs</Link>
              </span>
            )}
          </li>
        )}
      </ol>
      {pending && (
        <div className="arow">
          <button className="btn xs ghost" onClick={() => void step('dismiss')}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** The EVOLVE run a card started, and where it is. */
function EvolveLink({ run }: { run: { chatId: string } }) {
  const { data } = useApi<Chat>(`/api/chats/${run.chatId}`, { refreshOn: (ev) => ev.type === 'chat_done' && ev.chatId === run.chatId });
  const m = data?.meta;
  return (
    <div className="small">
      <Link to={`/ask/${run.chatId}`}>EVOLVE {m?.integration ?? ''}</Link> ·{' '}
      {data?.running ? (
        <span className="amber">working</span>
      ) : m?.approved ? (
        <span className="up">approved</span>
      ) : m?.checks ? (
        m.checks.ok ? <span className="up">checks pass; review it</span> : <span className="down">checks fail</span>
      ) : (
        <span className="mut">not checked</span>
      )}
    </div>
  );
}
