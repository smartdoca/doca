import { it, expect } from "vitest";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as Y from "yjs";
import { YjsDocument } from "slatetsx-kit-editor/yjs";
import { CanvasModel } from "aidcanvas/model";
import {
  readDocument,
  resolveAnchor,
  REMOTE_ORIGIN,
  isLocalContentOrigin,
} from "@eppt/editor/core";
import { restoreExlsxDocument } from "@online-office/univer-sheet/yjs";
import { projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import {
  assertSupportedMarkdownDocument,
  getMarkdownText,
  resolveMarkdownTextAnchor,
  applyRemoteMarkdownUpdate,
} from "exmd-collaborative-editor";

// Retain isolated extracted fixtures for inspection; never open user documents.
async function previous(artifact: string, packageName: string, entry: string) {
  const root = mkdtempSync(join(tmpdir(), "doca-package-upgrade-"));
  execFileSync("tar", ["-xzf", resolve("vendor", artifact), "-C", root]);
  const packageParent = dirname(
    realpathSync(resolve("node_modules", packageName)),
  );
  symlinkSync(
    packageName.startsWith("@") ? dirname(packageParent) : packageParent,
    join(root, "package/node_modules"),
  );
  return import(pathToFileURL(join(root, "package/dist", entry)).href);
}

it.each([
  "eppt-editor-0.2.1-0c3ccbc50090.tgz",
  "eppt-editor-0.2.1-fb2db7f69a7f.tgz",
  "eppt-editor-0.2.1-f549b182489c.tgz",
  "eppt-editor-0.2.1-361a4df1eea3.tgz",
  "eppt-editor-0.3.0-alpha.1-90deec2cb723.tgz",
])(
  "PPT layout upgrade from %s preserves checkpoint identities and element comments",
  async (artifact) => {
    const old = await previous(artifact, "@eppt/editor", "core.js");
    const source = old.createYDocument(old.createPresentation()),
      target = new Y.Doc();
    try {
      const value = old.readDocument(source),
        slideId = value.slideOrder[0];
      const elementIds = value.slides[slideId].elementOrder;
      const anchor = { type: "elements" as const, slideId, elementIds };
      const checkpoint = Y.encodeStateAsUpdate(source);
      let writes = 0;
      target.on("update", (_bytes, origin) => {
        if (isLocalContentOrigin(origin)) writes++;
      });
      Y.applyUpdate(target, checkpoint, REMOTE_ORIGIN);
      expect(readDocument(target)).toEqual(value);
      expect(Y.encodeStateAsUpdate(target)).toEqual(checkpoint);
      expect(resolveAnchor(target, anchor)).toBeTruthy();
      expect(writes).toBe(0);
    } finally {
      source.destroy();
      target.destroy();
    }
  },
);

it.each([
  "exmd-collaborative-editor-0.4.1-3d1fcbdfafc1.tgz",
  "exmd-collaborative-editor-0.4.2-df2b636669cd.tgz",
])(
  "Markdown checkpoint from %s and precise comment range survive layout upgrade",
  async (artifact) => {
    const old = await previous(
      artifact,
      "exmd-collaborative-editor",
      "index.js",
    );
    const a = new Y.Doc(),
      b = new Y.Doc();
    try {
      old.initializeMarkdownDocument(a, "# 标题\n旧版本评论范围\n");
      const text = old.getMarkdownText(a);
      const anchor = old.createMarkdownTextAnchor(text, 5, 8);
      const checkpoint = Y.encodeStateAsUpdate(a);
      applyRemoteMarkdownUpdate(b, checkpoint);
      assertSupportedMarkdownDocument(b);
      expect(Y.encodeStateAsUpdate(b)).toEqual(checkpoint);
      expect(getMarkdownText(b).toString()).toBe(text.toString());
      expect(resolveMarkdownTextAnchor(b, getMarkdownText(b), anchor)).toEqual({
        from: 5,
        to: 8,
      });
      getMarkdownText(b).insert(0, "新");
      expect(resolveMarkdownTextAnchor(b, getMarkdownText(b), anchor)).toEqual({
        from: 6,
        to: 9,
      });
    } finally {
      a.destroy();
      b.destroy();
    }
  },
);

it.each([
  "slatetsx-kit-editor-0.4.0-3da8bc66145d.tgz",
  "slatetsx-kit-editor-0.4.1-c80bc3be9654.tgz",
  "slatetsx-kit-editor-0.4.1-86a8cf2d8015.tgz",
  "slatetsx-kit-editor-0.4.1-5a812f97b1cc.tgz",
  "slatetsx-kit-editor-0.4.1-aa14d33ebfc7.tgz",
  "slatetsx-kit-editor-0.4.1-bb944b729731.tgz",
  "slatetsx-kit-editor-0.4.1-ad00cc441d48.tgz",
  "slatetsx-kit-editor-0.4.1-94537a2e836f.tgz",
  "slatetsx-kit-editor-0.4.1-38918ab1539e.tgz",
  "slatetsx-kit-editor-0.4.2-visuals-864e26b8fbd0.tgz",
  "slatetsx-kit-editor-0.4.3-a0fe473a5b5c.tgz",
  "slatetsx-kit-editor-0.4.4-1ce051a28e12.tgz",
  "slatetsx-kit-editor-0.4.5-8abdc3393b1c.tgz",
  "slatetsx-kit-editor-0.4.6-6d262e749438.tgz",
  "slatetsx-kit-editor-0.4.7-9d7dc617a269.tgz",
])(
  "rich checkpoint from %s restores without rewriting identities or emitting local edits",
  async (artifact) => {
    const old = await previous(artifact, "slatetsx-kit-editor", "yjs.js");
    const source = new Y.Doc(),
      target = new Y.Doc();
    const a = new old.YjsDocument(source),
      b = new YjsDocument(target);
    try {
      a.initialize([
        {
          id: "retained-block",
          type: "paragraph",
          children: [{ text: "保留的旧文档" }],
        },
      ]);
      a.editText("retained-block", 0, 0, "升级前 ");
      const checkpoint = Y.encodeStateAsUpdate(source);
      let writes = 0;
      b.onLocalUpdate(() => writes++);
      b.restore(checkpoint);
      expect(b.getValue()).toEqual(a.getValue());
      expect(Y.encodeStateAsUpdate(target)).toEqual(checkpoint);
      expect(writes).toBe(0);
      const update = b.editText("retained-block", 0, 0, "新版 ");
      a.applyRemoteUpdate(update);
      expect(b.getValue()).toEqual(a.getValue());
    } finally {
      a.destroy();
      b.destroy();
      source.destroy();
      target.destroy();
    }
  },
);

it.each([
  "aidcanvas-0.4.0-6983b228eb9e.tgz",
  "aidcanvas-0.4.1-ebf7d8848977.tgz",
])("canvas checkpoint from %s survives the current restore", async (artifact) => {
  const old = await previous(artifact, "aidcanvas", "model.js");
  const a = old.CanvasModel.initialize("kept-epoch", {
    version: 1,
    scene: {
      children: [
        {
          id: "kept-rect",
          tag: "Rect",
          width: 100,
          height: 80,
          fill: "#3366ff",
        },
      ],
    },
  });
  a.patch("kept-rect", { x: 40 });
  const checkpoint = a.checkpoint(),
    anchor = a.captureAnchor(["kept-rect"]);
  const b = CanvasModel.restore(checkpoint);
  try {
    expect(b.checkpoint()).toEqual(checkpoint);
    expect(b.getValue()).toEqual(a.getValue());
    expect(b.resolveAnchor(anchor).valid).toBe(true);
    let writes = 0;
    b.onLocalUpdate(() => writes++);
    b.applyUpdate(checkpoint);
    expect(writes).toBe(0);
    b.patch("kept-rect", { x: 80 });
    a.applyUpdate(b.checkpoint());
    expect(b.getValue()).toEqual(a.getValue());
  } finally {
    a.dispose();
    b.dispose();
  }
});

it.each([
  "online-office-univer-sheet-0.2.0-rc.5-6d45311dd066.tgz",
  "online-office-univer-sheet-0.2.0-rc.6-8666dbbc22b3.tgz",
  "online-office-univer-sheet-0.2.0-rc.7-2661dcf6c1c3.tgz",
  "online-office-univer-sheet-0.2.0-rc.7-0126666fe392.tgz",
  "online-office-univer-sheet-0.2.0-rc.13-051eab9f7414.tgz",
  "online-office-univer-sheet-0.2.0-rc.14-663c6007283f.tgz",
  "online-office-univer-sheet-0.2.0-rc.15-a82c0d180779.tgz",
])(
  "Excel %s baseline and legacy objects remain readable under the current candidate",
  async (artifact) => {
    const old = await previous(
      artifact,
      "@online-office/univer-sheet",
      "yjs.js",
    );
    const bundle = await old.createExlsxBaseline(
      {
        id: "workbook",
        name: "existing",
        locale: "zhCN",
        appVersion: "0.25.1",
        styles: {},
        sheetOrder: ["sheet"],
        sheets: {
          sheet: {
            id: "sheet",
            name: "Sheet1",
            rowCount: 30,
            columnCount: 20,
            cellData: {
              0: {
                0: {
                  v: "@测试",
                  custom: {
                    officeObject: {
                      version: 1,
                      kind: "mention",
                      id: "old-user",
                      label: "测试",
                    },
                  },
                },
                1: { v: 42, s: { bl: 1 } },
              },
            },
          },
        },
      },
      "kept-sheet-epoch",
    );
    const before = await old.restoreExlsxDocument(bundle),
      after = await restoreExlsxDocument(bundle);
    try {
      expect(Y.encodeStateAsUpdate(after)).toEqual(
        Y.encodeStateAsUpdate(before),
      );
      const snapshot = await projectExlsxWorkbook(bundle);
      expect(snapshot.sheets.sheet!.cellData?.[0]?.[0]?.v).toBe("@测试");
      expect(snapshot.sheets.sheet!.cellData?.[0]?.[0]?.custom).toEqual(
        bundle.baseline.snapshot.sheets.sheet.cellData[0][0].custom,
      );
    } finally {
      before.destroy();
      after.destroy();
    }
  },
);
