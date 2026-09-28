import type { SceneNode } from "@smartdoca/canvas/model";

// AidCanvas 0.4.1 uses `tag` for rendering and `name` for its native
// properties/commands. Both are needed; IDs remain owned by CanvasModel.
const nativeNames: Record<string, string> = {
  Rect: "rect",
  Ellipse: "ellipse",
  Text: "text",
  Image: "image",
  Line: "line",
  Arrow: "arrow",
  Path: "path",
  Polygon: "polygon",
  Star: "star",
  Group: "group",
  Frame: "frame",
};

export function nativeCanvasElement(element: SceneNode): SceneNode {
  const name = nativeNames[element.tag ?? ""];
  return {
    ...element,
    ...(!element.name && name
      ? {
          name:
            element.tag === "Line" &&
            element.endArrow &&
            element.endArrow !== "none"
              ? "arrow"
              : name,
        }
      : {}),
    ...(element.children
      ? { children: element.children.map(nativeCanvasElement) }
      : {}),
  };
}
