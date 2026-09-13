/**
 * Idempotency keys — milestone 7 (producer side).
 *
 * A client that POSTs an event and gets no response — timeout, dropped
 * connection — does not know whether we accepted it, so it retries. Without
 * protection, that retry enqueues the event a second time and the customer's
 * endpoint receives the same webhook twice. The client fixes this by sending an
 * `Idempotency-Key` it generates once per logical event; we guarantee that at
 * most one job is ever created per (tenant, key).
 *
 * Note this is a DIFFERENT guarantee from the queue's at-least-once delivery.
 * That is about redelivering a job we already have; this is about not creating
 * duplicate jobs in the first place. Together with the stable per-job header we
 * send on delivery, they let a careful receiver dedupe end to end.
 *
 * The tricky part is two identical requests arriving at the same instant, so a
 * plain "GET then create" is not enough — both would miss and both would
 * create. We reserve first:
 *
 *   1. SET key PENDING NX  — atomic; exactly one caller wins the slot.
 *   2. Winner creates the job, then overwrites the slot with the real job id.
 *   3. A later duplicate reads the slot: a job id means "already done, here it
 *      is"; still PENDING means "the first request is mid-flight, try again".
 *
 * Keys expire after a day: long enough to absorb realistic client retries,
 * short enough not to remember keys forever.
 */

import type Redis from 'ioredis';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENDING = 'PENDING';

// Namespaced by tenant so two tenants' keys can never collide — an idempotency
// key is only unique within the client that generated it.
function redisKey(tenant: string, key: string): string {
  return `idem:${tenant}:${key}`;
}

export type BeginResult =
  | { status: 'new' } // we own the slot; go create the job
  | { status: 'duplicate'; jobId: string } // already created; return this
  | { status: 'pending' }; // an identical request is still in flight

/**
 * Claim the idempotency slot for (tenant, key). Only the caller that gets
 * `{ status: 'new' }` should create a job; it must then call `complete` (on
 * success) or `abort` (on failure).
 */
export async function begin(
  redis: Redis,
  tenant: string,
  key: string,
): Promise<BeginResult> {
  const k = redisKey(tenant, key);

  const reserved = await redis.set(k, PENDING, 'PX', TTL_MS, 'NX');
  if (reserved === 'OK') return { status: 'new' };

  // Lost the race — someone got here first. Whether they have finished yet
  // decides what this caller should do.
  const existing = await redis.get(k);
  if (existing && existing !== PENDING) {
    return { status: 'duplicate', jobId: existing };
  }
  return { status: 'pending' };
}

/** Record the job id the reserved slot resolved to, so retries return it. */
export async function complete(
  redis: Redis,
  tenant: string,
  key: string,
  jobId: string,
): Promise<void> {
  await redis.set(redisKey(tenant, key), jobId, 'PX', TTL_MS);
}

/**
 * Release the slot after a failed creation, so the client's retry can try again
 * cleanly rather than being told "pending" until the key expires.
 */
export async function abort(
  redis: Redis,
  tenant: string,
  key: string,
): Promise<void> {
  await redis.del(redisKey(tenant, key));
}
