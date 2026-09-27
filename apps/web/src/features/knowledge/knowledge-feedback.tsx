import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import Preview from "@web/features/documents/markdown-preview.js";
type Case = {
  id: string;
  botTitle: string;
  judgment: string;
  created_at: string;
  message_id: string;
  snapshot: {
    conversationId?: string;
    messageId?: string;
    messages?: Array<{ id: string; role: string; content: string }>;
    question?: string;
    answer?: string;
  };
  reason: string;
};
export function KnowledgeFeedback({
  libraryId,
  openConversation,
}: {
  libraryId: string;
  openConversation: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Case[]>([]),
    [schedule, setSchedule] = useState("off"),
    [selected, setSelected] = useState<Case>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const root = `/knowledge/libraries/${libraryId}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Case[]; schedule: string }>(
      `${root}/feedback-workspace`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((x) => {
        setItems(x.items);
        setSchedule(x.schedule);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [root]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="knowledge-feedback-panel">
      <div className="knowledge-section-heading">
        <div>
          <h3>{t("studio.feedback")}</h3>
          <p>{t("curator.feedbackHint")}</p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy || !items.length}
          onClick={() =>
            void work(async () => {
              const result = await api<{ conversationId: string }>(
                `${root}/feedback-run`,
                "POST",
              );
              openConversation(result.conversationId);
            })
          }
        >
          {t("curator.analyzeFeedback")}
        </button>
      </div>
      <label>
        {t("curator.feedbackSchedule")}{" "}
        <select
          value={schedule}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value;
            void work(async () => {
              await api(`${root}/feedback-schedule`, "POST", {
                schedule: next,
              });
              setSchedule(next);
            });
          }}
        >
          {["off", "daily", "weekly"].map((mode) => (
            <option key={mode} value={mode}>
              {t(
                mode === "off"
                  ? "knowledge.manualOnly"
                  : mode === "daily"
                    ? "library.trigger.daily"
                    : "library.trigger.weekly",
              )}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="curator-feedback-list">
        {items.map((item) => (
          <button
            className="kc-task-card"
            type="button"
            key={item.id}
            onClick={() => setSelected(item)}
          >
            <strong>
              {item.botTitle} ·{" "}
              {t(
                item.judgment === "useful"
                  ? "studio.useful"
                  : "studio.unhelpful",
              )}
            </strong>
            <span>
              {item.snapshot.messages?.filter((m) => m.role === "user").at(-1)
                ?.content ||
                item.snapshot.question ||
                item.reason}
            </span>
            <small>{new Date(item.created_at).toLocaleString(locale)}</small>
          </button>
        ))}
      </div>
      {!items.length && <p>{t("studio.noFeedback")}</p>}
      {selected && (
        <Dialog
          title={selected.botTitle}
          close={() => setSelected(undefined)}
          className="curator-detail-dialog"
        >
          <p>{t("curator.snapshotHint")}</p>
          {selected.snapshot.messages?.map((message) => (
            <article
              key={message.id}
              className={
                message.id === selected.message_id
                  ? "curator-feedback-target"
                  : ""
              }
            >
              <strong>
                {message.role === "user"
                  ? t("curator.question")
                  : t("curator.answer")}
                {message.id === selected.message_id
                  ? ` · ${t("curator.feedbackTarget")}`
                  : ""}
              </strong>
              <Preview value={message.content} />
            </article>
          ))}
          {!selected.snapshot.messages && (
            <>
              <Preview value={selected.snapshot.question ?? ""} />
              <Preview value={selected.snapshot.answer ?? ""} />
            </>
          )}
        </Dialog>
      )}
    </section>
  );
}
