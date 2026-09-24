import { useAI } from "@web/features/ai/ai-context.js";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { AtSign, Copy, Pin, Share2, Star, Trash2 } from "lucide-react";
import { api, type Detail, type Resource } from "@web/shared/api.js";
import { publishReaction } from "@web/features/documents/document-reactions.js";
import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { Feedback } from "@web/shared/components/feedback.js";
import "@web/features/documents/tree-document-menu.css";

export function TreeDocumentMenu({
  resource,
  trigger,
  close,
  changed,
  remove,
}: {
  resource: Resource;
  trigger: HTMLElement;
  close(): void;
  changed(): void;
  remove(): void;
}) {
  const allowed = useEntitlements();
  const ai = useAI();
  const panel = useRef<HTMLDivElement>(null);
  const [favorite, setFavorite] = useState<boolean | null>(null);
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rect = trigger.getBoundingClientRect();
  useEffect(() => {
    const controller = new AbortController();
    void api<Detail>(
      `/resources/${resource.id}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((d) => {
        setFavorite(d.favorite);
        setPinned(d.pinned);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    panel.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const outside = (e: Event) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.contains(e.target as Node)
      )
        close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const scroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      controller.abort();
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  async function act(action: "copy" | "favorite" | "pin") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "copy") {
        const result = await api<{ id: string }>(
          `/resources/${resource.id}/copy`,
          "POST",
        );
        changed();
        location.hash = "/r/" + result.id;
      } else {
        const enabled = action === "pin" ? !pinned : !favorite;
        const patch = action === "pin" ? { pinned: enabled } : { favorite: enabled };
        publishReaction({ id: resource.id, ...patch, resource: { ...resource, ...patch } });
        try {
          await api(`/resources/${resource.id}/reaction`, "PUT", {
            kind: action,
            enabled,
          });
        } catch (e) {
          const revert = action === "pin" ? { pinned: !!pinned } : { favorite: !!favorite };
          publishReaction({ id: resource.id, ...revert, resource: { ...resource, ...revert } });
          throw e;
        }
        changed();
      }
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return createPortal(
    <div
      ref={panel}
      className="tree-document-menu"
      role="menu"
      aria-label={resource.title + "的操作"}
      style={{
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 208)),
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 250)),
      }}
      onKeyDown={(e) => {
        const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) &&
          buttons.length
        ) {
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {ai?.userId && resource.kind === "document" && (
        <button
          role="menuitem"
          disabled={favorite === null || !allowed("ai.create")}
          onClick={() => {
            ai.addDocument(resource);
            close();
          }}
        >
          <AtSign size={16} />
          引用给 AI
        </button>
      )}
      {resource.kind === "document" && (
        <button role="menuitem" onClick={() => { location.hash = `/knowledge?source=document:${resource.id}`; close(); }}>
          <Share2 size={16} />
          查找相关
        </button>
      )}
      <button
        role="menuitem"
        disabled={busy || !allowed("documents.copy")}
        onClick={() => void act("copy")}
        title="复制此文档及子文档到个人文档"
      >
        <Copy size={16} />
        复制文档
      </button>
      {resource.kind === "document" && (
        <button
          role="menuitem"
          disabled={busy || pinned === null}
          title={pinned ? "取消置顶" : "置顶文档"}
          onClick={() => void act("pin")}
        >
          <Pin size={16} fill={pinned ? "currentColor" : "none"} />
          {pinned ? "取消置顶" : "置顶文档"}
        </button>
      )}
      <button
        role="menuitem"
        disabled={busy || favorite === null}
        title={favorite ? "取消收藏" : "收藏文档"}
        onClick={() => void act("favorite")}
      >
        <Star size={16} fill={favorite ? "currentColor" : "none"} />
        {favorite ? "取消收藏" : "收藏文档"}
      </button>
      <button
        role="menuitem"
        className="danger"
        disabled={busy || resource.role !== "owner"}
        onClick={() => {
          close();
          remove();
        }}
      >
        <Trash2 size={16} />
        删除文档
      </button>
      {error && <Feedback message={error} tone="error" />}
    </div>,
    document.body,
  );
}
