/**
 * Delivering a webhook over HTTP.
 *
 * Deliberately knows nothing about queues or retries — it makes one attempt and
 * reports what happened. Deciding whether to retry is the worker's job (M4).
 */

import { createHmac } from 'node:crypto';

import { isRetryable } from '../../backoff';
import { createLogger } from '../../logger';
import type { Job } from '../../types';
import * as attemptRepository from './delivery.repository';

const log = createLogger('delivery');

/** A slow endpoint must not hold a worker hostage. */
const TIMEOUT_MS = 10_000;

/** Enough of the response to debug with; not enough to bloat the table. */
const MAX_BODY_CHARS = 2_000;

export interface DeliveryResult {
  success: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  /** False for permanent failures (4xx) — retrying would change nothing. */
  retryable: boolean;
}

/**
 * Sign a delivery so the receiver can prove it came from us and was not
 * tampered with — milestone 7.
 *
 * The signature is HMAC-SHA256 over `<timestamp>.<body>`, keyed by the webhook's
 * secret (which only we and the customer hold). The customer recomputes it and
 * compares. Two deliberate choices, both standard (this is the Stripe scheme):
 *
 *   - The timestamp is signed too and sent alongside. Signing only the body
 *     lets an attacker who captures one request replay it forever; binding a
 *     timestamp in lets the receiver reject anything older than a few minutes.
 *   - Verification on the far side must use a constant-time compare, or the
 *     comparison itself leaks the signature byte by byte via timing. Not our
 *     code to write, but it is the reason the scheme is shaped this way.
 */
function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/**
 * POST the job payload to the webhook URL, signed, and record the attempt.
 *
 * Success is defined as a 2xx response. Everything else — 4xx, 5xx, timeout,
 * DNS failure, connection refused — is a failure, and `retryable` distinguishes
 * a 500 (try again) from a 400 (never will).
 */
export async function deliver(
  job: Job,
  webhookUrl: string,
  secret: string,
): Promise<DeliveryResult> {
  // Monotonic audit sequence, not job.attempts + 1 — the retry budget resets on
  // a DLQ replay, but this must never reuse a number (see the repository).
  const attemptNumber = await attemptRepository.nextAttemptNumber(job.id);
  const startedAt = Date.now();

  // The signed bytes and the sent bytes must be identical, so serialise once
  // and reuse — re-stringifying could reorder keys and break the signature.
  const body = JSON.stringify(job.payload);
  const timestamp = Date.now().toString();
  const signature = sign(secret, timestamp, body);

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'webhook-delivery-platform/1.0',
        // Lets the receiver route without parsing, and correlate with us when
        // they report a problem.
        'x-event-type': job.eventType,
        'x-job-id': job.id,
        'x-attempt': String(attemptNumber),
        // The job id is stable across every retry of a delivery, so it doubles
        // as the receiver's dedupe key — the far side of our at-least-once
        // guarantee. Same header a client would send us on the way in.
        'idempotency-key': job.id,
        // HMAC signature + the timestamp it covers (M7).
        'x-signature-timestamp': timestamp,
        'x-signature': `v1=${signature}`,
      },
      body,
      // Without a timeout, one hung endpoint parks a worker indefinitely.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    statusCode = response.status;

    const text = await response.text();
    responseBody = text.slice(0, MAX_BODY_CHARS);

    if (!response.ok) {
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    // Network-level failure: timeout, DNS, connection refused. No status code
    // exists because no response was ever received.
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

  await attemptRepository.insert({
    jobId: job.id,
    attemptNumber,
    statusCode,
    responseBody,
    error,
    durationMs,
  });

  log.info(success ? 'delivered' : 'delivery failed', {
    jobId: job.id,
    attempt: attemptNumber,
    statusCode,
    durationMs,
    error,
  });

  return {
    success,
    statusCode,
    error,
    durationMs,
    retryable: !success && isRetryable(statusCode),
  };
}
