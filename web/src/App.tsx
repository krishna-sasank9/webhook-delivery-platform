import { useMemo, useState } from 'react';

import { api, type Job, type JobState } from './api';
import { usePolling } from './hooks';
import { StatCards } from './components/StatCards';
import { JobsTable } from './components/JobsTable';
import { JobDetail } from './components/JobDetail';
import { DlqPanel } from './components/DlqPanel';
import { EnqueuePanel } from './components/EnqueuePanel';

const REFRESH_MS = 2000;
const STATES: (JobState | 'all')[] = [
  'all', 'queued', 'in_flight', 'succeeded', 'failed', 'dead',
];

type Tab = 'jobs' | 'dlq';

export function App() {
  const [tenant, setTenant] = useState('acme');
  const [live, setLive] = useState(true);
  const [tab, setTab] = useState<Tab>('jobs');
  const [stateFilter, setStateFilter] = useState<JobState | 'all'>('all');
  const [selected, setSelected] = useState<Job | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const stats = usePolling(() => api.stats(), REFRESH_MS, live);

  const jobs = usePolling(
    () =>
      api.listJobs({
        tenant,
        state: stateFilter === 'all' ? undefined : stateFilter,
        limit: 100,
      }),
    REFRESH_MS,
    live,
    [tenant, stateFilter],
  );

  const dlq = usePolling(() => api.listDlq(200), REFRESH_MS, live && tab === 'dlq');

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const dlqCount = stats.data?.dlq ?? 0;
  const anyError = stats.error || jobs.error;

  const jobRows = useMemo(() => jobs.data?.jobs ?? [], [jobs.data]);

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>Webhook Delivery Platform</h1>
          <div className="sub">Operator dashboard · M8</div>
        </div>
        <div className="spacer" />

        <div className="control">
          <label>Tenant</label>
          <input
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            style={{ width: 110 }}
          />
        </div>

        <button onClick={() => setLive((v) => !v)}>
          <span className={`dot ${live ? '' : 'off'}`} />{' '}
          {live ? 'Live' : 'Paused'}
        </button>
      </div>

      {anyError && (
        <div className="error-banner">
          API error: {anyError}. Is the API running on :3000?
        </div>
      )}

      <StatCards stats={stats.data} />

      <EnqueuePanel tenant={tenant} onEnqueued={() => { jobs.refresh(); stats.refresh(); flash('Event enqueued'); }} />

      <div className="tabs">
        <button
          className={`tab ${tab === 'jobs' ? 'active' : ''}`}
          onClick={() => setTab('jobs')}
        >
          Jobs
        </button>
        <button
          className={`tab ${tab === 'dlq' ? 'active' : ''}`}
          onClick={() => setTab('dlq')}
        >
          Dead-letter
          {dlqCount > 0 && <span className="count">{dlqCount}</span>}
        </button>
      </div>

      {tab === 'jobs' && (
        <div className="panel">
          <div className="panel-head">
            <h2>Jobs</h2>
            <span className="dim">{jobRows.length}</span>
            <div className="spacer" />
            <label className="dim" style={{ fontSize: 12 }}>State</label>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as JobState | 'all')}
            >
              {STATES.map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All' : s}</option>
              ))}
            </select>
          </div>
          <JobsTable jobs={jobRows} loading={jobs.loading} onSelect={setSelected} />
        </div>
      )}

      {tab === 'dlq' && (
        <DlqPanel
          jobs={dlq.data?.jobs ?? []}
          loading={dlq.loading}
          onSelect={setSelected}
          onReplayed={(n) => {
            dlq.refresh();
            stats.refresh();
            jobs.refresh();
            flash(`Replayed ${n} job(s)`);
          }}
        />
      )}

      {selected && <JobDetail job={selected} onClose={() => setSelected(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
