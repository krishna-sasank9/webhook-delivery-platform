import pg from "pg";
import { config } from "./config";
import { createLogger } from "./logger";

const log = createLogger("db");

const pool = new pg.Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err: Error) => {
  log.error("idle client error", { error: err.message });
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const startedAt = Date.now();
  const result = await pool.query<T>(text, params);
  log.debug("query", {
    durationMs: Date.now() - startedAt,
    rows: result.rowCount,
  });
  return result;
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };
