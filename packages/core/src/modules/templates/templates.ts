import { checkDocumentSize } from "../entitlements/service.js";
import { validateDocument } from "@eppt/editor/core";
import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import { TEMPLATE_FORMATS, type TemplateFormat } from "./content.js";
export {
  TEMPLATE_FORMATS,
  blankTemplateContent,
  templatePreviewLines,
  type TemplateFormat,
} from "./content.js";
import { Doc, encodeStateAsUpdate } from "slatetsx-kit-editor/yjs";
import type { DB, Resource, Schema } from "../../../../db/src/index.js";
import { AppError, fail } from "../../shared/errors.js";
import { b64, plainText } from "../collaboration/documents.js";
import { storeNewMarkdown } from "../documents/codecs/markdown.js";
import { DocaYjsDocument } from "../documents/codecs/rich-runtime.js";
import { provisionSurface } from "../documents/codecs/surfaces.js";
import { indexDocumentReferences } from "../documents/references.js";
import type { Actor } from "../identity/passwords.js";

const PREVIEW_LIMIT = 180_000;

function requireAdmin(actor: Actor) {
  if (!actor.admin) fail(403, "需要系统管理员权限");
}

function cleanTitle(title: unknown) {
  if (typeof title !== "string") fail(400, "模板名称无效");
  const value = title.trim();
  if (!value || value.length > 160) fail(400, "模板名称无效");
  return value;
}

function checkPreview(preview: unknown) {
  if (preview === undefined || preview === null || preview === "") return "";
  if (
    typeof preview !== "string" ||
    preview.length > PREVIEW_LIMIT ||
    !/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(preview)
  )
    fail(400, "模板预览图无效");
  return preview;
}

function rejectUnsafe(value: unknown, depth = 0, budget = { n: 0 }) {
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
      /^[a-f0-9-]{36}$/.test(child)
    )
      fail(400, "模板不能包含已上传的素材");
    if (
      ["url", "href", "src", "sourceUrl"].includes(key) &&
      typeof child === "string" &&
      child &&
      !/^(https?:|mailto:|#|\/)/i.test(child)
    )
      fail(400, "模板包含不安全的链接");
    rejectUnsafe(child, depth + 1, budget);
  }
}

export async function assertTemplateContent(format: string, content: unknown) {
  if (!TEMPLATE_FORMATS.includes(format as TemplateFormat))
    fail(400, "不支持的模板类型");
  if (Buffer.byteLength(JSON.stringify(content ?? null)) > 768 * 1024)
    fail(413, "模板内容不能超过 768 KB");
  if (format === "markdown") {
    if (typeof content !== "string") fail(400, "Markdown 模板必须是文本");
    if (/]\([a-f0-9-]{36}\)/i.test(content) || /^(javascript:|data:|blob:)/im.test(content))
      fail(400, "模板不能包含已上传的素材或不安全链接");
    if (Buffer.byteLength(content) > 512 * 1024)
      fail(413, "Markdown 模板不能超过 512 KB");
    return;
  }
  rejectUnsafe(content);
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
) {
  await assertTemplateContent(resource.format, content);
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

function present(row: {
  id: string;
  format: string;
  title: string;
  preview: string;
  updated_at: string;
  created_at: string;
}) {
  return {
    id: row.id,
    format: row.format as TemplateFormat,
    title: row.title,
    preview: row.preview,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createTemplates(db: DB) {
  return {
    async list(format?: string) {
      if (format && !TEMPLATE_FORMATS.includes(format as TemplateFormat))
        fail(400, "不支持的模板类型");
      let query = db
        .selectFrom("document_templates")
        .select(["id", "format", "title", "preview", "created_at", "updated_at"])
        .orderBy("updated_at", "desc");
      if (format) query = query.where("format", "=", format as TemplateFormat);
      return { items: (await query.execute()).map(present) };
    },
    async get(id: string) {
      const row = await db
        .selectFrom("document_templates")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) fail(404, "模板不存在");
      let content: unknown;
      try {
        content = JSON.parse(row.content);
      } catch {
        fail(409, "模板内容损坏");
      }
      return { ...present(row), content };
    },
    async create(
      actor: Actor,
      input: {
        format: string;
        title: string;
        content: unknown;
        preview?: string;
      },
    ) {
      requireAdmin(actor);
      if (!TEMPLATE_FORMATS.includes(input.format as TemplateFormat))
        fail(400, "不支持的模板类型");
      await assertTemplateContent(input.format, input.content);
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(),
        format: input.format as TemplateFormat,
        title: cleanTitle(input.title),
        content: JSON.stringify(input.content),
        preview: checkPreview(input.preview),
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      await db.insertInto("document_templates").values(row).execute();
      return present(row);
    },
    async update(
      actor: Actor,
      id: string,
      input: { title?: string; content?: unknown; preview?: string },
    ) {
      requireAdmin(actor);
      const row = await db
        .selectFrom("document_templates")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) fail(404, "模板不存在");
      if (input.content !== undefined)
        await assertTemplateContent(row.format, input.content);
      const next = {
        title: input.title !== undefined ? cleanTitle(input.title) : row.title,
        content:
          input.content !== undefined ? JSON.stringify(input.content) : row.content,
        preview:
          input.preview !== undefined ? checkPreview(input.preview) : row.preview,
        updated_at: new Date().toISOString(),
      };
      await db
        .updateTable("document_templates")
        .set(next)
        .where("id", "=", id)
        .execute();
      return present({ ...row, ...next });
    },
    async remove(actor: Actor, id: string) {
      requireAdmin(actor);
      const row = await db
        .deleteFrom("document_templates")
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst();
      if (!row) fail(404, "模板不存在");
      return { ok: true };
    },
  };
}
