# Interview Notes — Webhook Delivery Platform

Running log of the design decisions, patterns, and bugs worth explaining out loud.
Each entry: **what**, **why it matters**, and the **gotcha** an interviewer might probe.

---

## M4 — Reliable queue: retries, backoff, DLQ, reaper

**Reliable-queue pattern (SQS-style).** Five Redis structures:
`ready` (list) → `inflight` (list) → `leases` (sorted set) → `delayed` (sorted set) → `dlq` (list).
Claiming a job is `BRPOPLPUSH ready → inflight` (atomic: the id is never in *neither*
list), plus a `ZADD` lease with an expiry. The worker must then explicitly
ack / retry / dead-letter.

- **Why atomic claim:** a plain `BRPOP` deletes the id the instant it's read. If
  the worker dies before finishing, nobody knows the job existed — silent loss.
- **Visibility timeout + reaper:** if a worker dies mid-delivery, its lease
  expires and the reaper (`ZRANGEBYSCORE leases -inf now`) moves the job back to
  ready. This is what makes loss *impossible* rather than merely unlikely.
- **Delivery guarantee:** **at-least-once**, never exactly-once. A worker can
  complete the HTTP call then die before acking → the job is redelivered. The
  fix isn't on our side; it's receiver-side idempotency (the `idempotency-key`
  header we send, stable across retries = the job id).
- **Lua for multi-step atomicity:** ack/retry/dlq each touch 2–3 keys. Redis is
  single-threaded and runs a script start-to-finish with nothing interleaved, so
  `LREM + ZREM (+ ZADD/LPUSH)` can't be torn by a crash between commands.

**Exponential backoff + FULL JITTER.**
`delay = random(0, min(2^(attempts-1) * base, cap))`.
- Exponential: a server that just 500'd is struggling; retrying every second is a
  self-inflicted DDoS.
- **Full jitter** (the load-bearing part): without randomness, 10k jobs that
  failed in the same outage all retry at the *same instant* — the "thundering
  herd" — and fail again in lockstep. Verified live: gaps of 718ms / 1990ms /
  647ms / 7725ms, clearly randomized.

**Retryable vs permanent.** 5xx / 408 / 429 / null(network) → retry; other 4xx →
die immediately. A 400 means malformed; sending identical bytes 5 more times
gets 5 identical rejections — pointless, and it pollutes the DLQ.

**DLQ is an inbox, not a bin.** Jobs that exhaust attempts land here for a human
to inspect and *replay* after fixing the cause (endpoint back online, URL fixed).

