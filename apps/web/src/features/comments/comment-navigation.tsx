import { ArrowUpToLine, ChevronUp, ChevronDown } from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";

export function CommentNavigation({
  ids,
  active,
  select,
}: {
  ids: string[];
  active: string | null;
  select(id: string): void;
}) {
  const { t } = useI18n();
  const index = active ? ids.indexOf(active) : -1;
  return (
    <nav className="comment-navigation" aria-label={t("comment.nav")}>
      <button
        className="icon"
        title={t("comment.first")}
        aria-label={t("comment.first")}
        disabled={!ids.length}
        onClick={() => select(ids[0]!)}
      >
        <ArrowUpToLine size={16} />
      </button>
      <button
        className="icon"
        title={t("comment.previous")}
        aria-label={t("comment.previous")}
        disabled={index <= 0}
        onClick={() => select(ids[index - 1]!)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        className="icon"
        title={t("comment.next")}
        aria-label={t("comment.next")}
        disabled={!ids.length || index >= ids.length - 1}
        onClick={() => select(ids[index + 1]!)}
      >
        <ChevronDown size={16} />
      </button>
    </nav>
  );
}
