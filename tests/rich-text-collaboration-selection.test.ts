import { describe, expect, it } from "vitest";
import { createEditor, Editor, Element, Transforms } from "slate";
import { withHistory } from "slate-history";
import { withRichBlocks } from "@smartdoca/slate";
import {
  Doc,
  applyUpdate,
  createYjsAdapter,
  encodeStateAsUpdate,
  YjsDocument,
} from "@smartdoca/slate/yjs";

const initialValue = [
  {
    id: "paragraph",
    type: "paragraph",
    children: [{ text: "before selected after" }],
  },
];

function replicas() {
  const local = new YjsDocument(new Doc());
  local.initialize(structuredClone(initialValue) as never);
  const remote = new YjsDocument(new Doc());
  applyUpdate(remote.doc, encodeStateAsUpdate(local.doc));

  const editor = withRichBlocks(withHistory(createEditor()));
  const disconnect = createYjsAdapter(local).connect!(editor) as () => void;
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: 7 },
    focus: { path: [0, 0], offset: 15 },
  });
  return { local, remote, editor, disconnect };
}

describe("rich-text collaboration selection", () => {
  it("keeps the selected text when a remote mark splits its Slate leaf", () => {
    const { local, remote, editor, disconnect } = replicas();
    let localWrites = 0;
    const stopLocal = local.onLocalUpdate(() => localWrites++);
    const before = remote.getValue();
    const after = structuredClone(before);
    const paragraph = after[0];
    if (!paragraph || !Element.isElement(paragraph))
      throw new Error("Expected a paragraph fixture");
    paragraph.children = [
      { text: "before " },
      { text: "selected", underline: true },
      { text: " after" },
    ];

    remote.acceptEditorValue(before, after);
    local.applyRemoteUpdate(encodeStateAsUpdate(remote.doc));

    expect(editor.selection && Editor.string(editor, editor.selection)).toBe(
      "selected",
    );
    expect(localWrites).toBe(0);
    stopLocal();
    disconnect();
    local.destroy();
    remote.destroy();
    local.doc.destroy();
    remote.doc.destroy();
  });

  it("tracks the selected text through a remote insertion before it", () => {
    const { local, remote, editor, disconnect } = replicas();

    remote.editText("paragraph", 0, 0, "remote ");
    local.applyRemoteUpdate(encodeStateAsUpdate(remote.doc));

    expect(editor.selection && Editor.string(editor, editor.selection)).toBe(
      "selected",
    );
    disconnect();
    local.destroy();
    remote.destroy();
    local.doc.destroy();
    remote.doc.destroy();
  });
});
