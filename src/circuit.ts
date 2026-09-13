/**
 * Circuit breaker — milestone 7.
 *
 * When a destination is down, retrying it is worse than useless: every attempt
 * burns a worker for the full 10s timeout, delaying healthy jobs behind it, and
 * piles load onto a server that is already struggling. The circuit breaker is
 * the fix borrowed from electrical wiring — after enough failures it "trips" and
 * stops sending current until things look safe again.
 *
 * Three states, per webhook:
 *
 *   CLOSED     normal. Deliveries flow. Consecutive failures are counted.
 *   OPEN       tripped. Deliveries are skipped immediately (fail fast) for a
 *              cooldown window — no wasted timeouts against a dead endpoint.
 *   HALF_OPEN  cooldown elapsed. Let ONE probe through: succeed and we close
 *              the circuit, fail and we open it again for another cooldown.
 *
 * Why per webhook and not global: one broken customer endpoint must not stop
 * deliveries to everyone else. The breaker is keyed by webhook id.
 *
 * Why Lua: state and counter live in Redis so every worker shares one view of a
 * destination's health — a breaker that each worker tracked locally would need
 * N failures per worker to trip. Reading the state, deciding, and transitioning
 * must be atomic or two workers racing on the boundary corrupt the count.
 *
 * The honest simplification: in HALF_OPEN this lets through possibly a few
 * concurrent probes rather than exactly one (enforcing exactly-one needs a
 * second lock). Slightly more load on a recovering endpoint, never a
 * correctness problem — worth stating rather than hiding.
 */

import type Redis from 'ioredis';

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Keep breaker state around well past a cooldown, then let it lapse to closed. */
const STATE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Decide whether a delivery may proceed, transitioning open -> half_open when
// the cooldown has elapsed. Returns the effective state the caller should act
// on: 'open' means block, anything else means go.
const CHECK_SCRIPT = `
  local key      = KEYS[1]
  local now      = tonumber(ARGV[1])
  local cooldown = tonumber(ARGV[2])

  local state = redis.call('HGET', key, 'state')
  if state == false or state == 'closed' then return 'closed' end
  if state == 'half_open' then return 'half_open' end

  -- state == 'open': block until the cooldown expires, then allow one probe.
  local openedAt = tonumber(redis.call('HGET', key, 'openedAt')) or 0
  if now - openedAt >= cooldown then
    redis.call('HSET', key, 'state', 'half_open')
    redis.call('PEXPIRE', key, ARGV[3])
    return 'half_open'
  end
  return 'open'
`;

// A success closes the circuit and clears the failure count, whatever state we
// were in — one clean delivery is the definition of recovered.
const SUCCESS_SCRIPT = `
  local key = KEYS[1]
  redis.call('HSET', key, 'state', 'closed', 'failures', 0)
  redis.call('PEXPIRE', key, ARGV[1])
  return 'closed'
`;

// A failure trips the breaker: a failed HALF_OPEN probe reopens it immediately,
// otherwise we count up and open once the threshold is crossed.
const FAILURE_SCRIPT = `
  local key       = KEYS[1]
  local threshold = tonumber(ARGV[1])
  local now       = tonumber(ARGV[2])
  local ttl       = ARGV[3]

  local state = redis.call('HGET', key, 'state')

  if state == 'half_open' then
    redis.call('HSET', key, 'state', 'open', 'openedAt', now, 'failures', threshold)
    redis.call('PEXPIRE', key, ttl)
    return 'open'
  end

  local failures = redis.call('HINCRBY', key, 'failures', 1)
  if failures >= threshold then
    redis.call('HSET', key, 'state', 'open', 'openedAt', now)
    redis.call('PEXPIRE', key, ttl)
    return 'open'
  end

  redis.call('PEXPIRE', key, ttl)
  return 'closed'
`;

/**
 * Should a delivery to this webhook be attempted right now?
 *
 * Returns 'open' to block (fail fast), 'closed'/'half_open' to proceed. The
 * open -> half_open transition happens here, so calling this is what lets a
 * recovered endpoint be tried again.
 */
export async function check(
  redis: Redis,
  key: string,
  cooldownMs: number,
): Promise<CircuitState> {
  const state = (await redis.eval(
    CHECK_SCRIPT,
    1,
    key,
    String(Date.now()),
    String(cooldownMs),
    String(STATE_TTL_MS),
  )) as CircuitState;
  return state;
}

/** Record a successful delivery: closes the circuit. */
export async function recordSuccess(redis: Redis, key: string): Promise<void> {
  await redis.eval(SUCCESS_SCRIPT, 1, key, String(STATE_TTL_MS));
}

/**
 * Record a failed delivery: trips the circuit once failures reach `threshold`,
 * or immediately if a half-open probe just failed.
 */
export async function recordFailure(
  redis: Redis,
  key: string,
  threshold: number,
): Promise<CircuitState> {
  const state = (await redis.eval(
    FAILURE_SCRIPT,
    1,
    key,
    String(threshold),
    String(Date.now()),
    String(STATE_TTL_MS),
  )) as CircuitState;
  return state;
}
