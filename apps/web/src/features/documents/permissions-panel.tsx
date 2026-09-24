import { useEffect, useRef, useState } from "react";
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
import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { accessLabels, type Manager } from "@web/features/documents/access-management.js";
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
  publicRole: string;
  requestsEnabled: boolean;
  effectiveRequestsEnabled: boolean;
  historyReaders: boolean;
  sharingEnabled: boolean;
  discoverable: boolean;
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
const titles = {
  main: "分享与权限",
  members: "协作者",
  invite: "邀请协作者",
  request: "申请权限",
  settings: "作品公开",
  sources: "权限来源",
};

export function PermissionDialog({
  detail,
  close,
  saved,
  embedded = false,
  authenticated = true,
}: {
  detail: Detail;
  close: () => void;
  saved: () => Promise<void>;
  embedded?: boolean;
  authenticated?: boolean;
}) {
  const allowed = useEntitlements(),
    id = detail.resource.id;
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [trail, setTrail] = useState<Array<keyof typeof titles>>(["main"]);
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
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (embedded) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-permissions-popup]")) return;
      const popup = target.closest("[role=listbox]");
      if (
        popup &&
        Array.from(
          panel.current?.querySelectorAll("[aria-controls]") ?? [],
        ).some((trigger) => trigger.getAttribute("aria-controls") === popup.id)
      )
        return;
      if (
        !panel.current?.contains(target) &&
        !target.closest("[data-permissions-trigger]")
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [embedded, close]);
  async function load() {
    const next = await api<Overview>(`/resources/${id}/permission-overview`);
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
      api<Overview>(`/resources/${id}/permission-overview`).then((next) => {
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
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [embedded]);
  function navigate(next: keyof typeof titles) {
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
      await api(`/resources/${id}/permission-sources/${sourceMember.id}`, "PUT", {
        revision: data.authzRevision,
        sourceType: source.type,
        sourceId: source.id,
        action,
        ...(action === "update"
          ? { role: roleValue, includeDescendants: scope }
          : {}),
      });
      const next = await load();
      setSourceMember(next.members.find((member) => member.id === sourceMember.id) ?? null);
      await saved();
      setNotice(action === "delete" ? "授权来源已删除" : "授权来源已更新");
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function act(path: string, body: unknown, message = "已保存") {
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
    await act(`/resources/${id}/permissions`, {
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
      `/resources/${id}/members/${m.id}`,
      {
        revision: data.authzRevision,
        role: nextRole,
        includeDescendants: scope,
      },
      nextRole ? "权限已更新" : "已移除协作者",
    );
    if (next) {
      setRemoving(null);
      const effective = next.members.find((x) => x.id === m.id);
      if (effective && effective.role !== (nextRole ?? "none"))
        setNotice("已保存，公开访问或其他授权仍让对方保留当前权限。");
    }
  }
  function origin(field: string) {
    if (!data || data.accessMode !== "inherit") return null;
    return data.inheritedFields.includes(field) ? (
      <small className="permissions-origin">继承自上级</small>
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
        恢复上级设置
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
      aria-label="分享与权限"
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
              aria-label="返回"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                back();
              }}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h2>{titles[page]}</h2>
        </div>
        <div className="permissions-header-actions">
          {data && page === "main" && (
            <>
              {data.hasParent && (
                <label
                  className="permissions-inherit-control"
                  title="继承上级协作者及未单独设置的权限；只有所有者可以切换"
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
                  继承上级
                </label>
              )}
              {authenticated && (
                <a
                  className="icon"
                  title="相关工单"
                  aria-label="相关工单"
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
                  title="作品公开"
                  onClick={() => navigate("settings")}
                >
                  <Globe size={16} />
                  <span>作品公开</span>
                </button>
              )}
            </>
          )}
          {!embedded && (
            <button
              className="icon"
              aria-label="关闭分享与权限"
              onClick={close}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="permissions-body" aria-busy={busy}>
        {error && <Feedback tone="error" message={error} />}
        {!data && !error && <p className="permissions-empty">正在加载…</p>}
        {data && page === "main" && (
          <>
            <section className="permissions-self">
              <span className="permissions-self-title">当前用户</span>
              {data.currentUser ? (
                <UserBadge
                  id={data.currentUser.id}
                  name={
                    data.currentUser.display_name || data.currentUser.public_id
                  }
                  passive
                />
              ) : (
                <span>未登录用户</span>
              )}
              <span className="permissions-self-role">
                {accessLabels[data.role] ?? "无权限"}
              </span>
              {data.rank < 4 && data.effectiveRequestsEnabled && (
                <button
                  className="permissions-request-button"
                  onClick={() => navigate("request")}
                >
                  申请权限
                </button>
              )}
            </section>
            {data.rank >= 3 && (
              <section className="permissions-collaboration">
                <button
                  type="button"
                  className="permissions-collaborators"
                  disabled={!data.canManage}
                  aria-label={`协作者，${data.members.length}人`}
                  onClick={() => navigate("members")}
                >
                  <span>
                    {data.canManage && allowed("sharing.invite")
                      ? "邀请协作者"
                      : "协作者"}
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
                {data.canManage && allowed("sharing.invite") && (
                  <button
                    type="button"
                    className="permissions-invite-entry"
                    onClick={() => navigate("invite")}
                  >
                    <Search size={16} />
                    <span>搜索用户名或昵称，邀请协作者</span>
                  </button>
                )}
              </section>
            )}
            {data.canManage && (
              <ShareLinkSettings
                id={id}
                changed={load}
                inheritedEnabled={data.sharingEnabled}
                inheritanceControl={origin("share_links_enabled")}
              />
            )}
          </>
        )}
        {data?.canManage && page === "invite" && allowed("sharing.invite") && (
          <form
            className="permissions-invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!person || busy) return;
              if (
                await act(
                  `/resources/${id}/members/${person.id}`,
                  {
                    revision: data.authzRevision,
                    role,
                    includeDescendants,
                    message: invitationMessage.trim(),
                  },
                  "邀请已提交",
                )
              ) {
                setPerson(null);
                setInvitationMessage("");
                navigate("main");
                setNotice("邀请已提交");
              }
            }}
          >
            <fieldset className="permissions-form" disabled={busy}>
              <div className="permissions-invite-recipient">
                <h3>选择协作者</h3>
                <PersonPicker
                  autoFocus
                  selected={person}
                  clear={() => setPerson(null)}
                  select={setPerson}
                />
              </div>
              <label>
                授予权限
                <Select
                  aria-label="邀请权限"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  {roles(data.isOwner).map((r) => (
                    <option key={r} value={r}>
                      {accessLabels[r]}
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
                  包含子文档
                </label>
              )}
              <label>
                <span>
                  备注 <span className="permissions-optional">（选填）</span>
                </span>
                <textarea
                  aria-label="邀请说明"
                  placeholder="说说邀请对方参与什么协作"
                  maxLength={1000}
                  rows={3}
                  value={invitationMessage}
                  onChange={(e) => setInvitationMessage(e.target.value)}
                />
              </label>
              <footer>
                <button type="button" onClick={() => navigate("main")}>
                  取消
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={!person || busy}
                >
                  {busy ? "正在邀请…" : "发送邀请"}
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
                    {m.sources.includes("inherit") ? " · 继承自上级" : ""}
                  </small>
                </div>
                {m.canAdjust ? (
                  <div className="permissions-member-controls">
                    <button
                      className="icon permissions-source-button"
                      title="查看权限来源"
                      aria-label={`${m.display_name}的权限来源`}
                      disabled={busy}
                      onClick={() => {
                        setSourceMember(m);
                        navigate("sources");
                      }}
                    >
                      <Info size={15} />
                    </button>
                    <Select
                      aria-label={`${m.display_name}的权限`}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => void member(m, e.target.value)}
                    >
                      {roles(data.isOwner).map((r) => (
                        <option key={r} value={r}>
                          {accessLabels[r]}
                        </option>
                      ))}
                    </Select>
                    {m.canAdjust && (
                      <button disabled={busy} onClick={() => setRemoving(m.id)}>
                        移除
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <span className="permissions-member-role">
                      {accessLabels[m.role]}
                    </span>
                    <button
                      className="icon permissions-source-button"
                      title="查看权限来源"
                      aria-label={`${m.display_name}的权限来源`}
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
                    包含子文档
                  </label>
                )}
                {removing === m.id && (
                  <div className="permissions-confirm">
                    <p>
                      取消该协作者在本文档的权限，并停止继承其上级授权。公开访问权限仍按作品设置生效。
                    </p>
                    <button
                      disabled={busy}
                      onClick={() => void member(m, null)}
                    >
                      确认移除
                    </button>
                    <button onClick={() => setRemoving(null)}>取消</button>
                  </div>
                )}
              </div>
            ))}
            {!data.members.length && (
              <p className="permissions-empty">暂无协作者</p>
            )}
          </>
        )}
        {data && page === "sources" && sourceMember && (
          <section className="permissions-source-list">
            <div className="permissions-source-person">
              <UserBadge id={sourceMember.id} name={sourceMember.display_name} />
              <span>{accessLabels[sourceMember.role] ?? sourceMember.role}</span>
            </div>
            {sourceMember.sourceDetails.map((source, index) => {
              const inherited = source.type === "parent_inherited";
              const parentOverride = source.type === "parent_override";
              const sourceLabel = inherited
                ? "父文档继承"
                : parentOverride
                  ? source.status === "disabled"
                    ? "阻断父文档权限"
                    : "覆盖父文档权限"
                  : source.type === "link"
                    ? `分享链接 ${source.id ?? ""}`
                    : "主动授权";
              return (
                <div className="permissions-source-card" key={`${source.type}:${source.id ?? index}`}>
                  <div className="permissions-source-card-title">
                    <span>{sourceLabel}</span>
                    <span>{source.status === "disabled" ? "已禁用" : accessLabels[source.role] ?? source.role}</span>
                  </div>
                  <div className="permissions-source-card-meta">
                    {supportsDescendants && source.includeDescendants
                      ? "包含子文档"
                      : "仅当前文档"}
                  </div>
                  {!inherited && (
                    <div className="permissions-source-card-actions">
                      {source.status !== "disabled" && (
                        <>
                          <Select
                            aria-label={`${sourceLabel}权限`}
                            value={source.role}
                            disabled={busy}
                            onChange={(event) =>
                              void sourceAction(source, "update", event.target.value)
                            }
                          >
                            {roles(data.isOwner).map((roleName) => (
                              <option key={roleName} value={roleName}>
                                {accessLabels[roleName]}
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
                              子文档
                            </label>
                          )}
                        </>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => void sourceAction(source, "delete")}
                      >
                        {parentOverride ? "取消覆盖" : "删除来源"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!sourceMember.sourceDetails.length && (
              <p className="permissions-empty">暂无可展示的授权来源</p>
            )}
          </section>
        )}
        {data?.canManage && page === "settings" && (
          <div className="permissions-settings">
            <fieldset className="permissions-form" disabled={busy}>
              <section className="permissions-section">
                <label className="permissions-switch">
                  <span>公开访问 {origin("visibility")}</span>
                  <input
                    role="switch"
                    aria-label="公开访问"
                    type="checkbox"
                    checked={!!isPublic}
                    disabled={
                      !isPublic &&
                      !allowed("sharing.site") &&
                      !allowed("sharing.public")
                    }
                    onChange={(e) =>
                      void settings({
                        visibility: e.target.checked
                          ? allowed("sharing.site")
                            ? "authenticated"
                            : "public"
                          : "invited",
                      })
                    }
                  />
                </label>
                {isPublic ? (
                  <div className="permissions-public-options">
                    <label className="permissions-check">
                      <input
                        type="checkbox"
                        checked={data.effectiveVisibility === "public"}
                        disabled={
                          data.effectiveVisibility !== "public" &&
                          !allowed("sharing.public")
                        }
                        onChange={(e) =>
                          void settings({
                            visibility: e.target.checked
                              ? "public"
                              : "authenticated",
                          })
                        }
                      />
                      公网开放（未登录可阅读）
                    </label>
                    <div className="permissions-option-row">
                      <span>公开权限 {origin("public_role")}</span>
                      <Select
                        aria-label="公开权限"
                        value={data.publicRole}
                        onChange={(e) =>
                          void settings({ publicRole: e.target.value })
                        }
                      >
                        {roles().map((r) => (
                          <option key={r} value={r}>
                            {accessLabels[r]}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                ) : (
                  <p className="subtle">
                    {data.effectiveRequestsEnabled
                      ? "获得文档地址的人可以申请访问。"
                      : "只有已获授权的人可以访问。"}
                  </p>
                )}
              </section>
              <section className="permissions-section permissions-application">
                <label className="permissions-switch">
                  <span>允许申请权限 {origin("requests_enabled")}</span>
                  <input
                    role="switch"
                    aria-label="允许申请权限"
                    type="checkbox"
                    checked={data.effectiveRequestsEnabled}
                    onChange={(e) =>
                      void settings({ requestsEnabled: e.target.checked })
                    }
                  />
                </label>
              </section>
            </fieldset>

            <fieldset className="permissions-form" disabled={busy}>
              <section className="permissions-section">
                <label className="permissions-check">
                  <input
                    type="checkbox"
                    checked={data.discoverable}
                    onChange={(e) =>
                      void settings({ discoverable: e.target.checked })
                    }
                  />
                  允许在公共发现中展示
                  {origin("discoverable")}
                </label>
                <p className="subtle">仍受公开范围和系统发现策略限制。</p>
              </section>
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
                    允许阅读者查看历史版本
                    {origin("history_readers")}
                  </label>
                </section>
              )}
            </fieldset>
          </div>
        )}
        <div className="permissions-status" role="status">
          {busy ? "正在保存…" : notice}
        </div>
      </div>
    </div>
  );
}
