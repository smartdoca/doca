import { useEffect, useState } from "react";
import { Select } from "antd";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
export function KnowledgeModelPicker({ libraryId }: { libraryId: string }) {
  const { t } = useI18n();
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]),
    [model, setModel] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.all([
      api<any>("/ai/options"),
      api<any>(`/knowledge/libraries/${libraryId}/system`),
    ])
      .then(([options, system]) => {
        if (live) {
          setModels(options.models);
          setModel(
            system.settings.modelId ||
              options.defaultModel ||
              options.models[0]?.id,
          );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [libraryId]);
  return (
    <div className="kc-model-picker">
      <Select
        aria-label={t("chat.selectModel")}
        variant="borderless"
        popupMatchSelectWidth={false}
        value={model}
        placeholder={t("chat.noModel")}
        disabled={busy || !models.length}
        options={models.map((m) => ({ value: m.id, label: m.name }))}
        onChange={async (value) => {
          setBusy(true);
          setError("");
          try {
            const system = await api<any>(
              `/knowledge/libraries/${libraryId}/system`,
            );
            await api(`/knowledge/libraries/${libraryId}/settings`, "PUT", {
              expectedRevision: system.settingsRevision,
              settings: { ...system.settings, modelId: value },
            });
            setModel(value);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
