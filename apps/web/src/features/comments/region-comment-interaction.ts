/** Editor pointer events arrive before the SDK resolves the clicked anchor.
 * Keep the drawer mounted throughout that sequence, including canvas cells.
 */
export function isRegionCommentInteraction(panel: HTMLElement | null, target: Element) {
  return Boolean(
    panel?.contains(target) ||
    panel?.closest(".surface-editor")?.contains(target) ||
    target.closest(".region-comment-toggle,.region-comment-add,.comment-popover,.user-card,[data-anchor-id],[data-comment-id]"),
  );
}

/** Overlapping regions must not deselect a thread that is still a candidate. */
export function activeCommentCandidate(active: string | null, ids: string[]) {
  return active && ids.includes(active) ? active : ids.length === 1 ? ids[0]! : null;
}
