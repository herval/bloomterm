import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useNow } from '../components.tsx';
import { reloadSetup, useSetup, type SetupState } from '../data.ts';
import { useDaemon } from '../feeds.ts';
import { age } from '../format.ts';
import { Icon } from '../icons.tsx';
import { isWindows, shellApp, thisComputer } from '../platform.ts';
import { Link } from '../router.tsx';
import { useShell } from '../shell.ts';
import { Card, PageHead } from '../ui.tsx';

// Setup (SPEC §8.8): what bloomterm needs on this computer, from bloomd's check (apps/daemon/src/setup.ts).
// The first visit comes here while something's missing, and the top bar links here until it's done.

const NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

export default function Setup() {
  const setup = useSetup();
  const { connected, status } = useDaemon();
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(15_000);

  // bloomd restarts to use an agent installed since it started; read setup again once it's back.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (restarting && connected && !wasConnected.current) {
      setRestarting(false);
      reloadSetup();
    }
    wasConnected.current = connected;
  }, [connected, restarting]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const s = await api<SetupState & { restarting: boolean }>('POST', '/api/setup/check');
      reloadSetup(s);
      if (s.restarting) setRestarting(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!setup) return <PageHead title="Setup" sub={`checking ${thisComputer}…`} />;
  const supervised = !!status?.supervised;
  return (
    <div className="setup">
      <PageHead title="Setup" sub={`what bloomterm needs on ${thisComputer}`} />
      <Card>
        <ol className="setupsteps">
          <AgentStep a={setup.agent} supervised={supervised} restarting={restarting} />
          <ChromeStep c={setup.chrome} />
        </ol>
        <div className="setupfoot">
          <button className={`btn sm ${setup.ready ? '' : 'primary'}`} onClick={() => void check()} disabled={checking || restarting}>
            <Icon name="refresh" size={13} />
            {restarting ? 'Restarting bloomd…' : checking ? 'Checking…' : setup.agent.restartNeeded && supervised ? 'Restart bloomd to use it' : 'Check again'}
          </button>
          {setup.ready ? (
            <span>
              All set. <Link to="/">Go to Today</Link>
            </span>
          ) : (
            <span className="mut small">Market data and news work in the meantime.</span>
          )}
          <span className="spacer" />
          <span className="mut small">checked {age(setup.checkedAt, now)} ago</span>
        </div>
        {error && <p className="pad err">{error}</p>}
      </Card>
    </div>
  );
}

function AgentStep({ a, supervised, restarting }: { a: SetupState['agent']; supervised: boolean; restarting: boolean }) {
  const name = a.found ? NAMES[a.found.kind] : null;
  const what = <p>Ask, the morning brief, news stories and EVOLVE run on it, on your own plan: there are no API keys.</p>;
  if (a.inUse && a.signedIn === false) {
    return (
      <Step n={1} title={`Sign in to ${name}`}>
        <p>{name} is installed, but signed out. In {shellApp}, run this and sign in, then check again:</p>
        <Command text={a.signIn ?? ''} />
        {what}
      </Step>
    );
  }
  if (a.inUse) {
    return (
      <Step n={1} ok title={`${NAMES[a.inUse.kind]} ${a.inUse.version.split(' ')[0]}${a.signedIn ? ', signed in' : ''}`}>
        {what}
        {a.signedIn === null && <p className="mut">This version can’t say whether it’s signed in. If it isn’t, Ask will tell you.</p>}
      </Step>
    );
  }
  if (a.found) {
    return (
      <Step n={1} title={`${name} is installed`}>
        {restarting ? (
          <p>bloomd is restarting to use it…</p>
        ) : supervised ? (
          <p>bloomd started before it was there: restart bloomd to use it.</p>
        ) : (
          <>
            <p>bloomd started before it was there. Stop bloomd (Ctrl-C where it runs) and start it again:</p>
            <Command text="bt daemon" />
          </>
        )}
        {a.signedIn === false && (
          <>
            <p>It’s signed out, too. In {shellApp}:</p>
            <Command text={a.signIn ?? ''} />
          </>
        )}
      </Step>
    );
  }
  const other = a.wanted !== 'auto' && a.installed.length > 0;
  return (
    <Step n={1} title="Install Claude Code or Codex">
      <p>bloomterm’s AI is your own coding agent. {isWindows ? 'Install one in PowerShell, from the Start menu:' : 'Install one in Terminal, then sign in to it:'}</p>
      <div className="mut small">Claude Code</div>
      <Command text={a.install.claude} />
      <div className="mut small">or Codex</div>
      <Command text={a.install.codex} />
      {isWindows ? (
        <p className="mut">Then check again here, and this page shows how to sign in.</p>
      ) : (
        <p className="mut">
          npm comes with Node.js, from{' '}
          <a href="https://nodejs.org/" target="_blank" rel="noreferrer">
            nodejs.org
          </a>
          . Then check again here.
        </p>
      )}
      {other && (
        <p>
          config.toml asks for <code>{a.wanted}</code> (<code>[agent] cli</code>), and only {a.installed.map((i) => NAMES[i.kind]).join(' and ')} is installed.
        </p>
      )}
    </Step>
  );
}

function ChromeStep({ c }: { c: SetupState['chrome'] }) {
  const why = <p>bloomterm signs in to your bank and broker accounts in Chrome, in a profile of its own, so it never sees your passwords.</p>;
  if (c.path) {
    const app = /^(.*\.app)\//.exec(c.path)?.[1] ?? c.path;
    return (
      <Step n={2} ok title="Google Chrome">
        {why}
        <p className="mut small">
          <code>{app}</code>
        </p>
      </Step>
    );
  }
  if (c.configured) {
    return (
      <Step n={2} title="Google Chrome isn’t where config.toml says">
        <p>
          <code>[browser] chrome = "{c.configured}"</code>, and there’s no Chrome there. Fix the path, or take the line out and bloomterm finds Chrome by itself.
        </p>
      </Step>
    );
  }
  return (
    <Step n={2} title="Install Google Chrome">
      {why}
      <p>
        <a className="btn sm" href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
          Get Chrome <Icon name="external" size={12} />
        </a>
      </p>
      <p className="mut">Market data and news work without it; your accounts wait for it.</p>
    </Step>
  );
}

function Step({ n, ok = false, title, children }: { n: number; ok?: boolean; title: string; children: ReactNode }) {
  return (
    <li className={`setupstep ${ok ? 'ok' : ''}`} aria-label={`${title}${ok ? ' (done)' : ''}`}>
      <span className="stepmark" aria-hidden="true">
        {ok ? <Icon name="check" size={12} /> : n}
      </span>
      <div>
        <div className="steptitle">{title}</div>
        {children}
      </div>
    </li>
  );
}

/** A command to run, with a Copy button. */
function Command({ text }: { text: string }) {
  const shell = useShell();
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => shell.toast(`Copied. Paste it in ${shellApp}.`),
      () => shell.toast('Couldn’t copy; select the command instead.', 'error'),
    );
  return (
    <div className="shellcmd">
      <code>{text}</code>
      <button className="btn xs ghost" onClick={copy} aria-label={`Copy ${text}`}>
        Copy
      </button>
    </div>
  );
}
