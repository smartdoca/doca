import { usePermissionPopover } from "./use-permission-popover.js";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Globe,
  Info,
  Search,
  X,
} from "lucide-react";
import { api, type Detail } from "@web/shared/api.js";
import { realtime } from "@web/features/documents/realtime.js";
import {
  accessText,
  type Manager,
} from "@web/features/documents/access-management.js";
import { useI18n } from "@web/shared/i18n.js";
import { RequestAccess } from "@web/features/documents/access-tasks.js";
import { ShareLinkSettings } from "@web/features/documents/sharing.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import "@web/features/documents/permissions.css";

type Member = {
  id: string;
  display_name: string;
  public_id: string;
  role: string;
  directRole: string | null;
  sources: string[];
  canAdjust: boolean;
  includeDescendants: boolean;
  sourceDetails: {
    type: string;
    sourceType: string;
    id: string | null;
    sourceResourceId: string | null;
    role: string;
    includeDescendants: boolean;
    status: string;
  }[];
};
type Overview = {
  rank: number;
  currentUser: { id: string; display_name: string; public_id: string } | null;
  role: string;
  version: number;
  authzRevision: number;
  accessMode: string;
  hasParent: boolean;
  supportsDescendants: boolean;
  inheritedFields: string[];
  visibility: string;
  effectiveVisibility: string;
  internetPublication?: boolean;
  publicRole: string;
  requestsEnabled: boolean;
  effectiveRequestsEnabled: boolean;
  historyReaders: boolean;
  sharingEnabled: boolean;
  discoverable: boolean;
  publicContainerId?: string | null;
  canManage: boolean;
  isOwner: boolean;
  administrators: Manager[];
  members: Member[];
};
const roles = (owner = false) => [
  "reader",
  "commenter",
  "editor",
  ...(owner ? ["manager"] : []),
];
const pageTitles = {
  main: "share.title",
  members: "share.members",
  invite: "share.invite",
  request: "share.request",
  settings: "share.settings",
  sources: "share.sources",
} as const;

