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
} as const;

export { config }