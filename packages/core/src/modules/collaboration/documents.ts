import { checkDocumentSize } from "../access/operation-policy.js";
import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import {
  Doc,
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
} from "@smartdoca/slate/yjs";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { authorize } from "../access/queries.js";
import { enqueueProjection } from "../automation/jobs.js";
import { enqueueKnowledge } from "../knowledge/service.js";
import { exchangeMarkdown } from "../documents/codecs/markdown.js";
import { DocaYjsDocument as YjsDocument } from "../documents/codecs/rich-runtime.js";
import { exchangeSurface } from "../documents/codecs/surfaces.js";
import {
  detachUnreferencedDocumentFiles,
  documentMediaIds,
} from "../documents/media.js";
import { indexDocumentReferences } from "../documents/references.js";
import { recordVersion } from "../history/repository.js";
import { readHistorySnapshot } from "../history/archive.js";
import type { Actor } from "../identity/passwords.js";
import {
  documentMentions,
  mentionIds,
  notify,
  validateNewMentions,
} from "../interactions/community.js";
import {
  checkProtocol,
  checkReceipt,
  editorEpoch,
  saveReceipt,
} from "./protocol.js";

export const DOCUMENT_CODECS = {
  rich_text: "slate-kit",
  spreadsheet: "exlsx-cell-registers",
  canvas: "aidcanvas-yjs",
  markdown: "markdown-ytext",
  presentation: null,
} as const;
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export function setDocumentTitle(runtime: YjsDocument, title: string) {
  const first = runtime.getValue()[0];
  if (
    first &&
    "type" in first &&
    first.type === "paragraph"
  )
    runtime.editText(
      first.id,
      0,
      runtime.doc.getText(`slate-kit:text:${first.id}`).length,
      title,
    );
  else
    runtime.execute({
      type: "insertBlock",
      block: {
        id: randomUUID(),
        type: "paragraph",
        title: "h1",
        children: [{ text: title }],
      },
    });
}
export function unb64(value: unknown, max = 1024 * 1024) {
  if (
    typeof value !== "string" ||
    value.length > max * 1.4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail(400, "协同数据格式无效");
  const result = Buffer.from(value, "base64");
  if (result.length > max) fail(413, "协同数据过大");
  return result;
}
export function plainText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(plainText).join("\n");
  const n = value as Record<string, unknown>;
  if (typeof n.text === "string")
    return n._mention && typeof n._mention === "object"
      ? String((n._mention as { name?: string }).name ?? "")
      : n.text;
  if (n.type === "mention") return String(n.name ?? "");
  if (n.type === "flowchart" && Array.isArray(n.nodes))
    return n.nodes.map((node: any) => String(node.label ?? "")).join("\n");
  if (typeof n.type === "string" && n.type.startsWith("custom:"))
    return String(n.label ?? "");
  return [
    n.code,
    n.source,
    ...(Array.isArray(n.children) ? n.children.map(plainText) : []),
  ]
    .filter((x) => typeof x === "string")
    .join("");
}
// Bound work before the SDK projects an untrusted CRDT command graph.
function validateRaw(value: unknown, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 100000 || depth > 40) fail(413, "文档结构过大");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      fail(400, "非法文档属性");
    if (
      ["url", "href"].includes(key) &&
      typeof child === "string" &&
      !/^(https?:|mailto:|#|\/)/i.test(child)
    )
      fail(400, "不支持的链接协议");
    if (
      key === "path" &&
      typeof child === "string" &&
      child !== "" && // SDK upload placeholder: no resource URL, preview stays local.
      !/^[a-f0-9-]{36}$/.test(child)
    )
      fail(400, "文件必须通过本系统上传");
    validateRaw(child, depth + 1, budget);
  }
}
export async function restoreDocument(
  tx: DB | Transaction<Schema>,
  id: string,
) {
  const state = await tx
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  const doc = new Doc();
  const runtime = new YjsDocument(doc);
  try {
    if (state) {
      if (state.codec !== DOCUMENT_CODECS.rich_text)
        fail(409, "此文档编码与当前编辑器不匹配，请新建文档。");
      applyUpdate(doc, unb64(state.checkpoint, 16 * 1024 * 1024));
      for (const update of await tx
        .selectFrom("document_updates")
        .selectAll()
        .where("resource_id", "=", id)
        .where("seq", ">", state.checkpoint_seq)
        .orderBy("seq")
        .execute())
        applyUpdate(doc, unb64(update.data));
    }
    return {
      doc,
      runtime,
      state,
      destroy: () => {
        runtime.destroy();
        doc.destroy();
      },
    };
  } catch (e) {
    runtime.destroy();
    doc.destroy();
    throw e;
  }
}
export async function documentAccess(
  tx: DB | Transaction<Schema>,
  actor: Actor | null,
  id: string,
  rank = 1,
) {
  const { resource, rank: level } = await authorize(tx, actor, id, rank);
  if (resource.kind !== "document") fail(404, "文档不存在或无权访问");
  return { resource, rank: level };
}
export function createDocuments(db: DB) {
  return {
    async exchange(
      actor: Actor | null,
      id: string,
      input: {
        vector?: string;
        update?: string;
        restoreVersion?: string;
        expectedSeq?: number;
        epochId?: string;
        codec?: string;
        schemaVersion?: number;
        protocolVersion?: number;
        messageId?: string;
      },
    ) {
      return transact(db, async (tx) => {
        const { resource, rank } = await documentAccess(tx, actor, id);
        if (resource.format === "markdown")
          return exchangeMarkdown(tx, actor, resource, rank, input);
        if (["spreadsheet", "canvas", "presentation"].includes(resource.format))
          return exchangeSurface(tx, actor, resource, rank, input);
        if (resource.format !== "rich_text")
          fail(409, "该文档类型的编辑器尚未接入");
        const loaded = await restoreDocument(tx, id);
        const { doc, runtime } = loaded;
        try {
          const epoch = await editorEpoch(tx, id);
          checkProtocol(input, "slate-kit", 3, epoch.epoch_id);
          if (input.update !== undefined && (!actor || rank < 3))
            fail(403, "当前文档为只读");
          const receipt = await checkReceipt(tx, id, epoch.epoch_id, input);
          const now = new Date().toISOString();
          if (!loaded.state) {
            runtime.initialize([
              {
                id: randomUUID(),
                type: "paragraph",
                title: "h1",
                children: [
                  { text: resource.title === "未命名" ? "" : resource.title },
                ],
              },
              { id: randomUUID(), type: "paragraph", children: [{ text: "" }] },
            ]);
            await tx
              .insertInto("document_states")
              .values({
                resource_id: id,
                codec: DOCUMENT_CODECS.rich_text,
                checkpoint: b64(encodeStateAsUpdate(doc)),
                checkpoint_seq: 0,
                seq: 0,
                text: resource.title,
                updated_at: now,
              })
              .execute();
          }
          let seq = loaded.state?.seq ?? 0;
          let checkpointSeq = loaded.state?.checkpoint_seq ?? 0;
          let changed = false;
          let notificationsChanged = false;
          if (input.restoreVersion) {
            if (!actor || rank < 4) fail(403, "需要管理权限才能回滚文档");
            if (seq !== input.expectedSeq)
              fail(409, "文档在预览后已变化，请重新查看历史版本再回滚");
            const snapshot = await readHistorySnapshot(tx, id, input.restoreVersion);
            if (!snapshot) fail(404, "历史版本不存在");
            const oldDoc = new Doc(),
              oldRuntime = new YjsDocument(oldDoc),
              nextDoc = new Doc(),
              nextRuntime = new YjsDocument(nextDoc);
            try {
              applyUpdate(oldDoc, unb64(snapshot.checkpoint, 16 * 1024 * 1024));
              applyUpdate(nextDoc, encodeStateAsUpdate(doc));
              nextRuntime.acceptEditorValue(
                nextRuntime.getValue(),
                oldRuntime.getValue(),
              );
              input = {
                ...input,
                update: b64(
                  encodeStateAsUpdate(nextDoc, encodeStateVector(doc)),
                ),
              };
              await recordVersion(tx, {
                id: randomUUID(),
                resource_id: id,
                seq,
                checkpoint: b64(encodeStateAsUpdate(doc)),
                title: resource.title,
                author_id: actor.id,
                created_at: now,
              });
            } finally {
              oldRuntime.destroy();
              oldDoc.destroy();
              nextRuntime.destroy();
              nextDoc.destroy();
            }
          }
          if (input.update !== undefined && !receipt?.old) {
            const before = b64(encodeStateAsUpdate(doc));
            const oldMentions = mentionIds(runtime.getValue());
            const previousMentions = documentMentions(runtime.getValue());
            const initial = JSON.stringify(
              doc.getMap("slate-kit:document").toJSON(),
            );
            applyUpdate(doc, unb64(input.update));
            if (doc.store.pendingStructs || doc.store.pendingDs)
              fail(409, "更新缺少依赖，请重新同步");
            if (
              initial !==
              JSON.stringify(doc.getMap("slate-kit:document").toJSON())
            )
              fail(400, "不能重新初始化已有文档");
            const raw = doc.toJSON();
            validateRaw(raw);
            const encoded = encodeStateAsUpdate(doc);
            if (encoded.length > 16 * 1024 * 1024)
              fail(413, "文档已达到当前协同容量上限");
            changed = before !== b64(encoded);
            if (changed) {
              await enqueueProjection(tx, "search", id, { resourceId: id });
              await enqueueKnowledge(tx, "document", id);
              if (!actor || rank < 3) fail(403, "当前文档为只读");
              const value = runtime.getValue();
              await indexDocumentReferences(tx, id, value);
              await detachUnreferencedDocumentFiles(
                tx,
                id,
                documentMediaIds(value),
              );
              validateRaw(value);
              await checkDocumentSize(
                tx,
                id,
                Buffer.byteLength(JSON.stringify(value)),
              );
              const mentions = mentionIds(value);
              await validateNewMentions(tx, actor, mentions, oldMentions);
              const text = plainText(value);
              const title = (plainText(value[0]).trim() || "未命名").slice(
                0,
                160,
              );
              seq++;
              const addedMentions = [...documentMentions(value)]
                .filter(([key, userId]) => previousMentions.get(key) !== userId)
                .map(([, userId]) => userId);
              notificationsChanged = addedMentions.length > 0;
              await notify(
                tx,
                actor,
                resource,
                "document.mentioned",
                addedMentions,
                undefined,
                `document:${id}:${seq}`,
              );
              await tx
                .insertInto("document_updates")
                .values({
                  resource_id: id,
                  seq,
                  data: input.update,
                  author_id: actor.id,
                  created_at: now,
                })
                .execute();
              const checkpoint =
                seq % 50 === 0 ||
                Date.now() - Date.parse(loaded.state?.updated_at ?? now) >
                  300000;
              if (checkpoint) checkpointSeq = seq;
              await tx
                .updateTable("document_states")
                .set({
                  seq,
                  text,
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
              if (checkpoint)
                await recordVersion(tx, {
                  id: randomUUID(),
                  resource_id: id,
                  seq,
                  checkpoint: b64(encoded),
                  title,
                  author_id: actor.id,
                  created_at: now,
                });
              if (checkpoint || input.restoreVersion)
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
              if (checkpoint)
                await tx
                  .deleteFrom("document_updates")
                  .where("resource_id", "=", id)
                  .where("seq", "<=", seq)
                  .execute();
              await tx
                .updateTable("resources")
                .set({
                  title,
                  updated_at: now,
                  version: resource.version + 1,
                  last_editor_id: actor.id,
                  last_edited_at: now,
                })
                .where("id", "=", id)
                .execute();
            }
          }
          const lastEditor =
            !changed && resource.last_editor_id
              ? await tx
                  .selectFrom("users")
                  .select("display_name")
                  .where("id", "=", resource.last_editor_id)
                  .executeTakeFirst()
              : null;
          await saveReceipt(tx, id, epoch.epoch_id, input, receipt, seq);
          return {
            codec: "slate-kit",
            schemaVersion: 3,
            protocolVersion: 1,
            epochId: epoch.epoch_id,
            checkpointSeq,
            seq,
            changed,
            notificationsChanged,
            rank,
            metadata: {
              title: changed
                ? (plainText(runtime.getValue()[0]).trim() || "未命名").slice(
                    0,
                    160,
                  )
                : resource.title,
              version: resource.version + Number(changed),
              updated_at: changed ? now : resource.updated_at,
              lastEditorName: changed
                ? actor!.display_name
                : (lastEditor?.display_name ?? null),
              lastEditedAt: changed ? now : (resource.last_edited_at ?? null),
            },
            vector: b64(encodeStateVector(doc)),
            update: b64(
              encodeStateAsUpdate(
                doc,
                input.vector === undefined
                  ? undefined
                  : unb64(input.vector, 65536),
              ),
            ),
          };
        } finally {
          loaded.destroy();
        }
      });
    },
  };
}
