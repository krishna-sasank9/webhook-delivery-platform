/**
 * The reliable queue — milestone 4.
 *
 * M3 used a plain BRPOP, which deletes the job ID the instant it is read. If
 * the worker then died, nothing anywhere knew the job had ever been claimed:
 * it sat at 'in_flight' in Postgres forever and no worker would look at it
 * again. Jobs were lost silently, which is the worst way to lose them.
 *
 * The fix is the "reliable queue" pattern:
 *
 *   ready    (list)       jobs waiting to be picked up
 *   inflight (list)       jobs a worker has claimed but not finished
 *   leases   (sorted set) jobId -> lease expiry timestamp
 *   delayed  (sorted set) jobId -> when it becomes due (retries, scheduling)
 *   dlq      (list)       jobs that exhausted their attempts
 *
 * Claiming a job MOVES it from ready to inflight atomically (BRPOPLPUSH), so
 * it is never in neither place. The worker must then explicitly acknowledge
 * it. If the worker dies, the lease expires and a reaper moves the job back to
 * ready — this is the VISIBILITY TIMEOUT, the same idea as SQS.
 *
 * The guarantee this buys is AT-LEAST-ONCE delivery: a job is never lost, but
 * it may be delivered twice (worker completes the HTTP call, then dies before
 * acking). Exactly-once is not achievable here — the fix is to make delivery
 * idempotent from the receiver's side, which is what the M7 idempotency key is
 * for. Being able to explain that trade-off is the point of this milestone.
 */

import type Redis from 'ioredis';

export const READY_QUEUE = 'queue:ready';
export const INFLIGHT_QUEUE = 'queue:inflight';
export const LEASES = 'queue:leases';
export const DELAYED = 'queue:delayed';
export const DLQ = 'queue:dlq';

/**
 * How long a worker may hold a job before it is considered dead.
 *
 * Must exceed the delivery timeout (10s) plus overhead, or a slow-but-alive
 * worker gets its job stolen and the delivery happens twice. Too long and a
 * genuinely crashed worker's jobs sit idle. 60s is a comfortable margin here.
 */
export const VISIBILITY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Producing
// ---------------------------------------------------------------------------

export async function push(redis: Redis, jobId: string): Promise<number> {
  return redis.lpush(READY_QUEUE, jobId);
}

/** Schedule a job to become ready at some point in the future. */
export async function pushDelayed(
  redis: Redis,
  jobId: string,
  runAtMs: number,
): Promise<void> {
  await redis.zadd(DELAYED, runAtMs, jobId);
}

// ---------------------------------------------------------------------------
// Consuming
// ---------------------------------------------------------------------------

/**
 * Claim a job: move it from ready to inflight and take a lease on it.
 *
 * BRPOPLPUSH is atomic — the ID is in exactly one list at all times, never in
 * neither. That atomicity is what makes this reliable rather than hopeful.
 *
 * The ZADD that records the lease is a separate command, so there is a very
 * small window where a job sits in inflight with no lease. `reapExpired`
 * handles that case explicitly rather than pretending it cannot happen.
 */
export async function reserve(
  redis: Redis,
  timeoutSeconds: number,
): Promise<string | null> {
  const jobId = await redis.brpoplpush(
    READY_QUEUE,
    INFLIGHT_QUEUE,
    timeoutSeconds,
  );

  if (!jobId) return null;

  await redis.zadd(LEASES, Date.now() + VISIBILITY_TIMEOUT_MS, jobId);
  return jobId;
}

/**
 * Successfully finished: remove from inflight and drop the lease.
 *
 * Lua so both happen atomically. A crash between the two would leave a
 * lease on a job no longer in flight, and the reaper would resurrect a job
 * that had already been delivered.
 */
const ACK_SCRIPT = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
`;

export async function ack(redis: Redis, jobId: string): Promise<void> {
  await redis.eval(ACK_SCRIPT, 2, INFLIGHT_QUEUE, LEASES, jobId);
}

/**
 * Failed but retryable: release the claim and schedule another attempt.
 */
const RETRY_SCRIPT = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
  return 1
`;

