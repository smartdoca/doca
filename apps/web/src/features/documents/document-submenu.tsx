import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "@web/features/documents/document-submenu.css";

/** A nested DOM menu keeps outside-click handling and focus inside the parent menu. */
export function DocumentSubmenu({
  label,
  icon,
  children,
  panelLabel,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  panelLabel?: string;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: -212,
    top: 0,
    side: "left",
  });
  const place = () => {
    const el = root.current;
    const panel = el?.querySelector<HTMLElement>(".document-submenu-panel");
    if (!el?.open || !panel) return;
    const rect = el.getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    const side = rect.left >= width + 12 ? "left" : "right";
    const x = side === "left" ? rect.left - width - 4 : rect.right + 4;
    setPosition({
      left: Math.max(8, Math.min(x, innerWidth - width - 8)) - rect.left,
      top:
        Math.max(
          8,
          Math.min(
            rect.top,
            innerHeight - panel.getBoundingClientRect().height - 8,
          ),
        ) - rect.top,
      side,
    });
  };
  const show = () => {
    const el = root.current;
    if (!el) return;
    el.closest(".document-more-menu")
      ?.querySelectorAll<HTMLDetailsElement>(".document-submenu[open]")
      .forEach((sibling) => {
        if (sibling !== el) sibling.open = false;
      });
    el.open = true;
    place();
  };
  useEffect(() => {
    const parent = root.current?.closest<HTMLDetailsElement>("details.menu");
    const close = () => {
      if (!parent?.open && root.current) root.current.open = false;
    };
    parent?.addEventListener("toggle", close);
    window.addEventListener("resize", place);
    return () => {
      parent?.removeEventListener("toggle", close);
      window.removeEventListener("resize", place);
    };
  }, []);
  return (
    <details
      ref={root}
      className="document-submenu"
      data-side={position.side}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open) place();
      }}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") show();
      }}
      onPointerLeave={(e) => {
        if (
          e.pointerType === "mouse" &&
          !e.currentTarget.contains(document.activeElement)
        )
          e.currentTarget.open = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          show();
          root.current
            ?.querySelector<HTMLButtonElement>(
              ".document-submenu-panel button:not(:disabled)",
            )
            ?.focus();
        } else if (e.key === "Escape" || e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          if (root.current) root.current.open = false;
          root.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          show();
        }}
      >
        {icon}
        <span>{label}</span>
        {position.side === "left" ? (
          <ChevronLeft size={14} />
        ) : (
          <ChevronRight size={14} />
        )}
      </summary>
      <div
        className="document-submenu-panel"
        role="group"
        aria-label={panelLabel ?? label}
        style={{ left: position.left, top: position.top }}
      >
        {children}
      </div>
    </details>
  );
}
