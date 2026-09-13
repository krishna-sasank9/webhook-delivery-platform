/**
 * Business rules for jobs.
 *
 * This is where the queue semantics will live. Today `enqueue` only writes a
 * row; in M3 it will also push the job id onto the Redis ready queue, and in
 * M4 it grows retry/backoff policy. Keeping that here — rather than in the
 * controller — is what makes those additions a one-file change.
 */

import type Redis from 'ioredis';

import { backoffMs } from '../../backoff';
import * as circuit from '../../circuit';
import { config } from '../../config';
import { ConflictError, NotFoundError } from '../../errors';
import * as idempotency from '../../idempotency';
import { createLogger } from '../../logger';
import * as queue from '../../queue';
import * as ratelimit from '../../ratelimit';
import type { Job, JobState } from '../../types';
import * as deliveryService from '../deliveries/delivery.service';
import * as webhookService from '../webhooks/webhook.service';
import * as repository from './job.repository';

const log = createLogger('job.service');

export async function enqueue(
  redis: Redis,
  input: {
    tenant: string;
    webhookId: string;
    eventType: string;
    payload: unknown;
    runAt?: Date;
    /** Client-supplied dedupe key (M7). Optional; when absent, no dedupe. */
    idempotencyKey?: string;
  },
): Promise<Job> {
  // Throws NotFound if the webhook does not exist OR belongs to another
  // tenant. Enforcing ownership here means every future caller of enqueue
  // gets the check for free.
  const webhook = await webhookService.getOwnedBy(input.webhookId, input.tenant);

  if (!webhook.isActive) {
    throw new ConflictError('webhook is inactive');
  }

  // ---- Idempotency gate (M7) --------------------------------------------
  // With a key, at most one job is ever created per (tenant, key). Reserve the
  // slot before doing any work: a duplicate returns the original job, and a
  // concurrent identical request is told to retry rather than double-enqueuing.
  const { idempotencyKey, ...jobInput } = input;

  if (idempotencyKey) {
    const outcome = await idempotency.begin(redis, input.tenant, idempotencyKey);

    if (outcome.status === 'duplicate') {
      const existing = await repository.findById(outcome.jobId);
      if (existing) {
        log.info('idempotent replay, returning existing job', {
          jobId: existing.id,
          idempotencyKey,
        });
        return existing;
      }
      // Slot pointed at a job whose row is gone (expired/deleted). Fall through
      // and create a fresh one, reusing the slot below.
    }

    if (outcome.status === 'pending') {
      throw new ConflictError('a request with this idempotency key is in progress');
    }
  }

  try {
    // Postgres first, Redis second. The order matters: the DB row is the source
    // of truth, so if the LPUSH fails we still have a durable 'queued' job that
    // a recovery sweep can find. The reverse order could put an ID on the queue
    // for a row that was never written.
    const job = await repository.insert(jobInput);

    // A job due in the future goes to the delayed set, where the scheduler
    // promotes it once its time arrives. Only jobs due now go straight to
    // ready — otherwise a worker would pick it up immediately and deliver early.
    const runAtMs = new Date(job.runAt).getTime();
    const delayed = runAtMs > Date.now();

    if (delayed) {
      await queue.pushDelayed(redis, job.id, runAtMs);
    } else {
      await queue.push(redis, job.id);
    }

    // Resolve the reserved slot to this job id, so client retries return it.
    if (idempotencyKey) {
      await idempotency.complete(redis, input.tenant, idempotencyKey, job.id);
    }

    log.info('job enqueued', {
      jobId: job.id,
      tenant: job.tenant,
      eventType: job.eventType,
      delayed,
      runAt: job.runAt,
    });

    return job;
  } catch (err) {
    // Creation failed after we reserved the slot — release it so the client's
    // retry is not stuck seeing 'pending' until the key expires.
    if (idempotencyKey) {
      await idempotency.abort(redis, input.tenant, idempotencyKey);
    }
    throw err;
  }
}

/**
 * Process one reserved job, then release the claim on it.
 *
 * The contract with the queue is that every reserved job ends in exactly one
 * of ack / retryLater / deadLetter. If this function returns without calling
 * one of them, the job stays in flight until its lease expires and the reaper
 * puts it back — correct, but slow. If it throws, the same thing happens.
 * Either way the job is never lost, which is the whole point of M4.
 */
