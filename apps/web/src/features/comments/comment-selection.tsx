import { AIReferenceButton } from "@web/features/ai/ai-context.js";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";
import { Element, Range, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import type { RichTextEditorHandle } from "@smartdoca/slate";
import type { YjsDocument } from "@smartdoca/slate/yjs";
import type { Comment } from "@web/shared/api.js";
import { resolveRichAnchor } from "@core/modules/documents/codecs/rich-anchor.js";
import { slatePoint } from "@web/features/documents/editor-presence.js";
// Readonly Slate does not always mirror the browser selection into editor.selection.
export function selectedTextRange(
  editor: RichTextEditorHandle["editor"],
  host: HTMLElement | null,
) {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !host?.contains(selection.anchorNode) ||
    !host.contains(selection.focusNode)
  )
    return null;
  try {
    return ReactEditor.toSlateRange(editor, selection, {
      exactMatch: false,
      suppressThrow: true,
    });
  } catch {
    return null;
  }
}
export function SelectionCommentAction({
  host,
  handle,
  editable,
  canComment,
  create,
}: {
  host: RefObject<HTMLElement | null>;
  handle: RefObject<RichTextEditorHandle | null>;
  editable: boolean;
  canComment: boolean;
  create: () => void;
}) {
  const { t } = useI18n();
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null),
    [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const picked = useRef<HTMLElement | null>(null);
  const mediaSelector = ".sk-image, .sk-video, .sk-attachment, .sk-diagram-figure";
  const selectMedia = (el: HTMLElement) => {
    const editor = handle.current?.editor;
    if (!editor) return;
    const slateNode =
      el.closest<HTMLElement>('[data-slate-node="element"]') ?? el;
    try {
      const node = ReactEditor.toSlateNode(editor, slateNode);
      if (!Element.isElement(node)) return;
      Transforms.select(editor, ReactEditor.findPath(editor, node));
    } catch {
      /* The image node can unmount between the click and the action. */
    }
  };
  useEffect(() => {
    let frame = 0;
    const update = () => {
      const h = host.current,
        e = handle.current?.editor;
      if (!h || !e) return;
      setToolbar(h.querySelector<HTMLElement>(".sk-floating"));
      const held =
        picked.current && h.contains(picked.current) ? picked.current : null;
      const media =
        h.querySelector<HTMLElement>(
          ".sk-image.is-selected, .sk-video.is-selected, .sk-attachment.is-selected, .sk-diagram-figure.is-selected",
        ) ?? held;
      if (media) {
        const r = media.getBoundingClientRect();
        setRect(
          r.height && r.bottom > 0
            ? {
                left: Math.max(8, Math.min(window.innerWidth - 90, r.left)),
                top: r.top > 60 ? r.top - 44 : r.bottom + 8,
              }
            : null,
        );
        return;
      }
      try {
        const selection = selectedTextRange(e, h);
        if (!selection || Range.isCollapsed(selection)) {
          setRect(null);
          return;
        }
        const range = ReactEditor.toDOMRange(e, selection),
          r = range.getBoundingClientRect();
        setRect(
          r.height && r.bottom > 0
            ? {
                left: Math.max(
                  8,
                  Math.min(window.innerWidth - 50, r.left + r.width / 2 - 18),
                ),
                top: r.top > 60 ? r.top - 44 : r.bottom + 8,
              }
            : null,
        );
      } catch {
        setRect(null);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const o = new MutationObserver(schedule);
    if (host.current)
      o.observe(host.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    const chooseMedia = (event: Event) => {
      const el = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
        mediaSelector,
      );
      const h = host.current;
      if (!el || !h?.contains(el)) return;
      picked.current = el;
      // The image click focuses the editor after selecting the void, which
      // drops the selection. Put it back once that focus settles.
      requestAnimationFrame(() => selectMedia(el));
      schedule();
    };
    const clearMedia = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(mediaSelector) ||
        target?.closest(".selection-comment-floating")
      )
        return;
      if (!picked.current) return;
      picked.current = null;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("pointerdown", clearMedia);
    host.current?.addEventListener("pointerup", chooseMedia);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      o.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointerdown", clearMedia);
      host.current?.removeEventListener("pointerup", chooseMedia);
      window.removeEventListener("resize", schedule);
    };
  }, [host, handle, editable]);
  const button = (
    <button
      className="doca-comment-trigger"
      title={canComment ? t("comment.selection") : t("comment.needPermission")}
      aria-label={t("comment.selection")}
      disabled={!canComment}
      onMouseDown={(e) => e.preventDefault()}
      onClick={create}
    >
      <MessageSquare size={16} />
    </button>
  );
  const floating = rect ? (
    <div
      className="selection-comment-floating"
      style={rect}
      onMouseDown={() => {
        if (picked.current) selectMedia(picked.current);
      }}
    >
      {button}
      <AIReferenceButton />
    </div>
  ) : null;
  const mediaSelected = Boolean(
    host.current?.querySelector(
      ".sk-image.is-selected, .sk-video.is-selected, .sk-attachment.is-selected, .sk-diagram-figure.is-selected",
    ) ||
      (picked.current && host.current?.contains(picked.current)),
  );
  return mediaSelected && floating
    ? createPortal(floating, document.body)
    : editable && toolbar
      ? createPortal(
          <span className="comment-action-divider">
            {button}
            <AIReferenceButton />
          </span>,
          toolbar,
        )
      : !editable && floating
        ? createPortal(floating, document.body)
        : null;
}
export function CommentHighlights({
  host,
  handle,
  runtime,
  comments,
  active,
  select,
  transientAnchor,
}: {
  host: RefObject<HTMLElement | null>;
  handle: RefObject<RichTextEditorHandle | null>;
  runtime: YjsDocument;
  comments: Comment[];
  active: string | null;
  select: (id: string | null) => void;
  transientAnchor?: unknown;
}) {
  const [rects, setRects] = useState<
    { id: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const latest = useRef(select);
  latest.current = select;
  useEffect(() => {
    let frame = 0;
    let hits: { id: string; rect: DOMRect }[] = [];
    const draw = () => {
      const h = host.current,
        e = handle.current?.editor;
      if (!h || !e) return;
      const origin = h.getBoundingClientRect();
      hits = [];
      for (const c of [...comments, ...(transientAnchor ? [{id: "ai-reference", anchor: JSON.stringify(transientAnchor)}] : [])])
        try {
          const a = JSON.parse(c.anchor!);
          for (const p of resolveRichAnchor(runtime, a)) {
          if (p.kind === "block") {
            const el = h.querySelector(`[data-block-id="${CSS.escape(p.blockId)}"]`);
            const rect = el?.getBoundingClientRect();
            if (rect && rect.width > 0) hits.push({ id: c.id, rect });
            continue;
          }
          const anchor = slatePoint(e, p.blockId, p.start),
            focus = slatePoint(e, p.blockId, p.end);
          if (!anchor || !focus) continue;
          for (const rect of Array.from(
            ReactEditor.toDOMRange(e, { anchor, focus }).getClientRects(),
          ))
            if (rect.width > 0) hits.push({ id: c.id, rect });
          }
        } catch {}
      setRects(
        hits.map(({ id, rect: r }) => ({
          id,
          left: r.left - origin.left,
          top: r.top - origin.top,
          width: r.width,
          height: r.height,
        })),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const click = (event: PointerEvent) => {
      const found = hits.find(
        (x) =>
          event.clientX >= x.rect.left &&
          event.clientX <= x.rect.right &&
          event.clientY >= x.rect.top &&
          event.clientY <= x.rect.bottom,
      );
      if (found?.id !== "ai-reference") latest.current(found?.id ?? null);
    };
    const selectionChanged = () => {
      const selection = window.getSelection();
      if (
        !selection?.anchorNode ||
        !host.current?.contains(selection.anchorNode)
      )
        return;
      // Keyboard navigation away from an anchor must clear both card and text.
      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (
          !hits.some(
            ({ rect: r }) =>
              rect.left >= r.left &&
              rect.left <= r.right &&
              rect.top >= r.top &&
              rect.top < r.bottom,
          )
        )
          latest.current(null);
      } catch {}
    };
    const h = host.current;
    h?.addEventListener("pointerup", click);
    document.addEventListener("selectionchange", selectionChanged);
    const o = new ResizeObserver(schedule);
    if (h) o.observe(h);
    runtime.doc.on("update", schedule);
    document.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      o.disconnect();
      h?.removeEventListener("pointerup", click);
      document.removeEventListener("selectionchange", selectionChanged);
      runtime.doc.off("update", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [host, handle, runtime, comments, transientAnchor]);
  return (
    <div className="comment-range-layer" aria-hidden="true">
      {rects.map((r, i) => (
        <span
          key={`${r.id}:${i}`}
          className={`comment-range-mark ${active === r.id || r.id === "ai-reference" ? "active" : ""}`}
          style={{ ...r, pointerEvents: "none" }}
        />
      ))}
    </div>
  );
}
