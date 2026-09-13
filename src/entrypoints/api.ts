import Fastify from "fastify";
import { config } from "../config";
import { createLogger } from "../logger";
import { createRedis } from "../redis";
import { query, closePool } from "../db";
import { registerRoutes } from "../routes";

const log = createLogger("api");
const redis = createRedis("api");

const app = Fastify({ logger: false });

let shuttingDown = false;

app.get("/", async () => {
  return { service: "webhook-delivery-platform", status: "ok" };
});

app.get("/health", async (_request, reply) => {
  const checks = { redis: false, postgres: false };

  try {
    const pong = await redis.ping();
    checks.redis = pong === "PONG";
  } catch (err) {
    log.error("redis healthcheck failed", { error: (err as Error).message });
  }

  try {
    await query("SELECT 1");
    checks.postgres = true;
  } catch (err) {
    log.error("postgres healthcheck failed", { error: (err as Error).message });
  }

  const healthy = checks.redis && checks.postgres;
  return reply.status(healthy ? 200 : 503).send({
    status: healthy ? "healthy" : "unhealthy",
    checks,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

async function start(): Promise<void> {
  try {
    await registerRoutes(app, redis);
    await app.listen({ port: config.api.port, host: "0.0.0.0" });
    log.info("api listening", { port: config.api.port, env: config.env });
  } catch (err) {
    log.error("failed to start", { error: (err as Error).message });
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("shutting down", { signal });
  try {
    await app.close();
    await redis.quit();
    await closePool();
    process.exit(0);
  } catch (err) {
    log.error("shutdown error", { error: (err as Error).message });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void start();
