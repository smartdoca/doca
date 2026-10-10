import { expect, it } from "vitest";
import { createEditor, type Descendant, type Range } from "slate";
import { Doc, encodeStateAsUpdate } from "@smartdoca/slate/yjs";
import { DocaYjsDocument } from "@core/modules/documents/codecs/rich-runtime.js";
import { captureRichSelection } from "../apps/web/src/features/comments/rich-selection-anchor.js";
import {
  canonicalRichAnchor,
  resolveRichAnchor,
  richAnchorParts,
} from "@core/modules/documents/codecs/rich-anchor.js";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
const commentBody = (text: string) => ({
  version: 1 as const,
  blocks: [
    { type: "paragraph" as const, children: [{ type: "text" as const, text }] },
  ],
});

const value: Descendant[] = [
  {
    id: "a",
    type: "paragraph",
    children: [{ text: "Hello " }, { text: "world", bold: true }],
  },
  { id: "b", type: "paragraph", title: "h2", children: [{ text: "Second line" }] },
  { id: "empty", type: "paragraph", children: [{ text: "" }] },
  { id: "c", type: "paragraph", children: [{ text: "Last paragraph" }] },
];
const selection: Range = {
  anchor: { path: [0, 1], offset: 1 },
  focus: { path: [3, 0], offset: 4 },
};
function fixture() {
  const doc = new Doc(),
    runtime = new DocaYjsDocument(doc),
    editor = createEditor();
  runtime.initialize(value);
  editor.children = structuredClone(value);
  return {
    doc,
    runtime,
    editor,
    close: () => {
      runtime.destroy();
      doc.destroy();
    },
  };
}
it("captures forward/backward multiline selections including formatted leaves without writes", () => {
  const f = fixture();
  try {
    let writes = 0;
    f.doc.on("update", () => writes++);
    const a = captureRichSelection(f.editor, f.runtime, selection, "epoch");
    const b = captureRichSelection(
      f.editor,
      f.runtime,
      { anchor: selection.focus, focus: selection.anchor },
      "epoch",
    );
    expect(a).toEqual(b);
    expect(a.quote).toBe("orld\nSecond line\nLast");
    expect(a.segments?.map((p) => p.blockId)).toEqual(["a", "b", "c"]);
    expect(
      resolveRichAnchor(f.runtime, a).map((p) => [p.blockId, p.start, p.end]),
    ).toEqual([
      ["a", 7, 11],
      ["b", 0, 11],
      ["c", 0, 4],
    ]);
    expect(writes).toBe(0);
    const single = captureRichSelection(f.editor, f.runtime, {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 1], offset: 3 },
    });
    expect(single.segments).toBeUndefined();
    expect(single.quote).toBe("llo wor");
  } finally {
    f.close();
  }
});
it("ignores collapsed endpoint blocks and rejects empty or oversized selections", () => {
  const f = fixture();
  try {
    const a = captureRichSelection(f.editor, f.runtime, {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
    expect(a.segments).toBeUndefined();
    expect(a.quote).toBe("Hello world");
    expect(() =>
      captureRichSelection(f.editor, f.runtime, {
        anchor: selection.anchor,
        focus: selection.anchor,
      }),
    ).toThrow();
    expect(() => richAnchorParts({ segments: [] })).toThrow();
    expect(() => richAnchorParts({ segments: Array(201).fill(a) })).toThrow();
    expect(() => richAnchorParts({ segments: [a, a] })).toThrow();
    expect(() => richAnchorParts({ ...a, quote: "x".repeat(5001) })).toThrow();
  } finally {
    f.close();
  }
});
it("resolves every segment after concurrent edits/checkpoint restore and survives partial deletion", () => {
  const f = fixture(),
    doc = new Doc(),
    peer = new DocaYjsDocument(doc);
  try {
    peer.applyRemoteUpdate(encodeStateAsUpdate(f.doc));
    const anchor = captureRichSelection(f.editor, f.runtime, selection);
    let echoes = 0;
    const stop = peer.onLocalUpdate(() => echoes++);
    peer.applyRemoteUpdate(f.runtime.editText("a", 0, 0, "prefix "));
    expect(echoes).toBe(0);
    stop();
    f.runtime.applyRemoteUpdate(peer.editText("b", 4, 0, " new"));
    expect(f.runtime.getValue()).toEqual(peer.getValue());
    const restoredDoc = new Doc(),
      restored = new DocaYjsDocument(restoredDoc);
    try {
      restored.restore(encodeStateAsUpdate(f.doc));
      expect(resolveRichAnchor(restored, anchor)).toEqual(
        resolveRichAnchor(peer, anchor),
      );
      expect(resolveRichAnchor(restored, anchor)[0]?.start).toBe(14);
      restored.execute({ type: "deleteBlock", blockId: "a" });
      expect(resolveRichAnchor(restored, anchor).map((p) => p.blockId)).toEqual(
        ["b", "c"],
      );
      restored.execute({ type: "deleteBlock", blockId: "b" });
      restored.execute({ type: "deleteBlock", blockId: "c" });
      expect(resolveRichAnchor(restored, anchor)).toEqual([]);
    } finally {
      restored.destroy();
      restoredDoc.destroy();
    }
  } finally {
    f.close();
    peer.destroy();
    doc.destroy();
  }
});
it("persists one multiline comment and provides all ranges to AI with server-derived quotes and ACL checks", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const owner = {
      ...(await createUser(
        db,
        {
          login: "rangeowner",
          displayName: "Owner",
          password: "anchor-test-password",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    const other = {
      ...(await createUser(
        db,
        {
          login: "rangeother",
          displayName: "Other",
          password: "anchor-test-password",
        },
        { actor: owner },
      )),
      admin: 0,
    };
    const content = createContent(db);
    const resource = await content.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Cross-line QA",
      initialContent: { schemaVersion: 2, children: value },
    });
    const loaded = await restoreDocument(db, resource.id);
    try {
      const editor = createEditor();
      editor.children = loaded.runtime.getValue();
      const anchor = captureRichSelection(editor, loaded.runtime, selection);
      const forged = {
        ...anchor,
        quote: "forged",
        segments: anchor.segments!.map((p) => ({ ...p, quote: "forged" })),
      };
      expect(canonicalRichAnchor(loaded.runtime, forged).quote).toBe(
        anchor.quote,
      );
      await content.comment(
        owner,
        resource.id,
        commentBody("Across paragraphs"),
        null,
        JSON.stringify(forged),
      );
      const detail = await content.detail(owner, resource.id);
      expect(detail.comments).toHaveLength(1);
      const stored = JSON.parse(detail.comments[0]!.anchor!);
      expect(stored.quote).toBe(anchor.quote);
      expect(stored.segments).toHaveLength(3);
      const ai = await readAIDocument(
        db,
        { actor: owner },
        resource.id,
        stored,
      );
      expect(ai.region).toMatchObject({
        quote: anchor.quote,
        ranges: [{ blockId: "a" }, { blockId: "b" }, { blockId: "c" }],
      });
      await expect(
        readAIDocument(db, { actor: other }, resource.id, stored),
      ).rejects.toThrow();
      await expect(
        content.comment(
          other,
          resource.id,
          commentBody("No access"),
          null,
          JSON.stringify(stored),
        ),
      ).rejects.toThrow();
      await expect(
        content.comment(
          owner,
          resource.id,
          commentBody("Bad anchor"),
          null,
          JSON.stringify({
            ...anchor,
            segments: [{ ...anchor.segments![0], start: "invalid" }],
          }),
        ),
      ).rejects.toThrow();
      expect(ai.seq).toBe(0);
    } finally {
      loaded.destroy();
    }
  } finally {
    await db.destroy();
  }
});
it("anchors a selected image or file without a text range", () => {
  const doc = new Doc(),
    runtime = new DocaYjsDocument(doc),
    editor = createEditor();
  const baseVoid = editor.isVoid.bind(editor);
  editor.isVoid = (element) =>
    ["image", "video", "attachment"].includes(String(element.type)) ||
    baseVoid(element);
  const media: Descendant[] = [
    { id: "p", type: "paragraph", children: [{ text: "前文" }] },
    {
      id: "img",
      type: "image",
      alt: "封面",
      path: "img",
      children: [{ text: "" }],
    },
    {
      id: "file",
      type: "attachment",
      name: "说明.pdf",
      path: "file",
      children: [{ text: "" }],
    },
  ];
  runtime.initialize(media);
  editor.children = runtime.getValue();
  try {
    const image = captureRichSelection(editor, runtime, {
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
    expect(image).toMatchObject({
      kind: "block",
      blockId: "img",
      quote: "封面",
    });
    expect(resolveRichAnchor(runtime, image)).toEqual([
      { blockId: "img", start: 0, end: 0, orphaned: false, kind: "block" },
    ]);
    expect(
      canonicalRichAnchor(runtime, { ...image, quote: "forged" }).quote,
    ).toBe("封面");
    const file = captureRichSelection(editor, runtime, {
      anchor: { path: [2, 0], offset: 0 },
      focus: { path: [2, 0], offset: 0 },
    });
    expect(canonicalRichAnchor(runtime, file).quote).toBe("说明.pdf");
    expect(resolveRichAnchor(runtime, { ...file, blockId: "missing" })).toEqual(
      [],
    );
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});

it("captures native diagrams for comments and AI references through edit, restore and deletion without writes", () => {
  const doc = new Doc(), runtime = new DocaYjsDocument(doc), editor = createEditor();
  editor.isVoid = (node) => ["flowchart", "mindmap"].includes(String(node.type));
  runtime.initialize([
    { id: "flow", type: "flowchart", nodes: [{ id: "s", label: "开始", x: 0, y: 0 }, { id: "e", label: "交付", x: 200, y: 0 }], edges: [{ id: "edge", source: "s", target: "e" }], children: [{ text: "" }] },
    { id: "mind", type: "mindmap", mindData: { nodeData: { id: "root", topic: "项目计划" } }, children: [{ text: "" }] },
  ]);
  editor.children = runtime.getValue();
  let writes = 0;
  doc.on("update", () => writes++);
  const collapsed = (index: number) => ({ anchor: { path: [index, 0], offset: 0 }, focus: { path: [index, 0], offset: 0 } });
  const restoredDoc = new Doc(), restored = new DocaYjsDocument(restoredDoc);
  try {
    const flow = captureRichSelection(editor, runtime, collapsed(0), "epoch");
    const mind = captureRichSelection(editor, runtime, collapsed(1), "epoch");
    expect(flow).toMatchObject({ kind: "block", blockId: "flow", quote: "开始 → 交付", epochId: "epoch" });
    expect(mind.quote).toBe("项目计划");
    expect(canonicalRichAnchor(runtime, { ...flow, quote: "forged" }).quote).toBe("开始 → 交付");
    expect(captureRichSelection(editor, runtime, { anchor: collapsed(0).anchor, focus: collapsed(1).focus }).segments?.map((p) => p.blockId)).toEqual(["flow", "mind"]);
    expect(writes).toBe(0);
    restored.restore(encodeStateAsUpdate(doc));
    expect(resolveRichAnchor(restored, flow)).toEqual(resolveRichAnchor(runtime, flow));
    expect(resolveRichAnchor(restored, mind)).toHaveLength(1);
    const nodes = (restored.getValue()[0] as any).nodes;
    restored.execute({ type: "setBlock", blockId: "flow", properties: { nodes: nodes.map((n: any) => ({ ...n, fillColor: "#dbeafe" })) } });
    expect(resolveRichAnchor(restored, flow)).toHaveLength(1);
    restored.execute({ type: "deleteBlock", blockId: "flow" });
    expect(resolveRichAnchor(restored, flow)).toEqual([]);
    expect(resolveRichAnchor(restored, mind)).toHaveLength(1);
  } finally {
    restored.destroy(); restoredDoc.destroy(); runtime.destroy(); doc.destroy();
  }
});
