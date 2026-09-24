import { z } from "zod";

const leaf = z
  .object({
    text: z.string().max(30000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    code: z.boolean().optional(),
    fontSize: z.number().min(8).max(200).optional(),
    fontFamily: z.string().max(200).optional(),
    color: z.string().max(100).optional(),
    backgroundColor: z.string().max(100).optional(),
  })
  .strict();
const link = z
  .object({
    id: z.string().uuid(),
    type: z.literal("link"),
    url: z
      .string()
      .max(2000)
      .refine((v) => /^(https?:\/\/|mailto:)/i.test(v)),
    children: z.array(leaf).min(1).max(100),
  })
  .strict();
const base = {
  id: z.string().uuid(),
  align: z.enum(["left", "center", "right"]).optional(),
};
const children = z
  .array(z.union([leaf, link]))
  .min(1)
  .max(1000);
const mediaPath = z.union([z.string().uuid(), z.literal("")]).optional();
// Native slatetsx subset, with empty resource paths allowed in local drafts only.
export const noteContentSchema = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({
          ...base,
          type: z.literal("paragraph"),
          title: z.enum(["h1", "h2", "h3", "h4", "h5"]).optional(),
          list: z.enum(["ul", "ol", "checkbox"]).optional(),
          checked: z.boolean().optional(),
          quote: z.boolean().optional(),
          indentation: z.number().int().min(0).max(100).optional(),
          listOrder: z.number().int().min(0).max(100000).optional(),
          children,
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("code-block"),
          language: z.string().max(100).optional(),
          code: z.string().max(30000).optional(),
          children,
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("divider"),
          children: z.array(leaf).min(1).max(1),
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("image"),
          path: mediaPath,
          alt: z.string().max(2000).optional(),
          width: z.number().min(1).max(10000).optional(),
          caption: z.string().max(2000).optional(),
          showCaption: z.boolean().optional(),
          displayStyle: z
            .enum(["plain", "rounded", "bordered", "shadow"])
            .optional(),
          children: z.array(leaf).min(1).max(1),
        })
        .strict(),
      z
        .object({
          ...base,
          type: z.literal("attachment"),
          path: mediaPath,
          name: z.string().max(2000),
          size: z.number().min(0).optional(),
          mimeType: z.string().max(200).optional(),
          children: z.array(leaf).min(1).max(1),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(500);
export const noteBodySchema = z
  .object({
    content: noteContentSchema,
    assetIds: z.array(z.string().uuid()).max(12),
  })
  .strict();
export type NoteContent = z.infer<typeof noteContentSchema>;
export type NoteAsset = {
  id: string;
  filename: string;
  mime: string;
  size: number;
};
export type QuickNote = {
  id: string;
  content: NoteContent;
  assets: NoteAsset[];
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
export function noteText(content: NoteContent) {
  return content
    .map((n) => {
      if (n.type === "image") return n.showCaption ? (n.caption ?? "") : "";
      if (n.type === "attachment" || n.type === "divider") return "";
      const text = n.children
        .map((c) =>
          "text" in c
            ? c.text
            : c.children.map((t) => t.text).join("") + ` (${c.url})`,
        )
        .join("");
      return `${n.type === "paragraph" ? (n.list === "checkbox" ? (n.checked ? "[x] " : "[ ] ") : n.list === "ul" ? "- " : n.list === "ol" ? "1. " : "") : ""}${text}`;
    })
    .join("\n");
}
export function noteHasText(content: NoteContent) {
  return content.some((n) =>
    n.children.some((c) =>
      "text" in c ? c.text.trim() : c.children.some((t) => t.text.trim()),
    ),
  );
}
export function inlineNoteAssets(content: NoteContent) {
  return content.flatMap((n) =>
    (n.type === "image" || n.type === "attachment") && n.path ? [n.path] : [],
  );
}
// Drop only empty edge paragraphs from display, retaining spacing inside the note.
export function displayNoteContent(content: NoteContent) {
  const visible = (n: NoteContent[number]) =>
    n.type !== "paragraph" ||
    n.list === "checkbox" ||
    n.children.some((c) => ("text" in c ? c.text.trim() : true));
  const start = content.findIndex(visible);
  if (start < 0) return [];
  let end = content.length;
  while (end > start && !visible(content[end - 1]!)) end--;
  return content.slice(start, end);
}
export const blankNote = (): NoteContent => [
  { id: crypto.randomUUID(), type: "paragraph", children: [{ text: "" }] },
];
