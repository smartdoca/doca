export type ScrollRange = {
  top: number;
  height: number;
  contentHeight: number;
};

/** Only the pane under the pointer participates; the other split pane may differ. */
export function markdownScrollTarget(
  delta: number,
  outer: ScrollRange,
  inner: ScrollRange[],
): "outer" | "native" {
  if (!Number.isFinite(delta) || !delta) return "native";
  if (outer.top > 1) return "outer";
  if (delta < 0 || outer.contentHeight <= outer.height + 1) return "native";
  return inner.some(
    (range) => range.contentHeight - range.height - range.top > 1,
  )
    ? "native"
    : "outer";
}

function range(el: HTMLElement): ScrollRange {
  return {
    top: el.scrollTop,
    height: el.clientHeight,
    contentHeight: el.scrollHeight,
  };
}

/** View-only host scroll chaining. Never changes editor selection, mode or content. */
export function attachMarkdownScroll(container: HTMLElement) {
  const outer = container.closest<HTMLElement>(".main-scroll");
  if (!outer) return () => {};
  function handoff(target: EventTarget | null, delta: number, event: Event) {
    if (
      !event.cancelable ||
      event.defaultPrevented ||
      !(target instanceof Element)
    )
      return;
    const pane = target.closest<HTMLElement>(".editor-pane, .preview-pane");
    if (
      !pane ||
      !container.querySelector(".markdown-sdk-container")?.contains(pane)
    )
      return;
    const inner: ScrollRange[] = [];
    // Nested code/diagram scroll areas retain their own scroll until their end.
    for (
      let el: HTMLElement | null =
        target instanceof HTMLElement ? target : target.parentElement;
      el && pane.contains(el);
      el = el.parentElement
    ) {
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY))
        inner.push(range(el));
      if (el === pane) break;
    }
    if (markdownScrollTarget(delta, range(outer!), inner) !== "outer") return;
    event.preventDefault();
    // No smooth animation: wheel/trackpad deltas already provide continuous movement.
    outer!.scrollTop = Math.max(0, outer!.scrollTop + delta);
  }
  function wheel(event: WheelEvent) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return;
    const unit =
      event.deltaMode === 1
        ? 20
        : event.deltaMode === 2
          ? outer!.clientHeight
          : 1;
    handoff(event.target, event.deltaY * unit, event);
  }
  let touch: { x: number; y: number } | undefined;
  function start(event: TouchEvent) {
    const first = event.touches.length === 1 ? event.touches[0] : undefined;
    touch = first ? { x: first.clientX, y: first.clientY } : undefined;
  }
  function move(event: TouchEvent) {
    const first = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!first || !touch) {
      touch = undefined;
      return;
    }
    const dx = touch.x - first.clientX,
      dy = touch.y - first.clientY;
    touch = { x: first.clientX, y: first.clientY };
    if (Math.abs(dy) > Math.abs(dx)) handoff(event.target, dy, event);
  }
  function end() {
    touch = undefined;
  }
  outer.addEventListener("wheel", wheel, { passive: false, capture: true });
  outer.addEventListener("touchstart", start, { passive: true, capture: true });
  outer.addEventListener("touchmove", move, { passive: false, capture: true });
  outer.addEventListener("touchend", end, true);
  outer.addEventListener("touchcancel", end, true);
  return () => {
    outer.removeEventListener("wheel", wheel, true);
    outer.removeEventListener("touchstart", start, true);
    outer.removeEventListener("touchmove", move, true);
    outer.removeEventListener("touchend", end, true);
    outer.removeEventListener("touchcancel", end, true);
  };
}
