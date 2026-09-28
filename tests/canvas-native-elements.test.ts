import { expect, it } from "vitest";
import { nativeCanvasElement } from "@core/shared/canvas-elements.js";
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
