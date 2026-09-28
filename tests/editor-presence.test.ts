import { expect, it } from "vitest";
import { createEditor } from "slate";
import { Doc, YjsDocument } from "@smartdoca/slate/yjs";
import { blockOffset, slatePoint } from "../apps/web/src/features/documents/editor-presence.js";

it("maps marked leaves, emoji UTF-16 offsets and mention object markers without using visible name length", () => {
  const editor = createEditor();
  editor.isInline = (n) => String(n.type) === "mention";
  editor.children = [
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "你好🙂", bold: true },
        {
          id: "m",
          type: "mention",
          userId: "u",
          name: "很长的用户名称",
          children: [{ text: "" }],
        },
        { text: "后半段" },
      ],
    },
  ] as unknown as typeof editor.children;
  expect(blockOffset(editor, { path: [0, 2], offset: 2 })).toEqual({
    blockId: "p",
    offset: 7,
  });
  expect(slatePoint(editor, "p", 7)).toEqual({ path: [0, 2], offset: 2 });
  expect(slatePoint(editor, "missing", 0)).toBeNull();
});

it("a cursor relative point follows concurrent text inserted before it", () => {
  const doc = new Doc(),
    runtime = new YjsDocument(doc);
  try {
    runtime.initialize([
      { id: "p", type: "paragraph", children: [{ text: "abcdef" }] },
    ]);
    const cursor = runtime.createCommentAnchor("p", 3, 3);
    runtime.editText("p", 0, 0, "你好");
    expect(runtime.resolveCommentAnchor(cursor).start).toBe(5);
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});
