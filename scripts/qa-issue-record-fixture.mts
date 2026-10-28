// Disposable website for manual/MCP regression verification. Never opens production data.
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "vite";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { restoreSurface } from "../packages/core/src/modules/documents/codecs/surfaces.js";
import { CanvasModel } from "@smartdoca/canvas/model";
import sharp from "sharp";
import {
  aiDefaults,
  saveAIConfig,
} from "../packages/core/src/modules/ai/config.js";
import { completionResponse } from "../tests/ai-mock.js";
import {
  createPresentation,
  createTextElement,
  readDocument,
} from "@smartdoca/slides/core";
import {
  restoreExlsxDocument,
  createExlsxCollaborationSession,
} from "@smartdoca/sheet/yjs";
import * as Y from "yjs";
import { createEditor } from "slate";
import { createMarkdownTextAnchor } from "@smartdoca/markdown";
import { restoreDocument } from "../packages/core/src/modules/collaboration/documents.js";
import { restoreMarkdown } from "../packages/core/src/modules/documents/codecs/markdown.js";
import { encodeMarkdownAnchor } from "../packages/core/src/modules/documents/codecs/markdown-anchor.js";
import { captureRichSelection } from "../apps/web/src/features/comments/rich-selection-anchor.js";

const output = resolve(
  process.env.DOCA_QA_OUTPUT ??
    "artifacts/verification/issue-record-20261028/fixture",
);
await mkdir(output, { recursive: true });
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "local";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { local: { provider: "local", root: output + "/storage" } },
});
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const owner = {
  ...(await createUser(
    db,
    {
      login: "issueqa",
      displayName: "Issue QA",
      password: "isolated-issue-20261028",
    },
    { bootstrap: true },
  )),
  admin: 1,
};
const content = createContent(db);
await saveAIConfig(
  db,
  {
    ...aiDefaults,
    defaultModel: "fixture",
    mediaModel: "fixture",
    vendors: [
      {
        id: "fixture",
        name: "Isolated fixture",
        provider: "compatible",
        baseUrl: "https://fixture.invalid/v1",
        apiKey: "fixture",
        enabled: true,
      },
    ],
    models: [
      {
        id: "fixture",
        vendorId: "fixture",
        model: "fixture",
        alias: "Fixture",
        enabled: true,
        tools: true,
        vision: true,
        maxInput: 64000,
        maxOutput: 4000,
      },
    ],
  },
  0,
);
const canvas = await content.create(owner, {
  kind: "document",
  format: "canvas",
  title: "Isolated issue canvas",
  initialContent: {
    version: 1,
    scene: {
      children: [
        {
          id: "qa-rect",
          tag: "Rect",
          x: 200,
          y: 150,
          width: 240,
          height: 140,
          fill: "#c8dfff",
        },
        {
          id: "qa-rect-two",
          tag: "Rect",
          x: 500,
          y: 150,
          width: 240,
          height: 140,
          fill: "#c8ffd9",
        },
      ],
    },
  },
});
const loaded = await restoreSurface(db, canvas.id, "canvas");
const model = CanvasModel.restore({
  codec: "aidcanvas-yjs",
  schemaVersion: 1,
  epochId: loaded.epochId,
  update: loaded.update,
});
let anchor, secondAnchor;
try {
  anchor = model.captureAnchor(["qa-rect"]);
  secondAnchor = model.captureAnchor(["qa-rect-two"]);
} finally {
  model.dispose();
}
const comment = await content.comment(
  owner,
  canvas.id,
  {
    version: 1,
    blocks: [
      {
        type: "paragraph",
        children: [{ type: "text", text: "Isolated anchored comment" }],
      },
    ],
  },
  null,
  JSON.stringify(anchor),
);
const secondComment = await content.comment(
  owner,
  canvas.id,
  {
    version: 1,
    blocks: [
      {
        type: "paragraph",
        children: [{ type: "text", text: "Second canvas comment" }],
      },
    ],
  },
  null,
  JSON.stringify(secondAnchor),
);
const documents = [
  {
    format: "canvas",
    id: canvas.id,
    comment: comment.id,
    comments: [comment.id, secondComment.id],
  },
];
for (const format of ["spreadsheet", "presentation"] as const) {
  let initialContent: any;
  if (format === "spreadsheet")
    initialContent = {
      id: "fixture-workbook",
      name: "Comment workbook",
      appVersion: "0.25.1",
      locale: "zhCN",
      styles: {},
      sheetOrder: ["qa-sheet"],
      sheets: {
        "qa-sheet": {
          id: "qa-sheet",
          name: "Sheet1",
          rowCount: 50,
          columnCount: 10,
          defaultRowHeight: 19.8,
          defaultColumnWidth: 79.2,
          cellData: {
            0: { 0: { v: "Preserve this cell" } },
            6: { 4: { v: "Second comment cell" } },
          },
        },
      },
    };
  else {
    initialContent = createPresentation();
    const slide = initialContent.slides[initialContent.slideOrder[0]];
    const element = createTextElement("Preserve this text");
    const second = createTextElement("Second comment text");
    second.transform.y *= 3;
    slide.elements = { [element.id]: element, [second.id]: second };
    slide.elementOrder = [element.id, second.id];
  }
  const resource = await content.create(owner, {
    kind: "document",
    format,
    title: "Isolated issue " + format,
    initialContent,
  });
  const surface = await restoreSurface(db, resource.id, format);
  let region: unknown, secondRegion: unknown;
  if (format === "spreadsheet") {
    const workbook = await restoreExlsxDocument({
      baseline: surface.baseline!,
      update: surface.update,
      checkpointSeq: 0,
    });
    const session = await createExlsxCollaborationSession({
      doc: workbook,
      baseline: surface.baseline!,
      sessionId: "fixture-anchor",
    });
    try {
      region = session.captureCellAnchor!({
        sheetId: surface.baseline!.snapshot.sheetOrder[0]!,
        startRow: 0,
        endRow: 3,
        startColumn: 0,
        endColumn: 2,
      });
      secondRegion = session.captureCellAnchor!({
        sheetId: surface.baseline!.snapshot.sheetOrder[0]!,
        startRow: 6,
        endRow: 9,
        startColumn: 4,
        endColumn: 6,
      });
    } finally {
      session.dispose();
      workbook.destroy();
    }
  } else {
    const replica = new Y.Doc();
    try {
      Y.applyUpdate(replica, surface.update);
      const value = readDocument(replica),
        slideId = value.slideOrder[0]!;
      region = {
        type: "elements",
        epochId: surface.epochId,
        slideId,
        elementIds: [value.slides[slideId]!.elementOrder[0]!],
      };
      secondRegion = {
        ...(region as object),
        elementIds: [value.slides[slideId]!.elementOrder[1]!],
      };
    } finally {
      replica.destroy();
    }
  }
  const thread = await content.comment(
    owner,
    resource.id,
    {
      version: 1,
      blocks: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "Isolated " + format + " comment" }],
        },
      ],
    },
    null,
    JSON.stringify(region),
  );
  const second = await content.comment(
    owner,
    resource.id,
    {
      version: 1,
      blocks: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "Second " + format + " comment" }],
        },
      ],
    },
    null,
    JSON.stringify(secondRegion),
  );
  documents.push({
    format,
    id: resource.id,
    comment: thread.id,
    comments: [thread.id, second.id],
  });
}
for (const format of ["rich_text", "markdown"] as const) {
  const lines = ["First commented text", "Second commented text"];
  const resource = await content.create(owner, {
    kind: "document",
    format,
    title: "Isolated issue " + format,
    ...(format === "rich_text"
      ? {
          initialContent: {
            schemaVersion: 2,
            children: [
              {
                id: "qa-title",
                type: "paragraph",
                children: [{ text: "Comment highlight fixture" }],
              },
              ...lines.map((text, i) => ({
                id: "qa-text-" + i,
                type: "paragraph",
                children: [{ text }],
              })),
            ],
          },
        }
      : { markdown: "# Comment highlight fixture\n\n" + lines.join("\n\n") }),
  });
  const anchors: unknown[] = [];
  if (format === "rich_text") {
    const loaded = await restoreDocument(db, resource.id);
    try {
      const editor = createEditor();
      editor.children = loaded.runtime.getValue();
      for (let i = 0; i < lines.length; i++)
        anchors.push(
          captureRichSelection(editor, loaded.runtime, {
            anchor: { path: [i + 1, 0], offset: 0 },
            focus: { path: [i + 1, 0], offset: lines[i]!.length },
          }),
        );
    } finally {
      loaded.destroy();
    }
  } else {
    const loaded = await restoreMarkdown(db, resource.id);
    try {
      const text = loaded.doc.getText("markdown");
      for (const line of lines) {
        const from = text.toString().indexOf(line);
        anchors.push(
          encodeMarkdownAnchor(
            createMarkdownTextAnchor(text, from, from + line.length),
            loaded.epochId,
            line,
          ),
        );
      }
    } finally {
      loaded.destroy();
    }
  }
  const ids: string[] = [];
  for (const [i, anchor] of anchors.entries()) {
    const thread = await content.comment(
      owner,
      resource.id,
      {
        version: 1,
        blocks: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: (i ? "Second " : "First ") + format + " comment",
              },
            ],
          },
        ],
      },
      null,
      JSON.stringify(anchor),
    );
    ids.push(thread.id);
  }
  documents.push({ format, id: resource.id, comment: ids[0]!, comments: ids });
}
const documentStates = () =>
  db
    .selectFrom("document_states")
    .select(["resource_id", "seq", "checkpoint"])
    .where(
      "resource_id",
      "in",
      documents.map((doc) => doc.id),
    )
    .orderBy("resource_id")
    .execute();
