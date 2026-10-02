import { createHash } from "node:crypto";
import * as Y from "yjs";
import { CanvasModel, CANVAS_SCHEMA_VERSION } from "@smartdoca/canvas/model";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import { readDocument } from "@smartdoca/slides/core";
import type { DB, Resource } from "../../../../db/src/index.js";
import { readSnapshot } from "../../../../db/src/transactions.js";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type {
  DocumentReadServiceV1,
  LibrariesServiceV1,
  PublicResource,
} from "@smartdoca/plugin-sdk/documents";
import type { Actor } from "../identity/passwords.js";
import { activeActor, authorize } from "../access/queries.js";
import { authorizeFileItem } from "../access/file-access.js";
import { fail } from "../../shared/errors.js";
import { createResourceReads } from "../resources/reads.js";
import { createResourceRunner } from "../resources/context.js";
import { queryResourcePage } from "../resources/queries.js";
import { restoreDocument } from "../collaboration/documents.js";
import { restoreMarkdown } from "./codecs/markdown.js";
import {
  restoreSurface,
  DEFAULT_SPREADSHEET_SCHEMA,
} from "./codecs/surfaces.js";
import { PPT_SCHEMA } from "./codecs/presentation.js";
import { documentMediaIds, textMediaIds } from "./media.js";

const formats = new Set([
  "rich_text",
  "markdown",
  "spreadsheet",
  "canvas",
  "presentation",
]);
export function publicResource(
  resource: Pick<
    Resource,
    "id" | "kind" | "title" | "format" | "parent_id" | "library_id" | "version"
  >,
  role: string,
): PublicResource {
  return {
    id: resource.id,
    kind: resource.kind,
    title: resource.title,
    format: resource.format,
    parentId: resource.parent_id,
    libraryId: resource.library_id,
    version: resource.version,
    role,
  };
}
const roles = ["none", "reader", "commenter", "editor", "manager", "owner"];
async function principal(
  db: DB,
  context: PluginRequestContext,
): Promise<Actor> {
  context.signal.throwIfAborted();
  const user = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", context.principal.id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!user) fail(401, "Account unavailable");
  return user;
}