### 🐞 BUG #1 — DLQ replay didn't redeliver (the whole reason M4 needed a fix)
Replay originally just moved the id `DLQ → ready` in Redis. But the Postgres row
was still `state='dead'`, so the worker's terminal-state guard (`if state==='dead'
ack`) discarded it instantly. It *looked* replayed (`{replayed:1}`) but was
silently dropped.
**Fix:** replay is not a pure Redis move. Orchestrate it in the service:
reset the Postgres row (`state='queued'`, fresh budget, `runAt=now`) **first**,
then push to ready — same Postgres-first ordering as enqueue.

### 🐞 BUG #2 — replayed job crashed on a UNIQUE violation (found during live verify)
After Fix #1, replay reset `attempts = 0`, and delivery code computed the audit
row number as `attemptNumber = job.attempts + 1`. So the redelivery tried to
insert `delivery_attempts` row **#1 again** — but rows #1–#5 already existed, and
`UNIQUE(jobId, attemptNumber)` rejected it. The insert threw *after* the HTTP call
had already gone out, so the job never acked and looped through the reaper forever.
**Root cause: two different counters were conflated.**
- `attempts` = the retry **budget** (drives backoff + exhaustion; *should* reset
  on replay for a fresh start).
- `attemptNumber` = the immutable **audit sequence** (must be monotonic, never
  reused).
**Fix:** decouple them. `attemptNumber` is now `COALESCE(MAX(attemptNumber),0)+1`
per job — monotonic no matter how many times the job is replayed. Safe without a
lock because an in-flight job is owned by exactly one worker.
Verified: after replay, audit rows read `1..5 = 500` then `6 = 200`, job
`succeeded`, `attempts=1`.

*Lesson to tell: the two DLQ-replay bugs both came from a data model that mixed
"how many tries are left" with "what actually happened." Separating budget from
audit trail fixed both.*

---

## M5 — Delayed jobs, distributed lock, scheduler process

**Delayed jobs** use the `delayed` sorted set scored by due-time. Both scheduled
deliveries (`runAt` in the future) and retry backoffs land there. A maintenance
sweep `ZRANGEBYSCORE delayed -inf now` promotes the due ones to `ready`. This is
also how backoff is enforced — a retry isn't "sleep then push", it's "push to
delayed with score = now + backoff", which survives a worker restart.

**Distributed lock (leader election).** Maintenance (promote + reap) is
*singleton* work — running it from every process means N concurrent sweeps
fighting over the same keys. So it moved out of the worker into a dedicated
**scheduler** process, and the whole loop runs under a lock so you can run many
schedulers for HA but only one does the work.
- `acquire`: `SET key <random-token> NX PX <ttl>` — atomic, exactly one winner.
- `release`/`renew`: Lua **compare-and-delete / compare-and-expire** — act only
  if the key still holds *our* token.
- **Why the token + CAS matters (the classic race):** A acquires → A stalls past
  the TTL → key expires → B acquires → A wakes and `DEL`s → **A just deleted B's
  lock.** The token check means A can only ever delete a lock it still owns.
- **Why a TTL:** if the leader crashes, the key expires on its own and a standby
  takes over. A lock with no TTL held by a dead process is a deadlock forever.
- **Renew vs re-acquire:** the leader renews every tick (extends TTL) rather than
  re-acquiring, so leadership is stable instead of bouncing between processes.
- **Honest scope:** this is a single-instance Redis lock, *not* Redlock (the
  multi-node quorum algorithm). With one Redis there's nothing to quorum over.
  The one failure it doesn't cover — two leaders briefly during a GC pause longer
  than the TTL — is made safe downstream because promote/reap are each a single
  atomic Lua script and idempotent, so a double-run can't corrupt anything.

**Reaper = crash recovery.** Verified live: a worker that threw mid-processing
left a job `in_flight`; its lease expired and the scheduler's reaper returned it
to `ready` automatically (~visibility timeout later).

**Failover verified live:** two schedulers running, only ONE logged "became
leader" (mutual exclusion). `kill -9` the leader → the standby became leader ~1s
after the dead leader's lock TTL lapsed. No config, no coordination — just the
lock.

**Process split:** `api` (accepts events) · `worker` (delivers, run many) ·
`scheduler` (time-based invariants, run for HA, one leads). One codebase, three
entrypoints, run as separate processes.

---

## M6 — Rate limiting (per-webhook token bucket)

Cap delivery rate **per destination** so one busy tenant can't starve another,
and so we don't flood a customer's endpoint into the 429s/500s that would trigger
more retries — a feedback loop that takes the endpoint down.

**Token bucket, in one Lua script.** Bucket holds up to `burst` tokens, refills
at `rate`/sec, each delivery spends one. Chosen over a fixed window because:
- idle time accrues tokens, so a quiet webhook can absorb a legitimate burst;
- a fixed window both allows a 2× spike across the boundary *and* forbids bursts
  within a window — the token bucket does neither.
- **Lazy refill:** compute accrued tokens from elapsed time on each call instead
  of a background timer — an untouched bucket costs nothing. Keys self-expire
  once they'd be full again.
- **Why atomic:** read-modify-write from Node races — two workers both read "1
  left", both proceed. One script = check-and-spend is indivisible.

**Key design point:** a rate-limited job is **rescheduled without spending an
attempt** — we're pacing ourselves, not failing. Verified live: 20 events at
burst=5/rate=5/s → a few immediate, the rest parked in `delayed` (11 → 6 → 0)
draining at 5/s, **all 20 succeeded, 0 dead**.

---

## M7 — Idempotency, circuit breaker, HMAC signing

**HMAC signing (delivery integrity).** Sign `HMAC-SHA256(secret, "<ts>.<body>")`,
send as `x-signature: v1=...` + `x-signature-timestamp`. This is the Stripe
scheme.
- Sign the **timestamp too** so a captured request can't be replayed forever —
  the receiver rejects anything older than a few minutes.
- Serialize the body **once** and sign+send the same bytes (re-stringifying could
  reorder keys and break the signature).
- Receiver must use a **constant-time compare** or the comparison leaks the
  signature via timing. Verified live: receiver recomputed and reported `VALID`.

**Idempotency (producer-side dedupe).** A client that times out on POST retries;
without protection that creates a duplicate job. With an `Idempotency-Key` header
we guarantee **at most one job per (tenant, key)**.
- **Reserve-first** to handle two identical requests arriving at once:
  `SET key PENDING NX` — exactly one wins and creates the job, then overwrites the
  slot with the real job id. A later duplicate reads the slot: a job id → "here's
  the existing one"; still PENDING → "in flight, retry".
- On creation failure we `abort` (delete the slot) so the client's retry isn't
  stuck seeing PENDING until expiry. Keys expire after 24h.
- Distinct from the queue's at-least-once guarantee: this stops *duplicate jobs*;
  the `idempotency-key` header we send on delivery (= the stable job id) lets the
  *receiver* dedupe *redeliveries*. Verified live: same key ×3 → same jobId, one
  job created.

**Circuit breaker (per-webhook).** When a destination is down, retrying wastes a
worker for the full 10s timeout and piles load on a struggling server. Three
states in Redis (shared across all workers):
- **closed** → deliver, count consecutive failures.
- **open** → after `threshold` failures, *skip* deliveries for a cooldown (fail
  fast, no HTTP call).
- **half_open** → after cooldown, let one probe through; success closes, failure
  reopens.
- **Per webhook**, not global — one broken endpoint mustn't stop everyone else.
- **Not an attempt:** an open-circuit skip reschedules the job without spending
  its retry budget (same principle as rate limiting).
- **Honest simplification:** half-open may let a few concurrent probes through
  rather than exactly one (exact needs a second lock) — more load on a recovering
  endpoint, never a correctness bug.
- Verified live: 5 jobs → dead endpoint. Breaker opened after 3 failures; only
  **6 HTTP calls** reached it (vs 25 without a breaker) and **15 fast-skips**
  logged.

---

## Ops / testing gotchas (worth mentioning)

- **`tsx watch` orphans:** `pkill -f 'tsx watch'` kills the watcher but can leave
  the child `node` running, which keeps consuming from Redis and splits your
  logs. For deterministic tests run `tsx` (no `watch`) as a single process, or
  kill the whole process tree.
- **Redis connection factory, not singleton:** the worker's consume loop parks on
  `BRPOPLPUSH` for seconds; a connection blocked there can't serve any other
  command. Blocking connections also need `maxRetriesPerRequest: null` or ioredis
  counts the wait as a failed request and aborts the block.

---

## M8 — Operator dashboard (React + Vite)

A separate `web/` package (React 18 + Vite + TS), registered as a pnpm workspace
member so one `pnpm install` covers both. Talks to the API through a **Vite dev
proxy** (`/api/*` → `:3000`, prefix stripped) — so the browser only makes
same-origin requests and the backend needs **no CORS** concessions. For prod
you'd serve the built `dist/` behind the same origin as the API, or add
`@fastify/cors`.

**New read endpoints added for it (backend):**
- `GET /jobs/:id/attempts` — the delivery-attempt audit trail (getById first so a
  missing job is a clean 404, not an ambiguous empty list).
- `GET /queue/dlq` — a **read-only peek** (`LRANGE`, not pop) of the DLQ,
  hydrated into full job rows via a single `WHERE id = ANY($1)` batch query
  (re-sorted to match Redis order — SQL makes no ordering promise).

**Design points worth saying:**
- **Polling, not websockets.** The dashboard is a live view of a moving system;
  a 2s poll of `/queue/stats` + `/jobs` is simple, stateless, and survives
  reconnects for free. A `usePolling` hook runs a fetcher on an interval with an
  `enabled` flag (pause) and a manual `refresh` (call it right after a DLQ replay
  instead of waiting for the next tick).
- **The job-detail drawer is where the retry story is legible** — you read
  `#1..#5 = 500` then `#6 = 200` and see exactly what happened, straight off the
  `delivery_attempts` audit trail (the same table bug #2 was about).
- **DLQ `dlq > 0` is the one stat that's always an alert** — its card and tab
  badge go red, because unlike ready/inflight/delayed a non-zero DLQ always wants
  a human.
- **Replay from the UI** hits the same `POST /queue/dlq/replay` that resets each
  job server-side (bug #1 fix), then refreshes stats + jobs + DLQ together.

Verified live end-to-end through the proxy: jobs list, DLQ contents, per-job
attempts, stats — all correct; production `vite build` clean; `tsc` clean.

---

## M9 — Load test + architecture write-up

**Load test design (`scripts/loadtest.mjs`).** Self-contained: runs its *own*
receiver in-process so it can stamp the exact delivery time per job and diff it
against enqueue time with **no cross-machine clock skew**. Measures the four
things that actually matter for a queue:
1. enqueue throughput + latency (what a producer sees),
2. delivery throughput (how fast workers drain),
3. end-to-end latency (enqueue → delivered),
4. duplicate rate (at-least-once: how often "≥1" was ">1").

**Methodology gotchas worth mentioning:**
- **Spread load across many webhooks.** Delivery is rate-limited *per webhook*, so
  hammering one bucket measures the refill rate, not the system. The test fans out
  over 8 webhooks; for the capacity numbers the limiter was also raised so the
  result reflects the system, not a feature.
- **Measure worker count, don't assume it.** First scaling run was polluted by a
  leftover worker from a previous stack (the `tsx` process tree makes `pkill`
  unreliable). Re-ran counting *distinct worker ids from the logs* before each run
  — trust the system's own report, not your process bookkeeping.

**Numbers (one laptop, Docker Redis+PG):**
- Enqueue: ~4–5k events/sec, p50 ≈ 9ms, p99 ≈ 30ms — decoupled from delivery, so
  a slow customer never slows the producer (the whole point of the `202`).
- Delivery scales ~linearly: **1 worker → 219/sec**, **4 workers → 992/sec**
  (~4.5×); end-to-end p50 dropped 4.55s → 1.14s for a 2,000-job burst.
- **0 duplicates** with no failures; duplicates appear only on actual worker death
  (the reaper redelivering) — at-least-once being honest, not lossy.

**The scaling story to tell:** workers are stateless pull consumers and Redis
hands each `BRPOPLPUSH` to exactly one of them, so adding delivery capacity is
"run more worker processes" — no sharding, no coordination, no config. That
property is the payoff of putting the queue in Redis rather than in the workers.

**Architecture write-up:** [`ARCHITECTURE.md`](../ARCHITECTURE.md) at the repo
root — components, the queue lifecycle diagram, the at-least-once argument, a
failure-mode table, the load-test results, and an honest "production gaps"
section (single-instance lock vs Redlock, SSRF allow-listing, connection pooling,
automated Redis rebuild-from-Postgres).
