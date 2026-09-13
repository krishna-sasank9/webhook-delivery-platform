import { useEffect, useState } from 'react';

import { api, type Attempt, type Job } from '../api';
import { StateBadge, StatusPill } from './StateBadge';

/**
 * Slide-over showing everything about one job: its current row plus the full
 * delivery-attempt audit trail. The attempt list is where the retry story is
 * legible — you can read five 500s then a 200 and see exactly what happened.
 */
export function JobDetail({ job, onClose }: { job: Job; onClose: () => void }) {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getAttempts(job.id)
      .then((r) => live && setAttempts(r.attempts))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [job.id]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Job {job.id.slice(0, 8)}</h2>
          <StateBadge state={job.state} />
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="drawer-body">
          <div className="kv">
            <div className="k">Job ID</div><div className="v mono">{job.id}</div>
            <div className="k">Tenant</div><div className="v">{job.tenant}</div>
            <div className="k">Event type</div><div className="v">{job.eventType}</div>
            <div className="k">Webhook</div><div className="v mono">{job.webhookId}</div>
            <div className="k">Attempts</div><div className="v">{job.attempts} / {job.maxAttempts}</div>
            <div className="k">Run at</div><div className="v">{new Date(job.runAt).toLocaleString()}</div>
            <div className="k">Created</div><div className="v">{new Date(job.createdAt).toLocaleString()}</div>
            {job.lastError && (
              <>
                <div className="k">Last error</div>
                <div className="v" style={{ color: 'var(--danger)' }}>{job.lastError}</div>
              </>
            )}
          </div>

          <div className="section-title">Payload</div>
          <pre style={{
            margin: 0, background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '10px 12px', fontFamily: 'var(--mono)',
            fontSize: 12, overflowX: 'auto',
          }}>
            {JSON.stringify(job.payload, null, 2)}
          </pre>

          <div className="section-title">
            Delivery attempts {attempts ? `(${attempts.length})` : ''}
          </div>

          {error && <div className="error-banner">{error}</div>}
          {!attempts && !error && <div className="dim">Loading…</div>}
          {attempts && attempts.length === 0 && (
            <div className="dim">No delivery attempts recorded yet.</div>
          )}

          {attempts?.map((a) => (
            <div className="attempt" key={a.attemptNumber}>
              <div className="attempt-head">
                <span className="n">#{a.attemptNumber}</span>
                <StatusPill code={a.statusCode} />
                <span className="dim">{a.durationMs}ms</span>
                <div className="spacer" />
                <span className="dim">{new Date(a.attemptedAt).toLocaleTimeString()}</span>
              </div>
              {a.error && <div className="meta" style={{ color: 'var(--danger)' }}>{a.error}</div>}
              {a.responseBody && <pre>{a.responseBody}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
