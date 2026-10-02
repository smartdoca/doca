import { checkDocumentSize } from "../access/operation-policy.js";
import { validateDocument } from "@smartdoca/slides/core";
import type { Transaction } from "kysely";
import { TEMPLATE_FORMATS, type TemplateFormat } from "./content.js";
export {
  TEMPLATE_FORMATS,
  blankTemplateContent,
  type TemplateFormat,
} from "./content.js";
import { Doc, encodeStateAsUpdate } from "@smartdoca/slate/yjs";
import type { Resource, Schema } from "../../../../db/src/index.js";
import { AppError, fail } from "../../shared/errors.js";
import { b64, plainText } from "../collaboration/documents.js";
import { storeNewMarkdown } from "../documents/codecs/markdown.js";
import { DocaYjsDocument } from "../documents/codecs/rich-runtime.js";
import { provisionSurface } from "../documents/codecs/surfaces.js";
import { indexDocumentReferences } from "../documents/references.js";

function rejectUnsafe(value: unknown, depth = 0, budget = { n: 0 }, assets = new Set<string>()) {
  if (++budget.n > 100000 || depth > 40) fail(413, "模板内容过大");
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^(javascript:|data:|blob:)/i.test(value.trim()))
      fail(400, "模板包含不安全的链接");
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      fail(400, "非法模板内容");
    if (
      ["assetId", "path", "resourcePath"].includes(key) &&
      typeof child === "string" &&
      /^[a-f0-9-]{36}$/.test(child) && !assets.has(child)
    )
      fail(400, "模板不能包含已上传的素材");
    if (
      ["url", "href", "src", "sourceUrl"].includes(key) &&
      typeof child === "string" &&
      child &&
      !assets.has(child) &&
      !/^(https?:|mailto:|#|\/)/i.test(child)
    )
      fail(400, "模板包含不安全的链接");
    rejectUnsafe(child, depth + 1, budget, assets);
  }
}

export async function assertTemplateContent(format: string, content: unknown, assets = new Set<string>()) {
  if (!TEMPLATE_FORMATS.includes(format as TemplateFormat))
    fail(400, "不支持的模板类型");
  if (Buffer.byteLength(JSON.stringify(content ?? null)) > 768 * 1024)
    fail(413, "模板内容不能超过 768 KB");
  if (format === "markdown") {
    if (typeof content !== "string") fail(400, "Markdown 模板必须是文本");
    if ([...content.matchAll(/]\(([a-f0-9-]{36})\)/ig)].some(m => !assets.has(m[1]!)) || /^(javascript:|data:|blob:)/im.test(content))
      fail(400, "模板不能包含已上传的素材或不安全链接");
    if (Buffer.byteLength(content) > 512 * 1024)
      fail(413, "Markdown 模板不能超过 512 KB");
    return;
  }
  rejectUnsafe(content, 0, {n:0}, assets);
  if (format === "rich_text") {
    if (!Array.isArray(content) || !content.length) fail(400, "文档模板内容无效");
    const doc = new Doc();
    const runtime = new DocaYjsDocument(doc);
    try {
      runtime.initialize(content as never);
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(400, "文档模板内容无效");
    } finally {
      runtime.destroy();
      doc.destroy();
    }
    return;
  }
  if (format === "canvas") {
    const input = content as { version?: unknown; scene?: { children?: unknown } };
    if (input?.version !== 1 || !input.scene || !Array.isArray(input.scene.children))
      fail(400, "画板模板内容无效");
    return;
  }
  if (format === "spreadsheet") {
    const input = content as { sheets?: unknown; sheetOrder?: unknown[] };
    if (!input?.sheets || !Array.isArray(input.sheetOrder) || !input.sheetOrder.length)
      fail(400, "表格模板内容无效");
    return;
  }
  try {
    validateDocument(content as Parameters<typeof validateDocument>[0]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(400, "演示文稿模板内容无效");
  }
}

async function applyRichText(
  tx: Transaction<Schema>,
  resource: Resource,
  content: unknown[],
) {
  const doc = new Doc();
  const runtime = new DocaYjsDocument(doc);
  try {
    runtime.initialize(content as never);
    const value = runtime.getValue();
    await checkDocumentSize(
      tx,
      resource.id,
      Buffer.byteLength(JSON.stringify(value)),
    );
    await tx
      .insertInto("document_states")
      .values({
        resource_id: resource.id,
        codec: "slate-kit",
        checkpoint: b64(encodeStateAsUpdate(doc)),
        seq: 0,
        checkpoint_seq: 0,
        text: plainText(value),
        updated_at: resource.updated_at,
      })
      .execute();
    await indexDocumentReferences(tx, resource.id, value);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(400, "文档模板内容无效");
  } finally {
    runtime.destroy();
    doc.destroy();
  }
}

export async function applyTemplateContent(
  tx: Transaction<Schema>,
  resource: Resource,
  content: unknown,
  assets = new Set<string>(),
) {
  await assertTemplateContent(resource.format, content, assets);
  if (resource.format === "markdown") {
    await storeNewMarkdown(
      tx,
      resource.id,
      content as string,
      resource.updated_at,
    );
    return;
  }
  if (resource.format === "rich_text") {
    await applyRichText(tx, resource, content as unknown[]);
    return;
  }
  await provisionSurface(tx, resource, content);
}
