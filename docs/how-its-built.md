# How it's built — patterns & interview guide

Two parts: **why this project is worth talking about in interviews**, and **how
the code is actually structured** so the patterns can be rebuilt from scratch.
Per-milestone *why* (and the bugs found) lives in [`interview-notes.md`](interview-notes.md);
the big picture in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## Part 1 — Interview value

### What it proves

Most candidates say *"I used BullMQ / SQS / Kafka."* This project lets me say
*"I built the reliable-queue pattern from Redis primitives, and here's every
trade-off I hit."* That's the shift from **library user** to **understanding the
machinery** — the gap interviewers probe for.

Fluent talking points it unlocks:

| Topic | The line |
| --- | --- |
| Delivery semantics | At-least-once, because exactly-once is impossible across a network — so make delivery idempotent instead of pretending to prevent duplicates. |
| Visibility timeout / leases | A claimed job holds a lease; if the worker dies, the lease expires and a reaper requeues it (same idea as SQS). |
| Atomicity | Multi-step queue ops are Lua scripts — Redis runs them start-to-finish single-threaded, so a crash can't tear them half-done. |
| Thundering herd | Exponential backoff *with full jitter* — without jitter, jobs that failed in one outage retry in lockstep and re-DDoS the recovering server. |
| Distributed lock | `SET NX PX` with a random token, released via a Lua compare-and-delete — the token stops you deleting a lock that already expired and got retaken. |
| Circuit breaker | Per-webhook, three states, so one dead endpoint doesn't waste workers or starve healthy customers. |
| Backpressure | Per-webhook token bucket; a throttled job is *rescheduled, not failed* — it doesn't burn its retry budget. |
| Security | HMAC-SHA256 over timestamp+body so replays are rejected; SSRF guard on registration; IDOR returns 404 not 403. |

### The two bugs are the best material

For "tell me about a hard bug":
1. **DLQ replay silently dropped jobs** — a Redis-only move left Postgres saying
   `dead`, so the worker acked it away. *Coordination and truth must agree.*
2. **Replay crashed on a UNIQUE violation** — `attempts` (retry budget) was
   conflated with `attemptNumber` (audit sequence). *Two concepts wearing one
   variable.* This one signals seniority — it's a data-modeling insight, not a
   syntax fix.

### Measured, not guessed

"Load-tested it: ~4–5k enqueues/sec; delivery scaled ~linearly 219→992/sec across
1→4 workers; zero duplicates without failures." Most candidates never benchmark
their own projects.

### The story arc (memorize the shape)

> Naive version = one inline POST. Then: customer is down? → queue + retries.
> Worker dies mid-retry? → visibility timeout + reaper. 10k retries fire at once?
> → backoff + jitter. Endpoint permanently down? → circuit breaker + DLQ. Client
> double-submits? → idempotency. Someone forges a delivery? → HMAC.

Each answer is a milestone. That progression *is* system-design thinking.

---

## Part 2 — How the code is written

The whole codebase is **~6 patterns applied repeatedly**. Learn the patterns, not
the 20 files.

### Pattern 1 — The process model
One `package.json`, one `src/`, **three entrypoints** (`src/entrypoints/{api,worker,scheduler}.ts`)
run as separate OS processes that **never import each other** — they communicate
only through Redis and Postgres. A "modular monolith / worker pool": fault
isolation + independent scaling (8 workers, 1 api) without microservice overhead.
Each entrypoint wires up connections, starts a server or loop, and handles
`SIGTERM` for graceful shutdown.

### Pattern 2 — Layering: controller → service → repository
Every feature has three files:
- **controller.ts** — HTTP only: parse request, call service, shape response. Knows Fastify.
- **service.ts** — business rules; throws domain errors; **never imports Fastify**.
- **repository.ts** — SQL only; no decisions.

The service is reusable (the worker calls `jobService.process` with no HTTP
involved). Domain errors (`src/errors.ts`) are translated to status codes in **one
place**: `routes.ts`'s `setErrorHandler`. That inversion keeps services HTTP-free.

### Pattern 3 — The foundations (write these first, every project)
- **config.ts** — typed env loader that **fails fast** (`required`/`requiredInt` throw on boot, not at 3am).
- **logger.ts** — `createLogger(scope)` → scoped structured JSON logs.
- **db.ts** — one `pg.Pool` + a `query()` helper (never a connection per query).
- **redis.ts** — a **factory** `createRedis(name, {blocking})`, *not* a singleton.

**Why redis is a factory:** a blocking command (`BRPOPLPUSH`) *monopolizes its
connection* — while parked waiting for a job, that socket can't run any other
command. So the worker needs a second connection for ack/retry. Blocking
connections also set `maxRetriesPerRequest: null`, or ioredis counts the wait as a
failed request and aborts the block.

### Pattern 4 — The queue = data structures + Lua wrapped in thin functions
`src/queue.ts` is the heart: **5 Redis keys** and functions over them.
```
ready(list)  inflight(list)  leases(zset)  delayed(zset)  dlq(list)
```
Each function is a one-line Redis call or a **Lua script + thin TS wrapper**.
`ack` must remove from `inflight` AND drop the lease atomically:
```lua
redis.call('LREM', KEYS[1], 1, ARGV[1])   -- inflight
redis.call('ZREM', KEYS[2], ARGV[1])      -- leases
```
**Mental model:** anything touching 2+ keys that must not be interrupted = one Lua
script. `KEYS[]` = keys, `ARGV[]` = args. Redis being single-threaded does the
hard part. `reserve` = `BRPOPLPUSH ready→inflight` + `ZADD` lease; `promoteDue`/
`reapExpired` = `ZRANGEBYSCORE … then move`. Same shape every time.

### Pattern 5 — Every coordination primitive is the same shape
`lock.ts`, `ratelimit.ts`, `circuit.ts`, `idempotency.ts` are all **Lua makes the
atomic decision, a thin TS function calls it**:
- **Lock:** `SET key token NX PX ttl`; release = Lua `if GET==token then DEL`.
- **Rate limit:** Lua token bucket — read tokens+ts, refill by elapsed time, spend one if available.
- **Circuit breaker:** Lua reads state (closed/open/half_open), decides allow/block, transitions.
- **Idempotency:** `SET key PENDING NX` to reserve, overwrite with job id when done.

Write one and you can write all four — they're variations on "read-decide-write, atomically."

### Pattern 6 — Ordering & the worker loop
- **Postgres-first, Redis-second, everywhere.** Enqueue writes the DB row (truth)
  then pushes the id (coordination). A crash between them leaves a recoverable
  `queued` row — never a queued id pointing at nothing. Replay does the same.
- **The worker loop** (`worker.ts`): `reserve → process → (ack|retry|deadLetter)`,
  wrapped so **one bad job never kills the worker** (on exception: log, leave it
  for the reaper). The `process()` state machine in `job.service.ts` runs
  circuit → rate-limit → deliver → success/retry/dead, in that order.

### The one thing to trace to understand it all
Follow a single event:

**`POST /events`** → `job.controller` (parse + read idempotency header) →
`job.service.enqueue` (check webhook ownership → reserve idempotency slot →
**insert Postgres row** → **push id to Redis**) → `202`.

Then, separately: **worker** → `queue.reserve` (claim + lease) →
`job.service.process` (circuit check → rate check → `delivery.service.deliver`
with HMAC → 2xx `queue.ack` / 5xx `queue.retryLater` with backoff / exhausted
`queue.deadLetter`).

Read those two paths top to bottom once and you own the project.
