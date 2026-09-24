// Imported only by the isolated in-memory QA server.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { generateImageAsset } from "../apps/server/src/ai/images.js";
import { insertGeneratedImage } from "../apps/server/src/ai/image-insert.js";
import {
  readAIDocument,
  editAIDocument,
} from "../packages/core/src/workflows/ai-documents.js";
import { CanvasModel } from "aidcanvas/model";
import {
  restoreSurface,
  exchangeSurface,
} from "../packages/core/src/modules/documents/codecs/surfaces.js";
import type { DB } from "../packages/db/src/index.js";
import type { Actor } from "../packages/core/src/modules/identity/passwords.js";
import type { StorageRuntime } from "../apps/server/src/adapters/storage.js";

export async function seedNativeElements(
  db: DB,
  actor: Actor,
  docs: { id: string; format: string }[],
  storage: StorageRuntime,
) {
  if (process.env.DOCA_QA_ISOLATED !== "1")
    throw Error("Isolated fixtures only");
  const image = await generateImageAsset(
    db,
    { actor },
    { prompt: "隔离图片元素测试" },
    randomUUID(),
    {
      storage,
      fetch: (async () =>
        Response.json({
          data: [
            {
              b64_json: (
                await sharp({
                  create: {
                    width: 320,
                    height: 200,
                    channels: 3,
                    background: "#248a66",
                  },
                })
                  .png()
                  .toBuffer()
              ).toString("base64"),
            },
          ],
        })) as typeof fetch,
    },
  );
  for (const doc of docs) {
    if (doc.format !== "spreadsheet")
      await insertGeneratedImage(
        db,
        { actor },
        { assetId: image.assetId, resourceId: doc.id },
        randomUUID(),
        storage,
      );
    const read = await readAIDocument(db, { actor }, doc.id);
    if (doc.format === "canvas") {
      // Exercise an already-saved, nameless element as well as new AI elements.
      const loaded = await restoreSurface(db, doc.id, "canvas");
      const model = CanvasModel.restore({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: loaded.epochId,
        update: loaded.update,
      });
      const first = model.getValue().scene.children![0]!;
      model.add({ ...first, id: "legacy-image", name: "", x: 500, y: 40 });
      model.add({
        id: "legacy-text",
        tag: "Text",
        x: 40,
        y: 350,
        text: "旧 AI 文字",
        fontSize: 24,
      });
      model.add({
        id: "legacy-rect",
        tag: "Rect",
        x: 500,
        y: 350,
        width: 200,
        height: 100,
        fill: "#eeccaa",
      });
      await db.transaction().execute((tx) =>
        exchangeSurface(tx, actor, read.resource, 4, {
          protocolVersion: 1,
          codec: "aidcanvas-yjs",
          schemaVersion: 1,
          epochId: loaded.epochId,
          messageId: randomUUID(),
          update: Buffer.from(model.checkpoint().update).toString("base64"),
        }),
      );
      model.dispose();
    } else if (doc.format === "rich_text") {
      await editAIDocument(
        db,
        { actor },
        doc.id,
        { seq: read.seq, epochId: read.epochId! },
        [
          {
            type: "insertBlock",
            block: {
              id: "qa-code-block",
              type: "code-block",
              language: "go",
              code: 'package main\n\nfunc main() {\n  println("native code block")\n}',
              children: [{ text: "" }],
            },
          },
        ],
        randomUUID(),
      );
    } else if (doc.format === "spreadsheet") {
      const value = read.value as any;
      await editAIDocument(
        db,
        { actor },
        doc.id,
        { seq: read.seq, epochId: read.epochId! },
        [
          {
            type: "cells",
            sheetId: value.sheetOrder[0],
            cells: { 0: { 0: { v: "原生单元格" }, 1: { v: 12 } } },
          },
        ],
        randomUUID(),
      );
    }
  }
}
