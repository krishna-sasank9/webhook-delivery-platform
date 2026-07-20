export type JobState =
  | 'queued'
  | 'in_flight'
  | 'succeeded'
  | 'failed'
  | 'dead';

// ---------------------------------------------------------------------------
// Database row shapes.
//
// Postgres folds unquoted identifiers to lowercase, so the column declared as
// `webhookId` in the DDL comes back from `pg` as `webhookid`. These interfaces
// describe what the driver actually hands us — never what the DDL looks like.
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string;
  tenant: string;
  url: string;
  secret: string;
  isactive: boolean;
  createdat: Date;
}

export interface JobRow {
  id: string;
  tenant: string;
  webhookid: string;
  eventtype: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  maxattempts: number;
  runat: Date;
  lasterror: string | null;
  createdat: Date;
  updatedat: Date;
}

// ---------------------------------------------------------------------------
// API shapes — camelCase and JSON-friendly. Dates are ISO strings.
//
// `secret` is deliberately absent from `Webhook`: the signing secret must never
// leave the server, and modelling it as absent makes leaking it a type error
// rather than a code review catch.
// ---------------------------------------------------------------------------

export interface Webhook {
  id: string;
  tenant: string;
  url: string;
  isActive: boolean;
  createdAt: string;
}

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
