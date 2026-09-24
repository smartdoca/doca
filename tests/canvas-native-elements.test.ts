import { expect, it } from "vitest";
import { CanvasModel } from "aidcanvas/model";
import { nativeCanvasElement } from "@core/shared/canvas-elements.js";
import { withNativeCanvasView } from "../apps/web/src/features/documents/canvas-model-view.js";
import { validateEditOperations } from "@core/modules/ai/edit-schema.js";

it("rejects descriptive names and classification changes that hide native controls", () => {
  expect(() =>
    validateEditOperations("canvas", [
      { type: "add", element: { tag: "Image", name: "cat photo" } },
    ]),
  ).toThrow("原生工具分类");
  expect(() =>
    validateEditOperations("canvas", [
      { type: "patch", id: "picture", patch: { name: "rect" } },
    ]),
  ).toThrow("不能改变");
});

it("restores legacy AI controls without writes, replacing IDs or resetting a peer's changes", () => {
  const original = CanvasModel.initialize("native-qa", {
    version: 1,
    scene: {
      children: [
        {
          id: "picture",
          tag: "Image",
          width: 200,
          height: 100,
          data: { resourcePath: "asset" },
        },
        { id: "caption", tag: "Text", text: "hello" },
        { id: "box", tag: "Rect", width: 20 },
      ],
    },
  });
  const saved = original.checkpoint();
  const view = withNativeCanvasView(CanvasModel.restore(saved));
  const writes: Uint8Array[] = [];
  view.onLocalUpdate((u) => writes.push(u.update));
  try {
    const base = view.getValue().scene;
    expect(base.children?.map((n) => n.name)).toEqual([
      "image",
      "text",
      "rect",
    ]);
    expect(view.checkpoint().update).toEqual(saved.update);
    view.applyScene(base, base);
    expect(writes).toHaveLength(0);
    original.patch("caption", { text: "peer" });
    view.applyUpdate(original.checkpoint());
    expect(writes).toHaveLength(0);
    const current = view.getValue().scene;
    const changed = structuredClone(current);
    changed.children![0]!.width = 250;
    view.applyScene(changed, current);
    original.applyUpdate(view.checkpoint());
    const reloaded = withNativeCanvasView(
      CanvasModel.restore(view.checkpoint()),
    );
    expect(reloaded.getValue().scene).toEqual(view.getValue().scene);
    expect(original.getValue().scene.children?.map((n) => n.id)).toEqual([
      "picture",
      "caption",
      "box",
    ]);
    expect(original.getValue().scene.children?.[1]?.text).toBe("peer");
    expect(original.getValue().scene.children?.[0]?.width).toBe(250);
    reloaded.dispose();
  } finally {
    view.dispose();
    original.dispose();
  }
});

it("assigns native tools recursively and preserves explicit custom elements", () => {
  const result = nativeCanvasElement({
    tag: "Group",
    id: "group",
    children: [
      { tag: "Ellipse", id: "ellipse" },
      { tag: "Line", id: "arrow", endArrow: "angle" },
      { tag: "Path", id: "custom", name: "special-shape" },
    ],
  });
  expect(result.name).toBe("group");
  expect(result.children?.map((n) => n.name)).toEqual([
    "ellipse",
    "arrow",
    "special-shape",
  ]);
});
