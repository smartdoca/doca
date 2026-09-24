/** Reveal in the nearest vertical scrollport without moving horizontal ancestors.
 * Native scrollIntoView also scrolls overflow:hidden shells and animated drawers.
 */
export function scrollCommentIntoView(
  target: Element | null | undefined,
  block: "nearest" | "center" = "nearest",
) {
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (!/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) continue;
    if (parent.scrollHeight <= parent.clientHeight) continue;
    const box = target.getBoundingClientRect();
    const port = parent.getBoundingClientRect();
    const top = port.top + parent.clientTop;
    const bottom = top + parent.clientHeight;
    const delta = block === "center"
      ? (box.top + box.bottom - top - bottom) / 2
      : box.top < top ? box.top - top
        : box.bottom > bottom ? Math.min(box.bottom - bottom, box.top - top) : 0;
    if (delta) parent.scrollTo({ top: parent.scrollTop + delta, behavior: "smooth" });
    return;
  }
}
