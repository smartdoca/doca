import { useCallback, useEffect, useState } from "react";
import type { Detail } from "@web/shared/api.js";

/** Content backgrounds follow explicit comment clicks, independently of navigation. */
export function useCommentHighlight(
  resourceId: string,
  comments: Detail["comments"],
) {
  const [selection, setSelection] = useState<{
    resourceId: string;
    id: string;
  } | null>(null);
  const highlighted =
    selection?.resourceId === resourceId &&
    comments.some(
      (comment) =>
        comment.id === selection.id &&
        comment.anchor &&
        !comment.parent_id &&
        !comment.resolved &&
        !comment.deleted_at,
    )
      ? selection.id
      : null;
  const highlight = useCallback(
    (id: string | null) => {
      setSelection(id ? { resourceId, id } : null);
    },
    [resourceId],
  );
  useEffect(() => {
    if (!highlighted) return;
    const clearOutside = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId !==
        highlighted
      )
        highlight(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") highlight(null);
    };
    // Capture also sees SDK/composer events that intentionally stop bubbling.
    document.addEventListener("pointerdown", clearOutside, true);
    document.addEventListener("click", clearOutside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", clearOutside, true);
      document.removeEventListener("click", clearOutside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [highlighted, highlight]);
  // A resolved/deleted thread must not regain its old background if reopened.
  useEffect(() => {
    if (selection && !highlighted) setSelection(null);
  }, [selection, highlighted]);
  return [highlighted, highlight] as const;
}
