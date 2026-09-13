/**
 * Load test — milestone 9.
 *
 * Drives the platform end to end and measures what actually matters for a queue:
 *
 *   1. Enqueue throughput + latency  — how fast the API accepts events (the
 *      promise a producer sees: respond in ms regardless of the destination).
 *   2. Delivery throughput           — how fast workers drain the backlog.
 *   3. End-to-end latency            — enqueue → actually delivered, per job.
 *   4. Duplicate rate                — at-least-once means ≥1 delivery per job;
 *      this measures how often "≥1" was ">1" under load.
 *
 * Self-contained: it runs its OWN receiver in-process, so it can stamp the exact
 * moment each job lands and diff it against the moment that job was enqueued —
 * no clock-skew across machines. You only need the infra + api + worker(+scheduler)
 * running. Because delivery is rate-limited PER WEBHOOK, the test spreads events
 * across several webhooks so the aggregate reflects system capacity, not one
 * bucket's refill rate.
 *
 * Usage:
 *   node scripts/loadtest.mjs                 # 1000 events, 50 concurrent, 8 webhooks
 *   N=5000 CONCURRENCY=100 WEBHOOKS=16 node scripts/loadtest.mjs
 */

import http from 'node:http';

const API = process.env.API ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const WEBHOOKS = Number(process.env.WEBHOOKS ?? 8);
const RECEIVER_PORT = Number(process.env.RECEIVER_PORT ?? 4300);
const TENANT = `loadtest-${Date.now()}`;

// jobId -> { sent: ms }  and receive bookkeeping
const sentAt = new Map();
const recvAt = new Map();
let totalDeliveries = 0; // includes duplicates

// ---------------------------------------------------------------------------
// In-process receiver: 200 OK, records first-seen time per job id.
// ---------------------------------------------------------------------------
function startReceiver() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      totalDeliveries += 1;
      const jobId = req.headers['x-job-id'];
      if (jobId && !recvAt.has(jobId)) recvAt.set(jobId, Date.now());
      // drain body so the socket frees promptly
      req.resume();
      res.writeHead(200).end('ok');
    });
    server.listen(RECEIVER_PORT, () => resolve(server));
  });
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function getStats() {
  const res = await fetch(`${API}/queue/stats`);
  return res.json();
}

// Simple bounded-concurrency runner.
async function runPool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(name, samples, unit = 'ms') {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  console.log(
    `  ${name.padEnd(22)} n=${s.length}  ` +
      `avg=${(sum / s.length).toFixed(1)}${unit}  ` +
      `p50=${percentile(s, 50).toFixed(1)}  ` +
      `p95=${percentile(s, 95).toFixed(1)}  ` +
      `p99=${percentile(s, 99).toFixed(1)}  ` +
      `max=${s[s.length - 1].toFixed(1)}`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n=== Load test: N=${N} concurrency=${CONCURRENCY} webhooks=${WEBHOOKS} ===\n`);

  const server = await startReceiver();
  console.log(`receiver listening on :${RECEIVER_PORT}`);

  // Register the webhooks the load will be spread across.
  const webhookIds = [];
  for (let w = 0; w < WEBHOOKS; w++) {
    const { id } = await post('/webhooks', {
      tenant: TENANT,
      url: `http://localhost:${RECEIVER_PORT}/hook`,
    });
    webhookIds.push(id);
  }
  console.log(`registered ${webhookIds.length} webhooks\n`);

  // ---- Phase 1: enqueue ----
  const enqueueLatencies = [];
  const events = Array.from({ length: N }, (_, n) => n);
  const enqueueStart = Date.now();

  await runPool(events, CONCURRENCY, async (n) => {
    const t0 = Date.now();
    const { jobId } = await post('/events', {
      tenant: TENANT,
      webhookId: webhookIds[n % webhookIds.length],
      eventType: 'load.test',
      payload: { n },
    });
    enqueueLatencies.push(Date.now() - t0);
    sentAt.set(jobId, t0);
  });

  const enqueueMs = Date.now() - enqueueStart;
  console.log('ENQUEUE');
  summarize('  latency', enqueueLatencies);
  console.log(`  throughput           ${(N / (enqueueMs / 1000)).toFixed(0)} events/sec  (${enqueueMs}ms total)\n`);

  // ---- Phase 2: drain ----
  console.log('DRAINING (waiting for queue to empty)...');
  const drainStart = Date.now();
  let lastLog = 0;
  while (true) {
    const s = await getStats();
    const outstanding = s.ready + s.inflight + s.delayed;
    const now = Date.now();
    if (now - lastLog > 1000) {
      process.stdout.write(
        `  ready=${s.ready} inflight=${s.inflight} delayed=${s.delayed} ` +
          `delivered=${recvAt.size}/${N}\r`,
      );
      lastLog = now;
    }
    if (outstanding === 0 && recvAt.size >= N) break;
    if (now - drainStart > 120_000) {
      console.log('\n  timed out after 120s');
      break;
    }
    await sleep(200);
  }
  const drainMs = Date.now() - drainStart;

  // ---- Results ----
  const e2e = [];
  for (const [jobId, sent] of sentAt) {
    const recv = recvAt.get(jobId);
    if (recv) e2e.push(recv - sent);
  }

  console.log('\n\nDELIVERY');
  console.log(`  drain time           ${(drainMs / 1000).toFixed(1)}s`);
  console.log(`  delivery throughput  ${(N / (drainMs / 1000)).toFixed(0)} deliveries/sec`);
  summarize('  end-to-end latency', e2e);
  console.log('\nDELIVERY GUARANTEE');
  console.log(`  distinct jobs delivered  ${recvAt.size}/${N}`);
  console.log(`  total HTTP deliveries    ${totalDeliveries}`);
  const dupes = totalDeliveries - recvAt.size;
  console.log(
    `  duplicates               ${dupes} ` +
      `(${((dupes / Math.max(1, totalDeliveries)) * 100).toFixed(2)}% — at-least-once in action)`,
  );

  server.close();
  console.log('\ndone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
