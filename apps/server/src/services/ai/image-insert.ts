import { randomUUID } from "node:crypto";
import { z } from "zod";
import sharp from "sharp";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "@core/shared/errors.js";
import {
  checkScope,
  readAIDocument,
  editAIDocument,
  digest,
  type ToolContext,
  type EditOperation,
} from "@core/workflows/ai-documents.js";
import { requireCapability } from "@core/modules/entitlements/service.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  createStorage,
  storageDefaults,
  storageRuntime,
  type StorageRuntime,
  type StorageConfig,
} from "../../adapters/storage.js";

function floatingImageSize(width?: number, height?: number) {
  const ratio = Math.max(0.05, (width ?? 1) / (height ?? 1));
  let w = Math.min(480, 320 * ratio, width ?? 480);
  let h = w / ratio;
  const min = 16 / Math.min(w, h);
  if (min > 1) {
    w *= min;
    h *= min;
  }
  const max = 4096 / Math.max(w, h);
  if (max < 1) {
    w *= max;
    h *= max;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

function readFloatingObjects(value: any) {
  const raw = value.resources?.find(
    (r: any) => r.name === "EXLSX_FLOATING_OBJECTS",
  )?.data;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function cellIndex(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0)
    return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value;
}

export const imageInsertSchema = z.preprocess((value) => {
  const nested =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "spreadsheet" in value &&
    value.spreadsheet &&
    typeof value.spreadsheet === "object"
      ? (value.spreadsheet as Record<string, unknown>)
      : undefined;
  const v =
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  const { spreadsheet: _ignored, ...rest } = v;
  return {
    ...rest,
    sheetId: v.sheetId === undefined ? (nested?.sheetId ?? null) : v.sheetId,
    row: cellIndex(v.row === undefined ? nested?.row : v.row),
    column: cellIndex(v.column === undefined ? nested?.column : v.column),
  };
}, z.object({
  assetId: z.string().uuid().describe("已生成图片的 assetId"),
  resourceId: z.string().uuid().describe("目标文档 ID"),
  sheetId: z
    .union([z.string().min(1), z.null()])
    .describe("表格传 document_read 的 sheetOrder[0]；非表格传 null"),
  row: z
    .union([z.number().int().min(0), z.null()])
    .describe("表格零基行号；非表格传 null"),
  column: z
    .union([z.number().int().min(0), z.null()])
    .describe("表格零基列号；非表格传 null"),
}));

export function spreadsheetImagePlacement(
  input: z.infer<typeof imageInsertSchema>,
) {
  if (!input.sheetId) return undefined;
  return {
    sheetId: input.sheetId,
    row: input.row ?? 0,
    column: input.column ?? 0,
  };
}

async function sourceImage(
  db: DB,
  ctx: ToolContext,
  id: string,
  includePending = false,
) {
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!asset || !asset.mime.startsWith("image/")) fail(404, "图片不存在");
  // Possession of an ID does not authorize copying a private image.
  const generated = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("user_id", "=", ctx.actor.id)
    .where("result", "like", `%${id}%`)
    .execute();
  if (
    !generated.some((r) => {
      const v = JSON.parse(r.result);
      return v.kind === "image_generation" && v.assetId === id;
    })
  )
    fail(403, "只能插入自己生成的图片");
  if (asset.resource_id) await checkScope(db, ctx, asset.resource_id);
  else if (asset.owner_id !== ctx.actor.id) fail(403, "无权读取图片");
  if (
    !includePending &&
    !["none", "pass"].includes(asset.moderation_status ?? "none")
  )
    fail(403, "图片审核中或已被封禁");
  return asset;
}
export async function generatedImageStatus(
  db: DB,
  ctx: ToolContext,
  id: string,
) {
  const asset = await sourceImage(db, ctx, id, true);
  return {
    ready: ["none", "pass"].includes(asset.moderation_status ?? "none"),
    pending: asset.moderation_status === "pending",
  };
}

export interface GeneratedImageInsertInput {
  readonly assetId: string;
  readonly resourceId: string;
  readonly sheetId?: string | null;
  readonly row?: number | null;
  readonly column?: number | null;
}

/** Creates a document-local reference to one physical image, then inserts it via the native Yjs workflow. */
export async function insertGeneratedImage(
  db: DB,
  ctx: ToolContext,
  input: GeneratedImageInsertInput,
  requestId: string,
  runtime: StorageRuntime = storageRuntime(),
) {
  const normalized = imageInsertSchema.parse(input);
  await requireCapability(db, ctx.actor.id, "ai.create");
  await requireCapability(db, ctx.actor.id, "assets.upload");
  const { resource } = await checkScope(
    db,
    ctx,
    normalized.resourceId,
    true,
  );
  if (
    !["markdown", "rich_text", "canvas", "presentation", "spreadsheet"].includes(
      resource.format,
    )
  )
    fail(400, "当前支持插入文档、Markdown、画板、演示文稿和表格");
  if (spreadsheetImagePlacement(normalized) && resource.format !== "spreadsheet")
    fail(400, "工作表位置仅适用于表格文档");
  const source = await sourceImage(db, ctx, normalized.assetId);
  const identity = digest(normalized);
  const previous = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", requestId)
    .executeTakeFirst();
  if (previous) {
    if (previous.user_id !== ctx.actor.id || previous.digest !== identity)
      fail(409, "插入请求标识冲突");
    return JSON.parse(previous.result);
  }
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", source.profile_id)
    .executeTakeFirstOrThrow();
  const config = {
    ...storageDefaults,
    ...JSON.parse(profile.config),
    provider: profile.provider,
  } as StorageConfig;
  const storage = createStorage(runtime);
  const bytes = await storage.read(config, source.object_key);
  const metadata = await sharp(bytes, {
    limitInputPixels: 25000000,
  }).metadata();
  const ratio = (metadata.width ?? 1) / (metadata.height ?? 1);
  const assetId = randomUUID();
  const result = await transact(db, async (tx) => {
    await lockAIUser(tx, ctx.actor.id);
    const { resource: target } = await checkScope(
      tx,
      ctx,
      normalized.resourceId,
      true,
    );
    await sourceImage(tx, ctx, normalized.assetId);
    const old = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (old) {
      if (old.user_id !== ctx.actor.id || old.digest !== identity)
        fail(409, "插入请求标识冲突");
      return JSON.parse(old.result);
    }
    const physical = await tx
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", source.id)
      .executeTakeFirstOrThrow();
    const createdAt = new Date().toISOString();
    const asset: Schema["assets"] = {
      ...source,
      id: assetId,
      owner_id: target.owner_id,
      uploaded_by: ctx.actor.id,
      purpose: "attachment",
      resource_id: target.id,
      object_key: physical.object_key,
      created_at: createdAt,
    };
    await tx.insertInto("assets").values(asset).execute();
    const fileItemId = randomUUID();
    await tx
      .insertInto("file_items")
      .values({
        id: fileItemId,
        owner_id: target.owner_id,
        parent_type: "document",
        parent_id: target.id,
        storage_object_id: physical.id,
        name: source.filename,
        mime: source.mime,
        size: source.size,
        metadata: JSON.stringify({ assetId, sourceAssetId: source.id }),
        ai_description_override: null,
        locked: 1,
        version: 1,
        created_at: createdAt,
        updated_at: createdAt,
        deleted_at: null,
        delete_batch: null,
      })
      .execute();
    await enqueueProjection(tx, "search-file", fileItemId, {
      fileId: fileItemId,
    });
    const read = await readAIDocument(tx, ctx, target.id),
      value = read.value as any;
    const elementId = randomUUID();
    let operations: EditOperation[];
    if (target.format === "markdown")
      operations = [
        { type: "append", text: `\n\n![AI 生成图片](${assetId})\n` },
      ];
    else if (target.format === "rich_text")
      operations = [
        {
          type: "insertBlock",
          afterId: value.at(-1)?.id,
          block: {
            id: elementId,
            type: "image",
            path: assetId,
            alt: "AI 生成图片",
            width: Math.min(640, metadata.width ?? 640),
            children: [{ text: "" }],
          },
        },
      ];
    else if (target.format === "canvas") {
      const bottom = Math.max(
        0,
        ...(value.scene?.children ?? []).map(
          (e: any) => Number(e.y ?? 0) + Number(e.height ?? 0),
        ),
      );
      operations = [
        {
          type: "add",
          element: {
            id: elementId,
            tag: "Image",
            name: "image",
            x: 40,
            y: bottom + 40,
            width: 400,
            height: 400 / ratio,
            lockRatio: true,
            data: {
              resourcePath: assetId,
              fileName: source.filename,
              naturalWidth: metadata.width,
              naturalHeight: metadata.height,
            },
          },
        },
      ];
    } else if (target.format === "spreadsheet") {
      const place = spreadsheetImagePlacement(normalized);
      const sheetId = place?.sheetId ?? value.sheetOrder.find(
        (id: string) => value.sheets[id] && !value.sheets[id].hidden,
      );
      const sheet = value.sheets[sheetId];
      if (!sheet || sheet.hidden) fail(400, "请选择有效且可见的工作表");
      const { width, height } = floatingImageSize(metadata.width, metadata.height);
      const rowHeight = sheet.defaultRowHeight ?? 24;
      const rowTop = (row: number) => row * rowHeight + Object.entries(sheet.rowData ?? {})
        .reduce((sum, [index, data]: [string, any]) =>
          Number(index) < row ? sum + (data.h ?? rowHeight) - rowHeight : sum, 0);
      let row = place?.row ?? 0;
      const column = place?.column ?? 0;
      if (!place) {
        const usedRows = Object.entries(sheet.cellData ?? {})
          .filter(([, cells]: [string, any]) => Object.keys(cells).length)
          .map(([index]) => Number(index));
        let bottom = usedRows.length ? rowTop(Math.max(...usedRows) + 1) + 16 : 0;
        const floating = readFloatingObjects(value);
        for (const view of floating) {
          if (view.anchor?.sheetId !== sheetId) continue;
          const geometry = view.object.geometry;
          bottom = Math.max(bottom, rowTop(view.anchor.startRow) + geometry.offsetY + geometry.height + 16);
        }
        while (row < sheet.rowCount && rowTop(row) < bottom) row++;
        if (rowTop(row) < bottom) row += Math.ceil((bottom - rowTop(row)) / rowHeight);
      }
      if (place && (row >= sheet.rowCount || column >= sheet.columnCount))
        fail(400, "图片插入位置超出工作表范围");
      operations = [];
      if (row >= sheet.rowCount)
        operations.push({ type: "structure", edit: {
          sheetId, axis: "row", action: "insert", index: sheet.rowCount,
          count: row - sheet.rowCount + Math.ceil(height / rowHeight) + 1,
        } });
      operations.push({
        type: "putFloatingObject",
        input: {
          id: elementId, kind: "image", assetId, name: source.filename,
          anchor: { sheetId, startRow: row, endRow: row, startColumn: column, endColumn: column },
          offsetX: 8, offsetY: 8, width, height,
        },
      });
    } else {
      // A dedicated last slide avoids covering existing work without guessing layout intent.
      await editAIDocument(
        tx,
        { ...ctx, notify: undefined },
        target.id,
        { seq: read.seq, epochId: read.epochId! },
        [{ type: "addSlide", after: value.slideOrder.at(-1) }],
        requestId + "-page",
      );
      const page = await readAIDocument(tx, ctx, target.id),
        ppt = page.value as any;
      const width = Math.min(
          ppt.size.width * 0.8,
          ppt.size.height * 0.8 * ratio,
        ),
        height = width / ratio;
      operations = [
        {
          type: "insert",
          slideId: ppt.slideOrder.at(-1),
          element: {
            id: elementId,
            type: "image",
            assetId,
            alt: "AI 生成图片",
            transform: {
              x: (ppt.size.width - width) / 2,
              y: (ppt.size.height - height) / 2,
              width,
              height,
              rotation: 0,
            },
          },
        },
      ];
      Object.assign(read, { seq: page.seq, epochId: page.epochId });
    }
    await editAIDocument(
      tx,
      { ...ctx, notify: undefined },
      target.id,
      { seq: read.seq, epochId: read.epochId! },
      operations,
      requestId + "-edit",
    );
    const saved = {
      kind: "image_insert",
      resourceId: target.id,
      title: target.title,
      assetId,
      saved: true,
    };
    await tx
      .insertInto("ai_operations")
      .values({
        id: requestId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: identity,
        result: JSON.stringify(saved),
        created_at: new Date().toISOString(),
      })
      .execute();
    return saved;
  });
  await ctx.notify?.(normalized.resourceId).catch(() => {});
  return result;
}

/** Re-display only verified receipts belonging to this user and conversation. */
export async function showGeneratedImage(
  db: DB,
  ctx: ToolContext,
  sessionId: string,
  assetId?: string,
) {
  const rows = await db
    .selectFrom("ai_operations as o")
    .innerJoin("ai_jobs as j", "j.id", "o.job_id")
    .select("o.result")
    .where("o.user_id", "=", ctx.actor.id)
    .where("j.user_id", "=", ctx.actor.id)
    .where("j.session_id", "=", sessionId)
    .orderBy("o.created_at", "desc")
    .execute();
  const image = rows
    .map((r) => JSON.parse(r.result))
    .find(
      (r) =>
        r.kind === "image_generation" &&
        r.assetId &&
        (!assetId || r.assetId === assetId),
    );
  if (!image)
    fail(
      404,
      "当前会话没有这张图片的成功生成记录，尚未生成图片，不能展示或插入",
    );
  const status = await generatedImageStatus(db, ctx, image.assetId);
  return { ...image, ...status, kind: "image_display" };
}
