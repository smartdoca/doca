import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ListTree } from "lucide-react";
import { Dialog } from "@web/features/documents/dialogs.js";
import "@web/features/documents/outline-drawer.css";

/** Render outside the editor's size container so the launcher stays viewport-fixed. */
export function OutlineDrawer({
  container,
  headings,
  navigate,
  hidden,
  always = false,
  keepOpenOnNavigate = false,
  restore,
  inlineAvailable,
  launcherOffset = 12,
}: {
  container: RefObject<HTMLElement | null>;
  headings: { id: string; text: string; level: number }[];
  navigate: (id: string) => void;
  hidden: boolean;
  always?: boolean;
  keepOpenOnNavigate?: boolean;
  restore?: () => void;
  inlineAvailable?: boolean;
  launcherOffset?: number;
}) {
  const [layout, setLayout] = useState<{
    host: HTMLElement;
    left: number;
    top: number;
    collapsed: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const editor = container.current;
    const workspace = editor?.closest<HTMLElement>(".workspace");
    if (!editor || !workspace) return;
    const toolbar = workspace.querySelector<HTMLElement>(
      "#editor-toolbar-slot",
    );
    const header = workspace.querySelector<HTMLElement>(".topbar");
    const measure = () => {
      const top = Math.max(
        toolbar?.getBoundingClientRect().bottom ?? 0,
        header?.getBoundingClientRect().bottom ?? 0,
      );
      setLayout({
        host: workspace,
        left: editor.getBoundingClientRect().left,
        top,
        collapsed:
          always ||
          !(inlineAvailable ?? editor.getBoundingClientRect().width > 1050),
      });
    };
    const observer = new ResizeObserver(measure);
    [workspace, editor, toolbar, header].forEach(
      (el) => el && observer.observe(el),
    );
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [container, always, inlineAvailable]);
  useEffect(() => {
    if (!layout?.collapsed || hidden) setOpen(false);
  }, [layout?.collapsed, hidden]);
  if (!layout?.collapsed || hidden) return null;
  return createPortal(
    <div
      className="outline-drawer-host"
      style={
        {
          "--outline-left": `${layout.left}px`,
          "--outline-top": `${layout.top}px`,
          "--outline-launcher-offset": `${launcherOffset}px`,
        } as CSSProperties
      }
    >
      <button
        className="outline-floating-toggle"
        aria-label="展开文档导航"
        title="文档导航"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (
            restore &&
            inlineAvailable !== false &&
            (container.current?.getBoundingClientRect().width ?? 0) > 1050
          )
            restore();
          else setOpen(true);
        }}
      >
        <ListTree size={19} />
      </button>
      {open && (
        <Dialog
          title="文档导航"
          close={() => setOpen(false)}
          className="outline-drawer-panel"
          shadeClassName="outline-drawer-shade"
          shadeStyle={
            {
              "--outline-left": `${layout.left}px`,
              "--outline-top": `${layout.top}px`,
            } as CSSProperties
          }
        >
          <nav className="outline-drawer-links" aria-label="文档大纲">
            {headings.length ? (
              headings.map((h) => (
                <button
                  key={h.id}
                  title={h.text || "无标题"}
                  style={{ paddingLeft: 12 + (h.level - 1) * 14 }}
                  onClick={() => {
                    navigate(h.id);
                    if (!keepOpenOnNavigate) setOpen(false);
                  }}
                >
                  {h.text || "无标题"}
                </button>
              ))
            ) : (
              <p className="empty">添加标题后，这里将显示文档导航</p>
            )}
          </nav>
        </Dialog>
      )}
    </div>,
    layout.host,
  );
}
