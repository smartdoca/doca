import { BookOpen, FileText, FileCode2, Table2, Presentation, SquarePen } from "lucide-react";
import { Select } from "@web/shared/components/select.js";
import { useI18n } from "@web/shared/i18n.js";
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
  const { t } = useI18n();
  return (
    <Select
      aria-label={t("doc.filterType")}
      value={value}
      onChange={(e) => change(e.target.value)}
    >
      <option value="">{t("doc.filter.all")}</option>
      <option value="rich_text">{t("shell.type.rich")}</option>
      <option value="spreadsheet">{t("shell.type.sheet")}</option>
      <option value="presentation">{t("shell.type.slides")}</option>
      <option value="markdown">{t("shell.type.markdown")}</option>
    </Select>
  );
}
