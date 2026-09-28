import { Checkbox } from "antd";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
type Connection = {
  id: string;
  title: string;
  accessible: boolean;
  connected: boolean;
  invitationPending: boolean;
  preference: string;
  preferenceRevision: number;
};
export function KnowledgeConnections({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Connection[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () =>
    setItems(
      (await api<{ items: Connection[] }>("/knowledge/assistants")).items,
    );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const available = items?.filter((item) => item.accessible) ?? [];
  const selected = available.filter((item) => item.connected).length;
  async function selectConnections(targets: Connection[], enabled: boolean) {
    await act(async () => {
      const outcomes = await Promise.allSettled(
        targets.map((item) =>
          api(`/knowledge/assistants/${item.id}/connection`, "PUT", {
            integration: enabled ? "enabled" : "disabled",
            expectedRevision: item.preferenceRevision,
          }),
        ),
      );
      await load();
      const failed = outcomes.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }
  if (compact)
    return (
      <div className="ai-knowledge-sources">
        <Checkbox
          disabled={busy || !available.length}
          checked={!!available.length && selected === available.length}
          indeterminate={selected > 0 && selected < available.length}
          onChange={(e) => void selectConnections(available, e.target.checked)}
        >
          {t("chat.selectAllAnswers")}
        </Checkbox>
        <Feedback message={error} tone="error" />
        {!items && <p>{t("common.loading")}</p>}
        {items?.length === 0 && <p>{t("knowledge.botsEmpty")}</p>}
        {items?.map((item) => (
          <div key={item.id}>
            <Checkbox
              disabled={busy || !item.accessible}
              checked={item.connected}
              onChange={(e) => void selectConnections([item], e.target.checked)}
            >
              {item.title}
            </Checkbox>
            {item.invitationPending && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(`/knowledge/assistants/${item.id}/visit`, "POST", {
                      accept: true,
                    }),
                  )
                }
              >
                {t("knowledge.acceptInvitation")}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  return (
    <section>
      <p>{t("knowledge.connectionsHint")}</p>
      <Feedback message={error} tone="error" />
      {items?.length === 0 && <p>{t("knowledge.botsEmpty")}</p>}
      {items?.map((item) => (
        <div className="knowledge-bot-config" key={item.id}>
          <strong>{item.title}</strong>
          <p>
            {t(
              item.connected
                ? "knowledge.connectionActive"
                : "knowledge.connectionInactive",
            )}
          </p>
          {item.invitationPending && (
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/knowledge/assistants/${item.id}/visit`, "POST", {
                    accept: true,
                  }),
                )
              }
            >
              {t("knowledge.acceptInvitation")}
            </button>
          )}
          {item.accessible && (
            <Select
              aria-label={`${item.title} · ${t("knowledge.connections")}`}
              disabled={busy}
              value={item.preference}
              onChange={(e) =>
                void act(() =>
                  api(`/knowledge/assistants/${item.id}/connection`, "PUT", {
                    integration: e.target.value,
                    expectedRevision: item.preferenceRevision,
                  }),
                )
              }
            >
              <option value="default">
                {t("knowledge.connectionDefault")}
              </option>
              <option value="enabled">
                {t("knowledge.connectionEnabled")}
              </option>
              <option value="disabled">
                {t("knowledge.connectionDisabled")}
              </option>
            </Select>
          )}
        </div>
      ))}
    </section>
  );
}
