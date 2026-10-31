import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback, notifyFeedback } from "@web/shared/components/feedback.js";
import { accessText } from "@web/features/documents/access-management.js";
import { GroupPicker, type SelectableGroup } from "./group-picker.js";
import { GroupGrantMembers } from "./group-grant-members.js";
import {
  PermissionGrantRow,
  permissionRoleChoices,
} from "@web/shared/components/permission-grant-row.js";
import { GroupAvatar } from "./group-avatar.js";
import "./groups.css";

type Grants = {
  items: {
    groupId: string;
    name: string;
    avatar: string | null;
    role: string;
    status: string;
    includeDescendants: boolean;
    inherited: boolean;
    canAdjust: boolean;
  }[];
  revision: number;
};
export function GroupGrants({
  basePath,
  owner,
  view,
  folder = false,
  supportsDescendants = false,
  revision,
  changed,
  cancel,
}: {
  basePath: string;
  owner: boolean;
  view: "invite" | "members";
  folder?: boolean;
  supportsDescendants?: boolean;
  revision?: number;
  changed: () => Promise<unknown>;
  cancel?: () => void;
}) {
  const { t } = useI18n();
  const [grants, setGrants] = useState<Grants>();
  const [group, setGroup] = useState<SelectableGroup | null>(null),
    [role, setRole] = useState("reader"),
    [descendants, setDescendants] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const roleOptions = permissionRoleChoices(
    owner,
    folder ? "folder" : "resource",
  );
  const label = (value: string) =>
    accessText(t, value === "admin" ? "manager" : value);
  async function load() {
    setGrants(await api(`${basePath}/group-grants`));
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<Grants>(
      `${basePath}/group-grants`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setGrants)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [basePath, revision]);
  async function save(
    target: string,
    nextRole: string | null,
    scope = folder || (supportsDescendants && descendants),
  ) {
    if (!grants || busy) return false;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ pending: boolean }>(
        `${basePath}/group-grants/${target}`,
        "PUT",
        {
          revision: grants.revision,
          role: nextRole,
          includeDescendants: scope,
        },
      );
      await load();
      await changed();
      if (nextRole && view === "invite") {
        setGroup(null);
        notifyFeedback(
          t(result.pending ? "permissionsUi.invited" : "sharingUi.added"),
          "success",
        );
        cancel?.();
      } else if (nextRole) {
        notifyFeedback(
          t(result.pending ? "permissionsUi.invited" : "permissionsUi.updated"),
          "success",
        );
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`group-grants${view === "invite" ? " group-grants-invite" : ""}`}
    >
      {error && <Feedback tone="error" message={error} />}
      {view === "members" ? (
        <>
          <h3>{t("groups.authorize")}</h3>
          {grants?.items.map((grant) => {
            const key = `${grant.groupId}:${grant.status}`;
            const inheritedManager =
              owner && !grant.canAdjust && grant.role === "manager";
            return (
              <PermissionGrantRow
                key={key}
                className="group-grant-row"
                identity={
                  <span className="permission-group-identity">
                    <GroupAvatar name={grant.name} avatar={grant.avatar} />
                    <span>{grant.name}</span>
                  </span>
                }
                subtitle={
                  <>
                    {grant.status === "pending"
                      ? t("groups.pending")
                      : grant.inherited
                        ? t("groups.inheritedGrant")
                        : null}
                  </>
                }
                details={
                  grant.status === "active" && (
                    <GroupGrantMembers
                      basePath={basePath}
                      groupId={grant.groupId}
                      revision={grants!.revision}
                    />
                  )
                }
                permission={{
                  value: grant.role,
                  label: label(grant.role),
                  ariaLabel: t("groups.accessForGroup", { name: grant.name }),
                  reason: inheritedManager
                    ? t("groups.inheritedManager")
                    : !grant.canAdjust
                      ? t("permissionsUi.ownerOnlyRole")
                      : undefined,
                  options: grant.canAdjust
                    ? roleOptions.map((value) => ({
                        value,
                        label: label(value),
                      }))
                    : undefined,
                  disabled: busy,
                  change: (nextRole) =>
                    void save(
                      grant.groupId,
                      nextRole,
                      grant.includeDescendants,
                    ),
                }}
                remove={
                  grant.canAdjust
                    ? {
                        name: grant.name,
                        label: t("groups.removeGrantFor", { name: grant.name }),
                        disabled: busy,
                        description: t("groups.removeGrantConfirm", {
                          name: grant.name,
                        }),
                        confirm: () =>
                          save(grant.groupId, null, grant.includeDescendants),
                      }
                    : undefined
                }
                scope={
                  !folder && supportsDescendants && grant.canAdjust
                    ? {
                        checked: grant.includeDescendants,
                        disabled: busy,
                        change: (nextScope) =>
                          void save(grant.groupId, grant.role, nextScope),
                      }
                    : undefined
                }
              />
            );
          })}
          {grants && !grants.items.length && (
            <p className="permissions-empty">{t("groups.noGrants")}</p>
          )}
        </>
      ) : (
        <form
          className="permissions-invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (group) void save(group.id, role);
          }}
        >
          <fieldset className="permissions-form" disabled={busy}>
            <div className="permissions-invite-recipient">
              <h3>{t("groups.choose")}</h3>
              <GroupPicker
                selected={group}
                select={setGroup}
                clear={() => setGroup(null)}
              />
            </div>
            <label>
              {t("permissionsUi.grant")}
              <Select
                aria-label={t("permissionsUi.inviteAccess")}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {roleOptions.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </Select>
            </label>
            {!folder && supportsDescendants && (
              <label className="permissions-check">
                <input
                  type="checkbox"
                  checked={descendants}
                  onChange={(e) => setDescendants(e.target.checked)}
                />
                {t("role.scope.descendants")}
              </label>
            )}
            <p className="group-grant-help">{t("groups.grantHelp")}</p>
            <footer>
              <button type="button" onClick={cancel}>
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || !group || !grants}
              >
                {busy ? t("permissionsUi.inviting") : t("groups.grant")}
              </button>
            </footer>
          </fieldset>
        </form>
      )}
    </section>
  );
}
