/**
 * Request/response contracts for the webhook routes.
 *
 * Each DTO pairs a TypeScript type (compile-time) with its JSON Schema
 * (runtime). Keeping them in one file is deliberate: they describe the same
 * contract, and splitting them is how they drift apart.
 */

import type { Webhook } from '../../types';

// ---------------------------------------------------------------------------
// POST /webhooks
// ---------------------------------------------------------------------------

export interface RegisterWebhookBody {
  tenant: string;
  url: string;
}

export const registerWebhookSchema = {
  body: {
    type: 'object',
    required: ['tenant', 'url'],
    additionalProperties: false,
    properties: {
      tenant: { type: 'string', minLength: 1, maxLength: 128 },
      url: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  },
} as const;

/** The secret appears in this response only — never on any subsequent read. */
export interface RegisterWebhookResponse extends Webhook {
  secret: string;
}

// ---------------------------------------------------------------------------
// GET /webhooks?tenant=acme
// ---------------------------------------------------------------------------

export interface ListWebhooksQuery {
  tenant: string;
}

export const listWebhooksSchema = {
  querystring: {
    type: 'object',
    required: ['tenant'],
    properties: {
      tenant: { type: 'string', minLength: 1 },
    },
  },
} as const;

export interface ListWebhooksResponse {
  webhooks: Webhook[];
}

// ---------------------------------------------------------------------------
// GET /webhooks/:id
// ---------------------------------------------------------------------------

export interface WebhookParams {
  id: string;
}

export const getWebhookSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
} as const;
