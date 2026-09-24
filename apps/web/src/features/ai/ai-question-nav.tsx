import { ListTree } from "lucide-react";
import { Button, Popover, Tooltip } from "antd";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { UserQuestion } from "@web/features/ai/ai-session-ux.js";

function scrollQuestionIntoView(
  root: HTMLElement | null,
  id?: string | null,
  align: "end" | "nearest" = "end",
) {
  if (!root || !id) return;
  const item = root.querySelector<HTMLElement>(`[data-nav-question="${id}"]`);
  if (!item) return;
  const rootRect = root.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (
    align === "nearest" &&
    itemRect.top >= rootRect.top &&
    itemRect.bottom <= rootRect.bottom
  )
    return;
  root.scrollTop +=
    align === "end" || itemRect.bottom > rootRect.bottom
      ? itemRect.bottom - rootRect.bottom
      : itemRect.top - rootRect.top;
}

export function AIQuestionNav({
  questions,
  activeId,
  variant,
  onJump,
}: {
  questions: UserQuestion[];
  activeId?: string | null;
  variant: "rail" | "popover";
  onJump: (id: string) => void;
}) {
  const menuRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const targetId = activeId ?? questions.at(-1)?.id;
  const latestId = questions.at(-1)?.id;
  useLayoutEffect(() => {
    if (variant !== "rail") return;
    scrollQuestionIntoView(railRef.current, targetId, "nearest");
  }, [variant, targetId, questions.length]);
  useEffect(() => {
    if (variant !== "rail") return;
    const frame = requestAnimationFrame(() =>
      scrollQuestionIntoView(railRef.current, targetId, "nearest"),
    );
    return () => cancelAnimationFrame(frame);
  }, [variant, targetId, questions.length]);
  const revealLatest = (open: boolean) => {
    if (!open) return;
    const run = () =>
      scrollQuestionIntoView(menuRef.current, latestId, "end");
    requestAnimationFrame(() => requestAnimationFrame(run));
  };
  if (questions.length < 2) return null;
  const items = questions.map((q) => (
    <button
      key={q.id}
      type="button"
      data-nav-question={q.id}
      className={`ai-question-nav-item ${q.id === targetId ? "active" : ""}`}
      title={q.text}
      aria-label={q.text}
      aria-current={q.id === targetId ? "true" : undefined}
      onClick={() => onJump(q.id)}
    >
      <span className="ai-question-nav-dot" />
      {variant === "popover" && (
        <span className="ai-question-nav-label">{q.text}</span>
      )}
    </button>
  ));
  if (variant === "popover")
    return (
      <Popover
        trigger="click"
        placement="bottomRight"
        overlayClassName="ai-question-nav-overlay"
        onOpenChange={revealLatest}
        afterOpenChange={revealLatest}
        content={
          <nav
            ref={menuRef}
            className="ai-question-nav-menu"
            aria-label="问题导航"
          >
            {items}
          </nav>
        }
      >
        <Button
          type="text"
          className="ai-question-nav-trigger"
          aria-label="问题导航"
          title="问题导航"
        >
          <ListTree size={17} />
        </Button>
      </Popover>
    );
  return (
    <nav ref={railRef} className="ai-question-nav-rail" aria-label="问题导航">
      {questions.map((q) => (
        <Tooltip
          key={q.id}
          title={q.text}
          placement="right"
          mouseEnterDelay={0.12}
        >
          <button
            type="button"
            data-nav-question={q.id}
            className={`ai-question-nav-item ${q.id === targetId ? "active" : ""}`}
            aria-label={q.text}
            aria-current={q.id === targetId ? "true" : undefined}
            onClick={() => onJump(q.id)}
          >
            <span className="ai-question-nav-dot" />
          </button>
        </Tooltip>
      ))}
    </nav>
  );
}
