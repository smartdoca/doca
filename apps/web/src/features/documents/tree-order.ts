export type TreePlacement = "before" | "after" | "inside";
/** Edge zones are intentionally smaller than the middle nesting zone. */
export function treePlacement(
  y: number,
  top: number,
  height: number,
): TreePlacement {
  const edge = Math.min(9, height * 0.25);
  return y < top + edge
    ? "before"
    : y >= top + height - edge
      ? "after"
      : "inside";
}
