# Architecture

A from-scratch webhook delivery platform built on **raw Redis + Postgres** — no
BullMQ, no ORM. This document explains how the pieces fit, what guarantees the
system makes, how it behaves when things fail, and how it scales (with measured
numbers).

> Depth on any individual mechanism (the *why* behind each decision, plus the
> two bugs found during verification) lives in [`docs/interview-notes.md`](docs/interview-notes.md).

---

## 1. The problem

A system emits an event — *"payment succeeded"* — and customers have registered
URLs to be notified. Naively that's one `POST`. In reality the customer's server
may be **down, slow, or dead for days**; retries must not **hammer** it;
network failures mean deliveries can **duplicate**; and customers must be able to
**verify** a delivery genuinely came from us. The platform is the machinery that
turns "fire a POST" into a reliable, observable, abuse-resistant pipeline.

---

## 2. Components

One codebase, three process types, two datastores. Processes share nothing but
Redis and Postgres — they never call each other.

```
                    ┌──────────────┐
   HTTP client ───► │     api      │  accept event, write row, enqueue id, 202
                    └──────┬───────┘
                           │ (job id)
                    ┌──────▼───────┐        ┌──────────────┐
       Postgres ◄──►│    Redis     │◄──────►│  scheduler   │ promote due jobs,
   (source of       │ (queue +     │        │ (leader-     │ reap dead leases
    truth)          │  coordination)│       │  elected)    │
                    └──────┬───────┘        └──────────────┘
                           │ (reserve job id)
                    ┌──────▼───────┐
   customer   ◄──── │   worker ×N  │  deliver webhook (signed), retry/DLQ
   endpoint         └──────────────┘
```

| Process     | Responsibility                                                       | Scale |
| ----------- | ------------------------------------------------------------------- | ----- |
| `api`       | Accept events, enqueue, serve dashboard reads. Returns `202` in ms.  | N (stateless) |
| `worker`    | Reserve jobs, deliver webhooks, ack/retry/dead-letter.               | N (stateless, pull-based) |
| `scheduler` | Promote due delayed jobs, reap expired leases. **One leader** at a time. | N for HA, 1 active |

### Why two datastores

- **Postgres = system of record.** `jobs`, `webhooks`, `delivery_attempts`.
  Durable across crashes, queryable (*"failed jobs for tenant X last hour"* is an
  indexed `WHERE`), transactional. It holds job **data** and **history**.
- **Redis = coordination layer.** The queue (lists), in-flight set + leases
  (sorted sets), delayed jobs (sorted set), locks, rate-limit + circuit-breaker
  counters. In-memory and single-threaded, so operations are atomic without
  app-level locks; **Lua scripts** extend that atomicity to multi-step ops. It
  holds job **ids** and coordination state, and is treated as **losable** — if it
  flushes, the ready set is rebuilt from Postgres rows still in `queued`.

**The rule:** Postgres is truth; Redis is speed and coordination. Every enqueue
writes Postgres **first**, then Redis — so a crash between the two leaves a
durable `queued` row a sweep can recover, never a queued id with no row.

---

## 3. The reliable queue

Five Redis structures implement an SQS-style reliable queue:

```
ready    (list)        job ids waiting to be picked up
inflight (list)        job ids a worker has claimed but not finished
leases   (sorted set)  jobId -> lease expiry (ms)   ── visibility timeout
delayed  (sorted set)  jobId -> when it becomes due  ── retries + scheduling
dlq      (list)        job ids that gave up (permanent fail / attempts exhausted)
```

**Lifecycle of a job id:**

```
                 ┌────────────────── retryLater (backoff) ──────────────────┐
                 ▼                                                           │
 enqueue ──► ready ──BRPOPLPUSH──► inflight ──┬── ack ─────► (done)          │
                 ▲                            ├── retry ──► delayed ─promote─┘
  reap (lease    │                            └── deadLetter ─► dlq ─replay─► (ready, reset)
   expired) ─────┘
```

- **Atomic claim.** `BRPOPLPUSH ready → inflight` moves the id in one operation,
  so it's never in *neither* list. A plain `BRPOP` would delete the id the instant
  it's read — a worker crash then loses the job silently.
- **Visibility timeout + reaper.** Claiming also writes a lease (`ZADD`) with an
  expiry. A healthy worker acks/retries/dead-letters well within it; if a worker
  **dies**, its lease expires and the scheduler's reaper returns the id to
  `ready`. This is what makes loss *impossible* rather than merely unlikely.
- **Lua for multi-step atomicity.** ack/retry/dlq/promote/reap each touch 2–3
  keys; each is one script, so a crash can't tear it half-done.

---

## 4. Delivery guarantee: at-least-once

The system guarantees **at-least-once** delivery, never exactly-once. A worker
can complete the HTTP call and then die *before* acking; the lease expires and
the job is redelivered. Exactly-once is impossible across a network boundary, so
the platform makes duplicates *safe* instead of pretending to prevent them:

