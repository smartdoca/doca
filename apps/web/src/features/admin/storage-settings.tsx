import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
interface Settings {
  id: string;
  managedBy: "environment";
  config: {
    provider: "local" | "s3";
    bucket: string;
    region: string;
    endpoint: string;
    cdnDomain: string;
  };
}
export function StorageSettings() {
  const { t } = useI18n();
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Settings>("/admin/storage")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="admin-card">
      <h3>{t("storage.environmentTitle")}</h3>
      <p>{t("storage.environmentHelp")}</p>
      {error && <Feedback message={error} tone="error" />}
      {data && (
        <dl>
          <dt>{t("storage.storeId")}</dt>
          <dd>{data.id}</dd>
          <dt>{t("storage.provider")}</dt>
          <dd>{data.config.provider}</dd>
          {data.config.provider === "s3" && (
            <>
              <dt>{t("storage.bucket")}</dt>
              <dd>{data.config.bucket}</dd>
              <dt>{t("storage.region")}</dt>
              <dd>{data.config.region}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
