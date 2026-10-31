import { ownsControlledPopup } from "@web/shared/components/popup-ownership.js";
import { useEffect, useRef } from "react";

/** Shared dismissal and focus behavior for resource permission panels. */
export function usePermissionPopover(close: () => void, embedded = false) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (embedded) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (
        target.closest("[data-permissions-popup], [data-permissions-trigger]")
      )
        return;
      if (
        ownsControlledPopup(target, [
          panel.current,
          ...Array.from(document.querySelectorAll("[data-permissions-popup]")),
        ])
      )
        return;
      if (!panel.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [embedded, close]);
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [embedded]);
  return panel;
}
