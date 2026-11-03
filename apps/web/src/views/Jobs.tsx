import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { Empty, useNow } from '../components.tsx';
import { useDaemon, type JobRow } from '../feeds.ts';
import { age, clock } from '../format.ts';
import type { ViewProps } from '../functions.ts';

const STATUS_CLASS: Record<string, string> = { ok: 'up', failed: 'down', running: 'warn-t', queued: 'muted', cancelled: 'muted' };

export default function Jobs({ panel, nav, drill }: ViewProps) {
  const [first, second] = panel.args;
  if (first === 'job' && second) return <JobDetail id={second} />;
  return <JobList source={first} nav={nav} drill={drill} />;
}

function JobList({ source, nav, drill }: { source?: string; nav: ViewProps['nav']; drill: ViewProps['drill'] }) {
  const { jobs } = useDaemon();
  const now = useNow(10_000);
  const rows = (source ? jobs.filter((j) => j.source === source) : jobs).slice(0, 100);

  drill.current = (row) => {
    const j = rows[row - 1];
    if (j) nav.open({ fn: 'JOBS', args: ['job', j.id] });
    else nav.message(`no row ${row}`, 'error');
  };

  return (
    <div className="scroll">
      {source && <div className="section">Jobs for {source}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th className="n">#</th>
            <th className="r">When</th>
            <th>Job</th>
            <th>Why</th>
            <th>Status</th>
            <th className="r">Took</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j, i) => (
            <tr key={j.id} onClick={() => nav.open({ fn: 'JOBS', args: ['job', j.id] })}>
              <td className="n">{i + 1}</td>
              <td className="r muted" title={j.createdAt}>
                {age(j.createdAt, now)}
              </td>
              <td className="sec">
                {j.kind === 'run' ? `${j.source}.${j.dataset}` : `${j.kind} ${j.source}`}
              </td>
              <td className="muted">{j.trigger}</td>
              <td className={STATUS_CLASS[j.status] ?? ''}>
                {j.status}
                {j.method && <span className="muted"> {j.method}</span>}
              </td>
              <td className="r muted">{j.durationMs != null ? `${(j.durationMs / 1000).toFixed(1)}s` : ''}</td>
              <td className="err" title={j.error ?? ''}>
                {j.error ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>No jobs yet.</Empty>}
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<(JobRow & { result?: unknown; slot?: string | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { jobs } = useDaemon();
  const status = jobs.find((j) => j.id === id)?.status;
  useEffect(() => void get<any>(`/api/jobs/${id}`).then(setJob, (e) => setError((e as Error).message)), [id, status]);
  if (error) return <Empty>{error}</Empty>;
  if (!job) return <Empty>Loading job…</Empty>;
  return (
    <div className="scroll">
      <dl className="kv wide">
        <dt>Job</dt>
        <dd>{job.id}</dd>
        <dt>What</dt>
        <dd>{job.kind === 'run' ? `${job.source}.${job.dataset}` : `${job.kind} ${job.source}`}</dd>
        <dt>Trigger</dt>
        <dd>
          {job.trigger}
          {job.slot ? ` (slot ${clock(job.slot)})` : ''}
        </dd>
        <dt>Status</dt>
        <dd className={STATUS_CLASS[job.status] ?? ''}>{job.status}</dd>
        <dt>Created</dt>
        <dd>{clock(job.createdAt)}</dd>
        <dt>Finished</dt>
        <dd>{clock(job.finishedAt)}</dd>
        <dt>Took</dt>
        <dd>{job.durationMs != null ? `${(job.durationMs / 1000).toFixed(1)}s` : '—'}</dd>
        <dt>Method</dt>
        <dd>{job.method ?? '—'}</dd>
        <dt>Raw</dt>
        <dd className="muted">{job.rawDir ?? '—'}</dd>
      </dl>
      {job.error && <div className="warn">{job.error}</div>}
      {Array.isArray(job.attempts) && job.attempts.length > 0 && (
        <>
          <div className="section">Strategies tried</div>
          <pre className="pre">{JSON.stringify(job.attempts, null, 2)}</pre>
        </>
      )}
      {job.result !== undefined && job.result !== null && (
        <>
          <div className="section">Result</div>
          <pre className="pre">{JSON.stringify(job.result, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
