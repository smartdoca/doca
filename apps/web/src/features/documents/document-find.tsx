import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search, ChevronUp, ChevronDown, X, Replace } from "lucide-react";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { findTextOffsets } from "@web/shared/utils/find-text.js";
type Match = {
  range?: Range;
  element: HTMLElement;
  start?: number;
  length?: number;
};

// Searching only decorates the view. It never writes Slate/Yjs or workbook data.
export function DocumentFind({
  host,
  openNative,
  openReplace,
  replace,
}: {
  host?: RefObject<HTMLElement | null>;
  openNative?: () => Promise<unknown>;
  openReplace?: () => Promise<unknown>;
  replace?: (
    query: string,
    replacement: string,
    all: boolean,
    index: number,
  ) => number;
}) {
  const { t } = useI18n();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]),
    [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false),
    [replacement, setReplacement] = useState("");
  const [replaceRevision, setReplaceRevision] = useState(0);
  const performReplace = (all: boolean) => {
    try {
      replace?.(query, replacement, all, index);
      setReplaceRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const input = useRef<HTMLInputElement>(null);
  const nativeFind = useRef(openNative);
  const nativeReplace = useRef(openReplace);
  nativeFind.current = openNative;
  nativeReplace.current = openReplace;
  useEffect(() => {
    setSlot(document.getElementById("document-search-slot"));
  }, []);
  const show = (mode: "find" | "replace" = "find") => {
    if (mode === "replace" && nativeReplace.current) {
      void nativeReplace.current().catch((e) => setError((e as Error).message));
      return;
    }
    if (nativeFind.current) {
      void nativeFind.current().catch((e) => setError((e as Error).message));
      return;
    }
    if (mode === "replace") setExpanded(true);
    setOpen(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.altKey ||
        e.shiftKey ||
        (e.target as HTMLElement)?.closest('[role="dialog"]')
      )
        return;
      const command = e.key.toLowerCase();
      if (command !== "f" && command !== "r") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      show(command === "r" ? "replace" : "find");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  useEffect(() => {
    if (!open || !host?.current) {
      setMatches([]);
      return;
    }
    const h = host.current;
    let timer: ReturnType<typeof setTimeout>;
    const collect = () => {
      const found: Match[] = [];
      if (query) {
        // Join leaves within a block so mixed bold/colour text remains searchable.
        const groups = new Map<HTMLElement, Text[]>();
        for (const leaf of Array.from(
          h.querySelectorAll<HTMLElement>("[data-slate-string]"),
        )) {
          if (leaf.closest(".atomic-inline-anchor, .legacy-mention-anchor"))
            continue;
          const block =
            leaf.closest<HTMLElement>('[data-slate-node="element"]') ?? leaf;
          const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode()))
            groups.set(block, [...(groups.get(block) ?? []), node as Text]);
        }
        for (const [element, nodes] of groups) {
          const text = nodes.map((n) => n.data).join("");
          for (const start of findTextOffsets(text, query)) {
            const range = document.createRange();
            let offset = 0;
            for (const node of nodes) {
              if (start >= offset && start < offset + node.length)
                range.setStart(node, start - offset);
              if (
                start + query.length > offset &&
                start + query.length <= offset + node.length
              ) {
                range.setEnd(node, start + query.length - offset);
                break;
              }
              offset += node.length;
            }
            found.push({ range, element });
          }
        }
        for (const element of Array.from(
          h.querySelectorAll<HTMLTextAreaElement>("textarea"),
        )) {
          for (const start of findTextOffsets(element.value, query))
            found.push({ element, start, length: query.length });
        }
      }
      found.sort((a, b) =>
        a.element === b.element
          ? (a.start ?? 0) - (b.start ?? 0)
          : a.element.compareDocumentPosition(b.element) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      );
      setMatches(found);
      setIndex((i) => Math.min(i, Math.max(0, found.length - 1)));
    };
    collect();
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(collect, 150);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(h, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    h.addEventListener("input", schedule);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      h.removeEventListener("input", schedule);
    };
  }, [query, open, host, replaceRevision]);
  useEffect(() => {
    const css = CSS as typeof CSS & { highlights?: Map<string, unknown> };
    if (!open) return;
    const Highlight = (
      window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (Highlight && css.highlights) {
      css.highlights.set(
        "doca-find",
        new Highlight(...matches.flatMap((m) => (m.range ? [m.range] : []))),
      );
      css.highlights.set(
        "doca-find-current",
        new Highlight(
          ...(matches[index]?.range ? [matches[index].range!] : []),
        ),
      );
    }
    const current = matches[index];
    if (current) {
      current.element.scrollIntoView({ block: "center" });
      if (current.element instanceof HTMLTextAreaElement) {
        current.element.classList.add("document-find-code");
        current.element.setSelectionRange(
          current.start!,
          current.start! + current.length!,
        );
      }
    }
    return () => {
      css.highlights?.delete("doca-find");
      css.highlights?.delete("doca-find-current");
      current?.element.classList.remove("document-find-code");
    };
  }, [matches, index, open]);
  const move = (delta: number) =>
    setIndex((i) =>
      matches.length ? (i + delta + matches.length) % matches.length : 0,
    );
  return (
    <>
      {slot &&
        createPortal(
          <button
            className="icon"
            aria-label={t("doc.find")}
            title={t("doc.findShortcut")}
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
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
              if (e.key === "Enter") {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              }
            }}
          >
            {replace && (
              <button
                className="icon"
                aria-label={t("doc.findExpand")}
                aria-expanded={expanded}
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
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
            />
            <span role="status">
              {matches.length ? `${index + 1}/${matches.length}` : "0/0"}
            </span>
            <button
              className="icon"
              aria-label={t("doc.findPrevious")}
              disabled={!matches.length}
              onClick={() => move(-1)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              className="icon"
              aria-label={t("doc.findNext")}
              disabled={!matches.length}
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
            {expanded && replace && (
              <div className="document-replace-row">
                <input
                  aria-label={t("doc.replaceWith")}
                  placeholder={t("doc.replacePlaceholder")}
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      e.preventDefault();
                      performReplace(false);
                    }
                  }}
                />
                <button
                  disabled={!query || !matches.length}
                  onClick={() => performReplace(false)}
                >
                  {t("doc.replace")}
                </button>
                <button
                  disabled={!query || !matches.length}
                  onClick={() => performReplace(true)}
                >
                  {t("doc.replaceAll")}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
      <Feedback message={error} tone="error" />
    </>
  );
}
