import { searchExcerpt } from "../modules/discovery/search-excerpts.js";
import { recordVersion } from "../modules/history/repository.js";
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { createEditor, Editor, Node, Text, Transforms } from "slate";
import {
  createTableBlock,
  createColumnsBlock,
} from "@smartdoca/slate/headless";
import { importMarkdown } from "@smartdoca/slate/conversion";
import { CanvasModel } from "@smartdoca/canvas/model";
import { nativeCanvasElement } from "../shared/canvas-elements.js";
import {
  assertLinkUrl,
  validateEditOperations,
  validateRichNode,
} from "../modules/ai/edit-schema.js";
import {
  collectEditOperations,
  normalizeEditOperations,
  resolveSpreadsheetSheetId,
} from "../modules/ai/edit-normalize.js";
import {
  EditorController,
  readDocument,
  replaceMatches,
  resolveAnchor as resolvePptAnchor,
} from "@smartdoca/slides/core";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import {
  restoreExlsxDocument,
  createExlsxCollaborationSession,
} from "@smartdoca/sheet/yjs";
import type {
  CollaborationContext,
  CollaborationMutation,
} from "@smartdoca/sheet";
import { resolveMarkdownTextAnchor } from "@smartdoca/markdown";
import type { DB } from "../../../db/src/index.js";
import { transact } from "../../../db/src/transactions.js";
import { AppError, fail } from "../shared/errors.js";
import { authorize } from "../modules/access/queries.js";
import type { Actor } from "../modules/identity/passwords.js";
import { createContent } from "./resources.js";
import {
  b64,
  createDocuments,
  restoreDocument,
} from "../modules/collaboration/documents.js";
import { restoreMarkdown } from "../modules/documents/codecs/markdown.js";
import { decodeMarkdownAnchor } from "../modules/documents/codecs/markdown-anchor.js";
import { quotedRichAnchor, resolveRichAnchor } from "../modules/documents/codecs/rich-anchor.js";
import {
  restoreSurface,
  surfaceCodec,
  DEFAULT_SPREADSHEET_SCHEMA,
} from "../modules/documents/codecs/surfaces.js";
import { PPT_SCHEMA } from "../modules/documents/codecs/presentation.js";

