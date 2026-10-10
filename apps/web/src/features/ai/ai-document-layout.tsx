import {
  lazy,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Sparkles } from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";
import { LazyContent } from "@web/shared/components/lazy-content.js";
import { useAI } from "./ai-context.js";
import {
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  panelWidthMax,
  readPanelWidth,
  writePanelWidth,
} from "./ai-side-open.js";
import { DocumentScrollButtons } from "@web/features/documents/document-scroll-buttons.js";
import "./ai.css";
const AIChat = lazy(() =>
  import("./ai-chat.js").then((module) => ({ default: module.AIChat })),
);

function usePanelWidth() {
  const viewport = () =>
    typeof window === "undefined" ? 1280 : window.innerWidth;
  const [width, setWidth] = useState(() => readPanelWidth(viewport()));
  const widthRef = useRef(width);
  const dragging = useRef(false);
  if (!dragging.current) widthRef.current = width;
  useEffect(() => {
    const fit = () => {
      const next = clampPanelWidth(widthRef.current, window.innerWidth);
      widthRef.current = next;
      setWidth(next);
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    handle.setPointerCapture(event.pointerId);
    dragging.current = true;
    panel?.classList.add("is-resizing");
    document.body.classList.add("ai-panel-resizing");
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const apply = (clientX: number) => {
      const next = clampPanelWidth(
        startWidth + startX - clientX,
        window.innerWidth,
      );
      widthRef.current = next;
      if (panel instanceof HTMLElement) panel.style.width = `${next}px`;
      return next;
    };
    const move = (e: PointerEvent) => {
      apply(e.clientX);
    };
    const finish = (e: PointerEvent) => {
      const next = apply(e.clientX);
      writePanelWidth(next, window.innerWidth);
      dragging.current = false;
      setWidth(next);
      panel?.classList.remove("is-resizing");
      document.body.classList.remove("ai-panel-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };
  const nudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    const next = writePanelWidth(
      widthRef.current + (event.shiftKey ? step * 4 : step),
      window.innerWidth,
    );
    widthRef.current = next;
    setWidth(next);
  };
  return {
    width: dragging.current ? widthRef.current : width,
    startResize,
    nudge,
  };
}

export function AIDocumentLayout({
  children,
  disabled = false,
  format,
  surface,
}: {
  children: ReactNode;
  disabled?: boolean;
  format?: string;
  surface?: "document" | "files" | "knowledge";
}) {
  const { t, locale } = useI18n();

  const ai = useAI();
  const panel = usePanelWidth();
  const filesSurface = surface === "files";
  const enabled =
    !disabled &&
    !!ai?.userId &&
    (surface === "knowledge" ||
      filesSurface ||
      (!!ai.resource &&
        (ai.resource.kind === "document" || ai.resource.kind === "library")));
  return (
    <div
      className={`ai-document-layout ${enabled && ai?.open ? "ai-document-open" : ""}`}
    >
      <div className="ai-document-main">
        {children}
        {(format === "rich_text" || format === "markdown") && (
          <DocumentScrollButtons />
        )}
      </div>
      {enabled && ai?.open && (
        <aside className="ai-document-panel" style={{ width: panel.width }}>
          <div
            className="ai-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("chat.resize")}
            aria-valuemin={PANEL_WIDTH_MIN}
            aria-valuenow={panel.width}
            aria-valuemax={panelWidthMax(
              typeof window === "undefined" ? 1280 : window.innerWidth,
            )}
            tabIndex={0}
            onPointerDown={panel.startResize}
            onKeyDown={panel.nudge}
          />
          <LazyContent>
            <AIChat />
          </LazyContent>
        </aside>
      )}
      {enabled && !ai?.open && !filesSurface && (
        <button
          className="ai-document-trigger"
          title={t("chat.writing")}
          aria-label={t("chat.writing")}
          aria-expanded={ai?.open}
          onClick={() => ai?.setOpen(!ai.open)}
        >
          <Sparkles size={22} />
        </button>
      )}
    </div>
  );
}
