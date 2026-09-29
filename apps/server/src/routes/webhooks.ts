import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "@core/modules/automation/webhooks.js";
import type { DB } from "@db/index.js";
import type { WebhookDB } from "@db/webhook-database.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  resolveWebhookAddress,
  type WebhookResolve,
} from "../services/webhooks/http.js";

const eventName = Type.String({ minLength: 1, maxLength: 80 });
const headerField = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    value: Type.String({ maxLength: 4000 }),
  },
  { additionalProperties: false },
);
const headersField = Type.Optional(Type.Array(headerField, { maxItems: 30 }));
const bodyFields = {
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
  events: Type.Optional(Type.Array(eventName, { maxItems: 40 })),
  headers: headersField,
  enabled: Type.Optional(Type.Boolean()),
};

export function registerWebhooks(
  api: FastifyInstance,
  db: DB,
  hooks: WebhookDB,
  admin: (request: FastifyRequest) => Actor,
  resolve?: WebhookResolve,
) {
  const params = Type.Object({ id: Type.String({ format: "uuid" }) });
  async function callbackUrl(value: string) {
    await resolveWebhookAddress(value, resolve);
    return value;
  }
  api.get("/api/v1/admin/webhooks", async (request) => {
    admin(request);
    return listWebhookEndpoints(hooks);
  });
  api.post<{
    Body: {
      name: string;
      url: string;
      events: string[];
      headers?: { name: string; value: string }[];
    };
  }>(
    "/api/v1/admin/webhooks",
    {
      schema: {
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 80 }),
            url: Type.String({ minLength: 8, maxLength: 2000 }),
            events: Type.Array(eventName, { minItems: 1, maxItems: 40 }),
            headers: headersField,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      admin(request);
      await callbackUrl(request.body.url);
      return createWebhookEndpoint(db, hooks, request.body);
    },
  );
  api.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      url?: string;
      events?: string[];
      headers?: { name: string; value: string }[];
      enabled?: boolean;
    };
  }>(
    "/api/v1/admin/webhooks/:id",
    {
      schema: {
        params,
        body: Type.Object(bodyFields, { additionalProperties: false }),
      },
    },
    async (request) => {
      admin(request);
      if (request.body.url) await callbackUrl(request.body.url);
      return updateWebhookEndpoint(hooks, request.params.id, request.body);
    },
  );
  api.delete<{ Params: { id: string } }>(
    "/api/v1/admin/webhooks/:id",
    { schema: { params } },
    async (request) => {
      admin(request);
      return deleteWebhookEndpoint(hooks, request.params.id);
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/webhooks/:id/deliveries",
    { schema: { params } },
    async (request) => {
      admin(request);
      return listWebhookDeliveries(hooks, request.params.id);
    },
  );
}
