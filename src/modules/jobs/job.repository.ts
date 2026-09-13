/**
 * Data access for jobs. SQL only.
 */

import { query } from '../../db';
import type { Job, JobRow, JobState } from '../../types';

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    tenant: row.tenant,
    webhookId: row.webhookid,
    eventType: row.eventtype,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.maxattempts,
    runAt: row.runat.toISOString(),
    lastError: row.lasterror,
    createdAt: row.createdat.toISOString(),
  };
}

export async function insert(input: {
  tenant: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  runAt?: Date;
}): Promise<Job> {
  const result = await query<JobRow>(
    `INSERT INTO jobs (tenant, webhookId, eventType, payload, runAt)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     RETURNING *`,
    [
      input.tenant,
      input.webhookId,
      input.eventType,
      // JSONB expects a JSON string — pg will not serialise an object for us.
      JSON.stringify(input.payload),
      input.runAt ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('insert returned no row');
  }

  return toJob(row);
}

export async function findById(id: string): Promise<Job | null> {
  const result = await query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);

  const row = result.rows[0];
  return row ? toJob(row) : null;
}

/**
 * Fetch many jobs by id in one round trip, preserving the caller's order.
 *
 * Used to hydrate the DLQ view: Redis gives us the ordered list of dead job
 * ids, and this turns them into full rows. `= ANY($1)` is one query for the
 * whole set rather than N; the result is re-sorted to match `ids` because SQL
 * makes no ordering promise. Missing ids are simply absent (a dead job whose
 * row was cascade-deleted).
 */
export async function findByIds(ids: string[]): Promise<Job[]> {
  if (ids.length === 0) return [];

  const result = await query<JobRow>('SELECT * FROM jobs WHERE id = ANY($1)', [
    ids,
  ]);

  const byId = new Map(result.rows.map((row) => [row.id, toJob(row)]));
  return ids.map((id) => byId.get(id)).filter((job): job is Job => job != null);
}

/**
 * Move a job to a terminal or intermediate state, bumping the attempt counter.
 *
 * `updatedAt` is refreshed on every transition so the dashboard can show when
 * a job last changed — and so M4's sweeper can spot jobs stuck in_flight.
 */
export async function updateState(input: {
  id: string;
  state: JobState;
  incrementAttempts?: boolean;
  lastError?: string | null;
  /** Set when scheduling a retry; COALESCE leaves it untouched otherwise. */
  runAt?: Date;
}): Promise<Job | null> {
  const result = await query<JobRow>(
    `UPDATE jobs
     SET state      = $2,
         attempts   = attempts + $3,
         lastError  = $4,
         runAt      = COALESCE($5, runAt),
         updatedAt  = now()
     WHERE id = $1
     RETURNING *`,
    [
      input.id,
      input.state,
      input.incrementAttempts ? 1 : 0,
      input.lastError ?? null,
      input.runAt ?? null,
    ],
  );

  const row = result.rows[0];
  return row ? toJob(row) : null;
}

/**
 * Reset a dead job so it can be delivered again (DLQ replay).
 *
 * A replayed job starts a fresh life: state back to 'queued', attempts back to
 * zero, lastError cleared, runAt set to now so it is due immediately. Resetting
 * attempts is a deliberate policy choice — a replay happens *after* a human has
 * fixed whatever was broken (endpoint back online, URL corrected), so the job
 * deserves its full retry budget again rather than dying on the first hiccup.
 */
export async function resetForReplay(id: string): Promise<Job | null> {
  const result = await query<JobRow>(
    `UPDATE jobs
     SET state      = 'queued',
         attempts   = 0,
         lastError  = NULL,
         runAt      = now(),
         updatedAt  = now()
     WHERE id = $1
     RETURNING *`,
    [id],
  );

  const row = result.rows[0];
  return row ? toJob(row) : null;
}

export async function findByTenant(filters: {
  tenant: string;
  state?: JobState;
  limit: number;
}): Promise<Job[]> {
  // Conditions are built up so one function serves both "all jobs for tenant"
  // and "jobs in state X". Values stay parameterised — never interpolated.
  const conditions = ['tenant = $1'];
  const params: unknown[] = [filters.tenant];

  if (filters.state) {
    params.push(filters.state);
    conditions.push(`state = $${params.length}`);
  }

  params.push(filters.limit);

  const result = await query<JobRow>(
    `SELECT * FROM jobs
     WHERE ${conditions.join(' AND ')}
     ORDER BY createdAt DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(toJob);
}
