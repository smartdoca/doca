import { expect, it } from "vitest";
import { contentBlocks } from "@core/modules/content/blocks.js";

it("keeps unchanged paragraph identities and fingerprints when another paragraph is inserted or edited", () => {
  const before = contentBlocks(
    "Project",
    "First task\n\nSecond task\n\nThird task",
  );
  const inserted = contentBlocks(
    "Project",
    "New task\n\nFirst task\n\nSecond task\n\nThird task",
  );
  expect(inserted.slice(1).map((x) => [x.blockId, x.fingerprint])).toEqual(
    before.map((x) => [x.blockId, x.fingerprint]),
  );
  const edited = contentBlocks(
    "Project",
    "First task\n\nUpdated task\n\nThird task",
  );
  expect(edited[0]).toEqual(before[0]);
  expect(edited[2]).toEqual(before[2]);
  expect(edited[1]!.blockId).not.toBe(before[1]!.blockId);
});

it("includes meaningful heading context but not order in fingerprints", () => {
  const before = contentBlocks(
    "Project",
    "# Monday\n\nSubmit report\n\n# Friday\n\nSend invoice",
  );
  const after = contentBlocks(
    "Project",
    "# Tuesday\n\nSubmit report\n\n# Friday\n\nSend invoice",
  );
  expect(after[1]!.blockId).toBe(before[1]!.blockId);
  expect(after[1]!.fingerprint).not.toBe(before[1]!.fingerprint);
  expect(after[3]).toEqual(before[3]);
});

it("disambiguates duplicate text and normalizes line endings", () => {
  const blocks = contentBlocks("Title", "Repeat\n\nRepeat\n\nOther");
  expect(new Set(blocks.map((b) => b.blockId)).size).toBe(3);
  expect(contentBlocks("Title", "Repeat\r\n\r\nRepeat\r\n\r\nOther")).toEqual(
    blocks,
  );
  expect(blocks[0]!.fingerprint).toBe(blocks[1]!.fingerprint);
});

it("preserves the tail of long paragraphs and does not cut Unicode surrogate pairs", () => {
  const text = "😀".repeat(2501) + "TAIL";
  const blocks = contentBlocks("Title", text);
  expect(blocks.map((b) => b.text).join("")).toBe(text);
  expect(
    blocks.every(
      (b) => b.text.length <= 2000 && !/[\uD800-\uDBFF]$/u.test(b.text),
    ),
  ).toBe(true);
  expect(blocks.at(-1)!.text.endsWith("TAIL")).toBe(true);
});

it("represents title-only documents without losing their content", () => {
  expect(contentBlocks("Untitled notes", "")).toMatchObject([
    { title: "Untitled notes", text: "Untitled notes" },
  ]);
  expect(contentBlocks("", "")).toEqual([]);
});

it("invalidates nested tasks when an ancestor date heading changes", () => {
  const before = contentBlocks("Plan", "# Monday\n\n## Alice\n\nSubmit budget");
  const after = contentBlocks("Plan", "# Tuesday\n\n## Alice\n\nSubmit budget");
  expect(after[2]!.blockId).toBe(before[2]!.blockId);
  expect(after[2]!.fingerprint).not.toBe(before[2]!.fingerprint);
  expect(after[2]!.anchor.heading).toBe("Tuesday / Alice");
});
