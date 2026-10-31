import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import "./groups.css";

type Mode = "member" | "related" | "all";
type Policy = {
  mode: Mode;
  revision: number;
  overrides: { user_id: string; mode: Mode | null; revision: number }[];
};
const modes = ["member", "related", "all"] as const;
export function GroupDirectorySettings({
  users,
}: {
  users: { id: string; display_name: string }[];
}) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<Policy>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ids = users.map((user) => user.id).join(",");
  const path = `/admin/group-directory-policy?ids=${encodeURIComponent(ids)}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<Policy>(path, "GET", undefined, controller.signal)
      .then(setPolicy)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [path]);
  async function save(id: string, mode: Mode | null) {
    if (!policy || busy) return;
    setBusy(true);
    setError("");
    try {
      const revision =
        id === "system"
          ? policy.revision
          : (policy.overrides.find((row) => row.user_id === id)?.revision ?? 0);
      await api(
        id === "system"
          ? "/admin/group-directory-policy"
          : `/admin/users/${id}/group-directory`,
        "PUT",
        { mode, revision },
      );
      setPolicy(await api<Policy>(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        setPolicy(await api<Policy>(path));
      } catch {}
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card group-directory-settings">
      <h3>{t("groups.directory.title")}</h3>
      <p className="subtle">{t("groups.directory.help")}</p>
      {error && <Feedback tone="error" message={error} />}
      <h4>{t("groups.directory.site")}</h4>
      <div className="directory-mode-options">
        {modes.map((mode) => (
          <button
            key={mode}
            disabled={busy || !policy}
            aria-pressed={policy?.mode === mode}
            className={policy?.mode === mode ? "selected" : ""}
            onClick={() => void save("system", mode)}
          >
            <strong>{t(`groups.scope.${mode}`)}</strong>
            <small>{t(`groups.directory.${mode}`)}</small>
          </button>
        ))}
      </div>
      <h4>{t("groups.directory.overrides")}</h4>
      <p className="subtle">{t("groups.directory.overrideHelp")}</p>
      {users.map((user) => (
        <div className="directory-user-row" key={user.id}>
          <UserBadge id={user.id} name={user.display_name} />
          <Select
            aria-label={t("groups.directory.userScope", {
              name: user.display_name,
            })}
            value={
              policy?.overrides.find((row) => row.user_id === user.id)?.mode ??
              ""
            }
            disabled={busy || !policy}
            onChange={(e) =>
              void save(
                user.id,
                e.target.value ? (e.target.value as Mode) : null,
              )
            }
          >
            <option value="">{t("groups.directory.inherit")}</option>
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {t(`groups.scope.${mode}`)}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </section>
  );
}
