import { fail } from "@core/shared/errors.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import type { ContentServiceV1 } from "@smartdoca/plugin-sdk/content";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type { JsonObject } from "@smartdoca/plugin-sdk";

const purpose = z.enum(["knowledge", "analysis", "search"]);
const reference = z
  .object({
    sourceId: z.string().min(1).max(200),
    resourceId: z.string().min(1).max(1000),
    blockId: z.string().min(1).max(1000),
  })
  .strict();
const page = z
  .object({
    sourceId: z.string().min(1).max(200),
    purpose,
    config: z.record(z.string(), z.json()),
    cursor: z.string().min(1).max(16000).nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export function registerContentRoutes(
  api: FastifyInstance,
  auth: (request: FastifyRequest) => Actor,
  service: ContentServiceV1,
) {
  function requestContext(
    req: FastifyRequest,
    signal: AbortSignal,
  ): PluginRequestContext {
    const actor = auth(req);
    return {
      requestId: String(req.id || randomUUID()),
      signal,
      principal: {
        id: actor.id,
        displayName: actor.display_name,
        publicId: actor.public_id ?? "",
        admin: !!actor.admin,
      },
    };
  }
  api.get("/api/v1/content/sources", async (req, reply) => {
    const parsed = z.object({ purpose }).strict().safeParse(req.query);
    if (!parsed.success) fail(400, "Invalid content query");
    const query = parsed.data;
    reply.header("Cache-Control", "no-store");
    return {
      items: await service.sources(
        requestContext(req, AbortSignal.timeout(20_000)),
        query.purpose,
      ),
    };
  });
  for (const operation of ["list", "read", "resolve", "search"] as const) {
    api.post(
      `/api/v1/content/${operation}`,
      { bodyLimit: 100_000 },
      async (req, reply) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.raw.once("aborted", abort);
        reply.raw.once("close", abort);
        reply.header("Cache-Control", "no-store");
        try {
          const context = requestContext(req, controller.signal);
          if (operation === "resolve")
            return await service.resolve(
              context,
              z.object({ ref: reference, purpose }).strict().parse(req.body),
            );
          if (operation === "read") {
            const input = z
              .object({
                sourceId: z.string().min(1).max(200),
                purpose,
                config: z.record(z.string(), z.json()),
                ref: reference,
                fingerprint: z.string().min(1).max(1000),
              })
              .strict()
              .parse(req.body);
            return await service.read(context, {
              ...input,
              config: input.config as JsonObject,
            });
          }
          if (operation === "search") {
            const input = page
              .extend({ query: z.string().min(1).max(2000) })
              .parse(req.body);
            return await service.search(context, {
              ...input,
              config: input.config as JsonObject,
            });
          }
          const input = page.parse(req.body);
          return await service.list(context, {
            ...input,
            config: input.config as JsonObject,
          });
        } catch (error) {
          if (error instanceof z.ZodError) fail(400, "Invalid content request");
          throw error;
        } finally {
          req.raw.removeListener("aborted", abort);
          reply.raw.removeListener("close", abort);
        }
      },
    );
  }
}
