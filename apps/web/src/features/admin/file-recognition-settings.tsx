import { useI18n } from "@web/shared/i18n.js";
import { Check, ScanText, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";

type FileGroup = "image" | "pdf" | "office" | "text" | "other";
type FileSource = "personal" | "ai" | "documents" | "shared";
type Config = {
  enabled: boolean;
  modelId: string | null;
  ocrEnabled: boolean;
  recognitionGroups: FileGroup[];
  recognitionSources: FileSource[];
  searchGroups: FileGroup[];
};
type Settings = {
  revision: number;
  config: Config;
  models: Array<{ id: string; name: string; vision: boolean; pdf: boolean }>;
};

export function FileRecognitionSettings() {
  const { t } = useI18n();
  const [data, setData] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Settings>("/admin/files/recognition")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  async function save() {
    if (!data) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<Pick<Settings, "revision" | "config">>(
        "/admin/files/recognition",
        "PUT",
        { revision: data.revision, config: data.config },
      );
      setData((old) => (old ? { ...old, ...next } : old));
      setMessage(t("recognition.saved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("recognition.saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  const update = (patch: Partial<Config>) =>
    setData((old) =>
      old ? { ...old, config: { ...old.config, ...patch } } : old,
    );
  const toggle = <T extends string>(values: T[], value: T) =>
    values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
  const groups = [
    ["image", t("recognition.image")],
    ["pdf", "PDF"],
    ["office", "Office"],
    ["text", t("recognition.text")],
    ["other", t("recognition.other")],
  ] as const;
  const sources = [
    ["personal", t("recognition.personal")],
    ["ai", t("recognition.ai")],
    ["documents", t("recognition.documents")],
    ["shared", t("recognition.shared")],
  ] as const;
  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>{t("recognition.title")}</h2>
          <p>{t("recognition.intro")}</p>
        </div>
      </div>
      {error && <Feedback message={error} tone="error" />}
      {message && <Feedback message={message} tone="success" />}
      {!data ? (
        <div className="empty">
          {error ? t("recognition.loadFailed") : t("recognition.loading")}
        </div>
      ) : (
        <section className="admin-card file-recognition-settings">
          <div className="card-heading">
            <div>
              <h3>{t("recognition.policy")}</h3>
              <p className="subtle">{t("recognition.policyHelp")}</p>
            </div>
            <span
              className={`status-badge ${data.config.enabled ? "success" : ""}`}
            >
              {data.config.enabled
                ? t("services.enabled")
                : t("services.disabled")}
            </span>
          </div>
          <button
            type="button"
            className={`service-row ${data.config.enabled ? "selected" : ""}`}
            onClick={() => update({ enabled: !data.config.enabled })}
          >
            <span className="setting-icon">
              <ScanText size={20} />
            </span>
            <span>
              <strong>{t("recognition.auto")}</strong>
              <small>{t("recognition.autoHelp")}</small>
            </span>
            <span className="choice-dot">
              {data.config.enabled && <Check size={13} />}
            </span>
          </button>
          <label className="file-recognition-field">
            {t("recognition.model")}
            <Select
              value={data.config.modelId ?? ""}
              onChange={(event) =>
                update({ modelId: event.target.value || null })
              }
              disabled={!data.config.enabled}
            >
              <option value="">{t("recognition.noModel")}</option>
              {data.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                  {model.vision ? t("recognition.supportsImages") : ""}
                  {model.pdf ? t("recognition.supportsPdf") : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="service-row">
            <span className="setting-icon">
              <ShieldCheck size={20} />
            </span>
            <span>
              <strong>{t("recognition.ocr")}</strong>
              <small>{t("recognition.ocrHelp")}</small>
            </span>
            <input
              type="checkbox"
              checked={data.config.ocrEnabled}
              onChange={(event) => update({ ocrEnabled: event.target.checked })}
            />
          </label>
          <div className="file-recognition-policy">
            <strong>{t("recognition.groups")}</strong>
            <p>{t("recognition.groupsHelp")}</p>
            <div>
              {groups.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={data.config.recognitionGroups.includes(value)}
                    onChange={() =>
                      update({
                        recognitionGroups: toggle(
                          data.config.recognitionGroups,
                          value,
                        ),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="file-recognition-policy">
            <strong>{t("recognition.sources")}</strong>
            <p>{t("recognition.sourcesHelp")}</p>
            <div>
              {sources.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={data.config.recognitionSources.includes(value)}
                    onChange={() =>
                      update({
                        recognitionSources: toggle(
                          data.config.recognitionSources,
                          value,
                        ),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="file-recognition-policy">
            <strong>{t("recognition.searchGroups")}</strong>
            <p>{t("recognition.searchGroupsHelp")}</p>
            <div>
              {groups.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={data.config.searchGroups.includes(value)}
                    onChange={() =>
                      update({
                        searchGroups: toggle(data.config.searchGroups, value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          {!data.models.length && (
            <p className="admin-note">{t("recognition.noModels")}</p>
          )}
          <div className="admin-form-footer">
            <span className="subtle">{t("recognition.noTokens")}</span>
            <button
              className="primary"
              disabled={busy || (data.config.enabled && !data.config.modelId)}
              onClick={() => void save()}
            >
              {busy ? t("services.saving") : t("services.saveSettings")}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
