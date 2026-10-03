import {
  callCreationResource,
  type CreationResourceServices,
} from "./creation-resources.js";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import type {
  UsersServiceV1,
  PluginRequestContext,
} from "@smartdoca/plugin-sdk/platform";
import type {
  DocumentReadServiceV1,
  LibrariesServiceV1,
} from "@smartdoca/plugin-sdk/documents";
import { fail } from "@core/shared/errors.js";
import { stableId, type FilesServiceV1 } from "@smartdoca/plugin-sdk/files";

const id = z.string().min(1).max(200);
const document = z.object({ documentId: id }).strict();
const selection = z.object({ ids: z.array(id).max(100) }).strict();
/** Allowlisted public methods. Does not dispatch arbitrary service/property names. */
export function registerPluginPlatformRoutes(
  api: FastifyInstance,
  auth: (request: FastifyRequest) => Actor,
  services: CreationResourceServices & {
    users: UsersServiceV1;
    documents: DocumentReadServiceV1;
    libraries: LibrariesServiceV1;
    files: () => FilesServiceV1;
  },
) {
  api.post<{ Params: { pluginId: string; operation: string } }>(
    "/api/v1/plugin-platform/:pluginId/:operation",
    { bodyLimit: 100_000 },
    async (req, reply) => {
      if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(req.params.pluginId))
        fail(400, "Invalid plugin ID");
      const actor = auth(req);
      const controller = new AbortController(),
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
        switch (req.params.operation) {
          case "users.me":
            z.object({}).strict().parse(req.body);
            return await services.users.me(context);
          case "users.searchPage":
            return await services.users.searchPage(
              context,
              z
                .object({
                  query: z.string().max(160),
                  cursor: z.string().max(2048).nullable().optional(),
                  limit: z.number().int().min(1).max(100).optional(),
                })
                .strict()
                .parse(req.body),
            );
          case "users.resolveDirectory":
            return await services.users.resolveDirectory(
              context,
              selection.parse(req.body),
            );
          case "users.validateSelection":
            await services.users.validateSelection(
              context,
              selection.parse(req.body),
            );
            return null;
          case "documents.get":
            return await services.documents.get(
              context,
              document.parse(req.body),
            );
          case "documents.capabilities":
            return await services.documents.capabilities(
              context,
              document.parse(req.body),
            );
          case "documents.references":
            return await services.documents.references(
              context,
              document.parse(req.body),
            );
          case "documents.readSnapshot":
            return await services.documents.readSnapshot(
              context,
              document
                .extend({ expectedRevision: z.string().max(200).optional() })
                .parse(req.body),
            );
          case "libraries.list":
            return await services.libraries.list(
              context,
              z
                .object({
                  query: z.string().max(160).optional(),
                  cursor: z.string().max(2048).nullable().optional(),
                })
                .strict()
                .parse(req.body),
            );
          case "libraries.children":
            return await services.libraries.children(
              context,
              z
                .object({
                  libraryId: id,
                  parentId: id.nullable(),
                  cursor: z.string().max(2048).nullable().optional(),
                })
                .strict()
                .parse(req.body),
            );
          case "libraries.path":
            return await services.libraries.path(
              context,
              z.object({ resourceId: id }).strict().parse(req.body),
            );
          case "files.folders.get": {
            const input = z.object({ folderId: id }).strict().parse(req.body);
            return await services
              .files()
              .folders.get(
                { principalId: actor.id, signal: context.signal },
                { folderId: stableId(input.folderId, "folder") },
              );
          }
          case "files.folders.list": {
            const input = z
              .object({
                parentId: id.nullable(),
                cursor: id.nullable().optional(),
                limit: z.number().int().min(1).max(200).optional(),
              })
              .strict()
              .parse(req.body);
            return await services.files().folders.list(
              { principalId: actor.id, signal: context.signal },
              {
                ...input,
                parentId:
                  input.parentId === null
                    ? null
                    : stableId(input.parentId, "folder"),
              },
            );
          }
          case "files.files.get": {
            const input = z.object({ fileId: id }).strict().parse(req.body);
            return await services
              .files()
              .files.get(
                { principalId: actor.id, signal: context.signal },
                { fileId: stableId(input.fileId, "file") },
              );
          }
          case "files.files.list": {
            const input = z
              .object({
                folderId: id.nullable(),
                cursor: id.nullable().optional(),
                limit: z.number().int().min(1).max(200).optional(),
              })
              .strict()
              .parse(req.body);
            return await services.files().files.list(
              { principalId: actor.id, signal: context.signal },
              {
                ...input,
                folderId:
                  input.folderId === null
                    ? null
                    : stableId(input.folderId, "folder"),
              },
            );
          }
          default:
            if (
              /^(templates|materials)\.(providers|tags|search|retrieve|describe|collectionDescribe|collectionItems|read|import|consumers|consume)$/.test(
                req.params.operation,
              )
            )
              return await callCreationResource(
                services,
                context,
                req.params.operation,
                req.body,
              );
            fail(404, "Public operation unavailable");
        }
      } catch (error) {
        if (error instanceof z.ZodError)
          fail(400, "Invalid public operation input");
        throw error;
      } finally {
        req.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abort);
      }
    },
  );
}
