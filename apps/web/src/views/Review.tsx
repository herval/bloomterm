import { useEffect, useState } from 'react';
import { api, get } from '../api.ts';
import { useDaemon } from '../feeds.ts';
import { age } from '../format.ts';

// Your integrations (SPEC §6.11): EVOLVE's work, and your own edits, run only once you approve
// them. You approve exactly the files you reviewed: the diff's hash goes with the approval.

export interface Checks {
  load: boolean;
  typecheck: boolean;
  tests: boolean;
  readme: boolean;
  ok: boolean;
  output: string;
}
export interface Diff {
  base: 'yours' | 'built-in' | 'none';
  diff: string;
  hash: string;
}
interface Local {
  id: string;
  state: 'on' | 'changed' | 'unapproved' | 'error';
  hash: string;
  approved: { hash: string; at: string; run?: string } | null;
  replaces: boolean;
  running: boolean;
  error?: string;
}

export function ChecksLine({ checks }: { checks: Checks }) {
  const part = (label: string, ok: boolean) => <span className={ok ? 'up' : 'down'}>{`${ok ? '✓' : '✗'} ${label}`}</span>;
  return (
    <div className="checks">
      bloomd's checks: {part('loads', checks.load)} · {part('typecheck', checks.typecheck)} · {part('tests', checks.tests)} · {part('README', checks.readme)}
      {!checks.ok && checks.output && (
        <details>
          <summary className="muted">what failed</summary>
          <pre className="diff">{checks.output}</pre>
        </details>
      )}
    </div>
  );
}

const BASE: Record<Diff['base'], string> = { yours: 'your approved version', 'built-in': "bloomterm's built-in", none: 'nothing: it’s new' };

const lineClass = (l: string) =>
  l.startsWith('diff ') || l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined;

export function DiffView({ diff }: { diff: Diff }) {
  if (!diff.diff) return <div className="muted">no changes against {BASE[diff.base]}</div>;
  return (
    <>
      <div className="muted">against {BASE[diff.base]}</div>
      <pre className="diff">
        {diff.diff.split('\n').map((l, i) => (
          <div key={i} className={lineClass(l)}>
            {l || ' '}
          </div>
        ))}
      </pre>
    </>
  );
}

/** Restarts bloomd when launchd or the desktop app runs it; otherwise says how. */
export function RestartButton() {
  const { status } = useDaemon();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!status?.supervised) return <span className="muted">restart bloomd to run it (it runs in a terminal: stop it and start it again)</span>;
  if (state === 'sent') return <span className="muted">restarting bloomd…</span>;
  return (
    <>
      <button
        className="btn sm"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          api('POST', '/api/restart').then(
            () => setState('sent'),
            (e) => {
              setError((e as Error).message);
              setState('idle');
            },
          );
        }}
      >
        Restart bloomd
      </button>
      {error && <span className="err"> ✗ {error}</span>}
    </>
  );
}

/** Under an EVOLVE run: bloomd's checks, the diff, and Approve once you've looked at it. */
export function RunReview({ chatId, integration, checks, approved, onChange }: { chatId: string; integration: string; checks?: Checks; approved?: { at: string }; onChange: () => void }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = () => step(async () => setDiff(diff ? null : await get<Diff>(`/api/integrations/${integration}/diff?run=${chatId}`)));
  const approve = () =>
    step(async () => {
      await api('POST', `/api/evolve/${chatId}/approve`, { hash: diff!.hash });
      setDiff(null);
      onChange();
    });
  return (
    <>
      {checks ? <ChecksLine checks={checks} /> : <div className="muted">not checked yet</div>}
      {approved ? (
        <div className="evolve-actions">
          <span className="up">✓ approved {age(approved.at)} ago</span> <RestartButton />
        </div>
      ) : (
        <div className="evolve-actions">
          <button className="btn sm" disabled={busy} onClick={() => void review()}>
            {diff ? 'Hide diff' : 'Review diff'}
          </button>
          {diff && (
            <button className="btn sm primary" disabled={busy || !checks?.ok} title={checks?.ok ? 'run these files in place of what runs now' : 'the checks must pass first'} onClick={() => void approve()}>
              Approve {integration}
            </button>
          )}
          {!checks?.ok && <span className="muted">ask EVOLVE to fix what fails, right here</span>}
        </div>
      )}
      {error && <div className="err">✗ {error}</div>}
      {diff && <DiffView diff={diff} />}
    </>
  );
}

const stateText = (l: Local): [string, string] =>
  l.state === 'on'
    ? l.running
      ? ['up', 'running']
      : ['warn-t', 'approved; runs after a restart']
    : l.state === 'changed'
      ? ['warn-t', 'off: changed since you approved it']
      : l.state === 'unapproved'
        ? ['warn-t', 'off: not approved']
        : ['down', `off: didn’t load: ${l.error}`];

/** SET: the integrations in your data folder, from EVOLVE or edited by hand. */
export function YourIntegrations({ message }: { message: (text: string, kind?: 'info' | 'error') => void }) {
  const [list, setList] = useState<Local[] | null>(null);
  const [open, setOpen] = useState<{ id: string; diff: Diff } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const load = () => get<Local[]>('/api/integrations/local').then(setList, (e) => message((e as Error).message, 'error'));
  useEffect(() => void load(), []);

  async function step(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      message((e as Error).message, 'error');
    } finally {
      setBusy(null);
      void load();
    }
  }
  const review = (id: string) => step(id, async () => setOpen(open?.id === id ? null : { id, diff: await get<Diff>(`/api/integrations/${id}/diff`) }));
  const approve = (id: string) =>
    step(id, async () => {
      await api('POST', `/api/integrations/${id}/approve`, { hash: open!.diff.hash });
      setOpen(null);
      setChanged(true);
      message(`approved ${id}`);
    });
  const remove = (id: string) =>
    step(id, async () => {
      await api('DELETE', `/api/integrations/${id}`);
      setConfirm(null);
      setOpen(null);
      setChanged(true);
      message(`removed your ${id}; its versions stay in integrations/.history`);
    });

  if (!list) return null;
  if (!list.length) return <p className="muted">None yet. EVOLVE makes them, and you approve each one before it runs.</p>;
  return (
    <>
      <table className="grid keys">
        <tbody>
          {list.map((l) => {
            const [cls, text] = stateText(l);
            return (
              <tr key={l.id}>
                <td className="sec">{l.id}</td>
                <td className="muted">
                  {l.replaces ? 'replaces the built-in' : 'new'}
                  {l.approved && ` · approved ${age(l.approved.at)} ago`}
                </td>
                <td className={cls}>{text}</td>
                <td>
                  <button disabled={busy === l.id} onClick={() => void review(l.id)}>
                    {open?.id === l.id ? 'hide' : 'review'}
                  </button>
                  {open?.id === l.id && l.state !== 'on' && (
                    <button disabled={busy === l.id} onClick={() => void approve(l.id)} title="after bloomd's checks pass">
                      approve
                    </button>
                  )}
                  {confirm === l.id ? (
                    <button disabled={busy === l.id} onClick={() => void remove(l.id)}>
                      remove it?
                    </button>
                  ) : (
                    <button disabled={busy === l.id} onClick={() => setConfirm(l.id)}>
                      remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && <DiffView diff={open.diff} />}
      {(changed || list.some((l) => l.state === 'on' && !l.running)) && (
        <p>
          <RestartButton />
        </p>
      )}
    </>
  );
}
