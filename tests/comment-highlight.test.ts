// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useCommentHighlight } from "@web/features/comments/use-comment-highlight.js";
import type { Detail } from "@web/shared/api.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("highlights only a clicked comment and clears on outside clicks, close and resolution", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const comments: Detail["comments"] = ["a", "b"].map((id) => ({
    id,
    anchor: "{}",
    parent_id: null,
    resolved: 0,
    deleted_at: null,
    body: id,
    author_id: "author",
    display_name: "Author",
    version: 1,
    created_at: "2026-10-28T00:00:00Z",
  }));
  function View({ resolved = false }: { resolved?: boolean }) {
    const [open, setOpen] = useState(true);
    const [active, setActive] = useState("a"); // Link/native navigation may already select a card.
    const [highlighted, highlight] = useCommentHighlight(
      "document",
      comments.map((c) => ({ ...c, resolved: Number(resolved) })),
    );
    return createElement(
      "section",
      null,
      createElement("output", {
        "data-highlight": highlighted ?? "",
        "data-active": active,
      }),
      createElement(
        "div",
        {
          className: "editor",
          onPointerDown: (e) => e.stopPropagation(),
          onClick: () => setActive("a"),
        },
        "Document content",
      ),
      createElement("div", { className: "sidebar-blank" }, "Other position"),
      createElement(
        "button",
        {
          className: "toggle",
          onClick: () => {
            setOpen(!open);
            highlight(null);
          },
        },
        "Toggle comments",
      ),
      open &&
        comments.map((c) =>
          createElement(
            "article",
            {
              key: c.id,
              "data-thread-id": c.id,
              onClick: () => {
                setActive(c.id);
                highlight(c.id);
              },
            },
            createElement(
              "span",
              { onPointerDown: (e) => e.stopPropagation() },
              c.id,
            ),
          ),
        ),
    );
  }
  const click = async (selector: string) =>
    act(() => {
      const target = host.querySelector<HTMLElement>(selector)!;
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      target.click();
    });
  const selected = () =>
    host.querySelector("output")!.getAttribute("data-highlight");
  try {
    await act(() => root.render(createElement(View)));
    expect(selected()).toBe("");
    await click('[data-thread-id="a"] span');
    expect(selected()).toBe("a");
    await click('[data-thread-id="b"] span');
    expect(selected()).toBe("b");
    await click(".editor");
    expect(selected()).toBe("");
    await click('[data-thread-id="b"] span');
    expect(selected()).toBe("b");
    await click(".sidebar-blank");
    expect(selected()).toBe("");
    await click('[data-thread-id="b"] span');
    await click(".toggle");
    expect(selected()).toBe("");
    await click(".toggle");
    expect(selected()).toBe("");
    await click('[data-thread-id="a"] span');
    await act(() => root.render(createElement(View, { resolved: true })));
    expect(selected()).toBe("");
    await act(() => root.render(createElement(View)));
    expect(selected()).toBe("");
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
