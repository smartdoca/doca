import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function HoverTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [box, setBox] = useState<{ left: number; top: number; below: boolean } | null>(null);
  function place(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const below = rect.top < 36;
    const estimated = label.length * 12 + 16;
    const left = Math.max(
      8 + estimated / 2,
      Math.min(window.innerWidth - 8 - estimated / 2, rect.left + rect.width / 2),
    );
    setBox({
      left,
      top: below ? rect.bottom + 6 : rect.top - 6,
      below,
    });
  }
  return (
    <span
      className="hover-tip"
      onMouseEnter={(event) => place(event.currentTarget)}
      onMouseLeave={() => setBox(null)}
      onFocusCapture={(event) => place(event.currentTarget)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setBox(null);
      }}
    >
      {children}
      {box &&
        createPortal(
          <span
            className={`icon-tooltip${box.below ? " below" : ""}`}
            id={id}
            role="tooltip"
            style={{ left: box.left, top: box.top }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
