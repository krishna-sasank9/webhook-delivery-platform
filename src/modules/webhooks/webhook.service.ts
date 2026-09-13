/**
 * Business rules for webhooks.
 *
 * Knows nothing about HTTP. Throws domain errors; the controller decides what
 * status code each one becomes.
 */

import { randomBytes } from 'node:crypto';

import { NotFoundError, ValidationError } from '../../errors';
import { createLogger } from '../../logger';
import type { Webhook } from '../../types';
import * as repository from './webhook.repository';

const log = createLogger('webhook.service');

/**
 * Only http(s) endpoints may be registered.
 *
 * Without this, a caller could register `file://` or an internal address and
 * turn the delivery worker into a proxy into our own network — SSRF. This is a
 * business rule about what a valid webhook *is*, so it belongs here rather than
 * in the controller's request schema.
 */
function assertDeliverableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('url is not a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('url must use http or https');
  }
}

export async function register(input: {
  tenant: string;
  url: string;
}): Promise<{ webhook: Webhook; secret: string }> {
  assertDeliverableUrl(input.url);

  // 32 random bytes from a CSPRNG. This becomes the HMAC signing key (M7):
  // we sign each delivery with it, the customer verifies with their copy.
  // Returned to the caller exactly once, here.
  const secret = randomBytes(32).toString('hex');

  const webhook = await repository.insert({ ...input, secret });
  log.info('webhook registered', { id: webhook.id, tenant: input.tenant });

  return { webhook, secret };
}

export async function getById(id: string): Promise<Webhook> {
  const webhook = await repository.findById(id);
  if (!webhook) {
    throw new NotFoundError('webhook not found');
  }
  return webhook;
}

export async function listByTenant(tenant: string): Promise<Webhook[]> {
  return repository.findByTenant(tenant);
}

/**
 * The HMAC signing secret for a webhook — the one time it leaves the DB after
 * registration. Loaded separately from the webhook itself (see the repository)
 * so it is only ever read when we are about to sign a delivery, and can never
 * ride along in an API response by accident.
 */
export async function getSecret(id: string): Promise<string> {
  const secret = await repository.findSecretById(id);
  if (!secret) {
    throw new NotFoundError('webhook not found');
  }
  return secret;
}

/**
 * Resolves a webhook that `tenant` is allowed to enqueue against.
 *
 * The ownership check is the security-critical part: without it, tenant A
 * could deliver to tenant B's endpoint just by knowing its UUID (IDOR). We
 * deliberately raise NotFound rather than Forbidden — Forbidden would confirm
 * the webhook exists, which itself leaks information.
 */
export async function getOwnedBy(
  id: string,
  tenant: string,
): Promise<Webhook> {
  const webhook = await repository.findById(id);

  if (!webhook || webhook.tenant !== tenant) {
    throw new NotFoundError('webhook not found');
  }

  return webhook;
}
