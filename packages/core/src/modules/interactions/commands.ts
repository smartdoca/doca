import {
  createMarkdownTextAnchor,
  resolveMarkdownTextAnchor,
} from "exmd-collaborative-editor";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
import { permission } from "../access/policy.js";
import { restoreDocument } from "../collaboration/documents.js";
import {
  decodeMarkdownAnchor,
  encodeMarkdownAnchor,
} from "../documents/codecs/markdown-anchor.js";
import { restoreMarkdown } from "../documents/codecs/markdown.js";
import {
  canonicalRichAnchor,
  richAnchorParts,
  resolveRichAnchor,
} from "../documents/codecs/rich-anchor.js";
import { surfaceAnchor } from "../documents/codecs/surfaces.js";
import type { Actor } from "../identity/passwords.js";
import { createResourceRunner, event, get } from "../resources/context.js";
import { normalizeComment, notify } from "./community.js";
export function createInteractions(
  db: DB,
  run: ReturnType<typeof createResourceRunner>,
) {
  return {
    visit(actor: Actor, id: string, stamp = new Date()) {
      return run(actor, [id], async (ctx) => {
        get(ctx, id, "read_content");
        const lastVisit = await ctx.tx
          .selectFrom("visit_events")
          .select("created_at")
          .where("user_id", "=", actor.id)
          .where("resource_id", "=", id)
          .orderBy("created_at", "desc")
          .executeTakeFirst();
        const settings = await ctx.tx
          .selectFrom("settings")
          .select("default_timezone")
          .where("id", "=", "system")
          .executeTakeFirst();
        const day = (value: Date) =>
          new Intl.DateTimeFormat("sv-SE", {
            timeZone: settings?.default_timezone ?? "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(value);
        if (!lastVisit || day(new Date(lastVisit.created_at)) !== day(stamp))
          await ctx.tx
            .insertInto("visit_events")
            .values({
              id: randomUUID(),
              resource_id: id,
              user_id: actor.id,
              created_at: stamp.toISOString(),
            })
            .execute();
        await ctx.tx
          .insertInto("resource_visits")
          .values({
            user_id: actor.id,
            resource_id: id,
            visited_at: stamp.toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(["user_id", "resource_id"]).doUpdateSet({
              visited_at: sql<string>`case when resource_visits.visited_at < ${stamp.toISOString()} then ${stamp.toISOString()} else resource_visits.visited_at end`,
            }),
          )
          .execute();
        return { ok: true };
      });
    },
    commentPage(
      actor: Actor | null,
      id: string,
      cursor?: string,
      target?: string,
    ) {
      return run(actor, [id], async (ctx) => {
        const resource = get(ctx, id, "read_content");
        let q = ctx.tx
          .selectFrom("comments as c")
          .innerJoin("users as u", "u.id", "c.author_id")
          .selectAll("c")
          .select("u.display_name")
          .where("c.resource_id", "=", id);
        if (target) {
          const c = await ctx.tx
            .selectFrom("comments")
            .select(["id", "parent_id"])
            .where("id", "=", target)
            .where("resource_id", "=", id)
            .executeTakeFirst();
          if (!c) fail(404, "评论不存在");
          q = q.where("c.id", "in", [c.id, c.parent_id ?? c.id]);
        }
        const fingerprint = cursorFingerprint({ kind: "comments", id });
        if (cursor && !target) {
          const c = decodePageCursor(cursor, fingerprint);
          q = q.where(
            sql<boolean>`(c.created_at > ${c.value} or (c.created_at = ${c.value} and c.id > ${c.id}))`,
          );
        }
        const rows = await q
          .orderBy("c.created_at")
          .orderBy("c.id")
          .limit(201)
          .execute();
        const items = rows.slice(0, 200);
        const last = items.at(-1);
        return {
          items: items.map((c) => ({
            ...c,
            body: c.deleted_at ? "" : c.body,
            body_json: c.deleted_at ? null : c.body_json,
          })),
          nextCursor:
            rows.length > 200 && last && !target
              ? encodePageCursor(fingerprint, last.created_at, last.id)
              : null,
        };
      });
    },
    reaction(
      actor: Actor,
      id: string,
      kind: "like" | "favorite" | "pin",
      enabled: boolean,
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "read_content");
        if (kind === "pin" && r.kind !== "document") fail(400, "只能置顶文档");
        const old = await ctx.tx
          .selectFrom("reactions")
          .select("kind")
          .where("resource_id", "=", id)
          .where("user_id", "=", actor.id)
          .where("kind", "=", kind)
          .executeTakeFirst();
        if (!!old === enabled) return { ok: true };
        if (enabled)
          await ctx.tx
            .insertInto("reactions")
            .values({
              resource_id: id,
              user_id: actor.id,
              kind,
              ...(kind === "pin"
                ? { created_at: new Date().toISOString() }
                : {}),
            })
            .execute();
        else
          await ctx.tx
            .deleteFrom("reactions")
            .where("resource_id", "=", id)
            .where("user_id", "=", actor.id)
            .where("kind", "=", kind)
            .execute();
        if (kind !== "pin")
          await event(
            ctx,
            r,
            `${kind}.${enabled ? "added" : "removed"}`,
            enabled ? [r.owner_id] : [],
          );
        return { ok: true };
      });
    },
    comment(
      actor: Actor,
      id: string,
      body: string,
      parentId: string | null,
      anchor?: string,
      richBody?: unknown,
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "comment");
        if (r.kind !== "document")
          fail(400, "知识库本身不支持评论，请在具体文档中评论");
        const rich = await normalizeComment(ctx.tx, actor, id, richBody, body);
        const text = rich.text;
        let author: string | undefined;
        let storedAnchor: string | null = null;
        if (anchor) {
          if (
            parentId ||
            ![
              "rich_text",
              "spreadsheet",
              "canvas",
              "markdown",
              "presentation",
            ].includes(r.format) ||
            r.kind !== "document"
          )
            fail(400, "当前文档不支持选区评论");
          if (r.format === "markdown") {
            const loaded = await restoreMarkdown(ctx.tx, id);
            try {
              let decoded;
              try {
                decoded = decodeMarkdownAnchor(
                  JSON.parse(anchor),
                  loaded.epochId,
                );
              } catch {
                fail(400, "Markdown 评论位置或版本无效");
              }
              const text = loaded.doc.getText("markdown");
              const range = resolveMarkdownTextAnchor(
                loaded.doc,
                text,
                decoded,
              );
              if (!range) fail(409, "选区已删除或变化，请重新选择");
              const canonical = createMarkdownTextAnchor(
                text,
                range.from,
                range.to,
              );
              storedAnchor = JSON.stringify(
                encodeMarkdownAnchor(
                  canonical,
                  loaded.epochId!,
                  text.toString().slice(range.from, range.to),
                ),
              );
            } finally {
              loaded.destroy();
            }
          } else if (
            ["spreadsheet", "canvas", "presentation"].includes(r.format)
          ) {
            let a;
            try {
              a = JSON.parse(anchor);
            } catch {
              fail(400, "评论位置无效");
            }
            storedAnchor = JSON.stringify(
              await surfaceAnchor(ctx.tx, id, r.format, a),
            );
          } else {
            const loaded = await restoreDocument(ctx.tx, id);
            try {
              let a;
              try {
                a = JSON.parse(anchor);
              } catch {
                fail(400, "评论位置无效");
              }
              let parts, resolved;
              try {
                parts = richAnchorParts(a);
                resolved = resolveRichAnchor(loaded.runtime, a);
              } catch {
                fail(400, "评论位置无效");
              }
              if (resolved.length !== parts.length)
                fail(409, "选区已变化，请重新选择");
              try {
                storedAnchor = JSON.stringify(
                  canonicalRichAnchor(loaded.runtime, a),
                );
              } catch {
                fail(400, "评论选区过大或无效");
              }
            } finally {
              loaded.destroy();
            }
          }
        }
        if (
          ["canvas", "spreadsheet", "presentation"].includes(r.format) &&
          !anchor &&
          !parentId
        )
          fail(400, "此类型只支持区域评论");
        if (parentId) {
          const parent = await ctx.tx
            .selectFrom("comments")
            .selectAll()
            .where("id", "=", parentId)
            .where("resource_id", "=", id)
            .executeTakeFirst();
          if (
            !parent ||
            parent.parent_id ||
            parent.deleted_at ||
            parent.resolved
          )
            fail(400, "该评论不能回复");
          author = parent.author_id;
        }
        const commentId = randomUUID(),
          now = new Date().toISOString();
        await ctx.tx
          .insertInto("comments")
          .values({
            id: commentId,
            resource_id: id,
            author_id: actor.id,
            anchor: storedAnchor,
            body: text,
            body_json: JSON.stringify(rich.body),
            parent_id: parentId,
            resolved: 0,
            deleted_at: null,
            version: 1,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await event(ctx, r, "comment.created");
        await notify(
          ctx.tx,
          actor,
          r,
          "comment.mentioned",
          rich.mentions,
          commentId,
          `comment:${commentId}`,
        );
        await notify(
          ctx.tx,
          actor,
          r,
          "comment.created",
          [r.owner_id, ...(author ? [author] : [])].filter(
            (id) => !rich.mentions.includes(id),
          ),
          commentId,
          `comment:${commentId}`,
        );
        return { id: commentId };
      });
    },
    updateComment(
      actor: Actor,
      id: string,
      commentId: string,
      input: {
        version: number;
        body?: string;
        richBody?: unknown;
        deleted?: boolean;
        resolved?: boolean;
      },
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "comment");
        const c = await ctx.tx
          .selectFrom("comments")
          .selectAll()
          .where("id", "=", commentId)
          .where("resource_id", "=", id)
          .executeTakeFirst();
        if (!c || c.deleted_at) fail(404, "评论不存在");
        if (c.version !== input.version) fail(409, "评论已被修改");
        const manager = permission(r, actor, ctx.resources, ctx.grants) >= 4;
        if (
          ((input.body !== undefined || input.richBody !== undefined) &&
            c.author_id !== actor.id) ||
          ((input.deleted !== undefined || input.resolved !== undefined) &&
            c.author_id !== actor.id &&
            !manager)
        )
          fail(403, "无权修改评论");
        if (input.resolved !== undefined && c.parent_id)
          fail(400, "只能处理整条评论");
        const rich =
          input.body !== undefined || input.richBody !== undefined
            ? await normalizeComment(
                ctx.tx,
                actor,
                id,
                input.richBody,
                input.body ?? "",
                c.body_json,
              )
            : null;
        const body = rich?.text;
        if (body !== undefined && (!body || body.length > 5000))
          fail(400, "评论不能为空");
        await ctx.tx
          .updateTable("comments")
          .set({
            ...(body !== undefined ? { body } : {}),
            ...(rich ? { body_json: JSON.stringify(rich.body) } : {}),
            ...(input.deleted
              ? {
                  deleted_at: new Date().toISOString(),
                  body: "",
                  body_json: null,
                }
              : {}),
            ...(input.resolved !== undefined
              ? { resolved: Number(input.resolved) }
              : {}),
            version: c.version + 1,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", commentId)
          .execute();
        await event(ctx, r, "comment.updated");
        if (rich && !input.deleted)
          await notify(
            ctx.tx,
            actor,
            r,
            "comment.mentioned",
            rich.mentions,
            commentId,
            `comment:${commentId}:${c.version + 1}`,
          );
        return { ok: true };
      });
    },
  };
}
