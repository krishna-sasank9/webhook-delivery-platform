/**
 * Request/response contracts for the job routes.
 */

import type { Job, JobState } from '../../types';

const JOB_STATES: JobState[] = [
  'queued',
  'in_flight',
  'succeeded',
  'failed',
  'dead',
];

// ---------------------------------------------------------------------------
// POST /events
// ---------------------------------------------------------------------------

export interface EnqueueEventBody {
  tenant: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  /** ISO-8601. Omit to run immediately; set to schedule for later (M5). */
  runAt?: string;
}

export const enqueueEventSchema = {
  body: {
    type: 'object',
    required: ['tenant', 'webhookId', 'eventType', 'payload'],
    additionalProperties: false,
    properties: {
      tenant: { type: 'string', minLength: 1, maxLength: 128 },
      webhookId: { type: 'string', format: 'uuid' },
      eventType: { type: 'string', minLength: 1, maxLength: 128 },
      payload: { type: 'object' },
      runAt: { type: 'string', format: 'date-time' },
    },
  },
} as const;

/**
 * Deliberately minimal. The caller gets an id to poll with and nothing else —
 * echoing the payload back would imply we have done something with it, and at
 * this point we have only written a row.
 */
export interface EnqueueEventResponse {
  jobId: string;
  state: JobState;
}

// ---------------------------------------------------------------------------
// GET /jobs/:id
// ---------------------------------------------------------------------------

export interface JobParams {
  id: string;
}

export const getJobSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// GET /jobs?tenant=acme&state=queued&limit=50
// ---------------------------------------------------------------------------

export interface ListJobsQuery {
  tenant: string;
  state?: JobState;
  limit?: number;
}

export const listJobsSchema = {
  querystring: {
    type: 'object',
    required: ['tenant'],
    properties: {
      tenant: { type: 'string', minLength: 1 },
      state: { type: 'string', enum: JOB_STATES },
      // Capped so a client cannot ask for the entire table in one request.
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
} as const;

export interface ListJobsResponse {
  jobs: Job[];
  count: number;
}
