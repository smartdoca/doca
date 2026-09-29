import {
  checkCreation,
  requireCapability,
  checkDocumentSize,
  checkStorage,
} from "../access/operation-policy.js";
import { assertInternetPublication, checkPublication, checkTransfer } from "../access/operation-policy.js";
import { archiveInvitation, invitationState } from "../access/invitations.js";
import { protectManagers } from "./context.js";
import { randomUUID } from "node:crypto";
import { Doc, encodeStateAsUpdate } from "@smartdoca/slate/yjs";
import { sql, type Transaction } from "kysely";
import type { DB, Resource, Schema } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import {
  canRemoveResource,
  label,
  namedPermission,
  permission,
  isResourceOwnerLike,
} from "../access/policy.js";
import { effectiveResource } from "../access/inheritance.js";
import { emitIntegrationEvent } from "../automation/events.js";
import {
  DOCUMENT_CODECS,
  b64,
  plainText,
  restoreDocument,
  setDocumentTitle,
} from "../collaboration/documents.js";
import { distributionPolicy } from "../deployment/policies.js";
import {
  markdownTitle,
  restoreMarkdown,
  storeNewMarkdown,
} from "../documents/codecs/markdown.js";
import { DocaYjsDocument as YjsDocument } from "../documents/codecs/rich-runtime.js";
import { copySurface } from "../documents/codecs/surfaces.js";
import { importInitialContent } from "../documents/import.js";
import { applyTemplateContent } from "../templates/templates.js";
import type { Actor } from "../identity/passwords.js";
import {
  check,
  clean,
  createResourceRunner,
  descendants,
  event,
  get,
  nextTreeOrder,
  update,
  type Context,
} from "./context.js";
async function isCollaborator(
  tx: DB | Transaction<Schema>,
  resourceId: string,
  userId: string,
) {
  const granted = await tx
    .selectFrom("grants")
    .select("user_id")
    .where("resource_id", "=", resourceId)
    .where("user_id", "=", userId)
    .where("source_type", "in", ["direct", "link"])
    .where("status", "=", "active")
    .executeTakeFirst();
  if (granted) return true;
  return false;
}
async function erasePurgedResources(ctx: Context, actor: Actor, ids: string[]) {
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    await ctx.tx
      .updateTable("resources")
      .set({ parent_id: null, library_id: null })
      .where("id", "in", batch)
      .execute();
    await ctx.tx
      .updateTable("comments")
      .set({ parent_id: null })
      .where("resource_id", "in", batch)
      .execute();
  }
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    await ctx.tx
      .updateTable("audit_events")
      .set({ resource_id: null })
      .where("resource_id", "in", batch)
      .execute();
    await ctx.tx
      .updateTable("quick_note_compilations")
      .set({ document_id: null })
      .where("document_id", "in", batch)
      .execute();
    // Copies may share object keys. Revoke these attachment records, leave
    // physical object reclamation to storage GC rather than deleting live copies.
    await ctx.tx
      .updateTable("assets")
      .set({ resource_id: null, deleted_at: new Date().toISOString() })
      .where("resource_id", "in", batch)
      .execute();
    await ctx.tx
      .deleteFrom("file_items")
      .where("parent_type", "=", "document")
      .where("parent_id", "in", batch)
      .execute();
    await ctx.tx
      .deleteFrom("document_references")
      .where("target_id", "in", batch)
      .execute();
    for (const table of [
      "notifications",
      "comments",
      "grants",
      "reactions",
      "resource_visits",
      "visit_events",
      "share_links",
      "document_versions",
      "document_updates",
      "document_states",
      "access_invitations",
      "access_requests",
      "document_references",
    ] as const) {
      if (table === "document_references")
        await ctx.tx
          .deleteFrom(table)
          .where("source_id", "in", batch)
          .execute();
      else
        await ctx.tx
          .deleteFrom(table)
          .where("resource_id", "in", batch)
          .execute();
    }
  }
  for (let offset = 0; offset < ids.length; offset += 200)
    await ctx.tx
      .deleteFrom("resources")
      .where("id", "in", ids.slice(offset, offset + 200))
      .execute();
  for (const id of ids)
    await emitIntegrationEvent(ctx.tx, "resource.purged", {
      resourceId: id,
      actorId: actor.id,
    });
  return { ok: true, count: ids.length };
}
export function createResourceCommands(
  db: DB,
  run: ReturnType<typeof createResourceRunner>,
) {
  return {
    create(
      actor: Actor,
      input: {
        title: string;
        kind: Resource["kind"];
        format: Resource["format"];
        libraryId?: string | null;
        parentId?: string | null;
        markdown?: string;
        initialContent?: unknown;
        templateId?: string | null;
        private?: boolean;
      },
    ) {
      return run(actor, [input.parentId, input.libraryId], async (ctx) => {
        let libraryId = input.libraryId ?? null,
          parentId = input.parentId ?? null;
        if (
          input.markdown !== undefined &&
          (input.format !== "markdown" ||
            input.kind !== "document" ||
            Buffer.byteLength(input.markdown) > 512 * 1024)
        )
          fail(400, "仅支持导入 512 KB 以内的 Markdown 文档");
        if (input.kind === "library" && (libraryId || parentId))
          fail(400, "知识库不能嵌套");
        if (parentId) {
          const parent = get(ctx, parentId, "edit_content");
          if (parent.kind !== "document") fail(400, "父节点必须是文档");
          if (libraryId && libraryId !== parent.library_id)
            fail(400, "目录与知识库不一致");
          libraryId = parent.library_id;
          if (!libraryId) fail(400, "个人文档不支持子文档");
        }
        if (libraryId && get(ctx, libraryId, "edit_content").kind !== "library")
          fail(400, "知识库无效");
        await checkCreation(ctx.tx, actor.id, input.kind, input.format);
        if (input.initialContent !== undefined || input.markdown !== undefined)
          await requireCapability(ctx.tx, actor.id, "documents.import");
        const now = new Date().toISOString();
        const defaults = await distributionPolicy(ctx.tx, input.kind);
        const row: Resource = {
          id: randomUUID(),
          title:
            input.markdown !== undefined
              ? markdownTitle(input.markdown)
              : clean(input.title),
          kind: input.kind,
          format: input.format,
          owner_id: actor.id,
          last_editor_id: actor.id,
          last_edited_at: now,
          library_id: libraryId,
          parent_id: parentId,
          tree_order: await nextTreeOrder(ctx, parentId, libraryId),
          access_mode: libraryId || parentId ? "inherit" : "custom",
          visibility:
            input.private || defaults.defaultVisibility === "requestable"
              ? "invited"
              : defaults.defaultVisibility,
          requests_enabled: Number(
            !input.private && defaults.defaultVisibility === "requestable",
          ),
          share_links_enabled: Number(
            !input.private && input.kind === "document",
          ),
          discoverable: 0,
          history_readers: 0,
          version: 1,
          deleted_at: null,
          delete_batch: null,
          created_at: now,
          updated_at: now,
        };
        await checkPublication(ctx.tx, actor.id, actor.id, row.visibility);
        if (row.visibility === "public")
          await assertInternetPublication(ctx.tx, input.kind, actor.id);
        await ctx.tx.insertInto("resources").values(row).execute();
        if (input.initialContent !== undefined) {
          if (input.markdown !== undefined) fail(400, "不能同时导入两种内容");
          await importInitialContent(ctx.tx, actor, row, input.initialContent);
        }
        if (input.markdown !== undefined)
          await storeNewMarkdown(ctx.tx, row.id, input.markdown, now);
        if (input.templateId) {
          if (input.kind !== "document") fail(400, "只有文档可以使用模板");
          if (
            input.initialContent !== undefined ||
            input.markdown !== undefined
          )
            fail(400, "不能同时使用模板和导入内容");
          const template = await ctx.tx
            .selectFrom("document_templates")
            .selectAll()
            .where("id", "=", input.templateId)
            .executeTakeFirst();
          if (!template) fail(404, "模板不存在");
          if (template.format !== row.format) fail(400, "模板与文档类型不一致");
          let content: unknown;
          try {
            content = JSON.parse(template.content);
          } catch {
            fail(400, "模板内容损坏");
          }
          await applyTemplateContent(ctx.tx, row, content);
        }
        await event(ctx, row, `${row.kind}.created`);
        return row;
      });
    },
    initializeImport(actor: Actor, id: string, initialContent: unknown) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "edit_content");
        await requireCapability(ctx.tx, actor.id, "documents.import");
        if (
          r.owner_id !== actor.id ||
          r.version !== 1 ||
          Date.now() - Date.parse(r.created_at) > 15 * 60 * 1000
        )
          fail(409, "只能初始化刚创建的导入文档");
        const state = await ctx.tx
          .selectFrom("document_states")
          .select("resource_id")
          .where("resource_id", "=", id)
          .executeTakeFirst();
        if (state) fail(409, "文档已经打开或初始化，不能覆盖已有内容");
        await importInitialContent(ctx.tx, actor, r, initialContent);
        return r;
      });
    },
    initializeMarkdownImport(actor: Actor, id: string, markdown: string) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "edit_content");
        await requireCapability(ctx.tx, actor.id, "documents.import");
        if (r.kind !== "document" || r.format !== "markdown")
          fail(400, "不支持的 Markdown 导入目标");
        if (Buffer.byteLength(markdown) > 512 * 1024)
          fail(413, "导入后的 Markdown 不能超过 512 KB");
        if (
          r.owner_id !== actor.id ||
          r.version !== 1 ||
          Date.now() - Date.parse(r.created_at) > 15 * 60 * 1000
        )
          fail(409, "只能初始化刚创建的导入文档");
        const state = await ctx.tx
          .selectFrom("document_states")
          .select("resource_id")
          .where("resource_id", "=", id)
          .executeTakeFirst();
        if (state) fail(409, "文档已经打开或初始化，不能覆盖已有内容");
        const now = new Date().toISOString();
        await storeNewMarkdown(ctx.tx, id, markdown, now);
        const title = markdownTitle(markdown);
        await ctx.tx
          .updateTable("resources")
          .set({
            title,
            updated_at: now,
            last_edited_at: now,
            last_editor_id: actor.id,
          })
          .where("id", "=", id)
          .execute();
        r.title = title;
        return r;
      });
    },
    rename(actor: Actor, id: string, title: string, version: number) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "edit_content");
        check(r, version);
        await update(ctx, r, { title: clean(title) });
        if (r.kind === "document" && r.format === "markdown") {
          const loaded = await restoreMarkdown(ctx.tx, id);
          try {
            if (loaded.state) {
              const text = loaded.doc.getText("markdown"),
                first = text.toString().split("\n", 1)[0]!;
              loaded.doc.transact(() => {
                text.delete(0, first.length);
                text.insert(0, `# ${clean(title)}`);
              });
              const seq = loaded.state.seq + 1;
              await checkDocumentSize(
                ctx.tx,
                id,
                Buffer.byteLength(text.toString()),
              );
              await ctx.tx
                .updateTable("document_states")
                .set({
                  seq,
                  checkpoint_seq: seq,
                  checkpoint: b64(encodeStateAsUpdate(loaded.doc)),
                  text: text.toString(),
                  updated_at: new Date().toISOString(),
                })
                .where("resource_id", "=", id)
                .execute();
              await ctx.tx
                .deleteFrom("document_updates")
                .where("resource_id", "=", id)
                .execute();
            }
          } finally {
            loaded.destroy();
          }
        }
        if (r.kind === "document" && r.format === "rich_text") {
          const loaded = await restoreDocument(ctx.tx, id);
          try {
            if (loaded.state) {
              setDocumentTitle(loaded.runtime, clean(title));
              const seq = loaded.state.seq + 1;
              await checkDocumentSize(
                ctx.tx,
                id,
                Buffer.byteLength(JSON.stringify(loaded.runtime.getValue())),
              );
              await ctx.tx
                .updateTable("document_states")
                .set({
                  seq,
                  checkpoint_seq: seq,
                  checkpoint: b64(encodeStateAsUpdate(loaded.doc)),
                  text: plainText(loaded.runtime.getValue()),
                  updated_at: new Date().toISOString(),
                })
                .where("resource_id", "=", id)
                .execute();
              await ctx.tx
                .deleteFrom("document_updates")
                .where("resource_id", "=", id)
                .execute();
            }
          } finally {
            loaded.destroy();
          }
        }
        await event(ctx, r, "resource.renamed");
        return { ok: true };
      });
    },
    setPageWidth(actor: Actor, id: string, pageWidth: string, version: number) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, "edit_content");
        if (r.kind !== "document" || r.format !== "rich_text")
          fail(400, "只有富文本文档可以设置内容宽度");
        const next =
          pageWidth === "a3" || pageWidth === "fluid" || pageWidth === "a4"
            ? pageWidth
            : null;
        if (!next) fail(400, "内容宽度无效");
        check(r, version);
        await update(ctx, r, { page_width: next });
        return { ok: true, version: r.version + 1, pageWidth: next };
      });
    },
    transfer(
      actor: Actor,
      id: string,
      input: { version: number; userId: string; retainAccess: boolean },
    ) {
      return run(actor, [id], async (ctx) => {
        const r = get(ctx, id, 5);
        check(r, input.version);
        if (input.userId === actor.id) fail(400, "已经是所有者");
        if (
          !(await ctx.tx
            .selectFrom("users")
            .select("id")
            .where("id", "=", input.userId)
            .where("status", "=", "active")
            .executeTakeFirst())
        )
          fail(400, "目标用户不可用");
        if (
          r.library_id === null &&
          !(await isCollaborator(ctx.tx, id, input.userId))
        )
          fail(400, "只能转移给本文档的协作者");
        await ctx.tx
          .deleteFrom("grants")
          .where("resource_id", "=", id)
          .where("user_id", "in", [actor.id, input.userId])
          .execute();
        const priorInvitations = await ctx.tx
          .selectFrom("access_invitations")
          .selectAll()
          .where("resource_id", "=", id)
          .where("user_id", "in", [actor.id, input.userId])
          .execute();
        for (const invitation of priorInvitations) {
          await archiveInvitation(
            ctx.tx,
            invitationState(invitation) === "pending"
              ? {
                  ...invitation,
                  state: "cancelled",
                  decided_by: actor.id,
                  updated_at: new Date().toISOString(),
                }
              : invitation,
          );
        }
        await ctx.tx
          .deleteFrom("access_invitations")
          .where("resource_id", "=", id)
          .where("user_id", "in", [actor.id, input.userId])
          .execute();
        if (input.retainAccess)
          await ctx.tx
            .insertInto("grants")
            .values({ resource_id: id, user_id: actor.id, role: "manager" })
            .execute();
        await checkTransfer(ctx.tx, r, input.userId);
        await ctx.tx
          .updateTable("assets")
          .set({ owner_id: input.userId })
          .where("resource_id", "=", id)
          .execute();
        await update(ctx, r, { owner_id: input.userId });
        await event(ctx, r, "resource.transferred", [input.userId]);
        return { ok: true };
      });
    },
    arrange(
      actor: Actor,
      id: string,
      input: {
        version: number;
        targetId: string;
        placement: "before" | "after" | "inside";
      },
    ) {
      return run(actor, [id, input.targetId], [id], async (ctx) => {
        const r = get(ctx, id, "manage_structure"),
          target = get(ctx, input.targetId, "read_content");
        check(r, input.version);
        if (
          r.kind !== "document" ||
          target.kind !== "document" ||
          r.id === target.id
        )
          fail(400, "请选择另一个文档作为目标");
        if (!r.library_id || !target.library_id)
          fail(400, "个人文档不支持层级排序");
        if (r.library_id !== target.library_id)
          fail(400, "拖拽仅支持同一知识库内的文档");
        const parentId =
          input.placement === "inside" ? target.id : target.parent_id;
        const affected = descendants(ctx, r);
        if (affected.some((x) => x.id === parentId))
          fail(400, "不能放入自身或子文档");
        if (r.library_id) get(ctx, r.library_id, "edit_content");
        if (parentId) get(ctx, parentId, "edit_content");
        if (
          parentId !== r.parent_id &&
          affected.some(
            (x) =>
              x.deleted_at ||
              permission(x, actor, ctx.resources, ctx.grants) < 4,
          )
        )
          fail(403, "需要管理整个子树，且不能包含回收站文档");
        if (parentId !== r.parent_id)
          protectManagers(
            ctx,
            affected,
            ctx.resources.map((x) =>
              x.id === r.id ? { ...x, parent_id: parentId } : x,
            ),
          );
        const siblings: Resource[] = await ctx.tx
          .selectFrom("resources")
          .selectAll()
          .where("kind", "=", "document")
          .where("deleted_at", "is", null)
          .where("id", "!=", id)
          .where("parent_id", parentId ? "=" : "is", parentId)
          .where("library_id", r.library_id ? "=" : "is", r.library_id)
          .$if(!r.library_id && !parentId, (q) =>
            q.where("owner_id", "=", r.owner_id),
          )
          .orderBy("tree_order")
          .orderBy("created_at")
          .orderBy("id")
          .execute();
        const index =
          input.placement === "inside"
            ? siblings.length
            : siblings.findIndex((x) => x.id === target.id) +
              (input.placement === "after" ? 1 : 0);
        siblings.splice(index, 0, r);
        for (const [position, sibling] of siblings.entries())
          await ctx.tx
            .updateTable("resources")
            .set({ tree_order: position })
            .where("id", "=", sibling.id)
            .execute();
        // Keep explicit grants and links intact; inherited access follows the new parent.
        await update(ctx, r, { parent_id: parentId });
        await event(ctx, r, "resource.arranged");
        return { ok: true };
      });
    },
    move(
      actor: Actor,
      id: string,
      input: {
        version: number;
        parentId: string | null;
        libraryId: string | null;
      },
    ) {
      return run(
        actor,
        [id, input.parentId, input.libraryId],
        [id],
        async (ctx) => {
          const r = get(ctx, id, "manage_structure");
          check(r, input.version);
          if (r.kind !== "document") fail(400, "不能移动知识库");
          const affected = descendants(ctx, r);
          if (
            affected.some(
              (x) =>
                permission(x, actor, ctx.resources, ctx.grants) < 4 ||
                x.deleted_at,
            )
          )
            fail(403, "需要管理整个子树，且不能包含回收站文档");
          let libraryId = input.libraryId;
          if (input.parentId) {
            const parent = get(ctx, input.parentId, "edit_content");
            if (
              parent.kind !== "document" ||
              affected.some((x) => x.id === parent.id)
            )
              fail(400, "不能移动到自身或子文档");
            if (libraryId !== parent.library_id)
              fail(400, "目标目录与知识库不一致");
            libraryId = parent.library_id;
            if (!libraryId) fail(400, "个人文档不支持子文档");
          }
          if (
            libraryId &&
            get(ctx, libraryId, "edit_content").kind !== "library"
          )
            fail(400, "目标知识库无效");
          if (
            r.library_id !== libraryId &&
            affected.some((x) => !isResourceOwnerLike(x, actor, ctx.resources))
          )
            fail(403, "带子文档迁移需要拥有当前文档及全部子文档");
          if (!r.library_id) {
            if (!libraryId) fail(400, "个人文档没有目录层级");
            if (!isResourceOwnerLike(r, actor, ctx.resources))
              fail(403, "仅文档所有者可以转移文档");
            const container = ctx.resources.find(
              (x) => x.id === (input.parentId ?? libraryId),
            )!;
            if (permission(container, actor, ctx.resources, ctx.grants) < 4)
              fail(403, "需要目标知识库或文档的管理权限");
          } else if (
            !libraryId &&
            !isResourceOwnerLike(r, actor, ctx.resources)
          ) {
            fail(403, "仅文档所有者可以转移文档");
          }
          // Moving preserves explicit grants and links. Inherited management must not
          // change under an ordinary manager's structural operation.
          const simulated = ctx.resources.map((doc) =>
            affected.some((a) => a.id === doc.id)
              ? {
                  ...doc,
                  library_id: libraryId,
                  ...(doc.id === id ? { parent_id: input.parentId } : {}),
                }
              : doc,
          );
          protectManagers(ctx, affected, simulated);
          const leavingLibrary =
            !libraryId && !input.parentId && !!r.library_id;
          if (leavingLibrary) {
            // A personal document has no parent chain. Flatten a moved knowledge
            // base subtree and materialize the named permissions that were
            // inherited from the old library/tree before detaching it.
            const candidates = new Set([
              ...ctx.resources.map((x) => x.owner_id),
              ...ctx.grants.map((g) => g.user_id),
            ]);
            for (const doc of affected) {
              const localUsers = new Set(
                ctx.grants
                  .filter((g) => g.resource_id === doc.id)
                  .map((g) => g.user_id),
              );
              for (const userId of candidates) {
                if (userId === doc.owner_id || localUsers.has(userId)) continue;
                const rank = namedPermission(
                  doc,
                  { id: userId, display_name: "", admin: 0 },
                  ctx.resources,
                  ctx.grants,
                );
                if (rank >= 1 && rank <= 4)
                  await ctx.tx
                    .insertInto("grants")
                    .values({
                      resource_id: doc.id,
                      user_id: userId,
                      role: label(rank) as
                        "reader" | "commenter" | "editor" | "manager",
                      include_descendants: 1,
                    })
                    .execute();
              }
            }
          }
          for (const doc of affected) {
            await update(ctx, doc, {
              library_id: libraryId,
              ...(doc.id === id
                ? {
                    parent_id: input.parentId,
                    tree_order: await nextTreeOrder(
                      ctx,
                      input.parentId,
                      libraryId,
                    ),
                  }
                : {}),
              ...(leavingLibrary
                ? {
                    parent_id: null,
                    access_mode: "custom" as const,
                    permission_overrides: 63,
                    visibility: effectiveResource(doc, ctx.resources)
                      .visibility,
                    public_role: effectiveResource(doc, ctx.resources)
                      .public_role,
                    requests_enabled: effectiveResource(doc, ctx.resources)
                      .requests_enabled,
                    discoverable: effectiveResource(doc, ctx.resources)
                      .discoverable,
                    history_readers: effectiveResource(doc, ctx.resources)
                      .history_readers,
                    share_links_enabled: effectiveResource(doc, ctx.resources)
                      .share_links_enabled,
                  }
                : !input.parentId &&
                    !libraryId &&
                    doc.id === id &&
                    doc.access_mode === "inherit"
                  ? {
                      access_mode: "custom" as const,
                      visibility: "invited" as const,
                    }
                  : {}),
            });
          }
          await event(ctx, r, "resource.moved");
          return { ok: true };
        },
      );
    },
    purgeTrash(actor: Actor, targets: { id: string; version: number }[]) {
      return run(
        actor,
        targets.map((x) => x.id),
        targets.map((x) => x.id),
        async (ctx) => {
          const ids = [...new Set(targets.map((r) => r.id))];
          if (!ids.length || ids.length !== targets.length || ids.length > 1000)
            fail(400, "一次最多清空一千项，请分批处理");
          const selected = new Set(ids);
          for (const item of targets) {
            const r = get(ctx, item.id, "purge", true);
            check(r, item.version);
            if (!r.deleted_at) fail(409, "文件已恢复，请刷新回收站后重试");
          }
          if (
            ctx.resources.some(
              (r) =>
                !selected.has(r.id) &&
                ((r.parent_id && selected.has(r.parent_id)) ||
                  (r.library_id && selected.has(r.library_id))),
            )
          )
            fail(409, "包含未选中或无权清空的子文档，请先处理子文档");
          // Explicit IDs + versions are frozen in the confirmation dialog. Newly trashed
          // or restored resources cannot accidentally join this permanent deletion.
          return erasePurgedResources(ctx, actor, ids);
        },
      );
    },
    purgeDeleted(actor: Actor, id: string, version: number) {
      return run(actor, [id], [id], async (ctx) => {
        const root = get(ctx, id, "purge", true);
        check(root, version);
        if (!root.deleted_at) fail(409, "文件已恢复，请刷新回收站后重试");
        const tree = descendants(ctx, root);
        if (tree.some((item) => !item.deleted_at))
          fail(409, "包含仍在使用的子文档，不能永久删除");
        for (const item of tree) get(ctx, item.id, "purge", true);
        return erasePurgedResources(
          ctx,
          actor,
          tree.map((item) => item.id),
        );
      });
    },
    trash(actor: Actor, id: string, version: number, restore = false) {
      return run(actor, [id], [id], async (ctx) => {
        const r = get(ctx, id, restore ? "manage_structure" : "trash", true);
        check(r, version);
        if (restore) {
          if (!r.deleted_at) fail(409, "不在回收站");
          const parent = ctx.resources.find(
            (x) => x.id === (r.parent_id ?? r.library_id),
          );
          if (parent?.deleted_at) fail(409, "请先恢复上级目录或知识库");
          for (const x of descendants(ctx, r).filter(
            (x) => x.delete_batch === r.delete_batch,
          )) {
            if (permission(x, actor, ctx.resources, ctx.grants) < 4)
              fail(403, "需要管理整个恢复批次");
            await update(ctx, x, { deleted_at: null, delete_batch: null });
          }
        } else {
          if (r.deleted_at) fail(409, "已删除");
          const targets = descendants(ctx, r).filter((x) => !x.deleted_at);
          if (
            targets.some(
              (x) => !canRemoveResource(x, actor, ctx.resources, ctx.grants),
            )
          )
            fail(
              403,
              "需要拥有文档或管理其所属知识库，请先处理无权删除的子文档",
            );
          const batch = randomUUID();
          for (const x of targets)
            await update(ctx, x, {
              deleted_at: new Date().toISOString(),
              delete_batch: batch,
            });
          await ctx.tx
            .updateTable("file_items")
            .set((eb) => ({
              deleted_at: new Date().toISOString(),
              delete_batch: batch,
              version: eb("version", "+", 1),
            }))
            .where("parent_type", "=", "document")
            .where(
              "parent_id",
              "in",
              targets.map((x) => x.id),
            )
            .where("deleted_at", "is", null)
            .execute();
        }
        if (restore) {
          await ctx.tx
            .updateTable("file_items")
            .set((eb) => ({
              deleted_at: null,
              delete_batch: null,
              version: eb("version", "+", 1),
            }))
            .where("parent_type", "=", "document")
            .where(
              "parent_id",
              "in",
              descendants(ctx, r).map((x) => x.id),
            )
            .where("delete_batch", "=", r.delete_batch)
            .execute();
        }
        await event(ctx, r, restore ? "resource.restored" : "resource.trashed");
        return { ok: true };
      });
    },
    copy(
      actor: Actor,
      id: string,
      input: {
        parentId?: string | null;
        libraryId?: string | null;
        includeChildren?: boolean;
      } = {},
    ) {
      return run(
        actor,
        [id, input.parentId, input.libraryId],
        [id],
        async (ctx) => {
          const currentOnly = input.includeChildren === false,
            r = get(ctx, id, currentOnly ? "manage_structure" : "read_content");
          if (currentOnly && r.kind !== "document")
            fail(400, "仅支持复制当前文档");
          let destinationParent: string | null = null,
            destinationLibrary: string | null = null;
          if (currentOnly) {
            destinationParent = input.parentId ?? null;
            destinationLibrary = input.libraryId ?? null;
            if (destinationParent) {
              const parent = get(ctx, destinationParent, "manage_structure");
              if (parent.kind !== "document") fail(400, "目标目录必须是文档");
              if (parent.library_id === null) fail(400, "个人文档不支持子文档");
              if (
                destinationLibrary !== null &&
                destinationLibrary !== parent.library_id
              )
                fail(400, "目标目录与知识库不一致");
              destinationLibrary = parent.library_id;
            } else if (destinationLibrary) {
              if (
                get(ctx, destinationLibrary, "manage_structure").kind !==
                "library"
              )
                fail(400, "目标知识库无效");
            }
          }
          const targets = (currentOnly ? [r] : descendants(ctx, r)).filter(
            (x) => !x.deleted_at,
          );
          if (
            targets.some(
              (x) => permission(x, actor, ctx.resources, ctx.grants) < 1,
            )
          )
            fail(403, "部分子文档无权复制");
          await requireCapability(ctx.tx, actor.id, "documents.copy");
          const mapping = new Map(targets.map((x) => [x.id, randomUUID()]));
          const pending = [...targets];
          while (pending.length) {
            const i = pending.findIndex(
              (x) =>
                ![x.parent_id, x.library_id].some(
                  (p) => p && pending.some((t) => t.id === p),
                ),
            );
            if (i < 0) fail(409, "目录损坏");
            const x = pending.splice(i, 1)[0]!;
            await checkCreation(ctx.tx, actor.id, x.kind, x.format);
            const now = new Date().toISOString();
            const copiedParentId = currentOnly
              ? destinationParent
              : (mapping.get(x.parent_id ?? "") ?? null);
            const copiedLibraryId = currentOnly
              ? destinationLibrary
              : (mapping.get(x.library_id ?? "") ?? null);
            const copiedAccessMode =
              currentOnly && destinationLibrary
                ? ("inherit" as const)
                : ("custom" as const);
            await ctx.tx
              .insertInto("resources")
              .values({
                ...x,
                content_bytes: 0,
                cover_asset_id: null,
                id: mapping.get(x.id)!,
                tree_order: currentOnly
                  ? await nextTreeOrder(
                      ctx,
                      destinationParent,
                      destinationLibrary,
                    )
                  : (await nextTreeOrder(ctx, null, null)) + targets.indexOf(x),
                owner_id: actor.id,
                last_editor_id: actor.id,
                last_edited_at: now,
                title:
                  x.id === id
                    ? clean(`${x.title.slice(0, 150)} 副本`)
                    : x.title,
                parent_id: copiedParentId,
                library_id: copiedLibraryId,
                access_mode: copiedAccessMode,
                visibility: "invited",
                requests_enabled: Number(x.kind === "document"),
                ...(x.kind === "document"
                  ? {
                      share_links_enabled: 1,
                      discoverable: 0,
                      history_readers: 0,
                    }
                  : {}),
                version: 1,
                deleted_at: null,
                delete_batch: null,
                created_at: now,
                updated_at: now,
              })
              .execute();
            // Uploaded objects are immutable. Copies get independent asset IDs and
            // authorization links while safely reusing the stored bytes.
            const assets = await ctx.tx
              .selectFrom("assets")
              .selectAll()
              .where("resource_id", "=", x.id)
              .where("deleted_at", "is", null)
              .execute();
            const assetMapping = new Map<string, string>();
            for (const asset of assets) {
              if (asset.purpose === "cover" && asset.id !== x.cover_asset_id)
                continue;
              const assetId = randomUUID();
              assetMapping.set(asset.id, assetId);
              await checkStorage(ctx.tx, actor.id, Number(asset.size));
              await ctx.tx
                .insertInto("assets")
                .values({
                  ...asset,
                  id: assetId,
                  owner_id: actor.id,
                  resource_id: mapping.get(x.id)!,
                  created_at: now,
                })
                .execute();
              if (asset.id === x.cover_asset_id)
                await ctx.tx
                  .updateTable("resources")
                  .set({ cover_asset_id: assetId })
                  .where("id", "=", mapping.get(x.id)!)
                  .execute();
            }
            if (["spreadsheet", "canvas", "presentation"].includes(x.format)) {
              const target = await ctx.tx
                .selectFrom("resources")
                .selectAll()
                .where("id", "=", mapping.get(x.id)!)
                .executeTakeFirstOrThrow();
              await copySurface(ctx.tx, x, target, assetMapping);
              continue;
            }
            if (x.format === "markdown") {
              const original = await restoreMarkdown(ctx.tx, x.id);
              try {
                let text = original.doc.getText("markdown").toString();
                for (const [before, after] of assetMapping)
                  text = text.split(`](${before})`).join(`](${after})`);
                if (x.id === id)
                  text = `# ${x.title.slice(0, 150)} 副本\n${text.split("\n").slice(1).join("\n")}`;
                await storeNewMarkdown(ctx.tx, mapping.get(x.id)!, text, now);
              } finally {
                original.destroy();
              }
              continue;
            }
            const original = await restoreDocument(ctx.tx, x.id);
            try {
              if (original.state) {
                // A copy is a new document identity; comments and undo history are not copied.
                const value = original.runtime.getValue();
                const rewrite = (node: any): void => {
                  if (!node || typeof node !== "object") return;
                  if (
                    typeof node.path === "string" &&
                    assetMapping.has(node.path)
                  )
                    node.path = assetMapping.get(node.path);
                  Object.values(node).forEach((v) => {
                    if (v && typeof v === "object") rewrite(v);
                  });
                };
                rewrite(value);
                const copyDoc = new Doc();
                const runtime = new YjsDocument(copyDoc);
                try {
                  runtime.initialize(value);
                  await checkDocumentSize(
                    ctx.tx,
                    mapping.get(x.id)!,
                    Buffer.byteLength(JSON.stringify(value)),
                  );
                  if (x.id === id)
                    setDocumentTitle(
                      runtime,
                      clean(`${x.title.slice(0, 150)} 副本`),
                    );
                  await ctx.tx
                    .insertInto("document_states")
                    .values({
                      resource_id: mapping.get(x.id)!,
                      codec: DOCUMENT_CODECS.rich_text,
                      checkpoint: b64(encodeStateAsUpdate(copyDoc)),
                      seq: 0,
                      checkpoint_seq: 0,
                      text: plainText(runtime.getValue()),
                      updated_at: now,
                    })
                    .execute();
                } finally {
                  runtime.destroy();
                  copyDoc.destroy();
                }
              }
            } finally {
              original.destroy();
            }
          }
          const newId = mapping.get(id)!;
          await event(
            ctx,
            { ...r, id: newId, owner_id: actor.id },
            "resource.copied",
          );
          return { id: newId };
        },
      );
    },
  };
}
