/**
 * Retry backoff.
 *
 * Two ideas, both load-bearing:
 *
 * 1. EXPONENTIAL — wait 1s, 2s, 4s, 8s... rather than a fixed interval. A
 *    server that just returned 500 is probably struggling; retrying every
 *    second adds load to something already failing. Backing off gives it room
 *    to recover, and it is the difference between a retry policy and a DDoS.
 *
 * 2. JITTER — randomise the delay. Without it, 10,000 jobs that failed during
 *    the same outage all retry at exactly the same instant, hammering the
 *    recovering server and failing again in lockstep. This is the "thundering
 *    herd", and full jitter is the standard fix: pick uniformly from
 *    [0, computed delay] so retries spread out instead of synchronising.
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/**
 * Delay before attempt number `attempts + 1`.
 *
 *   attempts=1 -> up to 1s
 *   attempts=2 -> up to 2s
 *   attempts=3 -> up to 4s
 *   attempts=4 -> up to 8s
 *   attempts=5 -> up to 16s   (capped at 60s)
 */
export function backoffMs(attempts: number): number {
  const exponential = BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);

  // Full jitter: uniform in [0, capped].
  return Math.floor(Math.random() * capped);
}

/**
 * Should a failed delivery be retried?
 *
 * The distinction matters enormously in practice. A 500 means "try again
 * later" — the server is broken and may recover. A 400 means "this request is
 * malformed" — retrying sends the identical bytes and gets the identical
 * rejection, five times, for nothing.
 *
 * Two 4xx exceptions:
 *   408 Request Timeout  — transient by definition
 *   429 Too Many Requests — explicitly "slow down and retry"
 *
 * A null status means no response arrived at all (timeout, DNS, connection
 * refused). Always retryable: we have no evidence the request was even seen.
 */
export function isRetryable(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 408 || statusCode === 429) return true;
  if (statusCode >= 500) return true;
  return false;
}