export async function process(redis: Redis, jobId: string): Promise<void> {
  const job = await repository.findById(jobId);

  if (!job) {
    // ID on the queue, no row behind it. Nothing to retry — ack so it stops
    // cycling through the reaper forever.
    log.warn('job not found, acking to discard', { jobId });
    await queue.ack(redis, jobId);
    return;
  }

  if (job.state === 'succeeded' || job.state === 'dead') {
    // Already finished. Reachable via at-least-once redelivery: the worker
    // completed the HTTP call, then died before acking.
    log.warn('job already terminal, acking', { jobId, state: job.state });
    await queue.ack(redis, jobId);
    return;
  }

  const circuitKey = `circuit:webhook:${job.webhookId}`;

  // -------------------------------------------------------------------------
  // Preflight gate 1 — circuit breaker (M7)
  //
  // If this destination is tripped, do not even attempt: skip fast and try
  // again after the cooldown. Crucially this does NOT spend an attempt — the
  // job is being deferred because *we* chose not to send, not because delivery
  // failed. Counting it would dead-letter healthy jobs during an outage.
  // -------------------------------------------------------------------------
  const circuitState = await circuit.check(redis, circuitKey, config.circuit.cooldownMs);
  if (circuitState === 'open') {
    const runAtMs = Date.now() + config.circuit.cooldownMs;
    await repository.updateState({ id: job.id, state: 'queued', runAt: new Date(runAtMs) });
    await queue.retryLater(redis, jobId, runAtMs);
    log.info('circuit open, deferring delivery', { jobId, webhookId: job.webhookId });
    return;
  }

  // -------------------------------------------------------------------------
  // Preflight gate 2 — rate limit (M6)
  //
  // Out of tokens for this webhook: reschedule just past when the next token
  // refills. Also not an attempt — we are pacing ourselves, not failing.
  // -------------------------------------------------------------------------
  const rate = await ratelimit.take(
    redis,
    `ratelimit:webhook:${job.webhookId}`,
    config.rateLimit.perSecond,
    config.rateLimit.burst,
  );
  if (!rate.allowed) {
    const runAtMs = Date.now() + Math.max(rate.retryAfterMs, 100);
    await repository.updateState({ id: job.id, state: 'queued', runAt: new Date(runAtMs) });
    await queue.retryLater(redis, jobId, runAtMs);
    log.info('rate limited, deferring delivery', {
      jobId,
      webhookId: job.webhookId,
      retryAfterMs: rate.retryAfterMs,
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Deliver
  // -------------------------------------------------------------------------
  await repository.updateState({ id: job.id, state: 'in_flight' });

  const webhook = await webhookService.getById(job.webhookId);
  const secret = await webhookService.getSecret(job.webhookId);
  const result = await deliveryService.deliver(job, webhook.url, secret);

  // -------------------------------------------------------------------------
  // Success
  // -------------------------------------------------------------------------
  if (result.success) {
    // Close the breaker — one clean delivery means the endpoint has recovered.
    await circuit.recordSuccess(redis, circuitKey);
    await repository.updateState({
      id: job.id,
      state: 'succeeded',
      incrementAttempts: true,
      lastError: null,
    });
    await queue.ack(redis, jobId);
    return;
  }

  // A real delivery failure counts toward tripping the breaker for this
  // destination (a half-open probe failing reopens it immediately).
  await circuit.recordFailure(redis, circuitKey, config.circuit.failureThreshold);

  const attemptsAfter = job.attempts + 1;
  const exhausted = attemptsAfter >= job.maxAttempts;

  // -------------------------------------------------------------------------
  // Permanent failure, or out of attempts -> dead-letter queue
  //
  // A 400 means the request is malformed; sending the identical bytes four
  // more times produces four identical rejections. Failing fast on permanent
  // errors keeps the queue moving and keeps the DLQ meaningful.
  // -------------------------------------------------------------------------
  if (!result.retryable || exhausted) {
    await repository.updateState({
      id: job.id,
      state: 'dead',
      incrementAttempts: true,
      lastError: result.error,
    });
    await queue.deadLetter(redis, jobId);

    log.warn('job dead-lettered', {
      jobId,
      attempts: attemptsAfter,
      statusCode: result.statusCode,
      reason: exhausted ? 'attempts exhausted' : 'permanent failure',
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Retryable -> schedule another attempt with jittered exponential backoff
  // -------------------------------------------------------------------------
  const delayMs = backoffMs(attemptsAfter);
  const runAtMs = Date.now() + delayMs;

  await repository.updateState({
    id: job.id,
    state: 'queued',
    incrementAttempts: true,
    lastError: result.error,
    runAt: new Date(runAtMs),
  });
  await queue.retryLater(redis, jobId, runAtMs);

  log.info('job scheduled for retry', {
    jobId,
    attempt: attemptsAfter,
    maxAttempts: job.maxAttempts,
    delayMs,
  });
}

/**
 * Move jobs out of the dead-letter queue and back into circulation.
 *
 * The bug this fixes: moving the id from DLQ to ready in Redis alone left the
 * Postgres row at state='dead', so the worker's terminal-state guard acked the
 * replayed job straight back out of existence — it looked replayed but was
 * silently discarded. Redelivery only works if both stores agree the job is
 * alive again, which is why this lives here rather than in queue.ts.
 *
 * Order mirrors enqueue: reset Postgres (source of truth) first, push to ready
 * second. A crash between the two leaves a 'queued' row that is not on any
 * Redis list — recoverable by a sweep — never a ready id with no live row.
 */
export async function replay(redis: Redis, limit: number): Promise<string[]> {
  const replayed: string[] = [];

  for (let i = 0; i < limit; i += 1) {
    const jobId = await queue.popDlq(redis);
    if (!jobId) break; // DLQ drained

    const job = await repository.resetForReplay(jobId);
    if (!job) {
      // Id was in the DLQ but its row is gone (webhook deleted, cascade). There
      // is nothing to deliver, so drop it rather than pushing a dangling id.
      log.warn('replay: dlq id has no job row, discarding', { jobId });
      continue;
    }

    await queue.push(redis, jobId);
    replayed.push(jobId);
  }

  if (replayed.length > 0) {
    log.info('replayed dead-lettered jobs', { count: replayed.length });
  }

  return replayed;
}

export async function getById(id: string): Promise<Job> {
  const job = await repository.findById(id);
  if (!job) {
    throw new NotFoundError('job not found');
  }
  return job;
}

export async function listByTenant(filters: {
  tenant: string;
  state?: JobState;
  limit: number;
}): Promise<Job[]> {
  return repository.findByTenant(filters);
}
