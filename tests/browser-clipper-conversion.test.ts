import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { convertClipperMarkdown } from "../apps/server/src/services/browser-clipper-conversion.js";
import { createEditorDocument } from "@smartdoca/slate/headless";
import { MAX_INITIAL_IMPORT_BYTES } from "../packages/core/src/modules/documents/import.js";
import { Node } from "slate";

it("keeps real conversion degradations readable, inserts notices and returns current warnings", async () => {
  const result = await convertClipperMarkdown(
    "Before\n\n$x^2$\n\n<div>HTML text</div>\n\n![Missing](https://example.test/image.png)\n\nAfter",
    new Map(),
  );
  expect(result.warnings.map((item) => item.code)).toEqual([
    "format-degraded",
    "unsupported-content",
    "external-resource",
  ]);
  const body = JSON.stringify(result.initialValue);
  for (const text of [
    "Before",
    "$x^2$",
    "HTML text",
    "[Image: Missing]",
    "After",
  ])
    expect(body).toContain(text);
  expect(
    result.initialValue.filter((node) =>
      JSON.stringify(node).includes("Content not fully converted:"),
    ),
  ).toHaveLength(3);
  expect(result.markdown).toContain("Content not fully converted:");
});

it("preserves every source character and uploaded image when the converter throws", async () => {
  const source = randomUUID(),
    asset = randomUUID();
  const markdown = `Before\n\n![Figure](${source})\n\n<unexpected>原文 [a] $57</unexpected>\n\nAfter`;
  const result = await convertClipperMarkdown(
    markdown,
    new Map([[source, asset]]),
    async () => {
      throw Error("unexpected parser failure");
    },
  );
  expect(result.warnings).toHaveLength(1);
  expect(
    result.initialValue
      .slice(0, -result.warnings.length)
      .filter((node) => !("type" in node) || node.type !== "image")
      .map((node) => Node.string(node))
      .join(""),
  ).toBe(markdown);
  expect(
    result.initialValue.find((node) => "type" in node && node.type === "image"),
  ).toMatchObject({ path: asset });
  expect(JSON.stringify(result.initialValue)).not.toContain(
    "unexpected parser failure",
  );
});

it("preserves complete source and authorized images when formatting expands beyond the new-document import budget", async () => {
  const source = randomUUID(),
    asset = randomUUID();
  const markdown = `Before🙂\n\n${Array.from({ length: 8000 }, (_, i) => `Paragraph ${i} 引用👁️`).join("\n\n")}\n\n![Figure](${source})\n\nAfter`;
  const rich = await convertClipperMarkdown(
    markdown,
    new Map([[source, asset]]),
  );
  expect(
    Buffer.byteLength(JSON.stringify(createEditorDocument(rich.initialValue))),
  ).toBeGreaterThan(MAX_INITIAL_IMPORT_BYTES);
  const result = await convertClipperMarkdown(
    markdown,
    new Map([[source, asset]]),
    undefined,
    [],
    { maxDocumentBytes: MAX_INITIAL_IMPORT_BYTES },
  );
  const literal = result.initialValue
    .slice(0, -result.warnings.length)
    .filter((node) => !("type" in node) || node.type !== "image")
    .map((node) => Node.string(node));
  expect(literal.join("")).toBe(markdown);
  expect(literal.every((text) => Array.from(text).length <= 8192)).toBe(true);
  expect(
    result.initialValue.find((node) => "type" in node && node.type === "image"),
  ).toMatchObject({ path: asset });
  expect(result.warnings).toContainEqual(
    expect.objectContaining({
      code: "format-degraded",
      message: expect.stringContaining("exceeded the document import limit"),
    }),
  );
  expect(
    Buffer.byteLength(
      JSON.stringify(createEditorDocument(result.initialValue)),
    ),
  ).toBeLessThan(MAX_INITIAL_IMPORT_BYTES);
});
