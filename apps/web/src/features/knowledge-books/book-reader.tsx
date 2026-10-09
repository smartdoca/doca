import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  List,
} from "lucide-react";
import { Collapse } from "antd";
import type { MarkdownPreviewInteraction } from "@smartdoca/markdown";
import MarkdownPreview from "@web/features/documents/markdown-preview.js";
import { useI18n } from "@web/shared/i18n.js";
import {
  bookReadingModel,
  orderedBookPages,
  type BookPage,
  type BookOutlineEntry,
} from "./book-reading-model.js";

export function BookReader({
  page,
  pages,
  navigate,
  reviewParagraph,
}: {
  page: BookPage;
  pages: BookPage[];
  navigate: (id: string) => void;
  reviewParagraph?: (
    paragraph: BookPage["paragraphs"][number],
    preview: ReactNode,
  ) => ReactNode;
}) {
  const { t } = useI18n();
  const model = useMemo(() => bookReadingModel(page), [page]);
  const ordered = useMemo(() => orderedBookPages(pages), [pages]);
  const index = ordered.findIndex((item) => item.id === page.id);
  const previous = ordered[index - 1],
    next = ordered[index + 1];
  const host = useRef<HTMLDivElement>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const [active, setActive] = useState(model.outline[0]?.id);

  function reveal(entry: BookOutlineEntry) {
    const target = targets.current.get(entry.id);
    const scroller = host.current?.closest("article");
    if (!target || !scroller) return;
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        24,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    target.focus({ preventScroll: true });
    setActive(entry.id);
  }

  const interactions = useMemo(() => {
    const create = (paragraphId?: string): MarkdownPreviewInteraction => ({
      attach(root, mapping) {
        const entries = model.outline.filter(
          (entry) => !paragraphId || entry.paragraphId === paragraphId,
        );
        const expected = paragraphId
          ? page.paragraphs.find((item) => item.id === paragraphId)!.markdown
          : model.markdown;
        if (mapping.source !== expected) return () => {};
        const blocks = Array.from(
          root.querySelectorAll<HTMLElement>(
            model.headings
              ? "h1,h2,h3,h4,h5,h6"
              : ":scope > [data-exmd-source-line]",
          ),
        );
        const cleanups: (() => void)[] = [];
        for (const entry of entries) {
          const line = paragraphId ? entry.localLine : entry.line;
          const target =
            blocks.find(
              (element) => Number(element.dataset.exmdSourceLine) === line,
            ) ??
            blocks.find(
              (element) =>
                Number(element.dataset.exmdSourceLine) <= line &&
                Number(element.dataset.exmdSourceEndLine) >= line,
            );
          if (!target) continue;
          targets.current.set(entry.id, target);
          const previousTabIndex = target.getAttribute("tabindex");
          target.tabIndex = -1;
          if (model.headings) {
            const anchor = document.createElement("button");
            anchor.type = "button";
            anchor.className = "book-heading-anchor";
            anchor.textContent = "#";
            anchor.setAttribute(
              "aria-label",
              `${t("books.sectionAnchor")}: ${entry.label}`,
            );
            anchor.onclick = () => reveal(entry);
            target.append(anchor);
            cleanups.push(() => anchor.remove());
          }
          cleanups.push(() => {
            if (targets.current.get(entry.id) === target)
              targets.current.delete(entry.id);
            if (previousTabIndex === null) target.removeAttribute("tabindex");
            else target.setAttribute("tabindex", previousTabIndex);
          });
        }
        return () => cleanups.forEach((cleanup) => cleanup());
      },
    });
    return {
      full: create(),
      paragraphs: new Map(
        page.paragraphs.map((paragraph) => [
          paragraph.id,
          create(paragraph.id),
        ]),
      ),
    };
  }, [model, page, t]);

  useEffect(() => {
    host.current?.closest("article")?.scrollTo({ top: 0 });
  }, [page.id]);

  useEffect(() => {
    const scroller = host.current?.closest("article");
    if (!scroller) return;
    let frame = 0;
    function update() {
      const top = scroller!.getBoundingClientRect().top + 64;
      let current = model.outline[0]?.id;
      for (const entry of model.outline) {
        const target = targets.current.get(entry.id);
        if (target && target.getBoundingClientRect().top <= top)
          current = entry.id;
      }
      if (
        scroller!.scrollTop > 0 &&
        scroller!.scrollTop + scroller!.clientHeight >=
          scroller!.scrollHeight - 2
      )
        current = model.outline.at(-1)?.id;
      setActive(current);
    }
    const changed = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", changed, { passive: true });
    const observer = new ResizeObserver(changed);
    observer.observe(scroller);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", changed);
    };
  }, [model]);

  const outlineTitle = t(
    model.headings ? "books.onThisPage" : "books.pageParagraphs",
  );
  const outline = (
    <nav className="book-outline" aria-label={outlineTitle}>
      <ol>
        {model.outline.map((entry, index) => (
          <li
            key={entry.id}
            style={{
              paddingInlineStart: model.headings
                ? Math.max(
                    0,
                    entry.depth -
                      Math.min(...model.outline.map((item) => item.depth)),
                  ) * 12
                : 0,
            }}
          >
            <button
              type="button"
              title={entry.label}
              aria-current={active === entry.id ? "location" : undefined}
              onClick={() => reveal(entry)}
            >
              {!model.headings && (
                <span className="book-outline-number">{index + 1}</span>
              )}
              <span>{entry.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );

  return (
    <div className="book-reader" ref={host}>
      <header className="book-reader-header">
        <nav className="book-breadcrumb" aria-label={t("books.documentPath")}>
          {page.path.map((label, depth) => (
            <span key={depth}>
              <button
                type="button"
                onClick={() => {
                  const target = ordered.find((item) =>
                    page.path
                      .slice(0, depth + 1)
                      .every((name, i) => item.path[i] === name),
                  );
                  if (target) navigate(target.id);
                }}
              >
                {label}
              </button>
              <ChevronRight size={12} />
            </span>
          ))}
          <span className="book-breadcrumb-current" title={page.title}>
            {page.title}
          </span>
        </nav>
        <h1>{page.title}</h1>
      </header>
      {model.outline.length > 0 && (
        <Collapse
          className="book-outline-inline"
          ghost
          items={[
            {
              key: "outline",
              label: (
                <span className="book-outline-title">
                  <List size={15} />
                  {outlineTitle}
                </span>
              ),
              children: outline,
            },
          ]}
        />
      )}
      <div className="book-reader-columns">
        <div className="book-reader-content">
          {reviewParagraph ? (
            page.paragraphs.map((paragraph) =>
              reviewParagraph(
                paragraph,
                <div className="book-markdown">
                  <MarkdownPreview
                    value={paragraph.markdown}
                    interaction={interactions.paragraphs.get(paragraph.id)}
                  />
                </div>,
              ),
            )
          ) : (
            <div className="book-markdown">
              <MarkdownPreview
                value={model.markdown}
                interaction={interactions.full}
              />
            </div>
          )}
          <footer className="book-reader-footer">
            <div className="book-page-navigation">
              {[previous, next].map((item, side) =>
                item ? (
                  <button
                    type="button"
                    key={side}
                    className={side ? "book-next-page" : "book-previous-page"}
                    onClick={() => navigate(item.id)}
                  >
                    <span>
                      {!side && <ArrowLeft size={14} />}
                      {side
                        ? t("books.nextDocument")
                        : t("books.previousDocument")}
                      {!!side && <ArrowRight size={14} />}
                    </span>
                    <strong title={item.title}>{item.title}</strong>
                  </button>
                ) : (
                  <div key={side} />
                ),
              )}
            </div>
            <button
              type="button"
              className="book-back-top"
              onClick={() => {
                host.current?.closest("article")?.scrollTo({
                  top: 0,
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "instant"
                    : "smooth",
                });
                setActive(model.outline[0]?.id);
              }}
            >
              <ArrowUp size={14} />
              {t("books.backToTop")}
            </button>
          </footer>
        </div>
        {model.outline.length > 0 && (
          <aside className="book-outline-sidebar">
            <div className="book-outline-title">
              <List size={15} />
              {outlineTitle}
            </div>
            {outline}
          </aside>
        )}
      </div>
    </div>
  );
}
