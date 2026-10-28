import { useEffect, useRef, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { SiteLogo } from "@web/shared/components/site-logo.js";
import { Feedback } from "@web/shared/components/feedback.js";

export function SiteLogoSettings({
  revision,
  logoUrl,
  changed,
}: {
  revision: number;
  logoUrl: string | null;
  changed(): Promise<void>;
}) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  async function save(reset: boolean) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      let image: string | null = null;
      if (!reset) {
        if (!file) return;
        image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(new Error(t("admin.siteLogoReadFailed")));
          reader.readAsDataURL(file);
        });
      }
      await api("/admin/site-logo", "PUT", { revision, image });
      await changed();
      window.dispatchEvent(new Event("site-branding-changed"));
      setFile(null);
      if (input.current) input.current.value = "";
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="admin-card site-logo-settings"
      aria-label={t("admin.siteLogo")}
    >
      <div className="card-heading">
        <h3>{t("admin.siteLogo")}</h3>
      </div>
      <div className="site-logo-controls">
        <div className="site-logo-preview">
          <SiteLogo url={preview ?? logoUrl} />
        </div>
        <label>
          {t("admin.siteLogoChoose")}
          <input
            ref={input}
            type="file"
            aria-label={t("admin.siteLogoChoose")}
            aria-describedby="site-logo-hint"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => {
              const next = event.target.files?.[0];
              setError("");
              setSaved(false);
              if (!next) return;
              if (next.size > 5 * 1024 * 1024) {
                setError(t("admin.siteLogoTooLarge"));
                event.target.value = "";
                return;
              }
              if (
                !["image/png", "image/jpeg", "image/webp"].includes(next.type)
              ) {
                setError(t("admin.siteLogoInvalidImage"));
                event.target.value = "";
                return;
              }
              setFile(next);
            }}
          />
          <small id="site-logo-hint">{t("admin.siteLogoHint")}</small>
        </label>
      </div>
      <Feedback message={error} tone="error" />
      <Feedback
        message={saved ? t("admin.siteLogoSaved") : ""}
        tone="success"
      />
      <div className="admin-form-footer">
        <button
          type="button"
          disabled={busy || (!logoUrl && !file)}
          onClick={() => void save(true)}
        >
          {t("admin.siteLogoReset")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !file}
          onClick={() => void save(false)}
        >
          {busy ? t("admin.siteLogoSaving") : t("services.saveSettings")}
        </button>
      </div>
    </section>
  );
}
