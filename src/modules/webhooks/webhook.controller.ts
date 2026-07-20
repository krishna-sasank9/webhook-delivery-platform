/**
 * HTTP layer for webhooks.
 *
 * Responsibilities: declare routes, bind DTO schemas, call the service, shape
 * the response. No business logic, no SQL.
 */

import type { FastifyInstance } from 'fastify';

import type {
  ListWebhooksQuery,
  ListWebhooksResponse,
  RegisterWebhookBody,
  RegisterWebhookResponse,
  WebhookParams,
} from './webhook.dto';
import {
  getWebhookSchema,
  listWebhooksSchema,
  registerWebhookSchema,
} from './webhook.dto';
import * as service from './webhook.service';

export async function registerWebhookRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body: RegisterWebhookBody }>(
    '/webhooks',
    { schema: registerWebhookSchema },
    async (request, reply): Promise<RegisterWebhookResponse> => {
      const { webhook, secret } = await service.register(request.body);
      return reply.status(201).send({ ...webhook, secret });
    },
  );

  app.get<{ Querystring: ListWebhooksQuery }>(
    '/webhooks',
    { schema: listWebhooksSchema },
    async (request): Promise<ListWebhooksResponse> => {
      const webhooks = await service.listByTenant(request.query.tenant);
      return { webhooks };
    },
  );

  app.get<{ Params: WebhookParams }>(
    '/webhooks/:id',
    { schema: getWebhookSchema },
    async (request) => {
      return service.getById(request.params.id);
    },
  );
}