export async function retryLater(
  redis: Redis,
  jobId: string,
  runAtMs: number,
): Promise<void> {
  await redis.eval(
    RETRY_SCRIPT,
    3,
    INFLIGHT_QUEUE,
    LEASES,
    DELAYED,
    jobId,
    String(runAtMs),
  );
}

/**
 * Out of attempts, or failed permanently: move to the dead-letter queue.
 *
 * The DLQ is not a bin — it is an inbox. Jobs land here when the system has
 * given up, and a human decides whether to fix the endpoint and replay them.
 * A queue without one silently drops failures.
 */
const DLQ_SCRIPT = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('LPUSH', KEYS[3], ARGV[1])
  return 1
`;

export async function deadLetter(redis: Redis, jobId: string): Promise<void> {
  await redis.eval(DLQ_SCRIPT, 3, INFLIGHT_QUEUE, LEASES, DLQ, jobId);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Move delayed jobs whose time has come onto the ready queue.
 *
 * Atomic per batch: ZRANGEBYSCORE then ZREM+LPUSH inside one script, so two
 * workers running this concurrently cannot both promote the same job.
 */
const PROMOTE_SCRIPT = `
  local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  for _, jobId in ipairs(due) do
    redis.call('ZREM', KEYS[1], jobId)
    redis.call('LPUSH', KEYS[2], jobId)
  end
  return #due
`;

export async function promoteDue(
  redis: Redis,
  nowMs: number = Date.now(),
  batchSize = 100,
): Promise<number> {
  const promoted = await redis.eval(
    PROMOTE_SCRIPT,
    2,
    DELAYED,
    READY_QUEUE,
    String(nowMs),
    String(batchSize),
  );

  return Number(promoted);
}

/**
 * Return jobs whose lease expired to the ready queue.
 *
 * An expired lease means the worker holding it died — a healthy worker acks,
 * retries, or dead-letters well within the visibility timeout. This is the
 * mechanism that makes job loss impossible rather than merely unlikely.
 */
const REAP_SCRIPT = `
  local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  for _, jobId in ipairs(expired) do
    redis.call('ZREM', KEYS[1], jobId)
    redis.call('LREM', KEYS[2], 1, jobId)
    redis.call('LPUSH', KEYS[3], jobId)
  end
  return expired
`;

export async function reapExpired(
  redis: Redis,
  nowMs: number = Date.now(),
  batchSize = 100,
): Promise<string[]> {
  const reaped = await redis.eval(
    REAP_SCRIPT,
    3,
    LEASES,
    INFLIGHT_QUEUE,
    READY_QUEUE,
    String(nowMs),
    String(batchSize),
  );

  return reaped as string[];
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface QueueStats {
  ready: number;
  inflight: number;
  delayed: number;
  dlq: number;
}

export async function stats(redis: Redis): Promise<QueueStats> {
  // Pipelined: one round trip instead of four.
  const results = await redis
    .pipeline()
    .llen(READY_QUEUE)
    .llen(INFLIGHT_QUEUE)
    .zcard(DELAYED)
    .llen(DLQ)
    .exec();

  const value = (index: number): number => Number(results?.[index]?.[1] ?? 0);

  return {
    ready: value(0),
    inflight: value(1),
    delayed: value(2),
    dlq: value(3),
  };
}

/**
 * Remove and return the oldest job id from the DLQ, or null if it is empty.
 *
 * Intentionally does NOT push to ready. Replaying a dead job is not a pure
 * Redis move: the job's Postgres row is sitting at state='dead' with attempts
 * exhausted, and the worker's terminal-state guard would ack it straight back
 * out of existence. The row must be reset to 'queued' *before* the id goes onto
 * ready, so replay is orchestrated in job.service where both stores are in
 * reach — this function is just the Redis half. See job.service.replay.
 */
export async function popDlq(redis: Redis): Promise<string | null> {
  return redis.rpop(DLQ);
}