export function createPublicDocumentReads(db: DB): DocumentReadServiceV1 {
  async function access(context: PluginRequestContext, documentId: string) {
    const actor = await principal(db, context);
    const result = await authorize(db, actor, documentId, 1);
    if (result.resource.kind !== "document") fail(404, "Document unavailable");
    return { ...result, actor };
  }
  return {
    async get(context, input) {
      const result = await access(context, input.documentId);
      return publicResource(result.resource, roles[result.rank]!);
    },
    async capabilities(context, input) {
      const { rank, resource } = await access(context, input.documentId);
      return {
        readSnapshot: formats.has(resource.format),
        comment: rank >= 2,
        edit: rank >= 3,
        manage: rank >= 4,
      };
    },
    async references(context, input) {
      const { actor } = await access(context, input.documentId);
      return createResourceReads(db, createResourceRunner(db)).references(
        actor,
        input.documentId,
      );
    },
    async readSnapshot(context, input) {
      const actor = await principal(db, context);
      const read = async (tx: DB) => {
        const { resource } = await authorize(tx, actor, input.documentId, 1);
        if (resource.kind !== "document" || !formats.has(resource.format))
          fail(409, "Native snapshot unavailable for this format");
        const state = await tx
          .selectFrom("document_states")
          .selectAll()
          .where("resource_id", "=", resource.id)
          .executeTakeFirst();
        // Never create a baseline as a side effect of reading.
        if (!state) fail(409, "Document has not been initialized");
        let content: unknown, epochId: string | null, schemaVersion: number;
        if (resource.format === "rich_text") {
          const epoch = await tx
            .selectFrom("editor_epochs")
            .select("epoch_id")
            .where("resource_id", "=", resource.id)
            .executeTakeFirst();
          const loaded = await restoreDocument(tx, resource.id);
          try {
            content = loaded.runtime.getValue();
          } finally {
            loaded.destroy();
          }
          epochId = epoch ? epoch.epoch_id : null;
          schemaVersion = 3;
        } else if (resource.format === "markdown") {
          const loaded = await restoreMarkdown(tx, resource.id);
          try {
            if (!loaded.epochId) fail(409, "Document epoch unavailable");
            epochId = loaded.epochId;
            content = loaded.doc.getText("markdown").toString();
            schemaVersion = 1;
          } finally {
            loaded.destroy();
          }
        } else {
          const loaded = await restoreSurface(tx, resource.id, resource.format);
          epochId = loaded.epochId;
          if (resource.format === "canvas") {
            schemaVersion = CANVAS_SCHEMA_VERSION;
            const model = CanvasModel.restore({
              codec: "aidcanvas-yjs",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              epochId,
              update: loaded.update,
            });
            try {
              content = model.getValue();
            } finally {
              model.dispose();
            }
          } else if (resource.format === "presentation") {
            schemaVersion = PPT_SCHEMA;
            const doc = new Y.Doc();
            try {
              Y.applyUpdate(doc, loaded.update);
              content = readDocument(doc);
            } finally {
              doc.destroy();
            }
          } else {
            schemaVersion = DEFAULT_SPREADSHEET_SCHEMA;
            if (!loaded.baseline) fail(409, "Workbook baseline unavailable");
            content = await projectExlsxWorkbook({
              baseline: loaded.baseline,
              update: loaded.update,
              checkpointSeq: state.checkpoint_seq,
            });
          }
        }
        const serialized = JSON.stringify(content);
        if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
          fail(413, "Document snapshot exceeds 16 MiB");
        const revision = createHash("sha256")
          .update(
            JSON.stringify([
              state.codec,
              schemaVersion,
              epochId,
              state.seq,
              content,
            ]),
          )
          .digest("hex");
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== revision
        )
          fail(409, "Document content changed");
        const ids =
          resource.format === "rich_text"
            ? documentMediaIds(content)
            : textMediaIds(
                typeof content === "string" ? content : JSON.stringify(content),
              );
        const assets: { fileId: string; name: string; mime: string }[] = [];
        if (ids.size) {
          const files = await tx
            .selectFrom("file_items")
            .select(["id", "name", "mime", "storage_object_id", "metadata"])
            .where("deleted_at", "is", null)
            .where((eb) =>
              eb.or([
                eb("id", "in", [...ids]),
                eb("storage_object_id", "in", [...ids]),
              ]),
            )
            .execute();
          for (const file of files) {
            try {
              await authorizeFileItem(tx, actor, file.id);
              assets.push({
                fileId: file.id,
                name: file.name,
                mime: file.mime,
              });
            } catch (error) {
              if (!(
                error instanceof Error &&
                "status" in error &&
                [403, 404].includes(Number(error.status))
              ))
                throw error;
            }
          }
        }
        context.signal.throwIfAborted();
        await activeActor(tx, actor);
        return {
          documentId: resource.id,
          format: resource.format,
          codec: state.codec,
          schemaVersion,
          revision,
          epochId,
          seq: state.seq,
          content,
          assets,
        };
      };
      return db.isTransaction ? read(db) : readSnapshot(db, read);
    },
  };
}

export function createPublicLibraries(db: DB): LibrariesServiceV1 {
  return {
    async list(context, input) {
      const actor = await principal(db, context);
      const page = await queryResourcePage(db, actor, {
        kind: "library",
        scope: "all",
        q: input.query,
        cursor: input.cursor ?? undefined,
      });
      return {
        items: page.items.map((row) => publicResource(row, row.role)),
        nextCursor: page.nextCursor,
      };
    },
    async children(context, input) {
      const actor = await principal(db, context);
      const { resource } = await authorize(db, actor, input.libraryId, 1);
      if (resource.kind !== "library") fail(400, "Not a library");
      if (input.parentId) {
        const parent = await authorize(db, actor, input.parentId, 1);
        if (parent.resource.library_id !== input.libraryId)
          fail(400, "Parent is outside the library");
      }
      const page = await queryResourcePage(db, actor, {
        libraryId: input.libraryId,
        parentId: input.parentId ?? input.libraryId,
        cursor: input.cursor ?? undefined,
      });
      context.signal.throwIfAborted();
      return {
        items: page.items.map((row) => publicResource(row, row.role)),
        nextCursor: page.nextCursor,
      };
    },
    async path(context, input) {
      const actor = await principal(db, context);
      const result: PublicResource[] = [],
        seen = new Set<string>();
      let id: string | null = input.resourceId;
      while (id) {
        context.signal.throwIfAborted();
        if (seen.has(id) || seen.size >= 1000)
          fail(409, "Invalid resource hierarchy");
        seen.add(id);
        const { resource, rank } = await authorize(db, actor, id, 1);
        result.unshift(publicResource(resource, roles[rank]!));
        id = resource.parent_id ?? resource.library_id;
      }
      return result;
    },
  };
}
