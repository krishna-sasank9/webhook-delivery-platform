import type { Job } from '../api';
import { timeAgo } from '../hooks';
import { StateBadge } from './StateBadge';

export function JobsTable({
  jobs,
  loading,
  onSelect,
}: {
  jobs: Job[];
  loading: boolean;
  onSelect: (job: Job) => void;
}) {
  if (!loading && jobs.length === 0) {
    return <div className="empty">No jobs match this filter.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Job</th>
          <th>Event</th>
          <th>State</th>
          <th className="right">Attempts</th>
          <th>Last error</th>
          <th className="right">Updated</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id} onClick={() => onSelect(job)}>
            <td className="mono">{job.id.slice(0, 8)}</td>
            <td>{job.eventType}</td>
            <td><StateBadge state={job.state} /></td>
            <td className="right mono">
              {job.attempts}<span className="dim">/{job.maxAttempts}</span>
            </td>
            <td className="dim" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.lastError ?? '—'}
            </td>
            <td className="right dim">{timeAgo(job.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
