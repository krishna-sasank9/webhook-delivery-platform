import type { QueueStats } from '../api';

/**
 * The four queue depths at a glance. `dlq > 0` turns its card red because,
 * unlike the others, a non-zero DLQ always means something needs a human.
 */
export function StatCards({ stats }: { stats: QueueStats | null }) {
  const cards: { key: keyof QueueStats; label: string; hint: string }[] = [
    { key: 'ready', label: 'Ready', hint: 'ready' },
    { key: 'inflight', label: 'In-flight', hint: 'inflight' },
    { key: 'delayed', label: 'Delayed', hint: 'delayed' },
    { key: 'dlq', label: 'Dead-letter', hint: 'dlq' },
  ];

  return (
    <div className="stats">
      {cards.map((c) => {
        const value = stats?.[c.key] ?? 0;
        const alert = c.key === 'dlq' && value > 0;
        return (
          <div key={c.key} className={`card ${c.hint}${alert ? ' alert' : ''}`}>
            <div className="label">{c.label}</div>
            <div className="value">{stats ? value : '—'}</div>
          </div>
        );
      })}
    </div>
  );
}
