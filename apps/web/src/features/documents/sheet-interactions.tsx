import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Paperclip, FileText, Link } from "lucide-react";
import type {
  SpreadsheetEditorHandle,
  SpreadsheetCellObject,
  SpreadsheetCellRange,
} from "@smartdoca/sheet";
import { lookupUsers, type MentionUser } from "@web/features/comments/rich-comments.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { UserMention } from "@web/shared/components/user-mention.js";
import { assetUrl } from "@web/shared/api.js";
import {
  guessMime,
  isVisualMedia,
  type PreviewSource,
} from "@web/features/documents/document-file-preview.js";

export function SheetSelectionComment({
  handle,
  enabled,
  add,
}: {
  handle: SpreadsheetEditorHandle;
  enabled: boolean;
  add(): void;
}) {
const { t } = useI18n();

  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let visible = false;
    const choose = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest(".sheet-selection-comment")) return;
      visible = !!target.closest(".uos-editor__canvas");
      update();
    };
    const update = () => {
      try {
        setRect(visible && enabled ? handle.getSelectionRect() : null);
      } catch {
        setRect(null);
      }
    };
    document.addEventListener("pointerup", choose, true);
    document.addEventListener("keyup", choose, true);
    const timer = setInterval(update, 150);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerup", choose, true);
      document.removeEventListener("keyup", choose, true);
    };
  }, [handle, enabled]);
  if (!rect || rect.bottom < 160 || rect.top > innerHeight) return null;
  return createPortal(
    <button
      className="sheet-selection-comment"
      aria-label={t("editor.commentSelection")}
      title={t("editor.commentSelection")}
      style={{
        left: Math.max(8, Math.min(rect.left, innerWidth - 48)),
        top: Math.max(140, rect.top - 38),
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={add}
    >
      <MessageSquare size={20} />
    </button>,
    document.body,
  );
}
export function SheetUserPicker({
  range,
  choose,
  close,
}: {
  range: SpreadsheetCellRange;
  choose(user: MentionUser): void;
  close(): void;
}) {
const { t } = useI18n();

  const [q, setQ] = useState(""),
    [users, setUsers] = useState<MentionUser[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void lookupUsers(q, controller.signal)
        .then(setUsers)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);
  return createPortal(
    <div
      className="sheet-user-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="sheet-user-picker"
        role="dialog"
        aria-label="插入用户"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <input
          autoFocus
          aria-label={t("users.search")}
          placeholder={t("users.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <small>插入到第 {range.startRow + 1} 行选中单元格，替换整格内容</small>
        {error && <p role="alert">{error}</p>}
        <div>
          {users.map((u) => (
            <button key={u.id} onClick={() => choose(u)}>
              <UserBadge id={u.id} name={u.display_name} passive />
              <small>{u.public_id}</small>
            </button>
          ))}
          {!users.length && <p>暂无可选用户</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
export function renderSheetObject(
  object: SpreadsheetCellObject,
  onPreview?: (file: PreviewSource) => void,
) {
  if (object.kind === "mention")
    return <UserMention id={object.id} name={object.label} />;
  if (object.kind === "link") {
    try {
      const url = new URL(object.id);
      if (!/^https?:$/.test(url.protocol)) return null;
    } catch {
      return null;
    }
    return (
      <a
        href={object.id}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "flex", gap: 4, alignItems: "center" }}
      >
        <Link size={14} />
        {object.label}
      </a>
    );
  }
  if (!/^[a-f0-9-]{36}$/i.test(object.id)) return null;
  if (object.kind === "document")
    return (
      <a
        className="document-inline-reference"
        href={`#/r/${object.id}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <FileText size={14} />
        {object.label}
      </a>
    );
  if (object.kind === "image" || object.kind === "floating-image")
    return (
      <img
        draggable={false}
        alt={object.label}
        src={assetUrl(object.id)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    );
  const mime = guessMime(object.label);
  if (isVisualMedia(mime, object.label))
    return mime.startsWith("video/") ? (
      <video
        src={assetUrl(object.id)}
        controls
        preload="metadata"
        style={{ width: "100%", height: "100%" }}
      />
    ) : (
      <img
        draggable={false}
        alt={object.label}
        src={assetUrl(object.id)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    );
  if (onPreview)
    return (
      <button
        type="button"
        className="sheet-attachment-preview"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPreview({
            url: assetUrl(object.id),
            name: object.label,
            mime,
          });
        }}
      >
        <Paperclip size={14} />
        {object.label}
      </button>
    );
  return (
    <a
      href={assetUrl(object.id) + "?download=1"}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 4 }}
    >
      <Paperclip size={14} />
      {object.label}
    </a>
  );
}
