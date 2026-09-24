import { checkDocumentSize } from "../../entitlements/service.js";
import type { Transaction } from "kysely";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { DB, Resource, Schema } from "../../../../../db/src/index.js";
import { fail } from "../../../shared/errors.js";
import { enqueueProjection } from "../../automation/jobs.js";
import { enqueueKnowledge } from "../../knowledge/service.js";
import { b64, unb64 } from "../../collaboration/documents.js";
import { recordVersion } from "../../history/repository.js";
import type { Actor } from "../../identity/passwords.js";
import { recordActivity } from "../../interactions/activity.js";
import { detachUnreferencedDocumentFiles, textMediaIds } from "../media.js";
import { indexDocumentReferences } from "../references.js";

// Headless codec boundary. Contract tests compare these with the SDK's public capabilities.
export const MARKDOWN_CODEC = {
  codec: "markdown-ytext",
  schemaVersion: 1,
  protocolVersion: 1,
  textRoot: "markdown",
} as const;
export function markdownReferenceNodes(content: string) {
  const root = fromMarkdown(content);
  const definitions = new Map<string, string>();
  const walk = (node: any, visit: (node: any) => void) => {
    visit(node);
    node.children?.forEach((child: any) => walk(child, visit));
  };
  walk(root, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  const links: { type: string; url: string; children: { text: string }[] }[] =
    [];
  walk(root, (node) => {
    const url =
      node.type === "link"
        ? node.url
        : node.type === "linkReference"
          ? definitions.get(node.identifier)
          : undefined;
    if (typeof url === "string" && /^#\/r\/[a-f0-9-]{36}(?:\?|$)/i.test(url))
      links.push({ type: "link", url, children: [{ text: "" }] });
  });
  return links;
}
export async function markdownSelection(
  tx: DB,
  id: string,
  selection: Record<string, unknown> | undefined,
) {
  if (selection?.kind !== "markdown") fail(400, "Markdown 选区格式无效");
  const loaded = await restoreMarkdown(tx, id);
  try {
    for (const value of [selection.anchor, selection.focus]) {
      const position = Y.decodeRelativePosition(unb64(value, 512));
      if (position.tname && position.tname !== "markdown")
        fail(400, "Markdown 选区数据根无效");
      // Relative points inside text address CRDT items, not a root name. Resolve
      // against the document rather than rejecting all item-based positions.
      const point = Y.createAbsolutePositionFromRelativePosition(
        position,
        loaded.doc,
      );
      if (!point) return null; // A point ahead of the durable update is transient.
      if (point.type !== loaded.doc.getText("markdown"))
        fail(400, "Markdown 选区数据根无效");
    }
    return {
      kind: "markdown",
      anchor: selection.anchor,
      focus: selection.focus,
    };
  } finally {
    loaded.destroy();
  }
}
export function newMarkdown(text = "") {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap("exmd:meta").set("codec", MARKDOWN_CODEC.codec);
    doc.getMap("exmd:meta").set("schemaVersion", 1);
    if (text) doc.getText("markdown").insert(0, text);
  });
  return doc;
}
export function validateMarkdown(doc: Y.Doc) {
  const meta = doc.getMap("exmd:meta"),
    text = doc.getText("markdown");
  if (
    meta.get("codec") !== MARKDOWN_CODEC.codec ||
    meta.get("schemaVersion") !== 1 ||
    meta.size !== 2
  )
    fail(409, "Markdown 编码或版本不匹配");
  if (
    [...doc.share.keys()].some(
      (key) => !["markdown", "exmd:meta"].includes(key),
    )
  )
    fail(400, "非法 Markdown 数据根");
  if (
    text
      .toDelta()
      .some(
        (part: { insert?: unknown; attributes?: unknown }) =>
          typeof part.insert !== "string" || part.attributes,
      )
  )
    fail(400, "Markdown 仅支持纯文本数据");
  if (doc.store.pendingStructs || doc.store.pendingDs)
    fail(409, "更新缺少依赖，请重新同步");
  if (Y.encodeStateAsUpdate(doc).length > 16 * 1024 * 1024)
    fail(413, "Markdown 超出容量上限");
}
export async function restoreMarkdown(
  tx: DB | Transaction<Schema>,
  id: string,
) {
  const state = await tx
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  const epoch = await tx
    .selectFrom("markdown_epochs")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  const doc = new Y.Doc();
  try {
    if (state) {
      if (state.codec !== MARKDOWN_CODEC.codec || !epoch)
        fail(409, "Markdown 基线不完整");
      Y.applyUpdate(doc, unb64(state.checkpoint, 16 * 1024 * 1024));
      for (const row of await tx
        .selectFrom("document_updates")
        .selectAll()
        .where("resource_id", "=", id)
        .where("seq", ">", state.checkpoint_seq)
        .orderBy("seq")
        .execute())
        Y.applyUpdate(doc, unb64(row.data));
      validateMarkdown(doc);
    } else if (epoch) fail(409, "Markdown 基线不完整");
    return {
      doc,
      state,
      epochId: epoch?.epoch_id,
      destroy: () => doc.destroy(),
    };
  } catch (e) {
    doc.destroy();
    throw e;
  }
}
export function markdownTitle(text: string) {
  return (
    text
      .split(/\r?\n/, 1)[0]!
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim() || "未命名"
  ).slice(0, 160);
}
export async function storeNewMarkdown(
  tx: Transaction<Schema>,
  id: string,
  text: string,
  now: string,
  enforceAdmission = true,
) {
  const doc = newMarkdown(text);
  try {
    if (enforceAdmission)
      await checkDocumentSize(tx, id, Buffer.byteLength(text));
    else
      await tx
        .updateTable("resources")
        .set({ content_bytes: Buffer.byteLength(text) })
        .where("id", "=", id)
        .execute();
    await tx
      .insertInto("markdown_epochs")
      .values({ resource_id: id, epoch_id: randomUUID() })
      .execute();
    await tx
      .insertInto("document_states")
      .values({
        resource_id: id,
        codec: MARKDOWN_CODEC.codec,
        checkpoint: b64(Y.encodeStateAsUpdate(doc)),
        checkpoint_seq: 0,
        seq: 0,
        text,
        updated_at: now,
      })
      .execute();
    await indexDocumentReferences(tx, id, markdownReferenceNodes(text), 0);
  } finally {
    doc.destroy();
  }
}
export async function exchangeMarkdown(
  tx: Transaction<Schema>,
  actor: Actor | null,
  resource: Resource,
  rank: number,
  input: {
    vector?: string;
    update?: string;
    epochId?: string;
    codec?: string;
    schemaVersion?: number;
    protocolVersion?: number;
    messageId?: string;
    restoreVersion?: string;
    expectedSeq?: number;
  },
) {
  const id = resource.id,
    now = new Date().toISOString();
  if (
    !input.restoreVersion &&
    (input.codec !== MARKDOWN_CODEC.codec ||
      input.schemaVersion !== 1 ||
      input.protocolVersion !== 1)
  )
    fail(409, "Markdown 协同协议不匹配，请更新客户端");
  let loaded = await restoreMarkdown(tx, id);
  if (!loaded.state) {
    loaded.destroy();
    if (input.update !== undefined || input.epochId)
      fail(409, "Markdown 文档尚未初始化");
    await storeNewMarkdown(
      tx,
      id,
      resource.title === "未命名" ? "" : `# ${resource.title}\n`,
      now,
      false,
    );
    loaded = await restoreMarkdown(tx, id);
  }
  const { doc, state, epochId } = loaded;
  try {
    if (
      (input.epochId && input.epochId !== epochId) ||
      (input.update !== undefined && input.epochId !== epochId)
    )
      fail(409, "Markdown 版本已切换，未同步内容保留在本地，请导出恢复副本");
    let seq = state!.seq,
      checkpointSeq = state!.checkpoint_seq,
      changed = false,
      update = input.update;
    const text = doc.getText("markdown"),
      before = b64(Y.encodeStateAsUpdate(doc));
    if (input.restoreVersion) {
      if (!actor || rank < 4) fail(403, "需要管理权限才能回滚文档");
      if (input.expectedSeq !== seq) fail(409, "文档已变化，请重新预览后回滚");
      const row = await tx
        .selectFrom("document_versions")
        .selectAll()
        .where("resource_id", "=", id)
        .where("id", "=", input.restoreVersion)
        .executeTakeFirst();
      if (!row) fail(404, "历史版本不存在");
      const previous = new Y.Doc(),
        candidate = new Y.Doc();
      try {
        Y.applyUpdate(previous, unb64(row.checkpoint, 16 * 1024 * 1024));
        validateMarkdown(previous);
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
        // A rollback is a new transaction in the current epoch, never a replacement Y.Doc.
        const target = previous.getText("markdown").toString(),
          current = candidate.getText("markdown");
        if (current.toString() !== target)
          candidate.transact(() => {
            current.delete(0, current.length);
            current.insert(0, target);
          });
        update = b64(
          Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(doc)),
        );
        await recordVersion(tx, {
          id: randomUUID(),
          resource_id: id,
          seq,
          checkpoint: before,
          title: resource.title,
          author_id: actor.id,
          created_at: now,
        });
      } finally {
        previous.destroy();
        candidate.destroy();
      }
    }
    if (update !== undefined) {
      if (!actor || rank < 3) fail(403, "当前文档为只读");
      if (
        !input.restoreVersion &&
        (!input.messageId || input.messageId.length > 80)
      )
        fail(400, "缺少协同消息 ID");
      const bytes = unb64(update),
        digest = createHash("sha256").update(bytes).digest("hex");
      const receipt = input.messageId
        ? await tx
            .selectFrom("markdown_receipts")
            .selectAll()
            .where("resource_id", "=", id)
            .where("epoch_id", "=", epochId!)
            .where("message_id", "=", input.messageId)
            .executeTakeFirst()
        : null;
      if (receipt && receipt.digest !== digest)
        fail(409, "同一消息 ID 不能提交不同内容");
      if (!receipt) {
        Y.applyUpdate(doc, bytes);
        validateMarkdown(doc);
        const encoded = Y.encodeStateAsUpdate(doc);
        changed = before !== b64(encoded);
        if (changed) {
          await checkDocumentSize(tx, id, Buffer.byteLength(text.toString()));
          await enqueueProjection(tx, "search", id, { resourceId: id });
          await enqueueKnowledge(tx, "document", id);
          seq++;
          const content = text.toString(),
            title = markdownTitle(content);
          await detachUnreferencedDocumentFiles(tx, id, textMediaIds(content));
          await tx
            .insertInto("document_updates")
            .values({
              resource_id: id,
              seq,
              data: update,
              author_id: actor.id,
              created_at: now,
            })
            .execute();
          const checkpoint =
            seq % 50 === 0 ||
            input.restoreVersion ||
            Date.now() - Date.parse(state!.updated_at) >= 300000;
          await tx
            .updateTable("document_states")
            .set({
              seq,
              text: content,
              ...(checkpoint
                ? {
                    checkpoint: b64(encoded),
                    checkpoint_seq: seq,
                    updated_at: now,
                  }
                : {}),
            })
            .where("resource_id", "=", id)
            .execute();
          await tx
            .updateTable("resources")
            .set({
              title,
              version: resource.version + 1,
              updated_at: now,
              last_editor_id: actor.id,
              last_edited_at: now,
            })
            .where("id", "=", id)
            .execute();
          await recordActivity(tx, actor.id, id, "edit");
          // Derive only stable local document links; the read API applies target ACL.
          await indexDocumentReferences(
            tx,
            id,
            markdownReferenceNodes(content),
            seq,
          );
          if (checkpoint) {
            checkpointSeq = seq;
            await recordVersion(tx, {
              id: randomUUID(),
              resource_id: id,
              seq,
              checkpoint: b64(encoded),
              title,
              author_id: actor.id,
              created_at: now,
            });
            await tx
              .insertInto("audit_events")
              .values({
                id: randomUUID(),
                actor_id: actor.id,
                resource_id: id,
                action: input.restoreVersion
                  ? "document.version_restored"
                  : "document.updated",
                created_at: now,
              })
              .execute();
            await tx
              .deleteFrom("document_updates")
              .where("resource_id", "=", id)
              .where("seq", "<=", seq)
              .execute();
          }
        }
        if (input.messageId)
          await tx
            .insertInto("markdown_receipts")
            .values({
              resource_id: id,
              epoch_id: epochId!,
              message_id: input.messageId,
              digest,
              seq,
            })
            .execute();
      }
    }
    const lastEditor = resource.last_editor_id
      ? await tx
          .selectFrom("users")
          .select("display_name")
          .where("id", "=", resource.last_editor_id)
          .executeTakeFirst()
      : null;
    return {
      ...MARKDOWN_CODEC,
      epochId,
      seq,
      checkpointSeq,
      rank,
      changed,
      notificationsChanged: false,
      metadata: {
        title: changed ? markdownTitle(text.toString()) : resource.title,
        version: resource.version + Number(changed),
        updated_at: changed ? now : resource.updated_at,
        lastEditorName: changed
          ? actor!.display_name
          : (lastEditor?.display_name ?? null),
        lastEditedAt: changed ? now : (resource.last_edited_at ?? null),
      },
      vector: b64(Y.encodeStateVector(doc)),
      update: b64(
        Y.encodeStateAsUpdate(
          doc,
          input.vector === undefined ? undefined : unb64(input.vector, 65536),
        ),
      ),
    };
  } finally {
    loaded.destroy();
  }
}
