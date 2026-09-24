import { afterEach, expect, it, vi } from "vitest";
import { scrollCommentIntoView } from "../apps/web/src/features/comments/comment-scroll.js";

afterEach(() => vi.unstubAllGlobals());
function fixture(top: number, bottom: number) {
  const outer = { overflowY: "hidden", scrollTo: vi.fn(), parentElement: null };
  const panel = {
    overflowY: "auto", scrollHeight: 2000, clientHeight: 500,
    clientTop: 0, scrollTop: 200, scrollLeft: 90,
    parentElement: outer, getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: vi.fn(),
  };
  vi.stubGlobal("getComputedStyle", (node: any) => node);
  const target = { parentElement: panel, getBoundingClientRect: () => ({ top, bottom }) };
  return { panel, outer, target: target as unknown as Element };
}
it("reveals only vertically inside the closest scrollport", () => {
  const f = fixture(650, 750);
  scrollCommentIntoView(f.target);
  expect(f.panel.scrollTo).toHaveBeenCalledWith({ top: 350, behavior: "smooth" });
  expect(f.panel.scrollLeft).toBe(90);
  expect(f.outer.scrollTo).not.toHaveBeenCalled();
});
it("does not move a visible card or a missing target", () => {
  const f = fixture(150, 250);
  scrollCommentIntoView(f.target);
  scrollCommentIntoView(null);
  expect(f.panel.scrollTo).not.toHaveBeenCalled();
});
it("centers offscreen content without setting a horizontal coordinate", () => {
  const f = fixture(-100, 0);
  scrollCommentIntoView(f.target, "center");
  expect(f.panel.scrollTo).toHaveBeenCalledWith({ top: -200, behavior: "smooth" });
});
