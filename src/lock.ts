/**
 * A distributed lock — milestone 5.
 *
 * The problem it solves: maintenance work (promoting due jobs, reaping expired
 * leases) must happen, but it must NOT happen from every process at once. Run
 * ten schedulers and you get ten concurrent ZRANGEBYSCORE sweeps fighting over
 * the same keys — wasted work, and a real risk of double-promoting a job. We
 * want exactly one process doing it at a time, with automatic failover if that
 * process dies. That is leader election, and a lock with a TTL is the simplest
 * way to get it.
 *
 * The design is the classic single-instance Redis lock:
 *
 *   acquire   SET key <random-token> NX PX <ttl>
 *   release   delete the key ONLY IF it still holds our token (Lua CAS)
 *   renew     extend the TTL ONLY IF it still holds our token
 *
 * Two details are load-bearing:
 *
 *   1. The TTL. If the leader crashes without releasing, the key expires on its
 *      own and another process can take over. A lock without a TTL held by a
 *      dead process is a deadlock forever.
 *
 *   2. The unique token + compare-and-delete on release. Without it, this race
 *      loses data: process A acquires, A stalls past the TTL, the key expires,
 *      B acquires the now-free lock, then A wakes and calls DEL — deleting B's
 *      lock. The token check means A can only ever delete a lock it still owns.
 *
 * This is deliberately NOT full Redlock (the multi-node quorum algorithm). With
 * a single Redis instance there is nothing to quorum over, and the honest
 * framing for an interview is: this is correct for one Redis, and the failure
 * mode it does not cover — two leaders briefly during a GC pause longer than
 * the TTL — is made safe downstream by the operations themselves being atomic
 * and idempotent (promote/reap are single Lua scripts).
 */

import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

export interface Lock {
  key: string;
  /** Random per-acquisition token that proves ownership on release/renew. */
  token: string;
}

/**
 * Try to take the lock. Returns a Lock on success, null if someone else holds
 * it. Never blocks — the caller decides whether to retry.
 */
export async function acquire(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<Lock | null> {
  const token = randomUUID();
  // NX = set only if absent; PX = expire after ttlMs. Both in one atomic
  // command, so two processes racing to acquire cannot both win.
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? { key, token } : null;
}

// Delete the key only if it still holds our token. GET-then-DEL in two commands
// would reintroduce the very race the token exists to prevent, so it must be
// one atomic script.
const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/** Release the lock. Returns false if we no longer held it (TTL had expired). */
export async function release(redis: Redis, lock: Lock): Promise<boolean> {
  const result = await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  return result === 1;
}

// Extend the TTL, again only if we still own the lock. This is how a leader
// keeps its leadership: renew every cycle instead of re-acquiring.
const RENEW_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

/**
 * Push the lock's expiry out by another ttlMs. Returns false if we lost the
 * lock in the meantime — the caller should treat that as "no longer leader".
 */
export async function renew(
  redis: Redis,
  lock: Lock,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis.eval(
    RENEW_SCRIPT,
    1,
    lock.key,
    lock.token,
    String(ttlMs),
  );
  return result === 1;
}
