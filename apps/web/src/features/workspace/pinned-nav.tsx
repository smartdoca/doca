import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin } from "lucide-react";
import { api, type Page, type Resource } from "@web/shared/api.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import {
  DocumentReactionButtons,
  type ReactionChange,
} from "@web/features/documents/document-reactions.js";
import { Feedback } from "@web/shared/components/feedback.js";

export function PinnedDocuments({ refresh }: { refresh: number }) {
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [items, setItems] = useState<Resource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [box, setBox] = useState({ left: 0, top: 0, maxHeight: 360 });
  function place() {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 300;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 120));
    setBox({
      left: Math.min(rect.right + 8, window.innerWidth - width - 8),
      top,
      maxHeight: Math.max(160, window.innerHeight - top - 12),
    });
  }
  function show() {
    window.clearTimeout(timer.current);
    place();
    setOpen(true);
  }
  function hide() {
    timer.current = window.setTimeout(() => setOpen(false), 140);
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<Page>("/resources?scope=pins&kind=document", "GET", undefined, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setItems(page.items);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const onReaction = (event: Event) => {
      const change = (event as CustomEvent<ReactionChange>).detail;
      if (!change?.id) return;
      setItems((old) => {
        if (change.pinned === false) return old.filter((item) => item.id !== change.id);
        const next = old.map((item) =>
          item.id === change.id
            ? {
                ...item,
                ...(change.favorite !== undefined ? { favorite: change.favorite } : {}),
                ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
              }
            : item,
        );
        if (change.pinned === true && change.resource && !next.some((item) => item.id === change.id))
          return [{ ...change.resource, pinned: true } as Resource, ...next];
        return next;
      });
    };
    window.addEventListener("resource-reaction", onReaction);
    return () => window.removeEventListener("resource-reaction", onReaction);
  }, []);
  useEffect(() => {
    if (!open) return;
    const update = () => place();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="sidebar-pin-entry"
        title="置顶文档"
        aria-label="置顶文档"
        aria-expanded={open}
        aria-haspopup="true"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={(e) => {
          if (!card.current?.contains(e.relatedTarget)) hide();
        }}
      >
        <Pin size={16} />
        <span className="sidebar-create-label">置顶</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            className="sidebar-pin-card"
            role="region"
            aria-label="置顶文档"
            style={{ left: box.left, top: box.top, maxHeight: box.maxHeight }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {error && <Feedback message={error} tone="error" />}
            {!loaded ? (
              <p className="sidebar-pin-empty">正在加载…</p>
            ) : !items.length ? (
              <p className="sidebar-pin-empty">还没有置顶文档</p>
            ) : (
              items.map((item) => (
                <div className="sidebar-pin-doc" key={item.id}>
                  <a href={`#/r/${item.id}`} title={item.title} onClick={() => setOpen(false)}>
                    <FileIcon r={item} size="compact" />
                    <span>{item.title}</span>
                  </a>
                  <DocumentReactionButtons resource={item} size={14} onError={setError} />
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
