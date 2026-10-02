import {
  createDocumentFilesPortV1,
  createDocumentsProviderV1,
  type DocumentAccessAction,
  type DocumentAccessRole,
  type DocumentResource,
  type DocumentsRequestContext,
  type DocumentsServiceV1,
} from "@doca/documents-capability";
import {
  stableId,
  type FilesServiceV1,
} from "@smartdoca/files-capability";
import { authorize, accessibleQuery } from "@core/modules/access/queries.js";
import { createDocuments } from "@core/modules/collaboration/documents.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { sql } from "kysely";
import { fail, AppError } from "@core/shared/errors.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";

const roles: DocumentAccessRole[] = [
  "reader",
  "commenter",
  "editor",
  "manager",
  "owner",
];
const actionRank: Record<DocumentAccessAction, number> = {
  read: 1,
  comment: 2,
  edit: 3,
  manage: 4,
  own: 5,
};

async function actorFor(
  db: DB,
  context: DocumentsRequestContext,
): Promise<Actor | null> {
  context.signal?.throwIfAborted();
  if (!context.principalId) return null;
  const actor = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", context.principalId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) fail(401, "账号不可用");
  return actor;
}

const documentResource = (row: Schema["resources"]): DocumentResource => ({
  id: stableId(row.id, "document-resource"),
  kind: row.kind,
  format: row.format,
  title: row.title,
  ownerId: row.owner_id,
  parentId: row.parent_id
    ? stableId(row.parent_id, "document-resource")
    : null,
  libraryId: row.library_id
    ? stableId(row.library_id, "document-resource")
    : null,
  version: row.version,
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function resourceAfter(db: DB, id: string) {
  return documentResource(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
}

const bytes = (value?: Uint8Array) =>
  value === undefined ? undefined : Buffer.from(value).toString("base64");
const decoded = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const requiredEpoch = (value?: string) => {
  if (!value) fail(500, "协同状态缺少 epoch");
  return value;
};

export function createServerDocumentsCapability(
  db: DB,
  files: FilesServiceV1,
): DocumentsServiceV1 {
  const content = createContent(db);
  const collaboration = createDocuments(db);
  return createDocumentsProviderV1({
    files: createDocumentFilesPortV1(files),
    resources: {
      async create(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        if (
          ![
            "rich_text",
            "spreadsheet",
            "presentation",
            "markdown",
            "canvas",
          ].includes(input.format)
        )
          fail(400, "文档格式不受支持");
        const row = await content.create(actor, {
          kind: input.kind,
          format: input.format as Schema["resources"]["format"],
          title: input.title,
          parentId: input.parentId,
          libraryId: input.libraryId,
        });
        return documentResource(row);
      },
      async get(context, input) {
        const actor = await actorFor(db, context);
        if (input.includeDeleted && actor) {
          const row = await db
            .selectFrom("resources")
            .selectAll()
            .where("id", "=", input.resourceId)
            .executeTakeFirst();
          if (!row || row.owner_id !== actor.id) return null;
          return documentResource(row);
        }
        try {
          const { resource } = await authorize(
            db,
            actor,
            input.resourceId,
            1,
          );
          return documentResource(resource);
        } catch {
          return null;
        }
      },
      async list(context, input) {
        const actor = await actorFor(db, context);
        const limit = Math.min(200, Math.max(1, input.limit ?? 50));
        let query = db
          .selectFrom("resources")
          .selectAll()
          .where("deleted_at", "is", null)
          .where(accessibleQuery(sql.ref("resources.id"), actor, 1))
          .orderBy("id");
        if (input.parentId !== undefined)
          query =
            input.parentId === null
              ? query.where("parent_id", "is", null)
              : query.where("parent_id", "=", input.parentId);
        if (input.libraryId !== undefined)
          query =
            input.libraryId === null
              ? query.where("library_id", "is", null)
              : query.where("library_id", "=", input.libraryId);
        if (input.cursor) query = query.where("id", ">", input.cursor);
        const visible: Schema["resources"][] = [];
        let scan = input.cursor;
        while (visible.length <= limit) {
          context.signal?.throwIfAborted();
          const batch = await (scan ? query.where("id", ">", scan) : query).limit(200).execute();
          if (!batch.length) break;
          for (const row of batch) {
            try {
              await authorize(db, actor, row.id, 1);
              visible.push(row);
              if (visible.length > limit) break;
            } catch (error) {
              if (!(error instanceof AppError && [403, 404].includes(error.status))) throw error;
            }
          }
          scan = batch[batch.length - 1]!.id;
          if (batch.length < 200) break;
        }
        return {
          items: visible.slice(0, limit).map(documentResource),
          cursor: visible.length > limit ? visible[limit - 1]!.id : null,
        };
      },
      async update(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        if (input.title !== undefined)
          await content.rename(
            actor,
            input.resourceId,
            input.title,
            input.expectedVersion,
          );
        else {
          const { resource } = await authorize(
            db,
            actor,
            input.resourceId,
            3,
          );
          if (resource.version !== input.expectedVersion)
            fail(409, "文档版本已变化");
        }
        return resourceAfter(db, input.resourceId);
      },
      async move(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        await content.move(actor, input.resourceId, {
          version: input.expectedVersion,
          parentId: input.parentId,
          libraryId: input.libraryId,
        });
        return resourceAfter(db, input.resourceId);
      },
      async copy(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        const result = await content.copy(actor, input.resourceId, {
          parentId: input.parentId,
          libraryId: input.libraryId,
          includeChildren: input.includeChildren,
        });
        return resourceAfter(db, result.id);
      },
      async trash(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        await content.trash(
          actor,
          input.resourceId,
          input.expectedVersion,
          false,
        );
        return resourceAfter(db, input.resourceId);
      },
      async restore(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        await content.trash(
          actor,
          input.resourceId,
          input.expectedVersion,
          true,
        );
        return resourceAfter(db, input.resourceId);
      },
      async purge(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        await content.purgeDeleted(
          actor,
          input.resourceId,
          input.expectedVersion,
        );
      },
    },
    access: {
      async authorize(context, input) {
        const actor = await actorFor(db, context);
        try {
          const result = await authorize(
            db,
            actor,
            input.resourceId,
            actionRank[input.action],
          );
          return {
            resourceId: input.resourceId,
            principalId: context.principalId,
            action: input.action,
            allowed: true,
            role: roles[Math.max(0, Math.min(4, result.rank - 1))] ?? null,
          };
        } catch {
          return {
            resourceId: input.resourceId,
            principalId: context.principalId,
            action: input.action,
            allowed: false,
            role: null,
          };
        }
      },
      async listGrants(context, input) {
        const actor = await actorFor(db, context);
        await authorize(db, actor, input.resourceId, 4);
        const resource = await db
          .selectFrom("resources")
          .select(["authz_revision"])
          .where("id", "=", input.resourceId)
          .executeTakeFirstOrThrow();
        const rows = await db
          .selectFrom("grants")
          .select(["user_id", "role"])
          .where("resource_id", "=", input.resourceId)
          .where("source_type", "=", "direct")
          .where("source_id", "=", "")
          .where("status", "=", "active")
          .execute();
        return rows.map((row) => ({
          resourceId: input.resourceId,
          principalId: row.user_id,
          role: row.role,
          version: resource.authz_revision ?? 1,
        }));
      },
      async putGrant(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        return transact(db, async (tx) => {
          const { resource } = await authorize(
            tx,
            actor,
            input.resourceId,
            4,
          );
          const revision = resource.authz_revision ?? 1;
          if (
            input.expectedVersion !== undefined &&
            input.expectedVersion !== revision
          )
            fail(409, "权限版本已变化");
          const now = new Date().toISOString();
          await tx
            .insertInto("grants")
            .values({
              resource_id: input.resourceId,
              user_id: input.principalId,
              source_type: "direct",
              source_id: "",
              source_resource_id: null,
              role: input.role,
              include_descendants: 0,
              status: "active",
              created_by: actor.id,
              created_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict
                .columns([
                  "resource_id",
                  "user_id",
                  "source_type",
                  "source_id",
                ])
                .doUpdateSet({
                  role: input.role,
                  status: "active",
                  updated_at: now,
                }),
            )
            .execute();
          await tx
            .updateTable("resources")
            .set({ authz_revision: revision + 1 })
            .where("id", "=", input.resourceId)
            .execute();
          return {
            resourceId: input.resourceId,
            principalId: input.principalId,
            role: input.role,
            version: revision + 1,
          };
        });
      },
      async revokeGrant(context, input) {
        const actor = await actorFor(db, context);
        if (!actor) fail(401, "需要登录");
        await transact(db, async (tx) => {
          const { resource } = await authorize(
            tx,
            actor,
            input.resourceId,
            4,
          );
          const revision = resource.authz_revision ?? 1;
          if (input.expectedVersion !== revision)
            fail(409, "权限版本已变化");
          await tx
            .updateTable("grants")
            .set({ status: "disabled", updated_at: new Date().toISOString() })
            .where("resource_id", "=", input.resourceId)
            .where("user_id", "=", input.principalId)
            .where("source_type", "=", "direct")
            .where("source_id", "=", "")
            .execute();
          await tx
            .updateTable("resources")
            .set({ authz_revision: revision + 1 })
            .where("id", "=", input.resourceId)
            .execute();
        });
      },
    },
    collaboration: {
      async join(context, input) {
        const actor = await actorFor(db, context);
        const state = await collaboration.exchange(actor, input.resourceId, {
          ...(input.vector ? { vector: bytes(input.vector) } : {}),
          ...(input.knownEpochId ? { epochId: input.knownEpochId } : {}),
        });
        if (
          !input.supportedCodecs.some(
            (entry) =>
              entry.codec === state.codec &&
              entry.schemaVersions.includes(state.schemaVersion),
          )
        )
          fail(409, "客户端不支持当前文档协议");
        return {
          protocolVersion: 1,
          resourceId: input.resourceId,
          codec: state.codec,
          schemaVersion: state.schemaVersion,
          epochId: requiredEpoch(state.epochId),
          seq: state.seq,
          checkpointSeq: state.checkpointSeq,
          vector: decoded(state.vector),
          update: decoded(state.update),
          readOnly: state.rank < 3,
        };
      },
      async sync(context, input) {
        const actor = await actorFor(db, context);
        const state = await collaboration.exchange(actor, input.resourceId, {
          epochId: input.epochId,
          vector: bytes(input.vector),
        });
        return {
          protocolVersion: 1,
          resourceId: input.resourceId,
          codec: state.codec,
          schemaVersion: state.schemaVersion,
          epochId: requiredEpoch(state.epochId),
          seq: state.seq,
          checkpointSeq: state.checkpointSeq,
          vector: decoded(state.vector),
          update: decoded(state.update),
          readOnly: state.rank < 3,
        };
      },
      async commit(context, input) {
        const actor = await actorFor(db, context);
        const state = await collaboration.exchange(actor, input.resourceId, {
          protocolVersion: input.protocolVersion,
          messageId: input.messageId,
          codec: input.codec,
          schemaVersion: input.schemaVersion,
          epochId: input.epochId,
          update: bytes(input.update),
        });
        return {
          protocolVersion: 1,
          resourceId: input.resourceId,
          messageId: input.messageId,
          epochId: requiredEpoch(state.epochId),
          seq: state.seq,
          changed: state.changed,
        };
      },
      async publishPresence(context) {
        await actorFor(db, context);
        // WebSocket presence remains connection-scoped in the realtime gateway.
      },
      async leave() {
        // The realtime gateway owns connection teardown and presence expiry.
      },
    },
  });
}
