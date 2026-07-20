/**
 * Route registration and the single error boundary.
 *
 * Controllers throw domain errors (see errors.ts); this is the one place that
 * turns them into HTTP responses. That inversion is what lets services stay
 * free of Fastify — they say *what* went wrong, this decides how to say it
 * over HTTP.
 */

import type { FastifyError, FastifyInstance } from "fastify";

import { AppError } from "./errors";
import { createLogger } from "./logger";
import { registerJobRoutes } from "./modules/jobs/job.controller";
import { registerWebhookRoutes } from "./modules/webhooks/webhook.controller";

const log = createLogger("http");

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.status)
        .send({ error: error.message, code: error.code });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: error.message,
        code: "VALIDATION_ERROR",
      });
    }

    log.error("unhandled error", {
      method: request.method,
      url: request.url,
      error: error.message,
      stack: error.stack,
    });

    return reply
      .status(500)
      .send({ error: "internal server error", code: "INTERNAL" });
  });

  await registerWebhookRoutes(app);
  await registerJobRoutes(app);
}
