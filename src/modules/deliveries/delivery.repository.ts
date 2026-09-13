/**
 * Data access for delivery attempts — the audit trail.
 *
 * One row per HTTP request actually made. A job that retries five times is one
 * `jobs` row and five `delivery_attempts` rows. This is what the M8 dashboard
 * renders when someone asks "why did this delivery fail?".
 */

import { query } from '../../db';

export interface AttemptRecord {
  jobId: string;
  attemptNumber: number;
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
}

/**
 * The next audit-sequence number for a job's delivery attempts.
 *
 * Deliberately NOT `job.attempts + 1`. That counter is the retry *budget*, and
 * a DLQ replay resets it to zero so the job gets a fresh start with short
 * backoff — which would make the delivery-cycle counter collide with the
 * `UNIQUE (jobId, attemptNumber)` rows the original run already wrote. This is a
 * monotonic sequence over what has actually been recorded, so it never reuses a
 * number no matter how many times a job is replayed. Safe without locking: a
 * job in flight is owned by exactly one worker at a time.
 */
export async function nextAttemptNumber(jobId: string): Promise<number> {
  const result = await query<{ next: string }>(
    `SELECT COALESCE(MAX(attemptNumber), 0) + 1 AS next
     FROM delivery_attempts
     WHERE jobId = $1`,
    [jobId],
  );
  return Number(result.rows[0]?.next ?? 1);
}

export async function insert(record: AttemptRecord): Promise<void> {
  await query(
    `INSERT INTO delivery_attempts
       (jobId, attemptNumber, statusCode, responseBody, error, durationMs)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      record.jobId,
      record.attemptNumber,
      record.statusCode,
      record.responseBody,
      record.error,
      record.durationMs,
    ],
  );
}

export async function findByJobId(jobId: string): Promise<AttemptRecord[]> {
  const result = await query<{
    jobid: string;
    attemptnumber: number;
    statuscode: number | null;
    responsebody: string | null;
    error: string | null;
    durationms: number;
  }>(
    `SELECT * FROM delivery_attempts
     WHERE jobId = $1
     ORDER BY attemptNumber ASC`,
    [jobId],
  );

  return result.rows.map((row) => ({
    jobId: row.jobid,
    attemptNumber: row.attemptnumber,
    statusCode: row.statuscode,
    responseBody: row.responsebody,
    error: row.error,
    durationMs: row.durationms,
  }));
}