const baseline = await documentStates();
const origin = "http://127.0.0.1:" + (process.env.DOCA_QA_PORT ?? "39829");
const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
const app = await createApp(db, {
  origin,
  ...(builtWeb ? { staticDirectory: resolve("apps/web/dist") } : {}),
  storage: storageRuntime(),
  ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      await new Promise((resolve) => setTimeout(resolve, 45000));
      return completionResponse(
        {
          id: "fixture-response",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "隔离流式消息验证。".repeat(30),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            total_tokens: 200,
          },
        },
        !!body.stream,
        body.stream ? 250 : 0,
      );
    }) as typeof fetch,
  },
});
await app.listen({
  host: "127.0.0.1",
  port: builtWeb ? Number(new URL(origin).port) : 0,
});
const address = app.server.address();
if (!address || typeof address === "string")
  throw new Error("Fixture listen failed");
const web = builtWeb
  ? undefined
  : await createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      cacheDir: output + "/vite",
      server: {
        host: "127.0.0.1",
        port: Number(new URL(origin).port),
        strictPort: true,
        hmr: false,
        proxy: {
          "/api": { target: `http://127.0.0.1:${address.port}`, ws: true },
        },
      },
    });
await web?.listen();
await sharp({
  create: { width: 320, height: 200, channels: 3, background: "#c8dfff" },
})
  .png()
  .toFile(output + "/comment.png");
const fixture = {
  origin,
  document: canvas.id,
  comment: comment.id,
  url: origin + "/#/r/" + canvas.id + "?comment=" + comment.id,
  login: "issueqa",
  password: "isolated-issue-20261028",
  image: output + "/comment.png",
  documents: documents.map((doc) => ({
    ...doc,
    url: origin + "/#/r/" + doc.id + "?comment=" + doc.comment,
  })),
};
await writeFile(output + "/fixture.json", JSON.stringify(fixture, null, 2));
console.log(JSON.stringify(fixture));
const startedAt = Date.now();
async function recordState() {
  const current = await documentStates();
  await writeFile(
    output + "/document-states.json",
    JSON.stringify(
      {
        elapsedMs: Date.now() - startedAt,
        baseline,
        current,
        unchanged: JSON.stringify(baseline) === JSON.stringify(current),
      },
      null,
      2,
    ),
  );
}
const observation = setInterval(() => void recordState(), 2000);
process.once("SIGINT", async () => {
  clearInterval(observation);
  await recordState();
  await web?.close();
  await app.close();
  await db.destroy();
  process.exit(0);
});
