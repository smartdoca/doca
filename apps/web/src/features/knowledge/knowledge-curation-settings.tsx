import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
export function KnowledgeCurationSettings({ scopeId }: { scopeId: string }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<any>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publication, setPublication] = useState<{
      revision: number;
      status: string;
      dirty: boolean;
      error: string;
    }>(),
    [mode, setMode] = useState("automatic");
  async function reload() {
    const root = `/knowledge/libraries/${scopeId}`;
    const [system, pub] = await Promise.all([
      api<any>(`${root}/system`),
      api<any>(`${root}/publication`),
    ]);
    setSettings({ value: system.settings, revision: system.settingsRevision });
    setMode(system.settings.publicationMode);
    setPublication(pub);
  }
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [scopeId]);
  async function work(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function configure(patch: Record<string, string>) {
    if (settings)
      await work(() =>
        api(`/knowledge/libraries/${scopeId}/settings`, "PUT", {
          expectedRevision: settings.revision,
          settings: { ...settings.value, ...patch },
        }),
      );
  }
  return (
    <fieldset
      className="knowledge-curation-settings"
      disabled={busy || !settings}
    >
      {error && <p role="alert">{error}</p>}
      <div className="kc-publication">
        <strong>{t("studio.publication")}</strong>
        <select
          aria-label={t("studio.publication")}
          value={mode}
          onChange={(e) =>
            void work(() =>
              api(`/knowledge/libraries/${scopeId}/publication-mode`, "PUT", {
                mode: e.target.value,
              }),
            )
          }
        >
          <option value="automatic">{t("studio.automatic")}</option>
          <option value="manual">{t("studio.manual")}</option>
        </select>
        <small>
          {t(publication?.dirty ? "studio.pending" : "studio.current", {
            version: publication?.revision ?? 0,
          })}
        </small>
        {publication?.error && <p role="alert">{publication.error}</p>}
        {publication?.dirty && (
          <button
            onClick={() =>
              void work(() =>
                api(`/knowledge/libraries/${scopeId}/publication`, "POST"),
              )
            }
          >
            {t("studio.publish")}
          </button>
        )}
      </div>
      {settings && (
        <div className="kc-publication">
          <strong>{t("studio.automationSettings")}</strong>
          <label>
            {t("studio.sourceScope")}
            <select
              value={settings.value.sourceScope}
              onChange={(e) => void configure({ sourceScope: e.target.value })}
            >
              <option value="internal">{t("studio.internalOnly")}</option>
              <option value="web">{t("studio.allowWeb")}</option>
            </select>
          </label>
          <label>
            {t("studio.automationPolicy")}
            <select
              value={settings.value.automationPolicy}
              onChange={(e) =>
                void configure({ automationPolicy: e.target.value })
              }
            >
              <option value="safe">{t("studio.safeAutomatic")}</option>
              <option value="draft">{t("studio.draftOnly")}</option>
            </select>
          </label>
        </div>
      )}
    </fieldset>
  );
}
