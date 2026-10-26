import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { convertClipperMarkdown } from "../apps/server/src/services/browser-clipper-conversion.js";

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
  expect(result.initialValue[0]).toMatchObject({
    children: [{ text: markdown }],
  });
  expect(
    result.initialValue.find((node) => "type" in node && node.type === "image"),
  ).toMatchObject({ path: asset });
  expect(JSON.stringify(result.initialValue)).not.toContain(
    "unexpected parser failure",
  );
});
