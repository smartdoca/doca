import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search, ChevronUp, ChevronDown, Replace, X } from "lucide-react";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { composingKey } from "./composition.js";
import { useDocumentSearchRequest } from "./use-document-search-request.js";
import { useFindQuery } from "./use-find-query.js";
export interface FindHandle<M> { find(query: string): M[] | Promise<M[]>; reveal(match: M): unknown; replace(match: M, text: string): unknown; replaceAll(query: string, text: string): unknown; }

/** Platform search UI; SDK enumerates, locates and mutates the model, never DOM text. */
export function ModelFind<M>({
  documentId,
  handle,
  revision,
  canEdit,
  openNative,
  openReplace,
}: {
  documentId: string;
  handle: RefObject<FindHandle<M> | null>;
  openNative?: () => Promise<unknown>;
  openReplace?: () => Promise<unknown>;
  revision: number;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [slot, setSlot] = useState<HTMLElement | null>(null),
    [open, setOpen] = useState(false),
    [replacement, setReplacement] = useState(""),
    [expanded, setExpanded] = useState(false),
    [matches, setMatches] = useState<M[]>([]),
    [index, setIndex] = useState(0);
  const { query, setQuery, composing, gate, inputProps } = useFindQuery();
  const request = useDocumentSearchRequest(documentId);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const native = useRef({ openNative, openReplace });
  native.current = { openNative, openReplace };
  useEffect(() => {
    if (!request) return;
    setQuery(request.query);
    setIndex(0);
    setExpanded(false);
    setOpen(true);
  }, [request, setQuery]);
  const input = useRef<HTMLInputElement>(null);
  const editable = useRef(canEdit);
  editable.current = canEdit;
  const show = (replace = false) => {
    const opener = replace ? native.current.openReplace : native.current.openNative;
    if (opener) {
      setOpen(false);
      setError("");
      void opener().catch((e) => setError((e as Error).message));
      return;
    }
    if (replace && editable.current) setExpanded(true);
    setOpen(true);
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    setSlot(document.getElementById("document-search-slot"));
    const key = (e: KeyboardEvent) => {
      if (composingKey(e)) return;
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
    if (composing || gate.composing) return;
    if (!open || !query) {
      setSearching(false);
      setMatches([]);
      setIndex(0);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setMatches([]);
    setError("");
    void (async () => {
      try {
        const found = await handle.current?.find(query) ?? [];
        if (cancelled) return;
        setSearching(false);
        setMatches(found);
        setIndex(0);
        if (found[0]) {
          const focus = document.activeElement as HTMLElement | null;
          handle.current?.reveal(found[0]);
          if (document.activeElement !== focus) focus?.focus({ preventScroll: true });
        }
      } catch (e) {
        if (!cancelled) {
          setSearching(false);
          setError((e as Error).message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [query, composing, open, revision, handle, gate, request]);

  const move = (delta: number) => {
    if (!matches.length || gate.composing) return;
    const next = (index + delta + matches.length) % matches.length;
    setIndex(next);
    if (matches[next]) {
      const focus = document.activeElement as HTMLElement | null;
      handle.current?.reveal(matches[next]);
      if (document.activeElement !== focus) focus?.focus({ preventScroll: true });
    }
  };
  return (
    <>
      <Feedback message={error} tone="error" />
      {slot &&
        createPortal(
          <button
            className="icon"
            title={t("doc.findShortcut")}
            aria-label={t("doc.find")}
            onClick={() => show()}
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
              if (gate.composing || composingKey(e.nativeEvent)) return;
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
              {...inputProps}
            />
            <span role="status">
              {error || (searching ? "…" : matches.length ? `${index + 1}/${matches.length}` : query ? t("doc.findNoMatches") : "0/0")}
            </span>
            <button
              className="icon"
              disabled={composing || !matches.length}
              aria-label={t("doc.findPrevious")}
              onClick={() => move(-1)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              className="icon"
              disabled={composing || !matches.length}
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
                  disabled={composing || !matches.length}
                  onClick={() => {
                    const match = matches[index];
                    if (match) handle.current?.replace(match, replacement);
                  }}
                >
                  {t("doc.replace")}
                </button>
                <button
                  disabled={composing || !matches.length}
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