export function PermissionDialog({
  detail,
  close,
  saved,
  embedded = false,
  authenticated = true,
  adapter,
}: {
  detail: { resource: Pick<Detail["resource"], "id"> & { kind: string } };
  adapter?: {
    basePath: string;
    roles: string[];
    publicRoles: string[];
    requests?: boolean;
    invitationNote?: boolean;
  };
  close: () => void;
  saved: () => Promise<void>;
  embedded?: boolean;
  authenticated?: boolean;
}) {
  const { t } = useI18n();
  const id = detail.resource.id;
  const basePath = adapter?.basePath ?? `/resources/${id}`;
  const memberRoles = (owner = false) => adapter?.roles ?? roles(owner);
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [trail, setTrail] = useState<Array<keyof typeof pageTitles>>(["main"]);
  const page = trail[trail.length - 1] ?? "main";
  const [person, setPerson] = useState<{
      id: string;
      display_name: string;
    } | null>(null),
    [role, setRole] = useState("reader"),
    [includeDescendants, setIncludeDescendants] = useState(true),
    [invitationMessage, setInvitationMessage] = useState(""),
    [removing, setRemoving] = useState<string | null>(null),
    [sourceMember, setSourceMember] = useState<Member | null>(null);
  const panel = usePermissionPopover(close, embedded);
  async function load() {
    const next = await api<Overview>(`${basePath}/permission-overview`);
    setData(next);
    return next;
  }
  useEffect(() => {
    let alive = true;
    setData(null);
    setTrail(["main"]);
    setPerson(null);
    setSourceMember(null);
    setError("");
    const refresh = () =>
      api<Overview>(`${basePath}/permission-overview`).then((next) => {
        if (alive) setData(next);
      });
    void refresh().catch((e) => {
      if (alive) setError(e.message);
    });
    const stop = realtime.subscribe((m) => {
      if (m.type === "notifications.changed") void refresh().catch(() => {});
    });
    return () => {
      alive = false;
      stop();
    };
  }, [id]);
  function navigate(next: keyof typeof pageTitles) {
    setTrail((current) => {
      if (current[current.length - 1] === next) return current;
      if (next === "main") return ["main"];
      return [...current, next];
    });
    setNotice("");
    setError("");
    setRemoving(null);
  }
  function back() {
    if (page === "sources") setSourceMember(null);
    setTrail((current) =>
      current.length > 1 ? current.slice(0, -1) : ["main"],
    );
    setNotice("");
    setError("");
    setRemoving(null);
  }
  useEffect(() => {
    panel.current?.querySelector(".permissions-body")?.scrollTo(0, 0);
  }, [page]);
  async function sourceAction(
    source: Member["sourceDetails"][number],
    action: "update" | "delete",
    roleValue = source.role,
    scope = source.includeDescendants,
  ) {
    if (!data || !sourceMember || source.type === "parent_inherited") return;
    setBusy(true);
    setError("");
    try {
      await api(`${basePath}/permission-sources/${sourceMember.id}`, "PUT", {
        revision: data.authzRevision,
        sourceType: source.type,
        sourceId: source.id,
        action,
        ...(action === "update"
          ? { role: roleValue, includeDescendants: scope }
          : {}),
      });
      const next = await load();
      setSourceMember(
        next.members.find((member) => member.id === sourceMember.id) ?? null,
      );
      await saved();
      setNotice(
        action === "delete"
          ? t("permissionsUi.sourceDeleted")
          : t("permissionsUi.sourceUpdated"),
      );
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function act(
    path: string,
    body: unknown,
    message = t("common.settingsSaved"),
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, "PUT", body);
      const next = await load();
      await saved();
      setNotice(message);
      return next;
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function settings(change: Record<string, unknown>) {
    if (!data) return;
    await act(`${basePath}/permissions`, {
      version: data.version,
      ...change,
    });
  }
  async function member(
    m: Member,
    nextRole: string | null,
    scope = m.includeDescendants,
  ) {
    if (!data) return;
    const next = await act(
      `${basePath}/members/${m.id}`,
      {
        revision: data.authzRevision,
        role: nextRole,
        includeDescendants: scope,
      },
      nextRole
        ? t("permissionsUi.updated")
        : t("permissionsUi.collaboratorRemoved"),
    );
    if (next) {
      setRemoving(null);
      const effective = next.members.find((x) => x.id === m.id);
      if (effective && effective.role !== (nextRole ?? "none"))
        setNotice(t("permissionsUi.otherAccess"));
    }
  }
  function origin(field: string) {
    if (!data || data.accessMode !== "inherit") return null;
    return data.inheritedFields.includes(field) ? (
      <small className="permissions-origin">
        {t("permissionsUi.inherited")}
      </small>
    ) : (
      <button
        type="button"
        className="permissions-text-button permissions-origin"
        disabled={busy}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void settings({ resetFields: [field] });
        }}
      >
        {t("permissionsUi.restoreParent")}
      </button>
    );
  }
  const inherited = data?.accessMode === "inherit",
    supportsDescendants = data?.supportsDescendants ?? false,
    isPublic =
      data && ["authenticated", "public"].includes(data.effectiveVisibility);
  return (
    <div
      className={`permissions-panel ${embedded ? "permissions-embedded" : "permissions-floating"}`}
      role={embedded ? "region" : "dialog"}
      aria-label={t("share.title")}
      ref={panel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          page === "main" ? close() : back();
        }
      }}
    >
      <header className="permissions-header">
        <div className="permissions-heading">
          {page !== "main" && (
            <button
              type="button"
              className="icon"
              aria-label={t("library.relations.back")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                back();
              }}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h2>{t(pageTitles[page])}</h2>
        </div>
        <div className="permissions-header-actions">
          {data && page === "main" && (
            <>
              {data.hasParent && (
                <label
                  className="permissions-inherit-control"
                  title={t("permissionsUi.inheritHelp")}
                >
                  <input
                    type="checkbox"
                    checked={inherited}
                    disabled={busy || !data.isOwner}
                    onChange={(e) =>
                      void settings({
                        accessMode: e.target.checked ? "inherit" : "custom",
                      })
                    }
                  />
                  {t("shell.access.inherit")}
                </label>
              )}
              {authenticated && (
                <a
                  className="icon"
                  title={t("permissionsUi.tickets")}
                  aria-label={t("permissionsUi.tickets")}
                  href={`#/tickets?resourceKind=${detail.resource.kind}&resourceId=${id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ClipboardList size={18} />
                </a>
              )}
              {data.canManage && (
                <button
                  className="permissions-public-button"
                  title={t("share.settings")}
                  onClick={() => navigate("settings")}
                >
                  <Globe size={16} />
                  <span>{t("share.settings")}</span>
                </button>
              )}
            </>
          )}
          {!embedded && (
            <button
              className="icon"
              aria-label={t("share.title")}
              onClick={close}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="permissions-body" aria-busy={busy}>
        {error && <Feedback tone="error" message={error} />}
        {!data && !error && (
          <p className="permissions-empty">{t("common.loading")}</p>
        )}
        {data && page === "main" && (
          <>
            <section className="permissions-self">
              <span className="permissions-self-title">
                {t("permissionsUi.currentUser")}
              </span>
              {data.currentUser ? (
                <UserBadge
                  id={data.currentUser.id}
                  name={
                    data.currentUser.display_name || data.currentUser.public_id
                  }
                  passive
                />
              ) : (
                <span>{t("permissionsUi.anonymous")}</span>
              )}
              <span className="permissions-self-role">
                {accessText(t, data.role) === data.role
                  ? t("role.none")
                  : accessText(t, data.role)}
              </span>
              {data.rank < 4 && data.effectiveRequestsEnabled && (
                <button
                  className="permissions-request-button"
                  onClick={() => navigate("request")}
                >
                  {t("ticket.requestedRole")}
                </button>
              )}
            </section>
            {data.rank >= 3 && (
              <section className="permissions-collaboration">
                <button
                  type="button"
                  className="permissions-collaborators"
                  disabled={!data.canManage}
                  aria-label={t("permissionsUi.collaboratorCount", {
                    count: data.members.length,
                  })}
                  onClick={() => navigate("members")}
                >
                  <span>
                    {data.canManage ? t("share.invite") : t("share.members")}
                  </span>
                  <span className="permissions-avatars">
                    {data.members.slice(0, 5).map((m) => (
                      <UserBadge
                        key={m.id}
                        id={m.id}
                        name={m.display_name}
                        passive
                        avatarOnly
                      />
                    ))}
                    {data.members.length > 5 && (
                      <span className="permissions-more">
                        +{data.members.length - 5}
                      </span>
                    )}
                    {data.canManage && <ChevronRight size={17} />}
                  </span>
                </button>
                {data.canManage && (
                  <button
                    type="button"
                    className="permissions-invite-entry"
                    onClick={() => navigate("invite")}
                  >
                    <Search size={16} />
                    <span>{t("permissionsUi.search")}</span>
                  </button>
                )}
              </section>
            )}
            {data.canManage && (
              <ShareLinkSettings
                id={id}
                basePath={basePath}
                allowedRoles={adapter?.publicRoles ?? roles(data.isOwner)}
                changed={load}
                inheritedEnabled={data.sharingEnabled}
                inheritanceControl={origin("share_links_enabled")}
              />
            )}
          </>
        )}
        {data?.canManage && page === "invite" && (
          <form
            className="permissions-invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!person || busy) return;
              if (
                await act(
                  `${basePath}/members/${person.id}`,
                  {
                    revision: data.authzRevision,
                    role,
                    includeDescendants,
                    message: invitationMessage.trim(),
                  },
                  t("permissionsUi.invited"),
                )
              ) {
                setPerson(null);
                setInvitationMessage("");
                navigate("main");
                setNotice(t("permissionsUi.invited"));
              }
            }}
          >
            <fieldset className="permissions-form" disabled={busy}>
              <div className="permissions-invite-recipient">
                <h3>{t("dialog.chooseCollaborator")}</h3>
                <PersonPicker
                  autoFocus
                  selected={person}
                  clear={() => setPerson(null)}
                  select={setPerson}
                />
              </div>
              <label>
                {t("permissionsUi.grant")}
                <Select
                  aria-label={t("permissionsUi.inviteAccess")}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  {memberRoles(data.isOwner).map((r) => (
                    <option key={r} value={r}>
                      {accessText(t, r)}
                    </option>
                  ))}
                </Select>
              </label>
              {supportsDescendants && (
                <label className="permissions-check">
                  <input
                    type="checkbox"
                    checked={includeDescendants}
                    onChange={(e) => setIncludeDescendants(e.target.checked)}
                  />
                  {t("role.scope.descendants")}
                </label>
              )}
              {adapter?.invitationNote !== false && (
                <label>
                  <span>
                    {t("permissionsUi.note")}
                    <span className="permissions-optional">
                      {t("permissionsUi.optional")}
                    </span>
                  </span>
                  <textarea
                    aria-label={t("ticket.inviteNote")}
                    placeholder={t("permissionsUi.noteHint")}
                    maxLength={1000}
                    rows={3}
                    value={invitationMessage}
                    onChange={(e) => setInvitationMessage(e.target.value)}
                  />
                </label>
              )}
              <footer>
                <button type="button" onClick={() => navigate("main")}>
                  {t("common.cancel")}
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={!person || busy}
                >
                  {busy
                    ? t("permissionsUi.inviting")
                    : t("permissionsUi.sendInvite")}
                </button>
              </footer>
            </fieldset>
          </form>
        )}
        {data &&
          page === "request" &&
          data.rank < 4 &&
          data.effectiveRequestsEnabled && (
            <RequestAccess id={id} rank={data.rank} user={authenticated} />
          )}
        {data && page === "members" && data.canManage && (
          <>
            {data.members.map((m) => (
              <div className="permissions-member" key={m.id}>
                <div className="permissions-person">
                  <UserBadge id={m.id} name={m.display_name} />
                  <small>
                    @{m.public_id}
                    {m.sources.includes("inherit")
                      ? t("permissionsUi.inheritedSuffix")
                      : ""}
                  </small>
                </div>
                {m.canAdjust ? (
                  <div className="permissions-member-controls">
                    <button
                      className="icon permissions-source-button"
                      title={t("permissionsUi.viewSources")}
                      aria-label={t("permissionsUi.sourcesFor", {
                        name: m.display_name,
                      })}
                      disabled={busy}
                      onClick={() => {
                        setSourceMember(m);
                        navigate("sources");
                      }}
                    >
                      <Info size={15} />
                    </button>
                    <Select
                      aria-label={t("permissionsUi.accessFor", {
                        name: m.display_name,
                      })}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => void member(m, e.target.value)}
                    >
                      {memberRoles(data.isOwner).map((r) => (
                        <option key={r} value={r}>
                          {accessText(t, r)}
                        </option>
                      ))}
                    </Select>
                    {m.canAdjust && (
                      <button disabled={busy} onClick={() => setRemoving(m.id)}>
                        {t("credentials.remove")}
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <span className="permissions-member-role">
                      {accessText(t, m.role)}
                    </span>
                    <button
                      className="icon permissions-source-button"
                      title={t("permissionsUi.viewSources")}
                      aria-label={t("permissionsUi.sourcesFor", {
                        name: m.display_name,
                      })}
                      onClick={() => {
                        setSourceMember(m);
                        navigate("sources");
                      }}
                    >
                      <Info size={15} />
                    </button>
                  </>
                )}
                {m.canAdjust && supportsDescendants && (
                  <label className="permissions-check permissions-member-scope">
                    <input
                      type="checkbox"
                      checked={m.includeDescendants}
                      disabled={busy}
                      onChange={(e) => void member(m, m.role, e.target.checked)}
                    />
                    {t("role.scope.descendants")}
                  </label>
                )}
                {removing === m.id && (
                  <div className="permissions-confirm">
                    <p>{t("permissionsUi.removeHelp")}</p>
                    <button
                      disabled={busy}
                      onClick={() => void member(m, null)}
                    >
                      {t("permissionsUi.confirmRemove")}
                    </button>
                    <button onClick={() => setRemoving(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!data.members.length && (
              <p className="permissions-empty">
                {t("permissionsUi.noCollaborators")}
              </p>
            )}
          </>
        )}
        {data && page === "sources" && sourceMember && (
          <section className="permissions-source-list">
            <div className="permissions-source-person">
              <UserBadge
                id={sourceMember.id}
                name={sourceMember.display_name}
              />
              <span>
                {accessText(t, sourceMember.role) ?? sourceMember.role}
              </span>
            </div>
            {sourceMember.sourceDetails.map((source, index) => {
              const inherited = source.type === "parent_inherited";
              const parentOverride = source.type === "parent_override";
              const sourceLabel = inherited
                ? t("permissionsUi.parentSource")
                : parentOverride
                  ? source.status === "disabled"
                    ? t("permissionsUi.blockParent")
                    : t("permissionsUi.overrideParent")
                  : source.type === "link"
                    ? t("permissionsUi.shareSource", { id: source.id ?? "" })
                    : t("permissionsUi.directGrant");
              return (
                <div
                  className="permissions-source-card"
                  key={`${source.type}:${source.id ?? index}`}
                >
                  <div className="permissions-source-card-title">
                    <span>{sourceLabel}</span>
                    <span>
                      {source.status === "disabled"
                        ? t("permissionsUi.disabled")
                        : (accessText(t, source.role) ?? source.role)}
                    </span>
                  </div>
                  <div className="permissions-source-card-meta">
                    {supportsDescendants && source.includeDescendants
                      ? t("role.scope.descendants")
                      : t("permissionsUi.currentOnly")}
                  </div>
                  {!inherited && (
                    <div className="permissions-source-card-actions">
                      {source.status !== "disabled" && (
                        <>
                          <Select
                            aria-label={t("permissionsUi.sourceAccess", {
                              name: sourceLabel,
                            })}
                            value={source.role}
                            disabled={
                              busy || (!!adapter && source.type === "link")
                            }
                            onChange={(event) =>
                              void sourceAction(
                                source,
                                "update",
                                event.target.value,
                              )
                            }
                          >
                            {memberRoles(data.isOwner).map((roleName) => (
                              <option key={roleName} value={roleName}>
                                {accessText(t, roleName)}
                              </option>
                            ))}
                          </Select>
                          {supportsDescendants && (
                            <label className="permissions-check">
                              <input
                                type="checkbox"
                                checked={source.includeDescendants}
                                disabled={busy}
                                onChange={(event) =>
                                  void sourceAction(
                                    source,
                                    "update",
                                    source.role,
                                    event.target.checked,
                                  )
                                }
                              />
                              {t("permissionsUi.children")}
                            </label>
                          )}
                        </>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => void sourceAction(source, "delete")}
                      >
                        {parentOverride
                          ? t("permissionsUi.clearOverride")
                          : t("permissionsUi.deleteSource")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!sourceMember.sourceDetails.length && (
              <p className="permissions-empty">
                {t("permissionsUi.noSources")}
              </p>
            )}
          </section>
        )}
        {data?.canManage && page === "settings" && (
          <div className="permissions-settings">
            {data.publicContainerId && (
              <p>
                {t("discovery.inherited")}{" "}
                <a href={`#/r/${data.publicContainerId}?view=settings`}>
                  {t("discovery.containerSettings")}
                </a>
              </p>
            )}
            {detail.resource.kind === "library" && (
              <p className="subtle">{t("discovery.libraryPublishHelp")}</p>
            )}
            <fieldset className="permissions-form" disabled={busy}>
              <section className="permissions-section">
                <label className="permissions-switch">
                  <span>
                    {t("permissionsUi.publicAccess")}
                    {origin("visibility")}
                  </span>
                  <input
                    role="switch"
                    aria-label={t("permissionsUi.publicAccess")}
                    type="checkbox"
                    disabled={!!data.publicContainerId}
                    checked={!!isPublic}
                    onChange={(e) =>
                      void settings({
                        visibility: e.target.checked
                          ? "authenticated"
                          : "invited",
                      })
                    }
                  />
                </label>
                {isPublic ? (
                  <div className="permissions-public-options">
                    {(data.internetPublication !== false ||
                      data.effectiveVisibility === "public") && (
                    <label className="permissions-check">
                      <input
                        type="checkbox"
                        disabled={!!data.publicContainerId}
                        checked={data.effectiveVisibility === "public"}
                        onChange={(e) =>
                          void settings({
                            visibility: e.target.checked
                              ? "public"
                              : "authenticated",
                          })
                        }
                      />
                      {t("permissionsUi.publicWeb")}
                    </label>
                    )}
                    <div className="permissions-option-row">
                      <span>
                        {t("permissionsUi.publicPermission")}
                        {origin("public_role")}
                      </span>
                      <Select
                        aria-label={t("permissionsUi.publicPermission")}
                        value={data.publicRole}
                        onChange={(e) =>
                          void settings({ publicRole: e.target.value })
                        }
                      >
                        {(adapter?.publicRoles ?? roles()).map((r) => (
                          <option key={r} value={r}>
                            {accessText(t, r)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                ) : (
                  <p className="subtle">
                    {data.effectiveRequestsEnabled
                      ? t("permissionsUi.requestHelp")
                      : t("permissionsUi.privateHelp")}
                  </p>
                )}
              </section>
              {adapter?.requests !== false && (
                <section className="permissions-section permissions-application">
                  <label className="permissions-switch">
                    <span>
                      {t("permissionsUi.allowRequests")}
                      {origin("requests_enabled")}
                    </span>
                    <input
                      role="switch"
                      aria-label={t("permissionsUi.allowRequests")}
                      type="checkbox"
                      checked={data.effectiveRequestsEnabled}
                      onChange={(e) =>
                        void settings({ requestsEnabled: e.target.checked })
                      }
                    />
                  </label>
                </section>
              )}
            </fieldset>

            <fieldset className="permissions-form" disabled={busy}>
              <p className="subtle">{t("discovery.policyManaged")}</p>
              {detail.resource.kind === "document" && (
                <section className="permissions-section">
                  <label className="permissions-check">
                    <input
                      type="checkbox"
                      checked={data.historyReaders}
                      onChange={(e) =>
                        void settings({ historyReaders: e.target.checked })
                      }
                    />
                    {t("permissionsUi.readerHistory")}
                    {origin("history_readers")}
                  </label>
                </section>
              )}
            </fieldset>
          </div>
        )}
        <div className="permissions-status" role="status">
          {busy ? t("common.savingChanges") : notice}
        </div>
      </div>
    </div>
  );
}
