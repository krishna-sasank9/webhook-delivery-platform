/**
 * Typed client for the platform API.
 *
 * Every call goes through /api/*, which the Vite dev server proxies to the
 * backend on :3000 (see vite.config.ts). Types mirror the server's DTOs — kept
 * here by hand because the two packages don't share a build.
 */

export type JobState =
  | 'queued'
  | 'in_flight'
  | 'succeeded'
  | 'failed'
  | 'dead';

export interface Job {
  id: string;
  tenant: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  createdAt: string;
}

export interface Attempt {
  jobId: string;
  attemptNumber: number;
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
  attemptedAt: string;
}

export interface QueueStats {
  ready: number;
  inflight: number;
  delayed: number;
  dlq: number;
}

export interface Webhook {
  id: string;
  tenant: string;
  url: string;
  isActive: boolean;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => request<QueueStats>('/queue/stats'),

  listJobs: (params: { tenant: string; state?: JobState; limit?: number }) => {
    const q = new URLSearchParams({ tenant: params.tenant });
    if (params.state) q.set('state', params.state);
    if (params.limit) q.set('limit', String(params.limit));
    return request<{ jobs: Job[]; count: number }>(`/jobs?${q.toString()}`);
  },

  getJob: (id: string) => request<Job>(`/jobs/${id}`),

  getAttempts: (id: string) =>
    request<{ attempts: Attempt[]; count: number }>(`/jobs/${id}/attempts`),

  listDlq: (limit = 100) =>
    request<{ jobs: Job[]; count: number }>(`/queue/dlq?limit=${limit}`),

  replayDlq: (limit = 100) =>
    request<{ replayed: number; jobIds: string[] }>('/queue/dlq/replay', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  listWebhooks: (tenant: string) =>
    request<{ webhooks: Webhook[] }>(
      `/webhooks?tenant=${encodeURIComponent(tenant)}`,
    ),

  enqueueEvent: (body: {
    tenant: string;
    webhookId: string;
    eventType: string;
    payload: unknown;
  }) =>
    request<{ jobId: string; state: JobState }>('/events', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
