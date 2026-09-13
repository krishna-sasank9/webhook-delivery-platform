/**
 * Worker — milestones 4-7.
 *
 * Does one thing: claim jobs and deliver them (ack / retry / dead-letter). The
 * queue's time-based maintenance — promoting due jobs, reaping dead leases —
 * moved out to the scheduler in M5, because that work is singleton and must not
 * run once per worker. A worker is now purely a consumer.
 *
 * It still needs TWO Redis connections. The consume loop parks on BRPOPLPUSH
 * for seconds at a time, and a connection blocked on that cannot serve any
 * other command — the ack/retry/rate-limit/circuit commands issued while
 * processing a job would queue up behind the block. This is the concrete reason
 * `createRedis` is a factory rather than a shared singleton.
 *
 * Scaling is running more copies of this process. Nothing to reconfigure:
 * Redis guarantees each BRPOPLPUSH hands a job to exactly one consumer.
 */

import { randomUUID } from 'node:crypto';

import { closePool } from '../db';
import { createLogger } from '../logger';
import * as jobService from '../modules/jobs/job.service';
import * as queue from '../queue';
import { createRedis } from '../redis';

const workerId = `worker-${randomUUID().slice(0, 8)}`;
const log = createLogger(workerId);

// Blocking connection for the consume loop.
const consumeRedis = createRedis(`${workerId}:consume`, { blocking: true });
// Non-blocking connection for ack/retry/DLQ, rate-limit and circuit commands.
const commandRedis = createRedis(`${workerId}:command`);

/** Bounds how long shutdown waits for an idle block to end. */
const BLOCK_SECONDS = 5;

let running = true;
let shuttingDown = false;

// ---------------------------------------------------------------------------

async function consume(): Promise<void> {
  log.info('consume loop started');

  while (running) {
    let jobId: string | null = null;

    try {
      jobId = await queue.reserve(consumeRedis, BLOCK_SECONDS);
    } catch (err) {
      if (!running) break; // connection closed during shutdown — expected
      log.error('reserve failed', { error: (err as Error).message });
      continue;
    }

    if (!jobId) continue; // timed out with nothing to do

    try {
      await jobService.process(commandRedis, jobId);
    } catch (err) {
      // Never let one bad job kill the worker. The job stays in flight; its
      // lease will expire and the reaper will return it to the ready queue.
      // Slower than an explicit nack, but it cannot be lost.
      log.error('job processing failed, leaving for reaper', {
        jobId,
        error: (err as Error).message,
      });
    }
  }

  log.info('consume loop exited');
}

// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('shutting down', { signal });

  // Stop claiming new work; let the in-flight job finish. Worst case the
  // consume loop exits after BLOCK_SECONDS.
  running = false;

  try {
    await consumeRedis.quit();
    await commandRedis.quit();
    await closePool();
    process.exit(0);
  } catch (err) {
    log.error('shutdown error', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info('worker started', {
  visibilityTimeoutMs: queue.VISIBILITY_TIMEOUT_MS,
});

void consume();
