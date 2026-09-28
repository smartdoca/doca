import { useEffect, useState, type RefObject } from "react";
import { ChevronsLeft } from "lucide-react";

type Heading = { id: string; text: string; level: number };

export function DocumentOutline({
  headings,
  container,
  navigate,
  collapse,
}: {
  headings: Heading[];
  container: RefObject<HTMLElement | null>;
  navigate: (id: string) => void;
  collapse: () => void;
}) {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const scroller = host.closest(".main-scroll");
      const top = scroller?.getBoundingClientRect().top ?? 0;
      let current = headings[0]?.id;
      for (const heading of headings) {
        const block = host.querySelector(
          `[data-block-id="${CSS.escape(heading.id)}"]`,
        );
        if (!block) continue;
        // Match the heading's scroll-margin so the item that lands at the
        // top of the document scroller stays the active nav entry.
        const margin = parseFloat(getComputedStyle(block).scrollMarginTop) || 0;
        if (block.getBoundingClientRect().top > top + margin + 8) break;
        current = heading.id;
      }
      if ((host.closest(".main-scroll")?.scrollTop ?? 0) <= 1)
        current = headings[0]?.id;
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [headings, container]);
  return (
    <nav className="document-outline" aria-label="文档大纲">
      <button
        className="outline-collapse"
        aria-label="收起文档导航"
        title="收起文档导航"
        onClick={collapse}
      >
        <ChevronsLeft size={19} />
      </button>
      <div className="document-outline-links">
        {headings.map((h) => (
          <button
            key={h.id}
            title={h.text || "无标题"}
            data-level={h.level}
            aria-current={h.id === active ? "location" : undefined}
            style={{ paddingLeft: 8 + Math.max(0, h.level - 1) * 14 }}
            onClick={() => {
              setActive(h.id);
              navigate(h.id);
            }}
          >
            {h.text || "无标题"}
          </button>
        ))}
        {!headings.length && (
          <p className="outline-empty">添加标题后显示文档导航</p>
        )}
      </div>
    </nav>
  );
}
