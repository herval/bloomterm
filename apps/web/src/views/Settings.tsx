import { useEffect, useState } from 'react';
import { api, get, signOut } from '../api.ts';
import { useSetup } from '../data.ts';
import { useDaemon } from '../feeds.ts';
import type { ViewProps } from '../functions.ts';
import { quitChrome, systemName, vault } from '../platform.ts';
import { Link } from '../router.tsx';
import { YourIntegrations } from './Review.tsx';

interface Secret {
  name: string;
  label: string;
  provider: string;
  covers: string;
  signup: string;
  from: 'env' | 'keychain' | null;
}

/** SET: API keys go into the Keychain or Credential Manager through bloomd. They're never sent back here. */
export default function Settings({ nav }: ViewProps) {
  const { status, sources, refresh } = useDaemon();
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => get<Secret[]>('/api/settings/secrets').then(setSecrets, (e) => nav.message((e as Error).message, 'error'));
  useEffect(() => void load(), []);

  async function save(name: string) {
    const value = (drafts[name] ?? '').trim();
    if (!value) return;
    setBusy(name);
    try {
      await api('PUT', `/api/settings/secrets/${name}`, { value });
      setDrafts((d) => ({ ...d, [name]: '' }));
      nav.message(`saved ${name} to your ${vault}`);
      await load();
    } catch (e) {
      nav.message((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    setBusy(name);
    try {
      await api('DELETE', `/api/settings/secrets/${name}`);
      nav.message(`removed ${name} from your ${vault}`);
      await load();
    } catch (e) {
      nav.message((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  // Same as `bt profile open`: bloomd closes its own Chrome for the profile and opens it in plain Chrome.
  async function openProfile(name: string) {
    setBusy(`profile:${name}`);
    try {
      await api('POST', `/api/profiles/${name}/open`, {});
      nav.message(`opened the ${name} profile in Chrome; ${quitChrome} when you're done, and jobs on it go again`);
      refresh();
    } catch (e) {
      nav.message((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="scroll settings">
      <div className="section">API keys</div>
      <p className="muted">Saved in your {systemName} {vault} (service “bloomterm”). bloomd reads them when it fetches; this page only sees whether each is set.</p>
      <table className="grid keys">
        <tbody>
          {secrets?.map((s) => (
            <tr key={s.name}>
              <td className="sec">{s.label}</td>
              <td className="muted">
                {s.covers} ·{' '}
                <a href={s.signup} target="_blank" rel="noreferrer">
                  get one
                </a>
              </td>
              <td className={s.from ? 'up' : 'warn-t'}>{s.from === 'env' ? 'set (environment)' : s.from ? 'set' : 'not set'}</td>
              <td>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(s.name);
                  }}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={s.from ? 'replace…' : 'paste key'}
                    value={drafts[s.name] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
                    aria-label={s.label}
                  />
                  <button type="submit" disabled={busy === s.name || !(drafts[s.name] ?? '').trim()}>
                    save
                  </button>
                  {s.from === 'keychain' && (
                    <button type="button" disabled={busy === s.name} onClick={() => void remove(s.name)}>
                      remove
                    </button>
                  )}
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section">Browser</div>
      <p className="muted">
        The Chrome profiles bloomd signs in and fetches with, separate from your own Chrome. Open one to sign in to a site or look around: it
        opens as a plain Chrome, which Google and bot checks accept. Jobs on that profile wait until you {quitChrome}.
      </p>
      <ThisComputer />
      <table className="grid keys">
        <tbody>
          {status?.profiles.map((p: any) => (
            <tr key={p.name}>
              <td className="sec">{p.name}</td>
              <td className="muted">
                {sources
                  .filter((s) => s.profile === p.name)
                  .map((s) => s.name)
                  .join(', ') || 'no sources yet'}
              </td>
              <td className={p.running ? 'up' : 'muted'}>{p.running ? 'running' : 'not running'}</td>
              <td>
                <button disabled={busy === `profile:${p.name}`} onClick={() => void openProfile(p.name)}>
                  open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section">Your integrations</div>
      <p className="muted">
        In {status?.home ?? '~/.bloomterm'}/integrations, from EVOLVE or edited by hand. Each runs only as you approved it, in place of the built-in with
        the same name; edit one and it stays off until you approve it again.
      </p>
      <YourIntegrations message={nav.message} />

      <div className="section">bloomd</div>
      {status && (
        <dl className="kv wide">
          <dt>pid</dt>
          <dd>{status.pid}</dd>
          <dt>address</dt>
          <dd>127.0.0.1:{status.port}</dd>
          <dt>data</dt>
          <dd className="muted">{status.home}</dd>
          <dt>up</dt>
          <dd>{Math.round(status.uptimeS / 60)} min</dd>
          <dt>queued</dt>
          <dd>{status.queued}</dd>
        </dl>
      )}
      <p>
        <button
          onClick={() => {
            signOut();
            location.reload();
          }}
        >
          sign this browser out
        </button>
      </p>
    </div>
  );
}

/** Which Chrome bloomd uses, and the way back to Setup (which also checks the agent CLI). */
function ThisComputer() {
  const setup = useSetup();
  if (!setup) return null;
  const chrome = setup.chrome.path && (/^(.*\.app)\//.exec(setup.chrome.path)?.[1] ?? setup.chrome.path);
  return (
    <p className="muted">
      {chrome ? (
        <>
          Chrome: <code>{chrome}</code>.{' '}
        </>
      ) : (
        'No Chrome found. '
      )}
      <Link to="/setup">Setup</Link> checks Chrome and your agent CLI.
    </p>
  );
}
