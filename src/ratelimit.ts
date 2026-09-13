/**
 * Rate limiting — milestone 6.
 *
 * Delivering as fast as the queue drains is a good way to get your platform
 * blocked. A customer's endpoint has capacity; exceed it and you cause the very
 * 429s and 500s that trigger retries, which add more load — a feedback loop
 * that takes the endpoint down. So we cap the delivery rate PER WEBHOOK: each
 * destination gets its own budget, and one busy tenant cannot starve another.
 *
 * The algorithm is a TOKEN BUCKET, chosen over a fixed window on purpose:
 *
 *   - A bucket holds up to `burst` tokens and refills at `rate` tokens/second.
 *   - Each delivery spends one token. No token, no delivery.
 *   - Idle time accrues tokens (up to the cap), so a quiet webhook can absorb a
 *     sudden burst — which is exactly how real traffic arrives. A fixed window
 *     both allows a nasty 2x spike across the boundary AND forbids legitimate
 *     bursts within a window; the token bucket does neither.
 *
 * It is one Lua script for a reason. Read-modify-write from Node — GET tokens,
 * compute, SET tokens — is a race: two workers both read "1 token left", both
 * decide they may proceed, both deliver. Redis runs a script atomically start
 * to finish, so the check and the spend are indivisible and the count is exact
 * even with fifty workers hitting the same bucket.
 */

import type Redis from 'ioredis';

/**
 * State lives in a hash per key: `tokens` (fractional, hence stored as a float
 * string) and `ts` (last refill time in ms). Lazy refill — we compute how many
 * tokens should have accrued since `ts` on each call rather than running a
 * timer — so an untouched bucket costs nothing until it is next used.
 */
const TOKEN_BUCKET_SCRIPT = `
  local key   = KEYS[1]
  local rate  = tonumber(ARGV[1])   -- tokens per second
  local burst = tonumber(ARGV[2])   -- bucket capacity
  local now   = tonumber(ARGV[3])   -- current time, ms
  local cost  = tonumber(ARGV[4])   -- tokens this request wants

  local state  = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(state[1])
  local ts     = tonumber(state[2])

  -- First sight of this bucket: start full, so a brand-new webhook is not
  -- throttled before it has sent anything.
  if tokens == nil then
    tokens = burst
    ts = now
  end

  -- Refill for the time elapsed since we last touched it, capped at burst.
  local elapsedSec = math.max(0, now - ts) / 1000
  tokens = math.min(burst, tokens + elapsedSec * rate)

  local allowed = 0
  local retryAfterMs = 0
  if tokens >= cost then
    allowed = 1
    tokens = tokens - cost
  else
    -- How long until enough tokens have refilled to cover this request.
    local deficit = cost - tokens
    retryAfterMs = math.ceil((deficit / rate) * 1000)
  end

  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  -- Reclaim the key once it would be fully refilled anyway — an idle bucket at
  -- capacity is indistinguishable from a fresh one, so keeping it wastes memory.
  local ttlMs = math.ceil((burst / rate) * 1000) + 1000
  redis.call('PEXPIRE', key, ttlMs)

  return { allowed, retryAfterMs }
`;

export interface RateResult {
  allowed: boolean;
  /** When throttled, roughly how long until a token is available (ms). */
  retryAfterMs: number;
}

/**
 * Try to spend one token from `key`'s bucket.
 *
 * A `false` result is not a failure — the destination is fine, we are simply
 * pacing ourselves. The caller should reschedule the job after `retryAfterMs`
 * WITHOUT counting an attempt against it.
 */
export async function take(
  redis: Redis,
  key: string,
  ratePerSecond: number,
  burst: number,
  cost = 1,
): Promise<RateResult> {
  const result = (await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    String(ratePerSecond),
    String(burst),
    String(Date.now()),
    String(cost),
  )) as [number, number];

  return { allowed: result[0] === 1, retryAfterMs: result[1] };
}
