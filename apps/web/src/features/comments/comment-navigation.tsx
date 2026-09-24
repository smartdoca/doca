import { ArrowUpToLine, ChevronUp, ChevronDown } from "lucide-react";

export function CommentNavigation({
  ids,
  active,
  select,
}: {
  ids: string[];
  active: string | null;
  select(id: string): void;
}) {
  const index = active ? ids.indexOf(active) : -1;
  return (
    <nav className="comment-navigation" aria-label="评论定位">
      <button
        className="icon"
        title="首条评论"
        aria-label="首条评论"
        disabled={!ids.length}
        onClick={() => select(ids[0]!)}
      >
        <ArrowUpToLine size={16} />
      </button>
      <button
        className="icon"
        title="上一条评论"
        aria-label="上一条评论"
        disabled={index <= 0}
        onClick={() => select(ids[index - 1]!)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        className="icon"
        title="下一条评论"
        aria-label="下一条评论"
        disabled={!ids.length || index >= ids.length - 1}
        onClick={() => select(ids[index + 1]!)}
      >
        <ChevronDown size={16} />
      </button>
    </nav>
  );
}
