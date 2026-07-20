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
