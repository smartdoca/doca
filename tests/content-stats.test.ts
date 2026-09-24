import { expect, it } from "vitest";
import { characterCount, countContentStats } from "@core/modules/documents/content-stats.js";

it("counts characters, images and attachments from document content", () => {
  expect(characterCount("你好 world")).toBe(7);
  expect(
    countContentStats([
      { type: "paragraph", children: [{ text: "你好" }] },
      { type: "image", alt: "封面", children: [{ text: "" }] },
      { type: "attachment", name: "说明.pdf", children: [{ text: "" }] },
      { type: "video", children: [{ text: "" }] },
    ]),
  ).toEqual({ words: 2, images: 1, attachments: 1 });
  const markdown = { markdown: "![封面](https://example.com/a.png)\n正文" };
  expect(countContentStats(markdown)).toEqual({
    words: characterCount("![封面](https://example.com/a.png)\n正文"),
    images: 1,
    attachments: 0,
  });
});
