/**
 * Operational endpoints for the queue itself.
 *
 * A dead-letter queue you cannot inspect or replay is just a slower way of
 * dropping jobs. These are the minimum controls an on-call engineer needs, and
 * they become the M8 dashboard's data source.
 */

import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

import { createLogger } from '../../logger';
import * as queue from '../../queue';
import * as jobService from '../jobs/job.service';

const log = createLogger('queue.controller');

export async function registerQueueRoutes(
  app: FastifyInstance,
  redis: Redis,
): Promise<void> {
  /**
   * GET /queue/stats
   *
   * `ready` climbing while `inflight` stays flat means workers cannot keep up
   * — the signal to scale out. `dlq` above zero always wants a human.
   */
  app.get('/queue/stats', async () => {
    return queue.stats(redis);
  });

  /**
   * POST /queue/dlq/replay
   *
   * Moves jobs from the DLQ back to ready. Use after fixing whatever was
   * broken — a customer's endpoint back online, a bad URL corrected.
   */
  app.post<{ Body: { limit?: number } }>(
    '/queue/dlq/replay',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        },
      },
    },
    async (request) => {
      const limit = request.body?.limit ?? 100;
      // Delegates to the service, which resets each job's Postgres row back to
      // 'queued' before re-queuing it — a raw Redis move would leave the row
      // 'dead' and the worker would ack the replayed job away as terminal.
      const jobIds = await jobService.replay(redis, limit);

      log.info('dlq replayed', { count: jobIds.length });

      return { replayed: jobIds.length, jobIds };
    },
  );
}
