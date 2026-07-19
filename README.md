# Webhook Delivery Platform

A webhook delivery platform built on **raw Redis primitives — no BullMQ** —
implementing reliable queuing, retries with exponential backoff, distributed
locking, and rate limiting from first principles.

The problem: a system emits an event ("payment succeeded"), and customers have
registered URLs to be notified. That sounds like one `POST`. It isn't — the
customer's server may be down, slow, or dead for days; retries must not
hammer them; duplicates must be deduplicable; and forged deliveries must be
detectable. This project builds the machinery that handles all of it.

---

## Stack

| Layer              | Technology                        |
| ------------------ | --------------------------------- |
| Language           | TypeScript (Node 22+)             |
| HTTP               | Fastify 5                         |
| Source of truth    | PostgreSQL 16 (`pg`, raw SQL)     |
| Coordination layer | Redis 7 (`ioredis`, no BullMQ)    |
| Local infra        | Docker Compose                    |
| Dashboard          | React + Vite *(planned, M8)*      |

No ORM, no job-queue library. Those are the point.

---

## Architecture

One codebase, one `package.json`, **three processes** that share nothing but
Redis and Postgres:

| Process     | Responsibility                                       |
| ----------- | ---------------------------------------------------- |
| `api`       | Accepts events, enqueues jobs, returns `202` in ms    |
| `worker`    | Pulls jobs, delivers webhooks, handles retries        |
| `scheduler` | Promotes delayed jobs to the ready queue when due     |

They never call each other directly. Workers are stateless and *pull* work, so
scaling is just running more copies — nothing to reconfigure, because the Redis
queue is the coordination point.

This is a **modular monolith / worker pool**, not microservices: no service
discovery, no cross-service contracts, one deploy unit — while still getting
fault isolation and independent scaling.

### Why two datastores

**PostgreSQL is the system of record** — `jobs`, `webhooks`,
`delivery_attempts`. It provides durability (a job survives a crash), query
power (*"all failed jobs for tenant X in the last hour"* is an indexed `WHERE`),
and transactions.

**Redis is the coordination layer** — the queue itself (lists), the in-flight
set, delayed jobs (sorted set scored by run-at time), distributed locks, and
rate-limiter counters. It is in-memory and single-threaded, which makes
operations atomic without application-level locking; Lua scripts extend that
atomicity to multi-step operations.

**The rule:** Redis stores job *IDs* and coordination state; Postgres stores job
*data* and history. Redis is treated as losable — if it flushes, the queue is
rebuilt from Postgres by finding jobs still in the `queued` state.

---

## Running locally

```bash
pnpm install
cp .env.example .env
docker compose up -d
docker compose ps          # wait for both services to report (healthy)
pnpm dev:api
```

Then:

```bash
curl -s localhost:3000/health
```

```json
{
  "status": "healthy",
  "checks": { "redis": true, "postgres": true },
  "uptimeSeconds": 29
}
```

The health check exercises both dependencies rather than reporting liveness
alone, and returns **503** with per-dependency detail when one is down — which
is what a load balancer or readiness probe needs to pull an instance out of
rotation. To see it work:

```bash
docker compose stop redis
curl -i -s localhost:3000/health   # 503, "redis": false, "postgres": true
docker compose start redis         # reconnects automatically
```

### Commands

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `pnpm dev:api`      | Run the HTTP API (watch mode)                 |
| `pnpm dev:worker`   | Run a worker — scale by running N copies      |
| `pnpm dev:scheduler`| Run the delayed-job scheduler                 |
| `pnpm typecheck`    | `tsc --noEmit` — the real type gate           |
| `pnpm infra:up`     | Start Redis + Postgres                        |
| `pnpm infra:down`   | Stop containers (data survives)               |

`docker compose down -v` additionally deletes volumes — a full reset.

---

## Roadmap

- [x] **M1** — Scaffold, Docker infra, dependency-aware health check
- [ ] **M2** — Job model, Postgres schema, enqueue endpoint
- [ ] **M3** — Redis list queue + single worker (end-to-end delivery)
- [ ] **M4** — Reliable queue: visibility timeout, ack/nack, retries, DLQ
- [ ] **M5** — Delayed jobs (sorted set + sweeper), distributed lock in Lua
- [ ] **M6** — Rate limiting: token bucket + sliding window, per tenant
- [ ] **M7** — Idempotency keys, circuit breaker, HMAC-signed delivery
- [ ] **M8** — React dashboard: queue depth, job states, retry/DLQ, charts
- [ ] **M9** — Load test + architecture write-up

---

## Project layout

```
src/
├── config.ts              # typed env loader, fails fast on missing vars
├── logger.ts              # structured JSON logger, createLogger(scope)
├── redis.ts               # createRedis() factory — see note below
├── db.ts                  # pg Pool + query() helper
└── entrypoints/
    ├── api.ts             # Fastify HTTP server
    ├── worker.ts          # job consumer            (M3)
    └── scheduler.ts       # delayed-job promoter    (M5)
```

**Why `createRedis()` is a factory, not a singleton:** Redis blocking commands
(`BRPOPLPUSH`, `BLPOP`) monopolise their connection — while parked waiting for a
job, that socket can serve no other command. A worker sharing one connection
between "wait for work" and "update job state" would deadlock. Each blocking
consumer therefore needs its own connection.
