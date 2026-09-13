import type { JobState } from '../api';

const LABEL: Record<JobState, string> = {
  queued: 'queued',
  in_flight: 'in-flight',
  succeeded: 'succeeded',
  failed: 'failed',
  dead: 'dead',
};

export function StateBadge({ state }: { state: JobState }) {
  return <span className={`badge ${state}`}>{LABEL[state]}</span>;
}

/** HTTP status shown as a colour-coded pill; null = no response arrived. */
export function StatusPill({ code }: { code: number | null }) {
  if (code == null) return <span className="status-pill status-none">—</span>;
  const klass =
    code < 300 ? 'status-2xx' : code < 500 ? 'status-4xx' : 'status-5xx';
  return <span className={`status-pill ${klass}`}>{code}</span>;
}
