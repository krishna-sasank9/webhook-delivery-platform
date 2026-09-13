import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Run an async fetcher now and on an interval, exposing {data, error, loading}.
 *
 * The dashboard is a live view of a moving system, so polling is the whole
 * point. `enabled` lets a caller pause it (auto-refresh toggle), and a manual
 * `refresh` is returned for actions that should update the view immediately —
 * e.g. right after a DLQ replay — rather than waiting for the next tick.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const savedFetcher = useRef(fetcher);
  savedFetcher.current = fetcher;

  const run = useCallback(async () => {
    try {
      const result = await savedFetcher.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run();
    if (!enabled) return;
    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, enabled, intervalMs, ...deps]);

  return { data, error, loading, refresh: run };
}

/** Relative time like "12s ago" — compact enough for a table cell. */
export function timeAgo(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0) return `in ${fmt(-secs)}`;
  if (secs < 5) return 'just now';
  return `${fmt(secs)} ago`;
}

function fmt(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
