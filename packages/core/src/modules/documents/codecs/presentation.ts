import * as Y from "yjs";
import {
  readDocument,
  validateDocument,
  type PresentationDocument,
} from "@eppt/editor/core";
import type { DB } from "../../../../../db/src/index.js";
import { fail } from "../../../shared/errors.js";

// The SDK calls its codec `eppt`, revision 5. Doca binds that revision into the
// negotiated codec since its common transport has no separate revision field.
export const PPT_CODEC = "eppt-yjs-v5";
export const PPT_SCHEMA = 2;
function bounded(
  value: any,
  assets: Set<string>,
  depth = 0,
  budget = { n: 0 },
) {
  if (++budget.n > 200000 || depth > 64) fail(413, "演示文稿结构过大");
  if (typeof value === "number" && !Number.isFinite(value))
    fail(400, "非法数值");
  if (typeof value === "string" && value.length > 100000) fail(413, "文本过长");
  if (value instanceof Uint8Array) fail(400, "资源必须通过系统上传");
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (
      [
        "__proto__",
        "constructor",
        "prototype",
        "data",
        "url",
        "href",
        "src",
        "sourceUrl",
      ].includes(k)
    )
      fail(400, "演示文稿包含不支持的属性或内嵌资源");
    if (k === "assetId" && !assets.has(String(v)))
      fail(400, "图片必须使用当前文档已上传的素材");
    bounded(v, assets, depth + 1, budget);
  }
}
async function assetIds(db: DB, id: string) {
  const rows = await db
    .selectFrom("assets")
    .select("id")
    .where("resource_id", "=", id)
    .where("deleted_at", "is", null)
    .where("mime", "like", "image/%")
    .execute();
  return new Set(rows.map((r) => r.id));
}
export async function validatePresentation(
  db: DB,
  id: string,
  value: PresentationDocument,
) {
  bounded(value, await assetIds(db, id));
  if (value.id !== id || (value.assets && Object.keys(value.assets).length))
    fail(400, "演示文稿身份或素材元数据无效");
  try {
    // Also validate unordered objects: projections must not hide invalid content.
    validateDocument({
      ...value,
      slideOrder: Object.keys(value.slides),
      slides: Object.fromEntries(
        Object.entries(value.slides).map(([k, s]) => [
          k,
          { ...s, elementOrder: Object.keys(s.elements) },
        ]),
      ),
    });
    validateDocument(value);
  } catch {
    fail(400, "无效的演示文稿内容");
  }
}
export async function validatePresentationUpdate(
  db: DB,
  id: string,
  bytes: Uint8Array,
) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    if (doc.store.pendingDs || doc.store.pendingStructs)
      fail(409, "更新缺少依赖");
    for (const key of doc.share.keys())
      if (key !== "presentation") fail(400, "未知演示文稿通道");
    const root = doc.getMap("presentation");
    for (const [key, name] of root.entries()) {
      if (!key.startsWith("section:")) continue;
      const sectionId = key.slice(8);
      if (
        !sectionId ||
        sectionId.length > 200 ||
        ["__proto__", "constructor", "prototype"].includes(sectionId) ||
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 200
      )
        fail(400, "幻灯片分组无效");
    }
    for (const k of root.keys())
      if (
        ![
          "id",
          "schemaVersion",
          "title",
          "size",
          "slideOrder",
          "slides",
          "assets",
        ].includes(k) &&
        !k.startsWith("section:")
      )
        fail(400, "未知演示文稿属性");
    // Check raw state too, including tombstones. Never mutate persisted state to repair an invalid update.
    bounded(root.toJSON(), await assetIds(db, id));
    const slides = root.get("slides");
    if (
      !(slides instanceof Y.Map) ||
      !(root.get("slideOrder") instanceof Y.Array)
    )
      fail(400, "幻灯片结构无效");
    slides.forEach((slide: any) => {
      if (
        !(slide instanceof Y.Map) ||
        !(slide.get("elements") instanceof Y.Map) ||
        !(slide.get("elementOrder") instanceof Y.Array)
      )
        fail(400, "幻灯片结构无效");
      if (slide.has("hidden") && typeof slide.get("hidden") !== "boolean")
        fail(400, "幻灯片隐藏状态无效");
      if (
        slide.has("sectionId") &&
        (typeof slide.get("sectionId") !== "string" ||
          !slide.get("sectionId") ||
          slide.get("sectionId").length > 200)
      )
        fail(400, "幻灯片分组无效");
      for (const k of slide.keys())
        if (
          ![
            "id",
            "name",
            "background",
            "notes",
            "elementOrder",
            "elements",
            "deleted",
            "hidden",
            "sectionId",
          ].includes(k)
        )
          fail(400, "未知幻灯片属性");
      slide.get("elements").forEach((el: any) => {
        if (!(el instanceof Y.Map)) fail(400, "元素结构无效");
        for (const k of el.keys())
          if (
            !k.startsWith("table-op:") &&
            ![
              "id",
              "type",
              "name",
              "transform",
              "opacity",
              "visible",
              "locked",
              "groupId",
              "animation",
              "deleted",
              "text",
              "fill",
              "background",
              "verticalAlign",
              "padding",
              "shape",
              "stroke",
              "strokeWidth",
              "assetId",
              "alt",
              "crop",
              "arrow",
              "cells",
              "headerFill",
              "chartType",
              "labels",
              "values",
              "color",
              "series",
              "stacking",
              "curve",
              "title",
              "showLegend",
              "showLabels",
            ].includes(k)
          )
            fail(400, "未知幻灯片元素属性");
      });
    });
    const value = readDocument(doc);
    await validatePresentation(db, id, value);
    const text = value.slideOrder
      .map((s) =>
        [
          value.slides[s]!.notes ?? "",
          ...value.slides[s]!.elementOrder.map((e) => {
            const el = value.slides[s]!.elements[e]!;
            return el.type === "text"
              ? el.paragraphs
                  .map((p) => p.children.map((c) => c.text).join(""))
                  .join("\n")
              : el.type === "table"
                ? el.cells.flat().join(" ")
                : "";
          }),
        ].join("\n"),
      )
      .join("\n");
    return {
      update: Y.encodeStateAsUpdate(doc),
      text,
      contentBytes: Buffer.byteLength(JSON.stringify(value)),
    };
  } finally {
    doc.destroy();
  }
}
