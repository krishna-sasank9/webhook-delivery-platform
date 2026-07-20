CREATE TABLE IF NOT EXISTS webhooks(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    isActive BOOLEAN NOT NULL DEFAULT TRUE,
    createdAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_tenant on webhooks (tenant) WHERE isActive;

CREATE TYPE job_state as ENUM (
    'queued',
    'in_flight',
    'succeeded',
    'failed',
    'dead'
);

CREATE TABLE IF NOT EXISTS jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant     TEXT        NOT NULL,
  webhookId    UUID        NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  eventType    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  state         job_state   NOT NULL DEFAULT 'queued',
  attempts      INT         NOT NULL DEFAULT 0,
  maxAttempts  INT         NOT NULL DEFAULT 5,
  runAt        TIMESTAMPTZ NOT NULL DEFAULT now(),
  lastError    TEXT,
  createdAt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT attempts_within_max CHECK (attempts <= maxAttempts)
);

CREATE INDEX IF NOT EXISTS idx_jobs_due
  ON jobs (runAt) WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_state
  ON jobs (tenant, state, createdAt DESC);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobId          UUID        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attemptNumber  INT         NOT NULL,
  statusCode     INT,
  responseBody   TEXT,
  error           TEXT,
  durationMs     INT         NOT NULL,
  attemptedAt    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (jobId, attemptNumber)
);

CREATE INDEX IF NOT EXISTS idx_attempts_job
  ON delivery_attempts (jobId, attemptNumber DESC);