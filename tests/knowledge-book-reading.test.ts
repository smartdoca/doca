import { expect, it } from "vitest";
import {
  bookReadingModel,
  orderedBookPages,
  bookPageTree,
  type BookPage,
} from "../apps/web/src/features/knowledge-books/book-reading-model.js";

function page(id: string, path: string[], markdown: string[]): BookPage {
  return {
    id,
    title: id,
    path,
    paragraphs: markdown.map((markdown, index) => ({
      id: `${id}-p${index}`,
      markdown,
      claimIds: [],
      reason: "",
    })),
  };
}

it("orders previous/next articles by the displayed directory, including interleaved source pages", () => {
  const pages = [
    page("a1", ["A", "inner"], []),
    page("b1", ["B"], []),
    page("a2", ["A"], []),
    page("a3", ["A", "inner"], []),
  ];
  expect(orderedBookPages(pages).map((item) => item.id)).toEqual([
    "a1",
    "a3",
    "a2",
    "b1",
  ]);
  expect(bookPageTree(pages).map((node) => node.title)).toEqual(["A", "B"]);
});

it("uses real heading text and levels, distinguishes duplicate titles and ignores fenced code comments", () => {
  const model = bookReadingModel(
    page(
      "network",
      [],
      [
        "## **TCP** 与流控\n\n介绍\n\n```sh\n# shell comment\n```",
        "### 窗口\n\n细节\n\n## TCP 与流控\n\n续",
      ],
    ),
  );
  expect(model.headings).toBe(true);
  expect(
    model.outline.map(({ label, depth, line, localLine }) => ({
      label,
      depth,
      line,
      localLine,
    })),
  ).toEqual([
    { label: "TCP 与流控", depth: 2, line: 1, localLine: 1 },
    { label: "窗口", depth: 3, line: 9, localLine: 1 },
    { label: "TCP 与流控", depth: 2, line: 13, localLine: 5 },
  ]);
  expect(new Set(model.outline.map((item) => item.id)).size).toBe(3);
});

it("parses the complete reading Markdown so code fences spanning stored paragraphs do not create false headings", () => {
  const model = bookReadingModel(
    page(
      "code",
      [],
      [
        "```sh\necho test",
        "## still a shell comment\n```\n\n## Actual section\n\nBody",
      ],
    ),
  );
  expect(model.outline.map((item) => item.label)).toEqual(["Actual section"]);
  expect(model.markdown).toBe(
    "```sh\necho test\n\n## still a shell comment\n```\n\n## Actual section\n\nBody",
  );
});

it("offers accurately numbered paragraph excerpts for valid articles without headings and leaves the artifact untouched", () => {
  const input = page(
    "plain",
    [],
    [
      "First *paragraph*.\n\nA continuation.",
      "\n\nSecond paragraph with `code`.",
    ],
  );
  const snapshot = JSON.stringify(input);
  const model = bookReadingModel(input);
  expect(model.headings).toBe(false);
  expect(
    model.outline.map(({ label, line, localLine, paragraphId }) => ({
      label,
      line,
      localLine,
      paragraphId,
    })),
  ).toEqual([
    {
      label: "First paragraph. A continuation.",
      line: 1,
      localLine: 1,
      paragraphId: "plain-p0",
    },
    {
      label: "Second paragraph with code.",
      line: 7,
      localLine: 3,
      paragraphId: "plain-p1",
    },
  ]);
  expect(JSON.stringify(input)).toBe(snapshot);
});
