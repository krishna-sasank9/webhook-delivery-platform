import { useState } from 'react';

import { api, type Job } from '../api';
import { timeAgo } from '../hooks';

/**
 * The dead-letter queue with a one-click replay. Replay resets each job to a
 * fresh state server-side and re-queues it, so the natural follow-through is to
 * refresh both this list and the stats — hence `onReplayed`.
 */
export function DlqPanel({
  jobs,
  loading,
  onSelect,
  onReplayed,
}: {
  jobs: Job[];
  loading: boolean;
  onSelect: (job: Job) => void;
  onReplayed: (count: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replay() {
    if (!confirm(`Replay ${jobs.length} dead-lettered job(s)? Each gets a fresh retry budget.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.replayDlq(jobs.length || 100);
      onReplayed(res.replayed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Dead-letter queue</h2>
        <span className="dim">{jobs.length} job(s)</span>
        <div className="spacer" />
        <button className="danger" onClick={replay} disabled={busy || jobs.length === 0}>
          {busy ? 'Replaying…' : 'Replay all'}
        </button>
      </div>

      {error && <div className="error-banner" style={{ margin: 16 }}>{error}</div>}

      {!loading && jobs.length === 0 ? (
        <div className="empty">Dead-letter queue is empty. 🎉</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Event</th>
              <th>Tenant</th>
              <th className="right">Attempts</th>
              <th>Last error</th>
              <th className="right">Failed</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} onClick={() => onSelect(job)}>
                <td className="mono">{job.id.slice(0, 8)}</td>
                <td>{job.eventType}</td>
                <td className="dim">{job.tenant}</td>
                <td className="right mono">{job.attempts}/{job.maxAttempts}</td>
                <td className="dim" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.lastError ?? '—'}
                </td>
                <td className="right dim">{timeAgo(job.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
