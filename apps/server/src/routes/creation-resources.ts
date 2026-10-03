import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Actor } from "@core/modules/identity/passwords.js";
import type {
  TemplatesServiceV1,
  MaterialsServiceV2,
} from "@smartdoca/plugin-sdk/creation-resources";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type { TemplateSelection } from "@smartdoca/plugin-contracts";
import {
  materialQueryFilterSchema,
  materialSearchSchema,
  materialRetrievalSchema,
  materialCollectionItemsSchema,
  resourceFilterSchema,
  resourceSearchSchema,
  resourceRetrievalSchema,
  resourceRefSchema,
  templateSelectionSchema,
} from "@core/modules/creation-resources/service.js";
import { fail } from "@core/shared/errors.js";
export interface CreationResourceServices {
  templates: TemplatesServiceV1;
  materials: MaterialsServiceV2;
}
export async function callCreationResource(
  services: CreationResourceServices,
  context: PluginRequestContext,
  operation: string,
  body: unknown,
) {
  const [kind, method] = operation.split(".");
  const service =
    kind === "templates"
      ? services.templates
      : kind === "materials"
        ? services.materials
        : null;
  if (!service) fail(404, "Resource service unavailable");
  switch (method) {
    case "providers":
      return service.providers(context, resourceFilterSchema.parse(body));
    case "tags":
      return kind === "materials"
        ? services.materials.tags(
            context,
            materialQueryFilterSchema.parse(body),
          )
        : services.templates.tags(context, resourceFilterSchema.parse(body));
    case "search":
      return kind === "materials"
        ? services.materials.search(context, materialSearchSchema.parse(body))
        : services.templates.search(context, resourceSearchSchema.parse(body));
    case "retrieve":
      return kind === "materials"
        ? services.materials.retrieve(
            context,
            materialRetrievalSchema.parse(body),
          )
        : services.templates.retrieve(
            context,
            resourceRetrievalSchema.parse(body),
          );
    case "describe":
      return service.describe(context, resourceRefSchema.parse(body));
    case "collectionDescribe":
      if (kind === "materials")
        return services.materials.collectionDescribe(
          context,
          resourceRefSchema.parse(body),
        );
      break;
    case "collectionItems":
      if (kind === "materials")
        return services.materials.collectionItems(
          context,
          materialCollectionItemsSchema.parse(body),
        );
      break;
    case "read":
      if (kind === "templates")
        return services.templates.read(
          context,
          templateSelectionSchema.parse(body) as TemplateSelection,
        );
      break;
    case "import":
      if (kind === "materials")
        return services.materials.import(
          context,
          z
            .object({
              ref: resourceRefSchema,
              operationKey: z.string().min(1).max(200),
            })
            .strict()
            .parse(body),
        );
      break;
    case "consumers":
      if (kind === "templates") {
        z.object({}).strict().parse(body);
        return services.templates.consumers(context);
      }
      break;
    case "consume":
      if (kind === "templates")
        return services.templates.consume(
          context,
          z
            .object({
              consumerId: z.string().min(1).max(200),
              selection: templateSelectionSchema,
              input: z.record(z.string(), z.any()),
            })
            .strict()
            .parse(body) as Parameters<TemplatesServiceV1["consume"]>[1],
        );
      break;
  }
  fail(404, "Resource operation unavailable");
}
export function registerCreationResourceRoutes(
  api: FastifyInstance,
  auth: (r: FastifyRequest) => Actor,
  services: CreationResourceServices,
) {
  api.post<{ Params: { kind: string; operation: string } }>(
    "/api/v1/creation-resources/:kind/:operation",
    { bodyLimit: 200000 },
    async (req, reply) => {
      const actor = auth(req),
        controller = new AbortController(),
        abort = () => controller.abort();
      req.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      const context: PluginRequestContext = {
        requestId: req.id,
        principal: {
          id: actor.id,
          displayName: actor.display_name,
          publicId: actor.public_id ?? "",
          admin: !!actor.admin,
        },
        signal: controller.signal,
      };
      reply.header("Cache-Control", "no-store");
      try {
        return await callCreationResource(
          services,
          context,
          `${req.params.kind}.${req.params.operation}`,
          req.body,
        );
      } catch (error) {
        if (error instanceof z.ZodError)
          fail(400, "Invalid creation resource input");
        throw error;
      } finally {
        req.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abort);
      }
    },
  );
}