- Every delivery carries a stable **`idempotency-key` = the job id**, identical
  across all retries — the receiver dedupes on it.
- Producers get a matching **`Idempotency-Key`** on the way *in* so a client's
  retry never creates a duplicate *job*.

Under the load test with no failures, duplicates were **0%**; they appear only
when a worker actually dies mid-delivery (verified separately via the reaper).

---

## 5. Reliability primitives

Each is a small, independent module; see interview-notes for the deep dive.

| Concern | Mechanism | Key idea |
| --- | --- | --- |
| Retry storms | **Exponential backoff + full jitter** | `random(0, min(2^n·base, cap))` — spreads a synchronized herd |
| Give-up | **Dead-letter queue** | an *inbox* for a human, with reset-and-replay |
| Worker death | **Visibility timeout + reaper** | lease expiry → job returns to ready |
| Singleton work | **Distributed lock** (`SET NX PX` + Lua CAS) | leader-elected scheduler, TTL failover |
| Overload | **Per-webhook token bucket** (Lua) | pace deliveries; a throttle ≠ a failed attempt |
| Dead endpoints | **Per-webhook circuit breaker** (Lua) | fail fast when down; probe to recover |
| Duplicate jobs | **Idempotency keys** (reserve-first) | at most one job per (tenant, key) |
| Forgery/tampering | **HMAC-SHA256 signing** | sign `ts.body`; timestamp defeats replay |

A subtle shared principle: **rate-limit and circuit-breaker deferrals do not
spend a job's retry budget** — the job is being *paced or protected*, not failing,
so counting them would dead-letter healthy jobs during an outage.

---

## 6. Failure modes

| What fails | What happens | Recovery |
| --- | --- | --- |
| A worker crashes mid-delivery | Job stuck `in_flight`; lease expires | Scheduler reaper returns it to `ready` (≤ visibility timeout) |
| The scheduler (leader) crashes | Its lock stops being renewed | A standby scheduler acquires the lock after TTL (~1s measured) and takes over |
| Redis flushes / restarts | Queue state lost | Ready set rebuilt from Postgres `queued` rows (source of truth intact) |
| Postgres is down | Enqueue + delivery fail loudly | `/health` returns 503 with per-dependency detail; LB pulls the instance |
| Customer endpoint is down | Retries with backoff → circuit opens → fail-fast → DLQ | Fix endpoint, replay DLQ from the dashboard |
| Duplicate client submit | Same `Idempotency-Key` → same job returned | No duplicate job created |

---

## 7. Scaling & load test

Workers are **stateless pull consumers**: Redis hands each `BRPOPLPUSH` to exactly
one worker, so scaling delivery is just running more worker processes — nothing to
reconfigure or shard.

Measured on one laptop (Docker Redis + Postgres, rate limiter raised so numbers
reflect capacity, not the bucket). Reproduce with `pnpm loadtest`.

**Enqueue (single API instance):** ~**4,000–5,000 events/sec**, p50 ≈ 9ms, p99 ≈ 30ms.
The `202` is decoupled from delivery, so producer latency is unaffected by slow
customers — the entire point of a queue.

**Delivery throughput scales ~linearly with workers** (2,000-job burst):

| Workers | Deliveries/sec | Drain time | End-to-end p50 |
| ------: | -------------: | ---------: | -------------: |
| 1       | 219            | 9.1s       | 4.55s          |
| 4       | **992**        | 2.0s       | 1.14s          |

4 workers ≈ **4.5× throughput** and drop end-to-end p50 from 4.55s to 1.14s.
Distinct jobs delivered: **2000/2000**, duplicates **0** in both runs.

*(End-to-end latency is dominated by backlog wait: with a 2,000-job burst, the
last jobs sit in `ready` until workers reach them — adding workers shortens that
tail, which is exactly what the numbers show.)*

---

## 8. Trade-offs & production gaps

Honest about what this is **not** (yet):

- **Single-instance Redis lock, not Redlock.** Correct for one Redis; the only
  uncovered case (two leaders during a GC pause > TTL) is made safe because
  promote/reap are atomic + idempotent. Multi-node Redis would need Redlock or a
  real coordinator.
- **Circuit breaker half-open** may admit a few concurrent probes rather than
  exactly one — slightly more load on a recovering endpoint, never incorrectness.
- **No outbound SSRF allow-listing beyond http/https** — a production system
  would also block internal IP ranges.
- **Rate limiter is per-webhook only** — no global or per-tenant ceiling yet.
- **Delivery is `fetch` per attempt** — a connection pool / HTTP2 would raise
  per-worker throughput.
- **Redis rebuild-from-Postgres** on flush is described but not automated — a
  startup reconciliation sweep would close that loop.

These are deliberate scope lines for a learning-first build, not oversights — each
has a clear path to production hardening.
