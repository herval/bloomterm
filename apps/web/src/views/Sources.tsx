import { useEffect, useState } from 'react';
import { useNow } from '../components.tsx';
import { get } from '../api.ts';
import { useDaemon } from '../feeds.ts';
import { age } from '../format.ts';
import type { ViewProps } from '../functions.ts';

const STATE_CLASS: Record<string, string> = { ok: 'up', needs_login: 'warn-t', challenge: 'warn-t', blocked: 'down', unknown: 'muted' };
const STATE_LABEL: Record<string, string> = { ok: 'OK', needs_login: 'SIGN-IN NEEDED', challenge: 'VERIFY', blocked: 'BLOCKED', unknown: 'unknown' };

interface Integration {
  id: string;
  name: string;
  covers: string;
  access: 'api' | 'browser';
  status: 'ready' | 'draft';
  provides: string[];
  secrets: string[];
}

export default function Sources({ nav, drill }: ViewProps) {
  const { sources } = useDaemon();
  const now = useNow(15_000);
  const [secrets, setSecrets] = useState<Array<{ name: string; from: string | null }>>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  useEffect(() => {
    void get<typeof secrets>('/api/settings/secrets').then(setSecrets, () => {});
    void get<Integration[]>('/api/integrations').then(setIntegrations, () => {});
  }, []);
  // Market data comes from the integrations that provide it; whether each works depends on its keys in SET.
  const market = integrations.filter((i) => i.provides.includes('market'));
  const has = (name: string) => secrets.some((s) => s.name === name && s.from);

  drill.current = (row) => {
    const s = sources[row - 1];
    if (s) nav.open({ fn: 'JOBS', args: [s.id] });
    else nav.message(`no row ${row}`, 'error');
  };

  return (
    <div className="scroll">
      <div className="section">Browser sources</div>
      <table className="grid">
        <thead>
          <tr>
            <th className="n">#</th>
            <th>Source</th>
            <th>Session</th>
            <th className="r">Since</th>
            <th>Datasets (last good · next)</th>
            <th>Profile</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s, i) => (
            <tr key={s.id} onClick={() => nav.open({ fn: 'JOBS', args: [s.id] })}>
              <td className="n">{i + 1}</td>
              <td className="sec" title={s.name}>
                {s.id}
                {s.status === 'draft' && <span className="muted"> draft · EVOLVE {s.id}</span>}
              </td>
              <td className={STATE_CLASS[s.session.state] ?? ''} title={s.session.lastError ?? ''}>
                {STATE_LABEL[s.session.state] ?? s.session.state}
                {s.session.state === 'needs_login' && <span className="muted"> · LOGIN {s.id}</span>}
              </td>
              <td className="r muted">{Date.parse(s.session.since) > 0 ? age(s.session.since, now) : '—'}</td>
              <td>
                {s.datasets.map((d) => (
                  <span key={d.name} className="ds">
                    {d.name} <span className="muted">{d.lastOk ? age(d.lastOk, now) : 'never'}</span>
                    {d.next && <span className="muted"> · {new Date(d.next).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
                  </span>
                ))}
              </td>
              <td className="muted">{s.profile}</td>
            </tr>
          ))}
          {sources.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No browser sources registered.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="section">Market data</div>
      <table className="grid">
        <tbody>
          {market.map((m) => {
            const ready = m.secrets.every(has);
            return (
              <tr key={m.id}>
                <td className="sec" title={m.name}>
                  {m.id}
                  {m.status === 'draft' && <span className="muted"> draft</span>}
                </td>
                <td>{m.covers}</td>
                <td className={ready ? 'up' : 'warn-t'}>{m.secrets.length === 0 ? 'no key needed' : ready ? 'key set' : 'no key'}</td>
                <td className="muted">{!ready && m.secrets.length > 0 && 'SET <GO> to add it'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
