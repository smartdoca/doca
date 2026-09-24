export type DocumentScrollEdge = "top" | "bottom";

export function scrollBoundary(edge: DocumentScrollEdge, contentHeight: number, viewportHeight: number) {
  return edge === "top" ? 0 : Math.max(0, contentHeight - viewportHeight);
}

/** View-only: leave the editor mode, selection and collaborative model untouched. */
export function scrollDocumentBoundary(
  root: HTMLElement,
  edge: DocumentScrollEdge,
  behavior: ScrollBehavior = "smooth",
) {
  const outer = root.querySelector<HTMLElement>(":scope > .main-scroll");
  if (!outer) return;
  // Markdown has nested scrolling. Move both visible columns to the same end,
  // including CodeMirror's scroller. The outer viewport stays above discussion.
  for (const pane of Array.from(outer.querySelectorAll<HTMLElement>(
    ".markdown-sdk-container .editor-pane, .markdown-sdk-container .preview-pane, .markdown-sdk-container .cm-scroller",
  ))) {
    const rect = pane.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0)
      pane.scrollTop = scrollBoundary(edge, pane.scrollHeight, pane.clientHeight);
  }
  const markdown = outer.querySelector(".markdown-sdk-container");
  const content = outer.querySelector<HTMLElement>('.editor-content [data-slate-editor="true"]');
  // Use the actual rich-text body, not the page's scrollHeight: the comment rail,
  // likes and whole-document discussion can all extend beyond the last block.
  const contentBottom = content
    ? content.getBoundingClientRect().bottom - outer.getBoundingClientRect().top + outer.scrollTop - outer.clientTop
    : 0;
  const top = edge === "bottom" && !markdown && content
    ? Math.min(scrollBoundary("bottom", outer.scrollHeight, outer.clientHeight), scrollBoundary("bottom", contentBottom, outer.clientHeight))
    : 0;
  outer.scrollTo({ top, behavior });
}