export const digest = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
// Rich-text append stores plain paragraphs; markdown link syntax becomes native
// link inlines so a saved result always contains a real, reviewable hyperlink.
const appendRichChildren = (text: string) => {
  const children: any[] = [];
  let rest = 0;
  for (const match of text.matchAll(
    /\[([^\]]{1,500})\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+)\)/gi,
  )) {
    if (match.index > rest)
      children.push({ text: text.slice(rest, match.index) });
    children.push({
      id: randomUUID(),
      type: "link",
      url: match[2],
      children: [{ text: match[1] }],
    });
    rest = match.index + match[0].length;
  }
  if (rest < text.length) children.push({ text: text.slice(rest) });
  return children.length ? children : [{ text }];
};
const markdownStructure =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s+\S|```|~~~|\|.*\||(?:[-*+]|\d+\.)\s+\S|>\s+\S)/;
export function looksLikeMarkdown(text: string) {
  return markdownStructure.test(text);
}
const blockPlainText = (node: any): string => {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map((child: any) => blockPlainText(child)).join("");
};
const markdownParagraph = (block: any) => {
  if (!block || block.type !== "paragraph" || !Array.isArray(block.children))
    return "";
  if (
    block.children.some(
      (child: any) => !child || typeof child.text !== "string" || child.type,
    )
  )
    return "";
  const text = block.children.map((child: any) => child.text).join("");
  return looksLikeMarkdown(text) ? text : "";
};
async function insertMarkdownBlocks(
  runtime: { execute: (op: any) => void; getValue: () => any[] },
  source: string,
  afterId?: string,
  parentId?: string,
) {
  const imported = await importMarkdown(source);
  const blocks = (imported.initialValue ?? []).filter((block: any) => {
    if (!block?.type) return false;
    const text = blockPlainText(block).trim();
    return !(block.type === "paragraph" && /^[\s|:-]*$/.test(text));
  });
  if (!blocks.length) return false;
  let after = afterId;
  for (const block of blocks) {
    runtime.execute({
      type: "insertBlock",
      afterId: after ?? (runtime.getValue().at(-1) as any)?.id,
      parentId,
      block,
    });
    after = (block as any).id;
  }
  return true;
}
export type AIReference = {
  resourceId: string;
  anchor?: any;
  label?: string;
  format?: string;
  description?: string;
  epochId?: string;
  seq?: number;
};
export type ToolContext = {
  actor: Actor;
  jobId?: string;
  lease?: string;
  allowedResources?: string[];
  exactResources?: boolean;
  writable?: boolean;
  notify?: (id: string) => Promise<void>;
};
export async function checkScope(
  db: DB,
  ctx: ToolContext,
  id: string,
  write = false,
) {
  if (write && ctx.writable === false) fail(403, "本次授权仅允许读取");
  const access = await authorize(db, ctx.actor, id, write ? 3 : 1);
  if (
    ctx.allowedResources !== undefined &&
    !ctx.allowedResources.includes(id) &&
    !(
      !ctx.exactResources &&
      access.resource.library_id &&
      ctx.allowedResources.includes(access.resource.library_id)
    )
  )
    fail(403, "文档不在本次授权范围内");
  await checkJob(db, ctx);
  return access;
}
export async function checkJob(db: DB, ctx: ToolContext) {
  if (ctx.jobId) {
    const job = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", ctx.jobId)
      .where("user_id", "=", ctx.actor.id)
      .executeTakeFirst();
    if (
      !job ||
      job.cancelled ||
      job.status !== "running" ||
      job.lease !== ctx.lease ||
      !job.lease_until ||
      job.lease_until < new Date().toISOString()
    )
      fail(409, "任务执行权已失效");
  }
}
async function sheetModel(loaded: Awaited<ReturnType<typeof restoreSurface>>) {
  if (!loaded.baseline) fail(409, "表格基线缺失");
  const bundle = {
    baseline: loaded.baseline,
    update: loaded.update,
    checkpointSeq: loaded.state.checkpoint_seq,
  };
  const doc = await restoreExlsxDocument(bundle);
  const session = await createExlsxCollaborationSession({
    doc,
    baseline: loaded.baseline,
    sessionId: "ai-" + randomUUID(),
  });
  let local: ((mutation: CollaborationMutation) => void) | undefined;
  // Headless host: the SDK owns CRDT encoding/validation; no view projection is needed.
  // This bridge never edits internal register keys or runs the browser's formula engine.
  const snapshot = await projectExlsxWorkbook(bundle);
  const context = {
    workbookId: loaded.baseline.workbookId,
    initialSnapshot: loaded.baseline.snapshot,
    getSnapshot: () => snapshot,
    getStyleById: (id: string) => (snapshot.styles as any)?.[id],
    onLocalMutation: (fn: typeof local) => {
      local = fn;
      return () => {
        local = undefined;
      };
    },
    applyRemoteMutation: async () => undefined,
  } as unknown as CollaborationContext;
  try {
    await session.connect(context);
    await session.ready;
  } catch (e) {
    session.dispose();
    doc.destroy();
    throw e;
  }
  return {
    doc,
    session,
    snapshot,
    mutate: async (mutation: CollaborationMutation) => {
      session.validateLocalMutation?.(mutation);
      local!(mutation);
      await session.flush();
      if (session.state === "error") fail(400, "表格命令执行失败");
    },
    destroy: () => {
      session.dispose();
      doc.destroy();
    },
  };
}
export async function aiSearchHit(
  db: DB,
  ctx: ToolContext,
  id: string,
  query: string,
) {
  return transact(db, async (tx) => {
    const { resource } = await checkScope(tx, ctx, id);
    const state = await tx
      .selectFrom("document_states")
      .select(["text", "seq"])
      .where("resource_id", "=", id)
      .executeTakeFirst();
    const body = state?.text ?? "";
    return {
      id,
      title: resource.title,
      format: resource.format,
      url: `#/r/${id}`,
      snippet: searchExcerpt(body, query, 800).summary,
      seq: state?.seq ?? 0,
    };
  });
}
export async function readAIDocument(
  db: DB,
  ctx: ToolContext,
  id: string,
  anchor?: any,
) {
  return transact(db, async (tx) => {
    const { resource } = await checkScope(tx, ctx, id);
    if (resource.kind !== "document")
      return { resource, value: null, seq: 0, epochId: "" };
    const epoch = await tx
      .selectFrom("editor_epochs")
      .selectAll()
      .where("resource_id", "=", id)
      .executeTakeFirst();
    if (anchor?.epochId && epoch && anchor.epochId !== epoch.epoch_id)
      fail(409, "引用版本已变化，请重新选择区域");
    await createDocuments(tx).exchange(ctx.actor, id, {
      codec:
        resource.format === "rich_text"
          ? "slate-kit"
          : resource.format === "markdown"
            ? "markdown-ytext"
            : surfaceCodec(resource.format),
      schemaVersion:
        resource.format === "rich_text"
          ? 3
          : resource.format === "presentation"
            ? PPT_SCHEMA
            : resource.format === "spreadsheet"
              ? epoch?.baseline
                ? JSON.parse(epoch.baseline).schemaVersion
                : DEFAULT_SPREADSHEET_SCHEMA
              : 1,
      protocolVersion: 1,
    });
    if (resource.format === "rich_text") {
      const l = await restoreDocument(tx, id);
      try {
        const epoch = await tx
          .selectFrom("editor_epochs")
          .select("epoch_id")
          .where("resource_id", "=", id)
          .executeTakeFirstOrThrow();
        let region = null;
        if (anchor) {
          let ranges;
          try {
            ranges = resolveRichAnchor(l.runtime, anchor);
          } catch {
            fail(400, "引用区域无效");
          }
          if (!ranges.length) fail(409, "引用区域已失效");
          region = {
            ...ranges[0]!,
            ranges,
            quote: ranges.map((p) => quotedRichAnchor(l.runtime, p)).join("\n"),
          };
        }
        return {
          resource,
          value: l.runtime.getValue(),
          seq: l.state!.seq,
          epochId: epoch.epoch_id,
          region,
        };
      } finally {
        l.destroy();
      }
    }
    if (resource.format === "markdown") {
      const l = await restoreMarkdown(tx, id);
      try {
        let region = null;
        if (anchor) {
          region = resolveMarkdownTextAnchor(
            l.doc,
            l.doc.getText("markdown"),
            decodeMarkdownAnchor(anchor, l.epochId),
          );
          if (!region) fail(409, "引用区域已失效");
        }
        return {
          resource,
          value: l.doc.getText("markdown").toString(),
          seq: l.state!.seq,
          epochId: l.epochId,
          region,
        };
      } finally {
        l.destroy();
      }
    }
    const l = await restoreSurface(tx, id, resource.format);
    let value: unknown,
      region: unknown = null;
    if (resource.format === "canvas") {
      const model = CanvasModel.restore({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: l.epochId,
        update: l.update,
      });
      try {
        value = model.getValue();
        if (anchor) {
          region = model.resolveAnchor(anchor);
          if (!(region as any).valid) fail(409, "图形引用已失效");
        }
      } finally {
        model.dispose();
      }
    } else if (resource.format === "presentation") {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, l.update);
      try {
        value = readDocument(doc);
        if (anchor) {
          region = resolvePptAnchor(doc, anchor);
          if (!region) fail(409, "幻灯片引用已失效");
        }
      } finally {
        doc.destroy();
      }
    } else {
      const model = await sheetModel(l);
      try {
        value = model.snapshot;
        if (anchor) {
          region = model.session.resolveCellAnchorRanges?.(anchor) ?? [];
          if (!(region as any[]).length) fail(409, "单元格引用已失效");
        }
      } finally {
        model.destroy();
      }
    }
    return { resource, value, region, seq: l.state.seq, epochId: l.epochId };
  });
}
export type EditOperation = { type: string; [key: string]: any };
export async function editAIDocument(
  db: DB,
  ctx: ToolContext,
  id: string,
  expected: { seq: number; epochId: string; format?: string },
  operations: EditOperation[],
  operationId: string,
) {
  if (
    !operations.length ||
    operations.length > 100 ||
    JSON.stringify(operations).length > 200000
  )
    fail(400, "编辑批次为空或过大");
  const result = await transact(db, async (tx) => {
    const { resource } = await checkScope(tx, ctx, id, true);
    if (expected.format && expected.format !== resource.format)
      fail(400, `此文档为 ${resource.format}，请使用 ${resource.format}_edit`);
    operations = collectEditOperations({ operations }) as EditOperation[];
    operations = normalizeEditOperations(resource.format, operations);
    validateEditOperations(resource.format, operations);
    if (resource.format === "canvas") {
      // The headless model accepts arbitrary arrow names; the renderer does not.
      const validateArrows = (element: any) => {
        if (!element || typeof element !== "object") return;
        for (const field of ["startArrow", "endArrow"])
          if (
            element[field] !== undefined &&
            !["none", "angle", "triangle", "circle", "diamond"].includes(
              element[field],
            )
          )
            fail(
              400,
              `${field} 必须为 none、angle、triangle、circle 或 diamond，例如 endArrow:'angle'`,
            );
        if (Array.isArray(element.children))
          element.children.forEach(validateArrows);
      };
      for (const op of operations)
        validateArrows(
          op.type === "add"
            ? op.element
            : op.type === "patch"
              ? op.patch
              : null,
        );
    }
    if (["markdown", "rich_text"].includes(resource.format))
      for (const op of operations)
        if (["append", "text"].includes(op.type) && typeof op.text !== "string")
          fail(
            400,
            "文字命令必须提供 text 字符串，例如 {type:'append',text:'正文'}",
          );
    const hash = digest({ id, expected, operations });
    const previous = await tx
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (previous) {
      if (previous.user_id !== ctx.actor.id || previous.digest !== hash)
        fail(409, "重复操作的内容不同");
      return JSON.parse(previous.result);
    }
    const state = await tx
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", id)
      .executeTakeFirstOrThrow();
    if (state.seq !== expected.seq)
      fail(409, "文档已被编辑，请重新读取后生成修改");
    let update: Uint8Array, epochId: string, schemaVersion: number;
    if (resource.format === "markdown") {
      const l = await restoreMarkdown(tx, id);
      try {
        epochId = l.epochId!;
        schemaVersion = 1;
        const vector = Y.encodeStateVector(l.doc),
          text = l.doc.getText("markdown");
        for (const op of operations) {
          if (op.type === "append") text.insert(text.length, String(op.text));
          else if (op.type === "text") {
            const { index, deleteCount, text: insertion } = op;
            if (
              !Number.isInteger(index) ||
              !Number.isInteger(deleteCount) ||
              index < 0 ||
              deleteCount < 0 ||
              index + deleteCount > text.length ||
              typeof insertion !== "string"
            )
              fail(400, "文字范围无效");
            text.delete(index, deleteCount);
            text.insert(index, insertion);
          } else fail(400, "Markdown 仅支持 text / append 命令");
        }
        update = Y.encodeStateAsUpdate(l.doc, vector);
      } finally {
        l.destroy();
      }
    } else if (resource.format === "rich_text") {
      const l = await restoreDocument(tx, id);
      try {
        epochId = (
          await tx
            .selectFrom("editor_epochs")
            .select("epoch_id")
            .where("resource_id", "=", id)
            .executeTakeFirstOrThrow()
        ).epoch_id;
        schemaVersion = 3;
        const vector = Y.encodeStateVector(l.doc);
        for (const op of operations) {
          if (op.type === "setBlock") {
            const find = (nodes: any[]): any => {
              for (const node of nodes) {
                if (node.id === op.blockId) return node;
                const nested = node.children && find(node.children);
                if (nested) return nested;
              }
            };
            const existing = find(l.runtime.getValue());
            if (!existing) fail(400, "文字块不存在");
            const next = { ...existing, ...op.properties };
            for (const key of op.unset ?? []) delete next[key];
            validateRichNode(next);
          }
          if (op.type === "text") {
            try {
              l.runtime.editText(op.blockId, op.index, op.deleteCount, op.text);
            } catch (error) {
              if (error instanceof Error && error.message === "Invalid text range") {
                const entry = [...Node.nodes({ children: l.runtime.getValue() } as Node)]
                  .find(([node]) => (node as any).id === op.blockId);
                const length = entry ? Node.string(entry[0]).length : null;
                fail(400, `文字范围越界：blockId=${op.blockId}，index=${op.index}，deleteCount=${op.deleteCount}，当前块文字长度（UTF-16）=${length ?? "未知"}。请按 blockId 读取完整正文后定位；整块替换须 index=0、deleteCount=实际长度，不要猜测。本批次未保存。`);
              }
              throw error;
            }
          } else if (op.type === "link") {
            assertLinkUrl(op.url);
            const before = l.runtime.getValue(),
              editor = createEditor();
            editor.children = structuredClone(before);
            editor.isInline = (node) => (node as any).type === "link";
            const entry = [...Node.nodes(editor)].find(
              ([node]) => (node as any).id === op.blockId,
            );
            if (!entry || Text.isText(entry[0])) fail(400, "文字块不存在");
            const [block, path] = entry;
            if (
              [...Node.elements(block)].some(
                ([n, p]) => p.length > 0 && (n as any).type !== "link",
              )
            )
              fail(400, "含原子元素的文字区域需缩小范围");
            const leaves = [...Node.texts(block)],
              total = leaves.reduce((n, [leaf]) => n + leaf.text.length, 0);
            if (
              !Number.isInteger(op.index) ||
              !Number.isInteger(op.length) ||
              op.index < 0 ||
              op.length < 1 ||
              op.index + op.length > total
            )
              fail(400, "链接范围无效");
            const point = (offset: number) => {
              for (const [leaf, p] of leaves) {
                if (offset <= leaf.text.length)
                  return { path: [...path, ...p], offset };
                offset -= leaf.text.length;
              }
              fail(400, "链接范围无效");
            };
            const at = {
              anchor: point(op.index),
              focus: point(op.index + op.length),
            };
            const range = Editor.rangeRef(editor, at, { affinity: "inward" });
            try {
              Transforms.unwrapNodes(editor, {
                at,
                match: (n) => (n as any).type === "link",
                split: true,
              });
              if (range.current)
                Transforms.wrapNodes(
                  editor,
                  {
                    id: randomUUID(),
                    type: "link",
                    url: op.url,
                    children: [],
                  },
                  { at: range.current, split: true },
                );
            } finally {
              range.unref();
            }
            l.runtime.acceptEditorValue(before, editor.children);
          } else if (op.type === "formatText") {
            const before = l.runtime.getValue(),
              editor = createEditor();
            editor.children = structuredClone(before);
            const entry = [...Node.nodes(editor)].find(
              ([node]) => (node as any).id === op.blockId,
            );
            if (!entry || Text.isText(entry[0])) fail(400, "文字块不存在");
            const [block, path] = entry;
            if (
              [...Node.elements(block)].some(
                ([n, p]) => p.length > 0 && (n as any).type !== "link",
              )
            )
              fail(400, "含原子元素的文字区域需缩小范围");
            const leaves = [...Node.texts(block)],
              total = leaves.reduce((n, [leaf]) => n + leaf.text.length, 0);
            if (
              !Number.isInteger(op.index) ||
              !Number.isInteger(op.length) ||
              op.index < 0 ||
              op.length < 1 ||
              op.index + op.length > total
            )
              fail(400, "格式范围无效");
            const allowed = [
              "bold",
              "italic",
              "underline",
              "strikethrough",
              "code",
              "fontSize",
              "fontFamily",
              "color",
              "backgroundColor",
            ];
            if (
              !op.style ||
              Object.keys(op.style).some((k) => !allowed.includes(k)) ||
              (op.unset ?? []).some((k: string) => !allowed.includes(k))
            )
              fail(400, "文字格式无效");
            const point = (offset: number) => {
              for (const [leaf, p] of leaves) {
                if (offset <= leaf.text.length)
                  return { path: [...path, ...p], offset };
                offset -= leaf.text.length;
              }
              fail(400, "格式范围无效");
            };
            const at = {
              anchor: point(op.index),
              focus: point(op.index + op.length),
            };
            const range = Editor.rangeRef(editor, at, { affinity: "inward" });
            try {
              Transforms.setNodes(editor, op.style, {
                at,
                match: Text.isText,
                split: true,
              });
              if (op.unset?.length && range.current)
                Transforms.unsetNodes(editor, op.unset, {
                  at: range.current,
                  match: Text.isText,
                  split: true,
                });
            } finally {
              range.unref();
            }
            l.runtime.acceptEditorValue(before, editor.children);
          } else if (op.type === "insertTable") {
            if (
              !Number.isInteger(op.rows) ||
              !Number.isInteger(op.columns) ||
              op.rows < 1 ||
              op.columns < 1 ||
              op.rows * op.columns > 1000
            )
              fail(400, "表格尺寸无效");
            l.runtime.execute({
              type: "insertBlock",
              afterId: op.afterId,
              parentId: op.parentId,
              block: createTableBlock(op.rows, op.columns),
            });
          } else if (op.type === "insertColumnsLayout") {
            if (![2, 3, 4].includes(op.count)) fail(400, "分栏数量无效");
            l.runtime.execute({
              type: "insertBlock",
              afterId: op.afterId,
              parentId: op.parentId,
              block: createColumnsBlock(op.count),
            });
          } else if (op.type === "append") {
            const text = String(op.text ?? "");
            if (
              looksLikeMarkdown(text) &&
              (await insertMarkdownBlocks(l.runtime, text).catch(() => false))
            ) {
              /* Headings, lists and tables become native blocks. */
            } else
              for (const paragraph of text.split("\n"))
                l.runtime.execute({
                  type: "insertBlock",
                  block: {
                    id: randomUUID(),
                    type: "paragraph",
                    children: appendRichChildren(paragraph),
                  },
                  afterId: (l.runtime.getValue().at(-1) as any)?.id,
                } as any);
          } else if (op.type === "insertBlock" && markdownParagraph(op.block)) {
            const inserted = await insertMarkdownBlocks(
              l.runtime,
              markdownParagraph(op.block),
              op.afterId,
              op.parentId,
            ).catch(() => false);
            if (!inserted) l.runtime.execute(op as any);
          } else if (
            [
              "insertBlock",
              "deleteBlock",
              "moveBlock",
              "setBlock",
              "insertRows",
              "insertColumns",
              "deleteRows",
              "deleteColumns",
              "merge",
              "split",
              "resizeRow",
              "resizeColumn",
              "setCellStyle",
              "setTextStyle",
              "clearCells",
              "setCellContent",
              "paste",
              "deleteTable",
              "insertColumn",
              "deleteColumn",
            ].includes(op.type)
          )
            l.runtime.execute(op as any);
          else fail(400, "不支持的富文本命令");
        }
        update = Y.encodeStateAsUpdate(l.doc, vector);
      } finally {
        l.destroy();
      }
    } else {
      const l = await restoreSurface(tx, id, resource.format);
      epochId = l.epochId;
      if (resource.format === "canvas") {
        schemaVersion = 1;
        const model = CanvasModel.restore({
          codec: "aidcanvas-yjs",
          schemaVersion: 1,
          epochId,
          update: l.update,
        });
        const updates: Uint8Array[] = [];
        model.onLocalUpdate((u) => updates.push(u.update));
        try {
          for (const op of operations) {
            if (op.type === "add")
              model.add(nativeCanvasElement(op.element), op.parentId);
            else if (op.type === "patch") model.patch(op.id, op.patch);
            else if (op.type === "remove") model.remove(op.ids);
            else if (op.type === "place")
              model.place(op.id, op.parentId ?? null, op.beforeId);
            else if (op.type === "group") model.group(op.ids);
            else if (op.type === "ungroup") model.ungroup(op.id);
            else if (op.type === "text")
              model.editText(op.id, op.index, op.deleteCount, op.text);
            else fail(400, "不支持的画板命令");
          }
          update = Y.mergeUpdates(updates);
        } finally {
          model.dispose();
        }
      } else if (resource.format === "presentation") {
        schemaVersion = PPT_SCHEMA;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, l.update);
        const vector = Y.encodeStateVector(doc),
          controller = new EditorController(doc);
        try {
          for (const op of operations) {
            if (op.type === "addSlide") controller.addSlide(op.after, op.slide);
            else if (op.type === "deleteSlide")
              controller.deleteSlide(op.slideId);
            else if (op.type === "insert") {
              if (op.element?.type === "text" && !Array.isArray(op.element.paragraphs))
                fail(400, '文本元素需要 paragraphs:[{type:"paragraph",children:[{text:"…"}]}]，或直接给 text 字符串');
              controller.insert(op.slideId, op.element);
            }
            else if (op.type === "add") controller.add(op.slideId, op.kind);
            else if (op.type === "patch") {
              if ("paragraphs" in op.patch)
                fail(400, '幻灯片文字不能用 patch.paragraphs 修改。请先读取该页完整正文，再用 {type:"replaceText",slideId,id,query:"原段落文字",text:"替换文字"}；多段分别替换。样式用 formatText/paragraphFormat。');
              controller.patch(op.slideId, op.id, op.patch);
            }
            else if (op.type === "remove")
              controller.remove(op.slideId, op.ids);
            else if (op.type === "moveSlide")
              controller.moveSlideBefore(op.slideId, op.before ?? null);
            else if (op.type === "slideProperty")
              controller.slideProperty(op.slideId, op.field, op.value);
            else if (op.type === "align")
              controller.align(op.slideId, op.ids, op.axis);
            else if (op.type === "table")
              controller.tableCommand(op.slideId, op.id, op.command);
            else if (op.type === "replaceText") {
              const matches = controller.find(op.query).filter((match) =>
                (!op.slideId || match.anchor.slideId === op.slideId) &&
                (!op.id || match.anchor.elementId === op.id));
              if (!matches.length)
                fail(400, "目标范围内找不到原文，未保存任何修改。请按 slideId 读取完整正文；query 必须是单段内的实际文字，不能拼接大纲预览或跨段落。");
              replaceMatches(doc, matches, op.text);
            }
            else if (op.type === "formatText")
              controller.formatText(op.slideId, op.ids, op.marks);
            else if (op.type === "paragraphFormat")
              controller.paragraphFormat(op.slideId, op.ids, op.format);
            else if (op.type === "pageSize") {
              // The editor takes CSS pixels. Models often send the document's EMU size.
              const pixels = (value: number) =>
                value > 10000 ? value / 9525 : value;
              controller.pageSize(pixels(op.width), pixels(op.height));
            }
            else if (op.type === "distribute")
              controller.distribute(op.slideId, op.ids, op.axis);
            else if (op.type === "arrange")
              controller.arrange(op.slideId, op.ids, op.action);
            else if (op.type === "group") controller.group(op.slideId, op.ids);
            else if (op.type === "ungroup")
              controller.ungroup(op.slideId, op.ids);
            else if (op.type === "duplicate")
              controller.duplicate(op.slideId, op.ids);
            else if (op.type === "duplicateSlides")
              controller.duplicateSlides(op.ids);
            else if (op.type === "setSlidesHidden")
              controller.setSlidesHidden(op.ids, op.hidden);
            else if (op.type === "createSection")
              controller.createSection(op.name, op.ids);
            else if (op.type === "renameSection")
              controller.renameSection(op.id, op.name);
            else if (op.type === "deleteSection")
              controller.deleteSection(op.id);
            else if (op.type === "assignSection")
              controller.assignSection(op.ids, op.sectionId);
            else fail(400, "不支持的幻灯片命令");
          }
          update = Y.encodeStateAsUpdate(doc, vector);
        } catch (error) {
          if (error instanceof AppError) throw error;
          const reason = error instanceof Error ? error.message : "未知错误";
          fail(400, `幻灯片编辑失败：${reason}`);
        } finally {
          controller.dispose();
          doc.destroy();
        }
      } else {
        const model = await sheetModel(l);
        schemaVersion = l.baseline!.schemaVersion;
        const vector = Y.encodeStateVector(model.doc);
        try {
          for (const op of operations) {
            if (op.type === "cells")
              await model.mutate({
                id: "sheet.mutation.set-range-values",
                params: {
                  unitId: id,
                  subUnitId: resolveSpreadsheetSheetId(
                    op.sheetId,
                    model.snapshot,
                  ),
                  cellValue: op.cells,
                },
              });
            else if (op.type === "structure" && model.session.editStructure)
              await model.session.editStructure({
                ...op.edit,
                sheetId: resolveSpreadsheetSheetId(
                  op.edit.sheetId,
                  model.snapshot,
                ),
              });
            else if (
              op.type === "mutation" &&
              model.session.supportsMutation?.(op.id)
            )
              await model.mutate({ id: op.id, params: op.params });
            else if (op.type === "putFloatingObject") {
              if (!model.session.putFloatingObject)
                fail(400, "当前表格版本不支持浮动图片，请使用 image_insert");
              try {
                await model.session.putFloatingObject(op.input);
              } catch (error) {
                const reason =
                  error instanceof Error ? error.message : "未知错误";
                fail(400, `表格插入浮动对象失败：${reason}`);
              }
            }
            else if (
              op.type === "updateFloatingGeometry" &&
              model.session.updateFloatingGeometry
            )
              await model.session.updateFloatingGeometry(op.id, op.patch);
            else if (
              op.type === "removeFloatingObject" &&
              model.session.removeFloatingObject
            )
              await model.session.removeFloatingObject(op.id);
            else
              fail(
                400,
                "表格支持 cells 及当前版本可用的 structure；公式写入不代表已验证计算结果",
              );
          }
          update = Y.encodeStateAsUpdate(model.doc, vector);
        } finally {
          model.destroy();
        }
      }
    }
    if (epochId !== expected.epochId)
      fail(409, "文档版本谱系已变化，请重新读取");
    const receipt = await createDocuments(tx).exchange(ctx.actor, id, {
      update: b64(update),
      codec: state.codec,
      protocolVersion: 1,
      schemaVersion,
      epochId,
      messageId: operationId,
    });
    if (receipt.changed) {
      const version = await tx
        .selectFrom("document_versions")
        .select(["id", "recovery_json"])
        .where("resource_id", "=", id)
        .where("seq", "=", receipt.seq)
        .executeTakeFirst();
      if (version?.recovery_json) {
        await tx
          .updateTable("document_versions")
          .set({
            recovery_json: JSON.stringify({
              ...JSON.parse(version.recovery_json),
              origin: "ai",
            }),
          })
          .where("id", "=", version.id)
          .execute();
      } else if (!version) {
        await recordVersion(
          tx,
          {
            id: randomUUID(),
            resource_id: id,
            seq: receipt.seq,
            checkpoint: receipt.update,
            title: receipt.metadata?.title ?? resource.title,
            author_id: ctx.actor.id,
            created_at: new Date().toISOString(),
          },
          "ai",
        );
      }
      await tx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          actor_id: ctx.actor.id,
          resource_id: id,
          action: "document.ai_edited",
          created_at: new Date().toISOString(),
        })
        .execute();
    }
    const result = {
      resourceId: id,
      seq: receipt.seq,
      epochId,
      saved: true,
      format: resource.format,
      ...(resource.format === "spreadsheet"
        ? { formulaCalculation: "not_verified" }
        : {}),
    };
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: hash,
        result: JSON.stringify(result),
        created_at: new Date().toISOString(),
      })
      .execute();
    return result;
  });
  // Saving has committed. A disconnected client must not turn a durable edit into a failed tool result.
  await ctx.notify?.(id).catch(() => {});
  return result;
}
export async function createAIDocument(
  db: DB,
  ctx: ToolContext,
  input: Parameters<ReturnType<typeof createContent>["create"]>[1],
  operationId: string,
) {
  const result = await transact(db, async (tx) => {
    if (ctx.writable === false) fail(403, "凭据仅允许读取");
    await checkJob(tx, ctx);
    for (const id of [input.libraryId, input.parentId].filter(Boolean))
      await checkScope(tx, ctx, id!, true);
    if (
      ctx.allowedResources !== undefined &&
      ctx.allowedResources.length > 0 &&
      !input.libraryId &&
      !input.parentId
    )
      fail(403, "必须在授权知识库内创建");
    const previous = await tx
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", operationId)
        .executeTakeFirst(),
      hash = digest(input);
    if (previous) {
      if (previous.user_id !== ctx.actor.id || previous.digest !== hash)
        fail(409, "重复请求内容不同");
      return JSON.parse(previous.result);
    }
    if (input.format === "rich_text" && input.initialContent) {
      const value = input.initialContent as { children?: unknown[] };
      if (!Array.isArray(value.children))
        fail(400, "富文本初始内容必须包含 children");
      const seen = new Set<string>();
      value.children.forEach((node) => validateRichNode(node, seen));
    }
    const created = await createContent(tx).create(ctx.actor, input);
    await tx
      .insertInto("ai_operations")
      .values({
        id: operationId,
        user_id: ctx.actor.id,
        job_id: ctx.jobId ?? null,
        digest: hash,
        result: JSON.stringify(created),
        created_at: new Date().toISOString(),
      })
      .execute();
    return created;
  });
  return result;
}

// Render previews from the same readonly native adapters used by history.
export async function previewAIDocument(db: DB, actor: Actor, id: string) {
  return transact(db, async (tx) => {
    const read = await readAIDocument(tx, { actor }, id);
    const resource = {
      id: read.resource.id,
      title: read.resource.title,
      format: read.resource.format,
      kind: read.resource.kind,
    };
    if (resource.kind !== "document") fail(400, "请选择文档预览");
    if (resource.format === "markdown")
      return { resource, markdown: read.value };
    if (resource.format === "rich_text") return { resource, value: read.value };
    const loaded = await restoreSurface(tx, id, resource.format);
    return {
      resource,
      surface: {
        format: resource.format,
        epochId: loaded.epochId,
        baseline: loaded.baseline,
        update: b64(loaded.update),
      },
    };
  });
}
