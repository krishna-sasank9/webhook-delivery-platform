/**
 * Migration runner.
 *
 * Applies every .sql file in /migrations that hasn't been applied yet, in
 * filename order, recording each one in a `schema_migrations` table so that
 * re-running this script is safe.
 *
 * Usage: pnpm migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pool, closePool } from './db';
import { createLogger } from './logger';

const log = createLogger('migrate');

// ESM has no __dirname, so derive it from this file's own URL. Resolving the
// path relative to *this file* (not the shell's cwd) means `pnpm migrate`
// works no matter which directory you run it from.
const thisFile = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(thisFile), '..', 'migrations');

async function migrate(): Promise<void> {
  // ---------------------------------------------------------------------
  // STEP 1 — Make sure the bookkeeping table exists.
  // This is the table that remembers which migrations have already run.
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      appliedAt  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ---------------------------------------------------------------------
  // STEP 2 — Work out which migrations still need to run.
  //   all files on disk  MINUS  names already in schema_migrations
  // ---------------------------------------------------------------------
  const filesOnDisk = await readdir(migrationsDir);

  const result = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  const alreadyApplied = new Set(result.rows.map((row) => row.name));

  const pending = filesOnDisk
    .filter((file) => file.endsWith('.sql'))
    .sort() // 001_, 002_, 003_ — zero-padded so string sort == numeric order
    .filter((file) => !alreadyApplied.has(file));

  if (pending.length === 0) {
    log.info('nothing to apply, schema is up to date');
    return;
  }

  log.info('pending migrations', { count: pending.length, files: pending });

  // ---------------------------------------------------------------------
  // STEP 3 — Apply each pending migration, one at a time, in order.
  // ---------------------------------------------------------------------
  for (const file of pending) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');

    // Check out ONE connection and hold it. A transaction must run entirely
    // on the same connection — pool.query() would hand out a different one
    // per call, so BEGIN and COMMIT could land on different connections and
    // the transaction would never commit.
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // The migration itself...
      await client.query(sql);

      // ...and the record that it ran. Both in the same transaction, so
      // they succeed together or fail together. That is the whole point:
      // a crash can never leave the schema changed but unrecorded, or
      // recorded but unchanged.
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);

      await client.query('COMMIT');
      log.info('applied', { file });
    } catch (err) {
      // Undo everything this migration did, then stop. Later migrations
      // may depend on this one, so continuing would be unsafe.
      await client.query('ROLLBACK');
      log.error('failed, rolled back', { file, error: (err as Error).message });
      throw err;
    } finally {
      // ALWAYS give the connection back, success or failure. Forgetting
      // this on the error path leaks one connection per failure until the
      // pool is exhausted and the process hangs forever.
      client.release();
    }
  }

  log.info('migrations complete', { applied: pending.length });
}

// ---------------------------------------------------------------------
// Entry point. Exit 0 on success, 1 on failure — so CI and shell scripts
// can tell whether the migration worked.
// ---------------------------------------------------------------------
try {
  await migrate();
  await closePool();
  process.exit(0);
} catch {
  await closePool();
  process.exit(1);
}
