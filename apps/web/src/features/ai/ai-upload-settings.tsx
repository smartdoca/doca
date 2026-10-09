import { Alert, InputNumber, Select, Switch } from "antd";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import type {
  AIUploadLimits,
  AIUploadPolicy,
} from "@core/modules/ai/upload-policy.js";
import { uploadErrorMessage } from "./ai-upload-errors.js";

export function AIUploadSettings() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<{
    policy: AIUploadPolicy;
    revision: number;
  } | null>(null);
  const [target, setTarget] = useState("global");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<
    { id: string; display_name: string; login: string }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const load = () =>
    api<{ policy: AIUploadPolicy; revision: number }>(
      "/admin/ai/upload-policy",
    ).then(setSaved);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void api<{ items: typeof users }>(
          `/admin/users?q=${encodeURIComponent(query)}`,
          "GET",
          undefined,
          controller.signal,
        )
          .then((value) => setUsers(value.items))
          .catch((e) => {
            if (!controller.signal.aborted) setError(e.message);
          }),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  if (!saved) return error ? <Alert type="error" title={error} /> : null;
  const limits =
    target === "global"
      ? saved.policy.global
      : (saved.policy.users[target] ?? saved.policy.global);
  const change = (next: AIUploadLimits) => {
    setNotice(false);
    setSaved(
      (value) =>
        value && {
          ...value,
          policy:
            target === "global"
              ? { ...value.policy, global: next }
              : {
                  ...value.policy,
                  users: { ...value.policy.users, [target]: next },
                },
        },
    );
  };
  return (
    <div className="ai-upload-settings">
      <p>{t("aiUpload.help")}</p>
      <label>
        {t("aiUpload.scope")}
        <Select
          showSearch
          filterOption={false}
          onSearch={setQuery}
          value={target}
          onChange={setTarget}
          options={[
            { value: "global", label: t("aiUpload.global") },
            ...[
              ...new Set([
                ...users.map((user) => user.id),
                ...Object.keys(saved.policy.users),
              ]),
            ].map((id) => {
              const user = users.find((item) => item.id === id);
              return {
                value: id,
                label: user ? `${user.display_name} (${user.login})` : id,
              };
            }),
          ]}
        />
      </label>
      {target !== "global" && (
        <label>
          {t("aiUpload.inherit")}
          <Switch
            checked={!saved.policy.users[target]}
            onChange={(inherit) => {
              if (!inherit) change({ ...saved.policy.global });
              else {
                const next = { ...saved.policy.users };
                delete next[target];
                setSaved({
                  ...saved,
                  policy: { ...saved.policy, users: next },
                });
              }
            }}
          />
        </label>
      )}
      {(["maxFiles", "maxFileBytes", "maxTotalBytes"] as const).map((key) => (
        <label key={key}>
          {t(`aiUpload.${key}`)}
          <InputNumber
            min={0}
            precision={0}
            disabled={target !== "global" && !saved.policy.users[target]}
            value={limits[key] / (key === "maxFiles" ? 1 : 1024 ** 2)}
            onChange={(value) =>
              change({
                ...limits,
                [key]: Math.round(
                  Number(value ?? 0) * (key === "maxFiles" ? 1 : 1024 ** 2),
                ),
              })
            }
          />
          <span>
            {limits[key] === 0
              ? t("aiUpload.unlimited")
              : key === "maxFiles"
                ? t("aiUpload.files")
                : "MB"}
          </span>
        </label>
      ))}
      <button
        className="secondary"
        disabled={busy || (target !== "global" && !saved.policy.users[target])}
        onClick={() =>
          change({ maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 })
        }
      >
        {t("aiUpload.unlimitAll")}
      </button>
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          setNotice(false);
          try {
            setSaved(await api("/admin/ai/upload-policy", "PUT", saved));
            setNotice(true);
          } catch (e) {
            setError(uploadErrorMessage(e, t));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("aiAdmin.save")}
      </button>
      {notice && <Alert type="success" title={t("aiAdmin.saved")} />}
      {error && (
        <Alert
          type="error"
          title={error}
          action={
            <button onClick={() => void load().then(() => setError(""))}>
              {t("aiAdmin.refreshConfig")}
            </button>
          }
        />
      )}
    </div>
  );
}
