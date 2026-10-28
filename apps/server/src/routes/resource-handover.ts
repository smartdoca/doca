import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  userHandoverInventory,
  previewUserHandover,
  executeUserHandover,
  type HandoverInput,
} from "@core/modules/identity/resource-handover.js";

export function registerResourceHandover(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  notify: (userIds: string[]) => Promise<void>,
) {
  const params = Type.Object(
    { id: Type.String({ format: "uuid" }) },
    { additionalProperties: false },
  );
  const fields = {
    targetUserId: Type.String({ format: "uuid" }),
    keys: Type.Array(
      Type.String({
        pattern:
          "^(resource|folder|file|resource_access|folder_access):[a-f0-9-]{36}$",
      }),
      { minItems: 1, maxItems: 500, uniqueItems: true },
    ),
  };
  api.get<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id/resource-handover",
    {
      schema: {
        tags: ["Administration"],
        summary: "List resources and retained grants of a disabled account",
        params,
      },
    },
    (req) => userHandoverInventory(db, admin(req), req.params.id),
  );
  api.post<{ Params: { id: string }; Body: HandoverInput }>(
    "/api/v1/admin/users/:id/resource-handover/preview",
    {
      schema: {
        tags: ["Administration"],
        summary: "Preview the exact resource handover and permission conflicts",
        params,
        body: Type.Object(fields, { additionalProperties: false }),
      },
    },
    (req) => previewUserHandover(db, admin(req), req.params.id, req.body),
  );
  api.post<{
    Params: { id: string };
    Body: HandoverInput & { fingerprint: string };
  }>(
    "/api/v1/admin/users/:id/resource-handover/execute",
    {
      schema: {
        tags: ["Administration"],
        summary: "Confirm an unchanged handover in one transaction",
        params,
        body: Type.Object(
          {
            ...fields,
            fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const result = await executeUserHandover(
        db,
        admin(req),
        req.params.id,
        req.body,
      );
      // Committed facts remain successful even if a transient cluster notification needs a later refresh.
      await notify([req.params.id, req.body.targetUserId]).catch((error) =>
        api.log.error(error),
      );
      return result;
    },
  );
}
