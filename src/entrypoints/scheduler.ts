/**
 * Scheduler — milestone 5.
 *
 * Owns the queue's background maintenance:
 *
 *   promoteDue()  delayed jobs (scheduled deliveries, retry backoffs) whose
 *                 time has come move onto the ready queue
 *   reapExpired() jobs whose lease expired — their worker died mid-delivery —
 *                 move back onto the ready queue
 *
 * In M4 this ran inside the worker, which was fine for one worker and wrong for
 * many: every worker would sweep the same sorted sets every second. Maintenance
 * is singleton work, so it belongs in its own process — and to make *that*
 * process safe to run in more than one copy (for failover), the whole loop runs
 * under a distributed lock. Only the lock holder is the leader and does the
 * work; the rest sit idle, ready to take over the instant the leader's lock
 * expires. Workers, meanwhile, now do nothing but consume.
 *
 * So the three processes are cleanly separated:
 *   api        accepts events
 *   worker     delivers them (run many)
 *   scheduler  keeps the queue's time-based invariants (run for HA, one leads)
 */

import { closePool } from '../db';
import { acquire, release, renew, type Lock } from '../lock';
import { createLogger } from '../logger';
import * as queue from '../queue';
import { createRedis } from '../redis';

const log = createLogger('scheduler');

const redis = createRedis('scheduler');

const LOCK_KEY = 'lock:scheduler';

/** How often to sweep. */
const TICK_INTERVAL_MS = 1_000;

/**
 * Lock lifetime. Must comfortably exceed the tick interval so a leader that is
 * merely busy is not mistaken for dead — but short enough that a truly dead
 * leader is replaced quickly. A few ticks' worth is the sweet spot.
 */
const LOCK_TTL_MS = 5_000;

let running = true;
let shuttingDown = false;
let lock: Lock | null = null;

async function tick(): Promise<void> {
  // Renew if we already lead, otherwise try to become leader. Renewing rather
  // than re-acquiring every tick is what keeps leadership stable instead of
  // handing it around between processes.
  if (lock) {
    const stillLeader = await renew(redis, lock, LOCK_TTL_MS);
    if (!stillLeader) {
      log.warn('lost leadership');
      lock = null;
    }
  } else {
    lock = await acquire(redis, LOCK_KEY, LOCK_TTL_MS);
    if (lock) log.info('became leader');
  }

  // Followers do nothing but keep trying to acquire on the next tick.
  if (!lock) return;

  const promoted = await queue.promoteDue(redis);
  if (promoted > 0) log.info('promoted delayed jobs', { count: promoted });

  const reaped = await queue.reapExpired(redis);
  if (reaped.length > 0) {
    log.warn('reaped jobs from expired leases', {
      count: reaped.length,
      jobIds: reaped,
    });
  }
}

async function loop(): Promise<void> {
  log.info('scheduler loop started', {
    lockTtlMs: LOCK_TTL_MS,
    tickIntervalMs: TICK_INTERVAL_MS,
  });

  while (running) {
    try {
      await tick();
    } catch (err) {
      if (!running) break;
      log.error('tick failed', { error: (err as Error).message });
    }
    await sleep(TICK_INTERVAL_MS);
  }

  log.info('scheduler loop exited');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('shutting down', { signal });
  running = false;

  try {
    // Hand off leadership immediately rather than making the next process wait
    // out the TTL. Safe because release only deletes a lock we still own.
    if (lock) await release(redis, lock);
    await redis.quit();
    await closePool();
    process.exit(0);
  } catch (err) {
    log.error('shutdown error', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void loop();
