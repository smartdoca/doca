import {
  checkDocumentSize,
  requireCapability,
} from "../entitlements/service.js";
import type { Transaction } from "kysely";
import { readEditorDocument } from "slatetsx-kit-editor/headless";
import { Doc, encodeStateAsUpdate } from "slatetsx-kit-editor/yjs";
import type { Resource, Schema } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
import { b64, plainText } from "../collaboration/documents.js";
import type { Actor } from "../identity/passwords.js";
import {
  documentMentions,
  validateNewMentions,
} from "../interactions/community.js";
import { DocaYjsDocument } from "./codecs/rich-runtime.js";
import { provisionSurface } from "./codecs/surfaces.js";
import { indexDocumentReferences } from "./references.js";

// Imports establish a NEW resource/epoch, never overwrite an active replica.
// Asset remapping requires a portable bundle contract; reject rather than leak
// another resource's asset IDs or silently strip embedded media.
export function validateImport(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
  assets = new Set<string>(),
) {
  if (++budget.nodes > 100000 || depth > 40) fail(413, "导入内容结构过大");
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (
    node.tag === "Image" &&
    !assets.has(String((node.data as any)?.resourcePath ?? node.path ?? ""))
  )
    fail(400, "图片必须使用当前文档已上传的素材");
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      fail(400, "非法文件属性");
    if (
      ["path", "resourcePath", "assetId", "sourceUrl"].includes(key) &&
      child &&
      !assets.has(String(child))
    )
      fail(
        400,
        "此文件包含未打包的附件资源，暂不支持导入；请等待子包提供资源打包能力",
      );
    if (
      ["url", "href"].includes(key) &&
      typeof child === "string" &&
      !assets.has(child) &&
      !/^(https?:|mailto:|#|\/)/i.test(child)
    )
      fail(400, "文件包含不安全或临时链接");
    validateImport(child, depth + 1, budget, assets);
  }
}
export async function importInitialContent(
  tx: Transaction<Schema>,
  actor: Actor,
  resource: Resource,
  value: unknown,
) {
  await requireCapability(tx, actor.id, "documents.import");
  if (
    resource.kind !== "document" ||
    !["rich_text", "spreadsheet", "canvas", "presentation"].includes(
      resource.format,
    )
  )
    fail(400, "不支持的导入目标");
  if (Buffer.byteLength(JSON.stringify(value)) > 768 * 1024)
    fail(413, "转换后的文档不能超过 768 KB");
  const assets = await tx
    .selectFrom("assets")
    .select("id")
    .where("resource_id", "=", resource.id)
    .where("owner_id", "=", actor.id)
    .where("deleted_at", "is", null)
    .execute();
  validateImport(value, 0, { nodes: 0 }, new Set(assets.map((a) => a.id)));
  if (resource.format === "rich_text") {
    let document;
    try {
      document = readEditorDocument(
        value as Parameters<typeof readEditorDocument>[0],
      );
    } catch {
      fail(400, "不是受支持的 Doca 文档 JSON 文件");
    }
    const doc = new Doc(),
      runtime = new DocaYjsDocument(doc);
    try {
      runtime.initialize(document.children);
      await checkDocumentSize(
        tx,
        resource.id,
        Buffer.byteLength(JSON.stringify(runtime.getValue())),
      );
      await validateNewMentions(
        tx,
        actor,
        new Set(documentMentions(runtime.getValue()).keys()),
        new Set(),
      );
      const title =
        plainText(runtime.getValue()[0]).trim().slice(0, 200) || "未命名";
      await tx
        .updateTable("resources")
        .set({ title })
        .where("id", "=", resource.id)
        .execute();
      resource.title = title;
      await tx
        .insertInto("document_states")
        .values({
          resource_id: resource.id,
          codec: "slate-kit",
          checkpoint: b64(encodeStateAsUpdate(doc)),
          seq: 0,
          checkpoint_seq: 0,
          text: plainText(runtime.getValue()),
          updated_at: resource.updated_at,
        })
        .execute();
      await indexDocumentReferences(tx, resource.id, runtime.getValue());
    } finally {
      runtime.destroy();
      doc.destroy();
    }
  } else {
    const input = value as any;
    if (
      resource.format === "canvas" &&
      (input?.version !== 1 ||
        !input.scene ||
        !Array.isArray(input.scene.children))
    )
      fail(400, "不是受支持的画板 JSON 文件");
    if (
      resource.format === "spreadsheet" &&
      (!input?.sheets ||
        !Array.isArray(input.sheetOrder) ||
        !input.sheetOrder.length)
    )
      fail(400, "不是有效的 Excel 工作簿");
    await provisionSurface(tx, resource, input);
  }
}
