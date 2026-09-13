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
| Dashboard          | React 18 + Vite (`web/`)          |

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
| `pnpm loadtest`     | End-to-end load test (`scripts/loadtest.mjs`) |
| `pnpm infra:up`     | Start Redis + Postgres                        |
| `pnpm infra:down`   | Stop containers (data survives)               |

`docker compose down -v` additionally deletes volumes — a full reset.

### Dashboard (M8)

```bash
cd web
pnpm dev          # http://localhost:5173
```

The Vite dev server proxies `/api/*` to the API on `:3000` (see
`web/vite.config.ts`), so no CORS config is needed on the backend. The dashboard
shows live queue depths, a filterable job list with per-job delivery-attempt
timelines, a "send test event" producer, and a dead-letter queue with one-click
replay. Run the `api`, `worker`, and `scheduler` alongside it.

---

## Roadmap

- [x] **M1** — Scaffold, Docker infra, dependency-aware health check
- [x] **M2** — Job model, Postgres schema, enqueue endpoint
- [x] **M3** — Redis list queue + single worker (end-to-end delivery)
- [x] **M4** — Reliable queue: visibility timeout, ack/nack, retries, DLQ
- [x] **M5** — Delayed jobs (sorted set + sweeper), distributed lock in Lua
- [x] **M6** — Rate limiting: per-webhook token bucket
- [x] **M7** — Idempotency keys, circuit breaker, HMAC-signed delivery
- [x] **M8** — React dashboard: queue depth, job states, DLQ replay
- [x] **M9** — Load test (`pnpm loadtest`) + [architecture write-up](ARCHITECTURE.md)

---

## Project layout

```
src/
├── config.ts              # typed env loader, fails fast on missing vars
├── logger.ts              # structured JSON logger, createLogger(scope)
├── redis.ts               # createRedis() factory — see note below
├── db.ts                  # pg Pool + query() helper
├── queue.ts              # reliable queue: ready/inflight/leases/delayed/dlq (M4)
├── backoff.ts            # exponential backoff + full jitter        (M4)
├── lock.ts               # distributed lock (SET NX PX + Lua CAS)    (M5)
├── ratelimit.ts          # per-webhook token bucket (Lua)            (M6)
├── circuit.ts            # per-webhook circuit breaker (Lua)         (M7)
├── idempotency.ts        # producer-side dedupe (reserve-first)      (M7)
└── entrypoints/
    ├── api.ts            # Fastify HTTP server
    ├── worker.ts         # job consumer                              (M3/M4)
    └── scheduler.ts      # promoter + reaper, leader-elected         (M5)

web/                      # React + Vite operator dashboard          (M8)
├── src/api.ts            # typed API client (talks to /api/* proxy)
├── src/App.tsx           # stats, jobs, DLQ, live polling
└── src/components/       # StatCards, JobsTable, JobDetail, DlqPanel, …
```

**Why `createRedis()` is a factory, not a singleton:** Redis blocking commands
(`BRPOPLPUSH`, `BLPOP`) monopolise their connection — while parked waiting for a
job, that socket can serve no other command. A worker sharing one connection
between "wait for work" and "update job state" would deadlock. Each blocking
consumer therefore needs its own connection.
