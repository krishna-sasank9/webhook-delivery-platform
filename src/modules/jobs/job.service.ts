/**
 * Business rules for jobs.
 *
 * This is where the queue semantics will live. Today `enqueue` only writes a
 * row; in M3 it will also push the job id onto the Redis ready queue, and in
 * M4 it grows retry/backoff policy. Keeping that here — rather than in the
 * controller — is what makes those additions a one-file change.
 */

import { ConflictError, NotFoundError } from '../../errors';
import { createLogger } from '../../logger';
import type { Job, JobState } from '../../types';
import * as webhookService from '../webhooks/webhook.service';
import * as repository from './job.repository';

const log = createLogger('job.service');

export async function enqueue(input: {
  tenant: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  runAt?: Date;
}): Promise<Job> {
  // Throws NotFound if the webhook does not exist OR belongs to another
  // tenant. Enforcing ownership here means every future caller of enqueue
  // gets the check for free.
  const webhook = await webhookService.getOwnedBy(input.webhookId, input.tenant);

  if (!webhook.isActive) {
    throw new ConflictError('webhook is inactive');
  }

  const job = await repository.insert(input);

  log.info('job enqueued', {
    jobId: job.id,
    tenant: job.tenant,
    eventType: job.eventType,
    runAt: job.runAt,
  });

  // M3: push job.id onto the Redis ready queue here.

  return job;
}

export async function getById(id: string): Promise<Job> {
  const job = await repository.findById(id);
  if (!job) {
    throw new NotFoundError('job not found');
  }
  return job;
}

export async function listByTenant(filters: {
  tenant: string;
  state?: JobState;
  limit: number;
}): Promise<Job[]> {
  return repository.findByTenant(filters);
}
