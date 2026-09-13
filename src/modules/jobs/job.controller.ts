/**
 * HTTP layer for jobs.
 */

import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

import type {
  EnqueueEventBody,
  EnqueueEventResponse,
  JobParams,
  ListJobsQuery,
  ListJobsResponse,
} from './job.dto';
import {
  enqueueEventSchema,
  getJobSchema,
  listJobsSchema,
} from './job.dto';
import * as service from './job.service';

export async function registerJobRoutes(
  app: FastifyInstance,
  redis: Redis,
): Promise<void> {
  /**
   * POST /events — accept an event for delivery.
   *
   * Returns 202 Accepted, not 200 OK: the event has been accepted for
   * processing, not delivered. Delivery is the worker's job (M3). That gap is
   * the entire point of a queue — respond in milliseconds whether the
   * customer's server is fast, slow, or dead.
   */
  app.post<{ Body: EnqueueEventBody }>(
    '/events',
    { schema: enqueueEventSchema },
    async (request, reply): Promise<EnqueueEventResponse> => {
      const { runAt, ...rest } = request.body;

      // Idempotency is a transport concern, so it rides in a header rather than
      // the body — same convention Stripe and others use. Absent means "no
      // dedupe"; present means "at most one job for this key" (M7).
      const idempotencyKey = request.headers['idempotency-key'];

      const job = await service.enqueue(redis, {
        ...rest,
        // The DTO carries an ISO string over the wire; the service works in
        // Date objects. Parsing at the boundary keeps that conversion here.
        runAt: runAt ? new Date(runAt) : undefined,
        // A repeated header arrives as string[]; take the first.
        idempotencyKey: Array.isArray(idempotencyKey)
          ? idempotencyKey[0]
          : idempotencyKey,
      });

      return reply.status(202).send({ jobId: job.id, state: job.state });
    },
  );

  app.get<{ Params: JobParams }>(
    '/jobs/:id',
    { schema: getJobSchema },
    async (request) => {
      return service.getById(request.params.id);
    },
  );

  app.get<{ Querystring: ListJobsQuery }>(
    '/jobs',
    { schema: listJobsSchema },
    async (request): Promise<ListJobsResponse> => {
      const { tenant, state, limit = 50 } = request.query;
      const jobs = await service.listByTenant({ tenant, state, limit });
      return { jobs, count: jobs.length };
    },
  );
}
