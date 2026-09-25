import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search, ChevronUp, ChevronDown, Replace, X } from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";
export interface FindHandle<M> { find(query: string): M[]; reveal(match: M): unknown; replace(match: M, text: string): unknown; replaceAll(query: string, text: string): unknown; }

/** Platform search UI; SDK enumerates, locates and mutates the model, never DOM text. */
export function ModelFind<M>({
  handle,
  revision,
  canEdit,
}: {
  handle: RefObject<FindHandle<M> | null>;
  revision: number;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [slot, setSlot] = useState<HTMLElement | null>(null),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [replacement, setReplacement] = useState(""),
    [expanded, setExpanded] = useState(false),
    [matches, setMatches] = useState<M[]>([]),
    [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const editable = useRef(canEdit);
  editable.current = canEdit;
  const show = (replace = false) => {
    if (replace && editable.current) setExpanded(true);
    setOpen(true);
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    setSlot(document.getElementById("document-search-slot"));
    const key = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.altKey ||
        e.shiftKey ||
        (e.target as HTMLElement).closest('[role="dialog"]')
      )
        return;
      const command = e.key.toLowerCase();
      if (command !== "f" && command !== "r") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      show(command === "r");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  useEffect(() => {
    const found = open ? (handle.current?.find(query) ?? []) : [];
    setMatches(found);
    setIndex(0);
    if (found[0]) {
      const focus = document.activeElement as HTMLElement | null;
      handle.current?.reveal(found[0]);
      focus?.focus({ preventScroll: true });
    }
  }, [query, open, revision, handle]);
  const move = (delta: number) => {
    const next = (index + delta + matches.length) % matches.length;
    setIndex(next);
    if (matches[next]) handle.current?.reveal(matches[next]);
  };
  return (
    <>
      {slot &&
        createPortal(
          <button
            className="icon"
            title={t("doc.findShortcut")}
            aria-label={t("doc.find")}
            onClick={show}
          >
            <Search size={18} />
          </button>,
          slot,
        )}
      {open &&
        createPortal(
          <div
            className="document-find-panel"
            role="search"
            aria-label={t("doc.find")}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              }
            }}
          >
            {canEdit && (
              <button
                className="icon"
                aria-label={t("doc.findExpand")}
                onClick={() => setExpanded(!expanded)}
              >
                <Replace size={16} />
              </button>
            )}
            <Search size={16} />
            <input
              ref={input}
              aria-label={t("doc.findQuery")}
              placeholder={t("doc.findQuery")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span role="status">
              {matches.length ? `${index + 1}/${matches.length}` : "0/0"}
            </span>
            <button
              className="icon"
              disabled={!matches.length}
              aria-label={t("doc.findPrevious")}
              onClick={() => move(-1)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              className="icon"
              disabled={!matches.length}
              aria-label={t("doc.findNext")}
              onClick={() => move(1)}
            >
              <ChevronDown size={16} />
            </button>
            <button
              className="icon"
              aria-label={t("doc.findClose")}
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
            {canEdit && expanded && (
              <div className="document-replace-row">
                <input
                  value={replacement}
                  placeholder={t("doc.replacePlaceholder")}
                  aria-label={t("doc.replaceWith")}
                  onChange={(e) => setReplacement(e.target.value)}
                />
                <button
                  disabled={!matches.length}
                  onClick={() => {
                    const match = matches[index];
                    if (match) handle.current?.replace(match, replacement);
                  }}
                >
                  {t("doc.replace")}
                </button>
                <button
                  disabled={!matches.length}
                  onClick={() => handle.current?.replaceAll(query, replacement)}
                >
                  {t("doc.replaceAll")}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
