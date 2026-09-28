import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { type DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";
import { restoreSurface } from "@core/modules/documents/codecs/surfaces.js";
import { CanvasModel } from "@smartdoca/canvas/model";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import { importDocument } from "@smartdoca/slate/conversion";
import { createEditorDocument } from "@smartdoca/slate/headless";
import { validateImport } from "@core/modules/documents/import.js";
let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "importer",
        displayName: "Importer",
        password: "import-test-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());
it("imports Markdown with unsupported links as readable text through real host validation and reload", async () => {
  const unsafeLinks = ["./guide.md", "docs/authentication.md", "../README.md", "file:///tmp/private.md", "blob:temporary", "javascript:alert(1)"];
  const source = [
    "# 宽容导入验收",
    ...unsafeLinks.map((url, i) => `[保留标签${i}](<${url}>)`),
    "| 说明 | 文档 |\n| --- | --- |\n| 表格内容 | [表格中的相对链接](docs/guide.md) |",
    "[安全链接](https://example.com/guide)",
    "![失败图片的说明](https://example.com/missing.png)",
    "后续中文段落仍然保留。",
  ].join("\n\n");
  const converted = await importDocument(new File([source], "links.md", { type: "text/markdown" }), {
    filename: "links.md",
    resources: {
      signal: new AbortController().signal,
      importResource: async () => { throw Error("外部图片未自动下载，保留可读占位"); },
    },
  });
  expect(converted.warnings.length).toBeGreaterThan(0);
  expect(converted.resources).toHaveLength(0);
  const initialContent = createEditorDocument(converted.initialValue);
  expect(() => validateImport(initialContent)).not.toThrow();
  const links: string[] = [];
  function collect(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["url", "href"].includes(key) && typeof child === "string") links.push(child);
      collect(child);
    }
  }
  collect(initialContent);
  expect(links).toEqual(["https://example.com/guide"]);
  const r = await createContent(db).create(owner, {
    kind: "document", format: "rich_text", title: "links", initialContent,
  });
  const loaded = await restoreDocument(db, r.id);
  try {
    const text = JSON.stringify(loaded.runtime.getValue());
    for (let i = 0; i < unsafeLinks.length; i++) expect(text).toContain(`保留标签${i}`);
    expect(text).toContain("表格中的相对链接");
    expect(text).toContain("失败图片的说明");
    expect(text).toContain("后续中文段落仍然保留。");
    expect(r.title).toBe("宽容导入验收");
  } finally { loaded.destroy(); }
  // Lossy conversion is not a reason to bypass the server's safety boundary.
  expect(() => validateImport({ url: "file:///tmp/private.md" })).toThrow("不安全或临时链接");
});
it("initializes an unopened import once and refuses any overwrite", async () => {
  const content = createContent(db);
  const r = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Import",
  });
  const value = {
    schemaVersion: 2,
    children: [
      { id: "p", type: "paragraph", children: [{ text: "Imported once" }] },
    ],
  };
  await content.initializeImport(owner, r.id, value);
  await expect(content.initializeImport(owner, r.id, value)).rejects.toThrow(
    "不能覆盖",
  );
  const loaded = await restoreDocument(db, r.id);
  try {
    expect(loaded.runtime.getValue()[0]).toMatchObject({
      children: [{ text: "Imported once" }],
    });
  } finally {
    loaded.destroy();
  }
});
it("imports rich JSON atomically with a first-line title and restorable CRDT", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "rich_text",
    title: "filename",
    initialContent: {
      schemaVersion: 2,
      children: [
        {
          id: "p1",
          type: "paragraph",
          children: [{ text: "Import title", bold: true }],
        },
      ],
    },
  });
  expect(r.title).toBe("Import title");
  const loaded = await restoreDocument(db, r.id);
  try {
    expect(loaded.runtime.getValue()[0]).toMatchObject({
      children: [{ text: "Import title", bold: true }],
    });
    expect(loaded.state?.seq).toBe(0);
  } finally {
    loaded.destroy();
  }
});
it("imports a native canvas into a new canonical epoch without leaking view state", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "canvas",
    title: "Drawing",
    initialContent: {
      version: 1,
      scene: {
        children: [
          {
            id: "rect1",
            tag: "Rect",
            x: 20,
            y: 30,
            width: 80,
            height: 50,
            fill: "#ff0000",
          },
        ],
      },
    },
  });
  const loaded = await restoreSurface(db, r.id, "canvas"),
    model = CanvasModel.restore({
      codec: "aidcanvas-yjs",
      schemaVersion: 1,
      epochId: loaded.epochId,
      update: loaded.update,
    });
  try {
    expect(model.getValue().scene.children?.[0]).toMatchObject({
      id: "rect1",
      tag: "Rect",
      width: 80,
    });
    expect(loaded.state.seq).toBe(0);
  } finally {
    model.dispose();
  }
});
it("imports workbook snapshot as immutable baseline and restores its cells", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "Workbook",
    initialContent: {
      id: "old",
      name: "Old",
      appVersion: "0.25.1",
      locale: "zhCN",
      styles: {},
      sheetOrder: ["s"],
      sheets: {
        s: {
          id: "s",
          name: "Sheet1",
          rowCount: 50,
          columnCount: 20,
          cellData: { 0: { 0: { v: "Imported" } } },
        },
      },
    },
  });
  const loaded = await restoreSurface(db, r.id, "spreadsheet");
  expect(loaded.baseline!.schemaVersion).toBe(6);
  const snapshot = await projectExlsxWorkbook({
    baseline: loaded.baseline!,
    update: loaded.update,
    checkpointSeq: 0,
  });
  expect(snapshot.sheets.s?.cellData?.[0]?.[0]?.v).toBe("Imported");
});
it("rejects malformed, oversized and asset-bearing imports without leaving empty resources", async () => {
  const c = createContent(db);
  for (const initialContent of [
    { version: 1 },
    {
      version: 1,
      scene: {
        children: [{ tag: "Image", url: "https://example.com/image.png" }],
      },
    },
    {
      version: 1,
      scene: {
        children: [{ tag: "Image", data: { resourcePath: "foreign-asset" } }],
      },
    },
    {
      version: 1,
      scene: { children: [{ tag: "Rect", url: "javascript:alert(1)" }] },
    },
    { version: 1, scene: { children: [] }, extra: "a".repeat(800000) },
  ]) {
    await expect(
      c.create(owner, {
        kind: "document",
        format: "canvas",
        title: "Invalid",
        initialContent,
      }),
    ).rejects.toThrow();
  }
  expect(await db.selectFrom("resources").selectAll().execute()).toHaveLength(
    0,
  );
});
