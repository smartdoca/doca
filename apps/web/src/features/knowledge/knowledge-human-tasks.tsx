import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import Preview from "@web/features/documents/markdown-preview.js";
type Task = {
  id: string;
  title: string;
  conversation_id: string;
  revision: number;
  detail: { reason: string; options?: string[]; sourceKey?: string };
  entry?: { markdown: string; title: string };
};
export function HumanTasks({
  libraryId,
  conversationId,
}: {
  libraryId: string;
  conversationId: string;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Task[]>([]),
    [selected, setSelected] = useState<Task>(),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const root = `/knowledge/libraries/${libraryId}/human-tasks`;
  const load = async () => {
    const data = await api<{ items: Task[] }>(root);
    setItems(data.items);
    setSelected((old) =>
      old ? data.items.find((x) => x.id === old.id) : undefined,
    );
  };
  useEffect(() => {
    let live = true;
    const update = () =>
      api<{ items: Task[] }>(root)
        .then((x) => {
          if (live) {
            setItems(x.items);
            setSelected((old) =>
              old &&
              x.items.some(
                (item) => item.id === old.id && item.revision === old.revision,
              )
                ? old
                : undefined,
            );
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void update();
    const timer = setInterval(() => void update(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [root, conversationId]);
  async function resolve(action: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`${root}/${selected.id}/resolve`, "POST", {
        action,
        revision: selected.revision,
        reason,
      });
      setSelected(undefined);
      setReason("");
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="kc-assets kc-human-tasks">
      <h3>
        {t("curator.todos")} <small>{items.length}</small>
      </h3>
      <p>{t("curator.todosHint")}</p>
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <button
          className="kc-task-card"
          type="button"
          key={item.id}
          onClick={() => {
            setSelected(item);
            setReason("");
            setError("");
            void api<Task>(`${root}/${item.id}`)
              .then((detail) =>
                setSelected((old) => (old?.id === detail.id ? detail : old)),
              )
              .catch((e) => {
                setError(e.message);
                setSelected(undefined);
              });
          }}
        >
          <strong>{item.title}</strong>
          <small>
            {t(
              item.conversation_id === conversationId
                ? "curator.currentSession"
                : "curator.previousSession",
            )}
          </small>
          <span>
            {item.detail.reason === "draft_review"
              ? t("curator.draftReview")
              : item.detail.reason}
          </span>
        </button>
      ))}
      {!items.length && <p>{t("curator.noTodos")}</p>}
      {selected && (
        <Dialog
          title={selected.title}
          close={() => {
            if (!busy) setSelected(undefined);
          }}
          className="curator-detail-dialog"
        >
          <p>
            {selected.detail.reason === "draft_review"
              ? t("curator.draftReview")
              : selected.detail.reason}
          </p>
          {selected.detail.sourceKey && <p>{selected.detail.sourceKey}</p>}
          {selected.detail.options?.map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => setReason(option)}
            >
              {option}
            </button>
          ))}
          {selected.entry && <Preview value={selected.entry.markdown} />}
          <label>
            {t("curator.decision")}
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="curator-actions">
            {selected.entry && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve("adopt")}
              >
                {t("studio.adopt")}
              </button>
            )}
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => void resolve("resolve")}
            >
              {t("curator.submitDecision")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resolve("dismiss")}
            >
              {t("curator.dismiss")}
            </button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
