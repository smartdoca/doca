import { expect, it, vi } from "vitest";
import { activeCommentCandidate, isRegionCommentInteraction } from "../apps/web/src/features/comments/region-comment-interaction.js";

function fixture() {
  const cell = { closest: vi.fn(() => null) };
  const outside = { closest: vi.fn(() => null) };
  const surface = { contains: (node: unknown) => node === cell };
  const panel = { contains: () => false, closest: () => surface };
  return { cell: cell as unknown as Element, outside: outside as unknown as Element, panel: panel as unknown as HTMLElement };
}

it("does not dismiss on a cell pointerdown before the SDK anchor click", () => {
  const { panel, cell } = fixture();
  let open = true, active: string | null = "region-a";
  for (let n = 0; n < 5; n++) {
    if (!isRegionCommentInteraction(panel, cell)) { open = false; active = null; }
    expect(open).toBe(true);
    active = activeCommentCandidate(active, ["region-a"]);
    expect(active).toBe("region-a");
  }
  active = activeCommentCandidate(active, ["region-b"]);
  expect(active).toBe("region-b");
  expect(open).toBe(true);
});

it("keeps a selected thread in overlapping candidates", () => {
  expect(activeCommentCandidate("b", ["a", "b"])).toBe("b");
  expect(activeCommentCandidate("other", ["a", "b"])).toBeNull();
  expect(activeCommentCandidate("a", [])).toBeNull();
});

it("still dismisses outside the editor and protects related popovers", () => {
  const { panel, outside } = fixture();
  expect(isRegionCommentInteraction(panel, outside)).toBe(false);
  const popover = { closest: () => ({}) } as unknown as Element;
  expect(isRegionCommentInteraction(panel, popover)).toBe(true);
});
