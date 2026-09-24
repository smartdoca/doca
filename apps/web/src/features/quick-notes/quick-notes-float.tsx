import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Feather, Minus, X } from "lucide-react";
import type { NotesFloatState } from "@core/modules/page-state.js";
import { placeNotesFloat, useNotesFloat } from "@web/features/quick-notes/notes-float-store.js";
import "@web/features/quick-notes/quick-notes.css";

const QuickNotes = lazy(() =>
  import("@web/features/quick-notes/quick-notes.js").then((module) => ({
    default: module.QuickNotes,
  })),
);

type DragMode = "move" | "resize" | "resize-x" | "resize-y";

export function QuickNotesFloat({ userId }: { userId: string }) {
  const { state, patch } = useNotesFloat(userId);
  const [live, setLive] = useState<NotesFloatState | null>(null);
  const [attention, setAttention] = useState(false);
  const openRef = useRef(false);
  openRef.current = state.open;
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const drag = useRef<{
    mode: DragMode;
    px: number;
    py: number;
    origin: NotesFloatState;
    moved: boolean;
  } | null>(null);
  const liveRef = useRef<NotesFloatState | null>(null);
  liveRef.current = live;
  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    let timer = 0;
    const onAttention = () => {
      if (!openRef.current) return;
      setAttention(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAttention(false), 1100);
    };
    window.addEventListener("doca-notes-float-attention", onAttention);
    return () => {
      window.removeEventListener("doca-notes-float-attention", onAttention);
      window.clearTimeout(timer);
    };
  }, []);
  if (!state.open) return null;
  const shown = placeNotesFloat(live ?? state, viewport);

  const begin = (event: ReactPointerEvent, mode: DragMode) => {
    if (mode === "move" && (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, px: event.clientX, py: event.clientY, origin: shown, moved: false };
  };
  const move = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.px;
    const dy = event.clientY - current.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true;
    const next = { ...current.origin };
    if (current.mode === "move") {
      next.x = current.origin.x + dx;
      next.y = current.origin.y + dy;
    } else {
      if (current.mode !== "resize-y") next.width = current.origin.width + dx;
      if (current.mode !== "resize-x") next.height = current.origin.height + dy;
    }
    const placed = placeNotesFloat(next, viewport, state.collapsed);
    liveRef.current = placed;
    setLive(placed);
  };
  const finish = () => {
    const current = drag.current;
    const value = liveRef.current;
    drag.current = null;
    setLive(null);
    liveRef.current = null;
    if (current?.moved && value) patch(value);
  };

  if (state.collapsed) {
    return createPortal(
      <div
        className={`note-float-pill ${attention ? "is-attention" : ""}`}
        style={{ left: shown.x, top: shown.y }}
        onPointerDown={(event) => begin(event, "move")}
        onPointerMove={move}
        onPointerUp={() => {
          const moved = drag.current?.moved;
          finish();
          if (!moved) patch({ collapsed: false });
        }}
      >
        <Feather size={15} />
        <span>随手记</span>
        <button
          type="button"
          aria-label="关闭悬浮"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            patch({ open: false, collapsed: false });
          }}
        >
          <X size={14} />
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <section
      className={`note-float ${attention ? "is-attention" : ""}`}
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
      aria-label="随手记悬浮窗口"
    >
      <div
        className="note-float-bar"
        onPointerDown={(event) => begin(event, "move")}
        onPointerMove={move}
        onPointerUp={finish}
      >
        <Feather size={15} />
        <strong>随手记</strong>
        <button type="button" aria-label="折叠悬浮窗口" title="折叠" onClick={() => patch({ collapsed: true })}>
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label="关闭悬浮"
          title="关闭"
          onClick={() => patch({ open: false, collapsed: false })}
        >
          <X size={15} />
        </button>
      </div>
      <div className="note-float-body">
        <Suspense fallback={<p className="note-float-loading">正在打开随手记…</p>}>
          <QuickNotes userId={userId} changed={() => undefined} presentation="card" />
        </Suspense>
      </div>
      <div className="note-float-edge-x" onPointerDown={(event) => begin(event, "resize-x")} onPointerMove={move} onPointerUp={finish} />
      <div className="note-float-edge-y" onPointerDown={(event) => begin(event, "resize-y")} onPointerMove={move} onPointerUp={finish} />
      <div className="note-float-corner" aria-hidden="true" onPointerDown={(event) => begin(event, "resize")} onPointerMove={move} onPointerUp={finish} />
    </section>,
    document.body,
  );
}
