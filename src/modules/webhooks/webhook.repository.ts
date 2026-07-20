/**
 * Data access for webhooks. SQL only — no business rules, no decisions.
 */

import { query } from '../../db';
import type { Webhook, WebhookRow } from '../../types';

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    tenant: row.tenant,
    url: row.url,
    isActive: row.isactive,
    createdAt: row.createdat.toISOString(),
  };
}

export async function insert(input: {
  tenant: string;
  url: string;
  secret: string;
}): Promise<Webhook> {
  const result = await query<WebhookRow>(
    `INSERT INTO webhooks (tenant, url, secret)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.tenant, input.url, input.secret],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('insert returned no row');
  }

  return toWebhook(row);
}

export async function findById(id: string): Promise<Webhook | null> {
  const result = await query<WebhookRow>(
    'SELECT * FROM webhooks WHERE id = $1',
    [id],
  );

  const row = result.rows[0];
  return row ? toWebhook(row) : null;
}

/**
 * Reads the signing secret. Kept separate from findById so the secret is only
 * ever loaded when something genuinely needs to sign a request (M7) — it can
 * never leak into a response by accident.
 */
export async function findSecretById(id: string): Promise<string | null> {
  const result = await query<{ secret: string }>(
    'SELECT secret FROM webhooks WHERE id = $1',
    [id],
  );

  return result.rows[0]?.secret ?? null;
}

export async function findByTenant(tenant: string): Promise<Webhook[]> {
  const result = await query<WebhookRow>(
    `SELECT * FROM webhooks
     WHERE tenant = $1
     ORDER BY createdAt DESC`,
    [tenant],
  );

  return result.rows.map(toWebhook);
}
