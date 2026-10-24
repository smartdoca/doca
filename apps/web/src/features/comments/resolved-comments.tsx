import { useState } from "react";
import { Button, Empty, Modal } from "antd";
import { CircleCheck, RotateCcw } from "lucide-react";
import { api, type Comment, type Detail, type User } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { CommentMessage } from "./rich-comments.js";

/** Resolution is existing host comment state, separate from editor content. */
export function ResolvedComments({ detail, user, rank, changed, loadMore, quote }: {
  detail: Detail;
  user: User | null;
  rank: number;
  changed(): void;
  loadMore?: () => Promise<void>;
  quote(comment: Comment): string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const roots = detail.comments.filter(c => c.anchor && !c.parent_id && !c.deleted_at && c.resolved);
  async function restore(comment: Comment) {
    if (pending) return;
    setPending(comment.id);
    setError("");
    try {
      await api(`/resources/${detail.resource.id}/comments/${comment.id}`, "PATCH", {
        version: comment.version, resolved: false,
      });
      changed();
    } catch (error) {
      setError((error as Error).message);
    } finally { setPending(null); }
  }
  return <>
    <button type="button" className="icon comment-control"
      title={t("comment.resolved")} aria-label={t("comment.resolved")} aria-expanded={open}
      onClick={() => { setError(""); setOpen(true); }}>
      <CircleCheck size={16} />
    </button>
    <Modal open={open} title={t("comment.resolved")} footer={null} width={680}
      onCancel={() => setOpen(false)}>
      <Feedback message={error} tone="error" />
      <div className="resolved-comments-list">
        {!roots.length && <Empty description={t("comment.resolvedEmpty")} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        {roots.map(root => <article key={root.id} data-thread-id={root.id} className="selection-thread resolved-comment-thread">
          <div className="resolved-comment-heading">
            <div className="comment-quote">{quote(root)}</div>
            {user && rank >= 2 && (root.author_id === user.id || rank >= 4) &&
              <Button size="small" icon={<RotateCcw size={14} />} loading={pending === root.id} disabled={pending !== null}
                onClick={() => void restore(root)}>{t("comment.restore")}</Button>}
          </div>
          {[root, ...detail.comments.filter(c => c.parent_id === root.id)].map(comment =>
            <CommentMessage key={comment.id} comment={comment} user={user} rank={0} edit={() => {}} act={() => {}} />)}
        </article>)}
        {detail.commentsNextCursor && loadMore && <Button className="resolved-comments-more" loading={pending === "more"} disabled={pending !== null}
          onClick={async () => {
            setPending("more"); setError("");
            try { await loadMore(); } catch (error) { setError((error as Error).message); }
            finally { setPending(null); }
          }}>{t("comment.more")}</Button>}
      </div>
    </Modal>
  </>;
}
