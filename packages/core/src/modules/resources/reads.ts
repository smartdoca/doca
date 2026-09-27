import type { DB } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { cursorFingerprint, encodePageCursor } from "../../shared/cursor.js";
import { permission } from "../access/policy.js";
import { accessContext } from "../access/queries.js";
import {
  DOCUMENT_CODECS,
  b64,
  restoreDocument,
} from "../collaboration/documents.js";
import { restoreMarkdown } from "../documents/codecs/markdown.js";
import { restoreSurface, DEFAULT_SPREADSHEET_SCHEMA } from "../documents/codecs/surfaces.js";
import { indexDocumentReferences } from "../documents/references.js";
import type { Actor } from "../identity/passwords.js";
import { createResourceRunner, get, project } from "./context.js";
import { queryResourcePage, type ResourceQuery } from "./queries.js";
export function createResourceReads(
  db: DB,
  run: ReturnType<typeof createResourceRunner>,
) {
  return {
    references(actor: Actor | null, id: string) {
      return run(actor, [id], async (ctx) => {
        get(ctx, id, "read_content");
        const state = await ctx.tx
          .selectFrom("document_states as s")
          .leftJoin(
            "document_reference_index as i",
            "i.resource_id",
            "s.resource_id",
          )
          .select(["s.seq", "i.seq as indexedSeq"])
          .where("s.resource_id", "=", id)
          .where("s.codec", "=", DOCUMENT_CODECS.rich_text)
          .executeTakeFirst();
        if (state && state.seq !== state.indexedSeq) {
          const loaded = await restoreDocument(ctx.tx, id);
          try {
            await indexDocumentReferences(
              ctx.tx,
              id,
              loaded.runtime.getValue(),
              state.seq,
            );
          } finally {
            loaded.destroy();
          }
        }
        const edges = await ctx.tx
          .selectFrom("document_references")
          .selectAll()
          .where((eb) =>
            eb.or([eb("source_id", "=", id), eb("target_id", "=", id)]),
          )
          .execute();
        Object.assign(
          ctx,
          await accessContext(ctx.tx, actor, [
            id,
            ...edges.flatMap((e) => [e.source_id, e.target_id]),
          ]),
        );
        const visible = (ids: string[]) =>
          ctx.resources
            .filter(
              (r) =>
                r.kind === "document" &&
                ids.includes(r.id) &&
                permission(r, actor, ctx.resources, ctx.grants) > 0,
            )
            .map((r) => ({ id: r.id, title: r.title, format: r.format }));
        return {
          outgoing: visible(
            edges.filter((e) => e.source_id === id).map((e) => e.target_id),
          ),
          incoming: visible(
            edges.filter((e) => e.target_id === id).map((e) => e.source_id),
          ),
        };
      });
    },
    list(actor: Actor, query: ResourceQuery) {
      return queryResourcePage(db, actor, query);
    },
    detail(actor: Actor | null, id: string) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "read_content");
        const comments = await ctx.tx
          .selectFrom("comments")
          .innerJoin("users", "users.id", "comments.author_id")
          .select([
            "comments.id",
            "comments.body",
            "comments.body_json",
            "comments.parent_id",
            "comments.author_id",
            "comments.resolved",
            "comments.version",
            "comments.created_at",
            "comments.deleted_at",
            "comments.anchor",
            "users.display_name",
            "users.public_id",
            "users.login",
          ])
          .where("resource_id", "=", id)
          .orderBy("comments.created_at")
          .orderBy("comments.id")
          .limit(201)
          .execute();
        const reactions = await ctx.tx
          .selectFrom("reactions")
          .selectAll()
          .where("resource_id", "=", id)
          .execute();
        const owner = await ctx.tx
          .selectFrom("users")
          .select(["display_name", "public_id", "login"])
          .where("id", "=", r.owner_id)
          .executeTakeFirstOrThrow();
        const role = permission(r, actor, ctx.resources, ctx.grants);
        const editorEpoch =
          r.format === "spreadsheet"
            ? await ctx.tx
                .selectFrom("editor_epochs")
                .select("baseline")
                .where("resource_id", "=", id)
                .executeTakeFirst()
            : null;
        const lastEditor = r.last_editor_id
              ? await ctx.tx
                .selectFrom("users")
                .select(["display_name", "public_id", "login"])
              .where("id", "=", r.last_editor_id)
              .executeTakeFirst()
          : null;
        return {
          resource: {
            ...project(ctx, r),
            entry_state: actor
              ? ((
                  await ctx.tx
                    .selectFrom("resource_collections")
                    .select("resource_id")
                    .where("resource_kind", "=", r.kind)
                    .where("user_id", "=", actor.id)
                    .where("resource_id", "=", id)
                    .executeTakeFirst()
                )?.resource_id ? "joined" : null)
              : null,
          },
          ownerName:
            ctx.managerInfoVisible || role >= 4
              ? owner.display_name || owner.public_id || owner.login
              : "",
          editorSchemaVersion:
            r.format === "spreadsheet"
              ? editorEpoch?.baseline
                ? JSON.parse(editorEpoch.baseline).schemaVersion
                : DEFAULT_SPREADSHEET_SCHEMA
              : undefined,
          lastEditorName:
            lastEditor?.display_name || lastEditor?.public_id || lastEditor?.login || null,
          lastEditedAt: r.last_edited_at ?? null,
          commentsNextOffset: comments.length > 200 ? 200 : null,
          commentsNextCursor:
            comments.length > 200 && comments[199]
              ? encodePageCursor(
                  cursorFingerprint({ kind: "comments", id }),
                  comments[199].created_at,
                  comments[199].id,
                )
              : null,
          comments: comments.slice(0, 200).map(({ public_id, login, ...c }) => ({
            ...c,
            display_name: c.display_name || public_id || login,
            body: c.deleted_at ? "" : c.body,
            body_json: c.deleted_at ? null : c.body_json,
          })),
          likes: reactions.filter((x) => x.kind === "like").length,
          liked: reactions.some(
            (x) => x.kind === "like" && x.user_id === actor?.id,
          ),
          favorite: reactions.some(
            (x) => x.kind === "favorite" && x.user_id === actor?.id,
          ),
          pinned: reactions.some(
            (x) => x.kind === "pin" && x.user_id === actor?.id,
          ),
          grants:
            role >= 4
              ? await ctx.tx
                  .selectFrom("access_invitations as i")
                  .select([
                    "i.resource_id",
                    "i.user_id",
                    "i.role",
                    "i.state",
                    "i.version",
                  ])
                  .where("i.resource_id", "=", id)
                  .execute()
              : [],
        };
      });
    },
    trashPreview(actor: Actor, id: string) {
      return run(actor, [id], [id], async (ctx) => {
        const resource = get(ctx, id, "manage_structure", true);
        if (!resource.deleted_at) fail(409, "文件已恢复，请从文档列表打开");
        if (resource.kind === "library")
          return {
            resource,
            children: ctx.resources
              .filter(
                (r) =>
                  r.library_id === id &&
                  r.deleted_at &&
                  permission(r, actor, ctx.resources, ctx.grants) >= 4,
              )
              .map((r) => ({ id: r.id, title: r.title })),
          };
        if (resource.format === "markdown") {
          const loaded = await restoreMarkdown(ctx.tx, id);
          try {
            return {
              resource,
              markdown: loaded.doc.getText("markdown").toString(),
            };
          } finally {
            loaded.destroy();
          }
        }
        if (
          ["spreadsheet", "canvas", "presentation"].includes(resource.format)
        ) {
          const loaded = await restoreSurface(ctx.tx, id, resource.format);
          return {
            resource,
            surface: {
              format: resource.format,
              epochId: loaded.epochId,
              baseline: loaded.baseline,
              update: b64(loaded.update),
            },
          };
        }
        const loaded = await restoreDocument(ctx.tx, id);
        try {
          return { resource, value: loaded.runtime.getValue() };
        } finally {
          loaded.destroy();
        }
      });
    },
  };
}
