import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ReactEditor } from "slate-react";
import type { RichTextEditorHandle } from "slatetsx-kit-editor";
import type { YjsDocument } from "slatetsx-kit-editor/yjs";
import { slatePoint } from "@web/features/documents/editor-presence.js";
import { resolveRichAnchor } from "@core/modules/documents/codecs/rich-anchor.js";
import { commentRailHeight, placeCommentCards } from "@web/features/comments/comment-position.js";

/** Each root thread stays a separate card, aligned to its own live CRDT anchor. */
export function CommentCards({
  children,
  compact,
  handle,
  runtime,
}: {
  children: ReactNode;
  compact: boolean;
  handle: RefObject<RichTextEditorHandle | null>;
  runtime: YjsDocument;
}) {
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    let lastSourceOffset: number | undefined;
    function layout() {
      const host = rail.current,
        editor = handle.current?.editor;
      if (!host || !editor) return;
      const cards = Array.from(host.children) as HTMLElement[];
      const panel = host.closest<HTMLElement>(".content-comments");
      const source = host.closest<HTMLElement>(".main-scroll");
      if (!compact && panel) panel.scrollTop = 0;
      const sourceOffset = compact ? source?.scrollTop ?? 0 : 0;
      // Convert viewport anchor coordinates into the drawer's source-aligned rail.
      const drawerOffset = compact ? sourceOffset - (panel?.scrollTop ?? 0) : 0;
      const top = host.getBoundingClientRect().top;
      const positions = cards
        .map((card) => {
          // Measure at the final rail width, including expanded replies/images.
          card.style.width = "100%";
          let target = 0;
          try {
            const a = JSON.parse(card.dataset.anchor!);
            const p = resolveRichAnchor(runtime, a)[0];
            if (p?.kind === "block") {
              const el = document.querySelector(`[data-block-id="${CSS.escape(p.blockId)}"]`);
              if (el) target = el.getBoundingClientRect().top - top + drawerOffset;
            } else {
              const point = p && slatePoint(editor, p.blockId, p.start);
              if (point) {
                const range = ReactEditor.toDOMRange(editor, {
                  anchor: point,
                  focus: point,
                });
                target = (range.getClientRects()[0]?.top ?? top) - top + drawerOffset;
              }
            }
          } catch {
            /* Deleted anchors remain separate, accessible cards. */
          }
          return { card, target };
        })
        .sort((a, b) => a.target - b.target);
      let bottom = 0;
      const placed = placeCommentCards(
        positions.map(({ card, target }, order) => ({
          id: String(order),
          order,
          target,
          height: card.offsetHeight,
        })),
      );
      for (const { id, top: y } of placed) {
        const card = positions[Number(id)]!.card;
        card.style.position = "absolute";
        card.style.top = `${y}px`;
        bottom = y + card.offsetHeight + 16;
      }
      if (compact && panel && source) {
        const railOffset = top - panel.getBoundingClientRect().top + panel.scrollTop;
        host.style.height = `${commentRailHeight(bottom, source.scrollHeight - source.clientHeight, panel.clientHeight, railOffset)}px`;
        // Extend the rail before setting scrollTop, avoiding browser clamping.
        // Manual drawer scrolling remains possible until the document moves again.
        if (lastSourceOffset !== sourceOffset) panel.scrollTop = sourceOffset;
        lastSourceOffset = sourceOffset;
      } else host.style.height = `${bottom}px`;
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    if (rail.current) {
      Array.from(rail.current.children).forEach((c) => observer.observe(c));
      const editor = rail.current
        .closest(".editor-columns")
        ?.querySelector(".editor-content");
      if (editor) observer.observe(editor);
    }
    runtime.doc.on("update", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      runtime.doc.off("update", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [children, compact, handle, runtime]);
  return (
    <div className="comment-cards" ref={rail}>
      {children}
    </div>
  );
}
