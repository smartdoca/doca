import { expect, it } from "vitest";
import {
  blankNote,
  displayNoteContent,
  noteContentSchema,
  noteText,
} from "@core/shared/quick-notes.js";
it("hides empty display edges without removing interior spacing or unchecked tasks", () => {
  const text = { ...blankNote()[0]!, children: [{ text: "记录" }] };
  const empty = blankNote()[0]!;
  expect(displayNoteContent([empty])).toEqual([]);
  expect(displayNoteContent([empty, text, empty, text, empty])).toEqual([
    text,
    empty,
    text,
  ]);
  const todo = { ...empty, list: "checkbox" as const };
  expect(displayNoteContent([todo])).toEqual([todo]);
});
it("accepts the native lightweight format and preserves AI text extraction", () => {
  const content = noteContentSchema.parse([
    {
      ...blankNote()[0]!,
      title: "h2",
      children: [{ text: "标题", underline: true, backgroundColor: "#fff1b8" }],
    },
    {
      id: crypto.randomUUID(),
      type: "code-block",
      language: "text",
      children: [{ text: "example" }],
    },
    {
      id: crypto.randomUUID(),
      type: "image",
      path: crypto.randomUUID(),
      caption: "配图",
      showCaption: true,
      children: [{ text: "" }],
    },
  ]);
  expect(noteText(content)).toBe("标题\nexample\n配图");
});
