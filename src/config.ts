import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requiredInt(key: string): number {
  const raw = required(key);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * An integer with a fallback. Used for tuning knobs (rate limits, breaker
 * thresholds) that have sensible defaults — unlike connection details, a
 * missing value here is not a misconfiguration worth crashing over.
 */
function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

const config = {
  env: process.env.NODE_ENV ?? 'development',

  api: {
    port: requiredInt('API_PORT'),
  },

  redis: {
    host: required('REDIS_HOST'),
    port: requiredInt('REDIS_PORT'),
  },

  postgres: {
    host: required('PGHOST'),
    port: requiredInt('PGPORT'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
    database: required('PGDATABASE'),
  },

  // Per-webhook delivery rate limit (M6). A token bucket: `burst` deliveries
  // may go out at once, refilling at `perSecond`. Applied per destination so
  // one busy tenant cannot starve another and no single endpoint gets flooded.
  rateLimit: {
    perSecond: optionalInt('RATE_LIMIT_PER_SECOND', 10),
    burst: optionalInt('RATE_LIMIT_BURST', 20),
  },

  // Per-webhook circuit breaker (M7). After `failureThreshold` consecutive
  // failures the circuit opens and deliveries are skipped for `cooldownMs`,
  // then one probe is allowed through to test recovery.
  circuit: {
    failureThreshold: optionalInt('CIRCUIT_FAILURE_THRESHOLD', 5),
    cooldownMs: optionalInt('CIRCUIT_COOLDOWN_MS', 30_000),
  },
} as const;

export { config }