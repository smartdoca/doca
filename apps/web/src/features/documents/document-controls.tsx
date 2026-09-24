import { BookOpen, FileText, FileCode2, Table2, Presentation, SquarePen } from "lucide-react";
import { Select } from "@web/shared/components/select.js";
import type { Resource } from "@web/shared/api.js";
import "@web/features/documents/document-icons.css";

export function FileIcon({ r, size = "regular" }: {
  r: Pick<Resource, "kind" | "format">;
  size?: "regular" | "compact";
}) {
  const Icon =
    r.kind === "library"
      ? BookOpen
      : r.format === "spreadsheet"
        ? Table2
        : r.format === "canvas"
          ? SquarePen
          : r.format === "presentation"
          ? Presentation
          : r.format === "markdown"
          ? FileCode2
          : FileText;
  return (
    <span
      className={"file-glyph " + (r.kind === "library" ? "library" : r.format) + (size === "compact" ? " compact" : "")}
      aria-hidden="true"
    >
      <Icon size={size === "compact" ? 15 : 19} />
    </span>
  );
}
export function TypeFilter({
  value,
  change,
}: {
  value: string;
  change: (v: string) => void;
}) {
  return (
    <Select
      aria-label="文档类型"
      value={value}
      onChange={(e) => change(e.target.value)}
    >
      <option value="">全部类型</option>
      <option value="rich_text">文档</option>
      <option value="spreadsheet">表格</option>
      <option value="presentation">演示文稿</option>
      <option value="markdown">Markdown</option>
    </Select>
  );
}
