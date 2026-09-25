import { ModerationAdmin } from "@web/features/admin/moderation.js";
import { AIAdmin } from "@web/features/ai/ai-admin.js";
import { RegistrationReviews } from "@web/features/admin/registration-reviews.js";
import { MembershipIcon } from "@web/features/settings/membership-icon.js";
import type { AccountOptions } from "@web/features/auth/account-fields.js";
import { AdminAccountEditor } from "@web/features/account/account-settings.js";
import {
  MembershipSettings,
  AssignLevels,
  UserMembership,
} from "@web/features/settings/membership-settings.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { HookEvents } from "@web/shared/hooks/hook-events.js";
import { useEffect, useState } from "react";
import { Select } from "@web/shared/components/select.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { SearchSettings } from "@web/features/search/search-settings.js";
import { realtime } from "@web/features/documents/realtime.js";
import {
  LayoutDashboard,
  Users,
  KeyRound,
  HardDrive,
  Webhook,
  ShieldCheck,
  BookOpen,
  FileText,
  Activity,
  Plus,
  Search,
  RefreshCw,
  ArrowUpRight,
  UserRound,
  LockKeyhole,
  Settings as SettingsIcon,
  ScanText,
  LayoutTemplate,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { StorageSettings } from "@web/features/admin/storage-settings.js";
import "@web/features/admin/admin.css";
import { AuthenticationSettings } from "@web/features/auth/authentication.js";
import { DirectorySettings } from "@web/features/settings/directory-settings.js";
import { UserCardSettings } from "@web/features/settings/user-card-settings.js";
import { DistributionSettings } from "@web/features/settings/distribution-settings.js";
import { FileRecognitionSettings } from "@web/features/admin/file-recognition-settings.js";
import { TemplateSettings } from "@web/features/admin/template-settings.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";
import {
  pluginMessage,
  webPluginRegistry,
} from "@web/plugins/registry.js";

type Member = {
  id: string;
  login: string;
  public_id?: string;
  display_name: string;
  admin: number;
  status: string;
  baseLevel: { id: string; name: string; color?: string; icon?: string };
  effectiveLevel: { id: string; name: string; color?: string; icon?: string };
  levelExpiresAt: string | null;
  timedLevel: { id: string; name: string; color?: string; icon?: string } | null;
  timedLevelExpiresAt: number | null;
  loginMethods: string[];
};
type Settings = { site_name: string; registration: number; revision: number };
const pluginAdminPanels = webPluginRegistry.adminPanels.list();
const sectionGroups: {
  id: string;
  group: MessageKey;
  items: {
    id: string;
    label: string;
    plugin?: boolean;
    order?: number;
    Icon: typeof LayoutDashboard;
  }[];
}[] = [
  {
    id: "overview",
    group: "admin.group.overview" as MessageKey,
    items: [{ id: "overview", label: "admin.overview", Icon: LayoutDashboard }],
  },
  {
    id: "accounts",
    group: "admin.group.accounts" as MessageKey,
    items: [
      { id: "login", label: "admin.login", Icon: KeyRound },
      { id: "users", label: "admin.users", Icon: Users },
      { id: "registration", label: "admin.registration", Icon: UserRound },
      { id: "levels", label: "admin.levels", Icon: ShieldCheck },
    ],
  },
  {
    id: "content",
    group: "admin.group.content" as MessageKey,
    items: [
      { id: "access", label: "admin.access", Icon: LockKeyhole },
      { id: "moderation", label: "admin.moderation", Icon: ShieldCheck },
      { id: "templates", label: "admin.templates", Icon: LayoutTemplate },
    ],
  },
  {
    id: "intelligence",
    group: "admin.group.intelligence" as MessageKey,
    items: [
      { id: "ai", label: "admin.ai", Icon: SettingsIcon },
      { id: "file-recognition", label: "admin.recognition", Icon: ScanText },
    ],
  },
  {
    id: "system",
    group: "admin.group.system" as MessageKey,
    items: [
      { id: "platform", label: "admin.platform", order: 10, Icon: SettingsIcon },
      { id: "hooks", label: "admin.hooks", order: 30, Icon: Webhook },
    ],
  },
].map((group) => ({
  ...group,
  items: [
    ...group.items.map((item, index) => ({
      ...item,
      order: ("order" in item ? item.order : undefined) ?? (index + 1) * 10,
    })),
    ...pluginAdminPanels
      .filter((panel) => panel.group === group.id)
      .map((panel) => ({
        id: panel.tab,
        label: panel.labelKey,
        plugin: true,
        order: panel.order ?? 0,
        Icon: panel.icon ?? SettingsIcon,
      })),
  ].sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) ||
      left.id.localeCompare(right.id),
  ),
}));
const sections = sectionGroups.flatMap((g) => g.items);
const platformSections: [string, MessageKey][] = [
  ["general", "admin.siteInfo"],
  ["cards", "admin.experience"],
  ["storage", "admin.files"],
  ["search", "admin.search"],
];
const accessSections: [string, MessageKey][] = [
  ["permissions", "admin.contentAccess"],
  ["directory", "admin.directory"],
];
type AdminRoute = {
  tab: string;
  platformTab: string;
  accessTab: string;
};
function readAdminRoute(): AdminRoute {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const tab = sections.some((section) => section.id === params.get("tab"))
    ? params.get("tab")!
    : "overview";
  const platformTab = platformSections.some(([id]) => id === params.get("platform"))
    ? params.get("platform")!
    : "general";
  const accessTab = accessSections.some(([id]) => id === params.get("access"))
    ? params.get("access")!
    : "permissions";
  return { tab, platformTab, accessTab };
}
export function Admin({
  activePluginIds,
}: {
  readonly activePluginIds: ReadonlySet<string>;
}) {
  const { locale, t } = useI18n();
  const [accountTarget, setAccountTarget] = useState<string | null>(null),
    [membershipTarget, setMembershipTarget] = useState<string | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [accountPolicy, setAccountPolicy] = useState<AccountOptions | null>(null),
    [assigning, setAssigning] = useState(false);
  const [tab, setTab] = useState(() => readAdminRoute().tab),
    [platformTab, setPlatformTab] = useState(() => readAdminRoute().platformTab),
    [accessTab, setAccessTab] = useState(() => readAdminRoute().accessTab),
    [stats, setStats] = useState<{
      documents: number;
      libraries: number;
      users: number;
      online: number;
    } | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [users, setUsers] = useState<Member[]>([]),
    [next, setNext] = useState<number | null>(null),
    [q, setQ] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [target, setTarget] = useState<Member | null>(null),
    [passwordTarget, setPasswordTarget] = useState<Member | null>(null),
    [refresh, setRefresh] = useState(0);
  const matchedPluginAdminPanel =
    webPluginRegistry.adminPanels.getByConflictKey(tab);
  const pluginAdminPanel =
    matchedPluginAdminPanel &&
    activePluginIds.has(matchedPluginAdminPanel.pluginId)
      ? matchedPluginAdminPanel
      : undefined;
  useEffect(() => {
    if (matchedPluginAdminPanel && !pluginAdminPanel)
      navigateAdmin({ tab: "overview" });
  }, [activePluginIds, matchedPluginAdminPanel, pluginAdminPanel]);
  useEffect(() => {
    if (creating)
      void api<AccountOptions>("/admin/accounts/policy")
        .then(setAccountPolicy)
        .catch((e) => setError(e.message));
  }, [creating]);
  async function load() {
    const [s, p] = await Promise.all([
      api<typeof stats>("/admin/stats"),
      api<Settings>("/admin/settings"),
    ]);
    setStats(s);
    setSettings(p);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    void api<AccountOptions>("/admin/accounts/policy")
      .then(setAccountPolicy)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(
    () =>
      realtime.subscribe((m) => {
        if (m.type === "stats")
          setStats((s) => (s ? { ...s, online: m.online } : s));
      }),
    [],
  );
  useEffect(() => {
    const syncRoute = () => {
      const next = readAdminRoute();
      setTab(next.tab);
      setPlatformTab(next.platformTab);
      setAccessTab(next.accessTab);
    };
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(
      () =>
        void api<{ items: Member[]; nextOffset: number | null }>(
          "/admin/users?" +
            new URLSearchParams({
              ...(q.trim() ? { q: q.trim() } : {}),
              ...(statusFilter ? { status: statusFilter } : {}),
            }),
          "GET",
          undefined,
          controller.signal,
        )
          .then((d) => {
            setUsers(d.items);
            setNext(d.nextOffset);
          })
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          }),
      180,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [q, refresh, statusFilter]);
  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
      setRefresh((n) => n + 1);
      setMessage(success);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function navigateAdmin(patch: Partial<AdminRoute>) {
    const next = { ...readAdminRoute(), ...patch };
    setTab(next.tab);
    setPlatformTab(next.platformTab);
    setAccessTab(next.accessTab);
    const params = new URLSearchParams();
    if (next.tab !== "overview") params.set("tab", next.tab);
    if (next.tab === "platform" && next.platformTab !== "general")
      params.set("platform", next.platformTab);
    if (next.tab === "access" && next.accessTab !== "permissions")
      params.set("access", next.accessTab);
    const nextHash = "/admin" + (params.size ? `?${params.toString()}` : "");
    if (location.hash !== `#${nextHash}`) location.hash = nextHash;
  }
  return (
    <section className="admin-console">
      <div className="admin-heading">
        <span className="admin-emblem">
          <ShieldCheck size={24} />
        </span>
        <div>
          <h1>{t("admin.title")}</h1>
          <p>{t("admin.subtitle")}</p>
        </div>
        <span className="status-badge">{t("admin.badge")}</span>
      </div>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label={t("admin.nav")}>
          {sectionGroups.map(({ group, items }) => (
            <div className="admin-nav-group" key={group}>
              <h2>{t(group)}</h2>
              {items
                .filter(({ id, plugin }) => {
                  if (!plugin) return true;
                  const panel =
                    webPluginRegistry.adminPanels.getByConflictKey(id);
                  return !!panel && activePluginIds.has(panel.pluginId);
                })
                .map(({ id, label, plugin, Icon }) => (
                <button
                  key={id}
                  aria-current={tab === id ? "page" : undefined}
                  className={tab === id ? "active" : ""}
                  onClick={() => {
                    navigateAdmin({ tab: id });
                    setError("");
                    setMessage("");
                  }}
                >
                  <Icon size={18} />
                  {plugin
                    ? pluginMessage(locale, label)
                    : t(label as MessageKey)}
                </button>
                ))}
            </div>
          ))}
          <div className="admin-nav-note">
            <LockKeyhole size={16} />
            <p>{t("admin.navNote")}</p>
          </div>
        </nav>
        <main className="admin-content">
          {error && !creating && !target && !passwordTarget && (
            <Feedback message={error} tone="error" />
          )}
          {message && <Feedback message={message} tone="success" />}
          {pluginAdminPanel?.render({})}
          {tab === "overview" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.overview")}</h2>
                  <p>{t("admin.overviewLead")}</p>
                </div>
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => void act(async () => {}, t("admin.refreshed"))}
                >
                  <RefreshCw size={15} />
                  {t("admin.refresh")}
                </button>
              </div>
              <div className="admin-stats">
                {[
                  {
                    id: "documents",
                    label: t("admin.documents"),
                    value: stats?.documents,
                    Icon: FileText,
                    tone: "blue",
                    hint: t("admin.documentsHint"),
                  },
                  {
                    id: "libraries",
                    label: t("admin.libraries"),
                    value: stats?.libraries,
                    Icon: BookOpen,
                    tone: "purple",
                    hint: t("admin.librariesHint"),
                  },
                  {
                    id: "users",
                    label: t("admin.usersCount"),
                    value: stats?.users,
                    Icon: Users,
                    tone: "green",
                    hint: t("admin.usersHint"),
                  },
                  {
                    id: "online",
                    label: t("admin.online"),
                    value: stats?.online,
                    Icon: Activity,
                    tone: "orange",
                    hint: t("admin.onlineHint"),
                  },
                ].map(({ id, label, value, Icon, tone, hint }) => (
                  <article className="admin-stat" key={id}>
                    <span className={"stat-icon " + tone}>
                      <Icon size={21} />
                    </span>
                    <span>{label}</span>
                    <strong>{value ?? "—"}</strong>
                    <small>{hint}</small>
                  </article>
                ))}
              </div>
              <section className="admin-card">
                <div className="card-heading">
                  <h3>{t("admin.services")}</h3>
                  <span className="subtle">
                    {settings?.site_name ?? "Doca"}
                  </span>
                </div>
                <button className="service-row" onClick={() => navigateAdmin({ tab: "login" })}>
                  <span className="setting-icon">
                    <KeyRound size={20} />
                  </span>
                  <span>
                    <strong>{t("admin.accounts")}</strong>
                    <small>
                      {settings?.registration
                        ? t("admin.accountsOpen")
                        : t("admin.accountsClosed")}
                    </small>
                  </span>
                  <span className="status-badge success">{t("admin.enabled")}</span>
                  <ArrowUpRight size={17} />
                </button>
                <button
                  className="service-row"
                  onClick={() => {
                    navigateAdmin({ tab: "platform", platformTab: "storage" });
                  }}
                >
                  <span className="setting-icon">
                    <HardDrive size={20} />
                  </span>
                  <span>
                    <strong>{t("admin.storage")}</strong>
                    <small>{t("admin.storageHint")}</small>
                  </span>
                  <span className="subtle">{t("admin.viewConfig")}</span>
                  <ArrowUpRight size={17} />
                </button>
                <button className="service-row" onClick={() => navigateAdmin({ tab: "hooks" })}>
                  <span className="setting-icon">
                    <Webhook size={20} />
                  </span>
                  <span>
                    <strong>{t("admin.webhooks")}</strong>
                    <small>{t("admin.webhooksHint")}</small>
                  </span>
                  <span className="subtle">{t("admin.viewConfig")}</span>
                  <ArrowUpRight size={17} />
                </button>
              </section>
              <div className="admin-note">
                <ShieldCheck size={19} />
                <p>{t("admin.privacy")}</p>
              </div>
            </>
          )}
          {tab === "moderation" && <ModerationAdmin />}
          {tab === "templates" && <TemplateSettings />}
          {tab === "registration" && <RegistrationReviews />}
          {tab === "users" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.users")}</h2>
                  <p>创建账号，管理访问状态，并在密码丢失时重置密码。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setError("");
                    setCreating(true);
                  }}
                >
                  <Plus size={16} />
                  创建用户
                </button>
              </div>
              <section className="admin-card users-card">
                <div className="admin-users-toolbar">
                  <strong>
                    用户列表{" "}
                    <span className="subtle">{stats?.users ?? "—"}</span>
                  </strong>
                  <button
                    className="quiet-button"
                    disabled={!selected.length}
                    onClick={() => setAssigning(true)}
                  >
                    设置永久等级
                    {selected.length ? `（${selected.length}）` : ""}
                  </button>
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="搜索用户"
                      placeholder="搜索账号或昵称"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </label>
                  <Select
                    aria-label="用户状态筛选"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">全部状态</option>
                    <option value="pending">待审核</option>
                    <option value="active">正常</option>
                    <option value="disabled">已停用</option>
                  </Select>
                </div>
                <div className="admin-users-table">
                  <div className="admin-user-row table-head">
                    <span>用户</span>
                    <span>登录方式</span>
                    <span>永久等级</span>
                    <span>当前等级 / 到期时间</span>
                    <span>角色</span>
                    <span>账号状态</span>
                    <span>操作</span>
                  </div>
                  {loading ? (
                    <div className="empty">正在加载…</div>
                  ) : !users.length ? (
                    <div className="empty">没有匹配的用户</div>
                  ) : (
                    users.map((u) => (
                      <div className="admin-user-row" key={u.id}>
                        <div className="member-identity">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${u.display_name}`}
                            checked={selected.includes(u.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, u.id]
                                  : selected.filter((id) => id !== u.id),
                              )
                            }
                          />
                          <UserBadge id={u.id} name={u.display_name}>
                            <span>
                              <strong>{u.display_name}</strong>
                              <small>@{u.public_id ?? u.login}</small>
                            </span>
                          </UserBadge>
                        </div>
                        <span
                          className="member-login"
                          title={u.loginMethods.join("、")}
                        >
                          {u.loginMethods.join("、") || "尚未绑定"}
                        </span>
                        <span className="membership-label" style={{color: u.baseLevel.color}}><MembershipIcon icon={u.baseLevel.icon}/>{u.baseLevel.name}</span>
                        <span className="member-level">
                          <strong className="membership-label" style={{color: u.effectiveLevel.color}}><MembershipIcon icon={u.effectiveLevel.icon}/>{u.effectiveLevel.name}</strong>
                          <small>
                            {u.timedLevelExpiresAt
                              ? `${u.timedLevel?.name ?? "会员"}${u.timedLevelExpiresAt <= Date.now() ? "已过期" : "至"} · ${new Date(u.timedLevelExpiresAt).toLocaleDateString("zh-CN")}`
                              : "无定时会员"}
                          </small>
                        </span>
                        <span className="member-role">
                          {u.admin ? (
                            <ShieldCheck size={14} />
                          ) : (
                            <UserRound size={14} />
                          )}{" "}
                          {u.admin ? "管理员" : "普通用户"}
                        </span>
                        <span>
                          <span
                            className={
                              "status-badge " +
                              (u.status === "active" ? "success" : "muted")
                            }
                          >
                            <i />
                            {u.status === "active"
                              ? "正常"
                              : u.status === "pending"
                                ? "待审核"
                                : "已停用"}
                          </span>
                        </span>
                        <span className="admin-member-actions">
                          <button
                            className="text-action"
                            onClick={() => setAccountTarget(u.id)}
                          >
                            编辑
                          </button>
                          {(!accountPolicy || accountPolicy.passwordEnabled) && (
                            <button
                              className="text-action"
                              onClick={() => {
                                setError("");
                                setPasswordTarget(u);
                              }}
                            >
                              重置密码
                            </button>
                          )}
                          <button
                            className="text-action"
                            onClick={() => setMembershipTarget(u.id)}
                          >
                            等级
                          </button>
                          {u.status === "pending" ? <button className="text-action" onClick={()=>navigateAdmin({tab: "registration"})}>前往审核</button> : !u.admin ? (
                            <button
                              className={
                                "text-action " +
                                (u.status === "active" ? "danger" : "")
                              }
                              disabled={busy}
                              onClick={() => {
                                setError("");
                                setTarget(u);
                              }}
                            >
                              {u.status === "active"
                                ? "停用"
                                : u.status === "pending"
                                  ? "审核通过"
                                  : "启用"}
                            </button>
                          ) : (
                            <span className="subtle">—</span>
                          )}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {next !== null && (
                  <button
                    className="load-more"
                    disabled={loading}
                    onClick={async () => {
                      setLoading(true);
                      try {
                        const d = await api<{
                          items: Member[];
                          nextOffset: number | null;
                        }>(
                          "/admin/users?" +
                            new URLSearchParams({
                              offset: String(next),
                              ...(q.trim() ? { q: q.trim() } : {}),
                              ...(statusFilter ? { status: statusFilter } : {}),
                            }),
                        );
                        setUsers((old) => [...old, ...d.items]);
                        setNext(d.nextOffset);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    加载更多用户
                  </button>
                )}
              </section>
            </>
          )}
          {tab === "levels" && <MembershipSettings />}
          {tab === "ai" && <AIAdmin />}
          {tab === "file-recognition" && <FileRecognitionSettings />}
          {accountTarget && (
            <AdminAccountEditor
              userId={accountTarget}
              close={() => setAccountTarget(null)}
              saved={() => setRefresh((n) => n + 1)}
            />
          )}
          {membershipTarget && (
            <UserMembership
              userId={membershipTarget}
              close={() => setMembershipTarget(null)}
              saved={() => setRefresh((n) => n + 1)}
            />
          )}
          {assigning && (
            <AssignLevels
              users={users.filter((u) => selected.includes(u.id))}
              close={() => setAssigning(false)}
              saved={() => setRefresh((n) => n + 1)}
            />
          )}
          {tab === "login" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.login")}</h2>
                  <p>设置登录方式与新用户的加入规则。</p>
                </div>
              </div>
              <AuthenticationSettings saved={load} />
            </>
          )}
          {tab === "platform" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.platform")}</h2>
                  <p>{t("admin.platformLead")}</p>
                </div>
              </div>
              <div className="settings-tabs-column">
                <nav
                  className="platform-settings-tabs"
                  aria-label={t("admin.platformTabs")}
                >
                  {platformSections.map(([id, label]) => (
                    <button
                      key={id}
                      className={platformTab === id ? "active" : ""}
                      aria-current={platformTab === id ? "page" : undefined}
                      onClick={() => navigateAdmin({ platformTab: id! })}
                    >
                      {t(label)}
                    </button>
                  ))}
                </nav>
              </div>
              {platformTab === "general" && settings && (
                <form
                  className="admin-card site-identity-form"
                  key={settings.revision}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void act(
                      () =>
                        api("/admin/settings", "PUT", {
                          siteName: f.get("siteName"),
                          registrationEnabled: !!settings.registration,
                          revision: settings.revision,
                        }),
                      "站点设置已保存",
                    );
                  }}
                >
                  <div className="card-heading">
                    <h3>{t("admin.general")}</h3>
                  </div>
                  <label className="site-name-field">
                    站点名称
                    <input
                      name="siteName"
                      defaultValue={settings.site_name}
                      required
                      maxLength={160}
                    />
                  </label>
                  <div className="admin-form-footer">
                    <span />
                    <button className="primary" disabled={busy}>
                      保存设置
                    </button>
                  </div>
                </form>
              )}
              {platformTab === "cards" && <UserCardSettings />}
              {platformTab === "storage" && <StorageSettings />}
              {platformTab === "search" && <SearchSettings />}
            </>
          )}
          {tab === "access" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.access")}</h2>
                  <p>{t("admin.accessLead")}</p>
                </div>
              </div>
              <div className="settings-tabs-column">
                <nav
                  className="platform-settings-tabs"
                  aria-label={t("admin.accessTabs")}
                >
                  {accessSections.map(([id, label]) => (
                    <button
                      key={id}
                      className={accessTab === id ? "active" : ""}
                      aria-current={accessTab === id ? "page" : undefined}
                      onClick={() => navigateAdmin({ accessTab: id! })}
                    >
                      {t(label)}
                    </button>
                  ))}
                </nav>
              </div>
              {accessTab === "permissions" && <DistributionSettings />}
              {accessTab === "directory" && <DirectorySettings />}
            </>
          )}
          {tab === "hooks" && <HookEvents />}
        </main>
      </div>
      {creating && (
        <Dialog
          title="创建用户"
          close={() => {
            if (!busy) setCreating(false);
          }}
        >
          <form
            className="admin-account-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await act(
                  () =>
                    api("/admin/users", "POST", {
                      login: f.get("login"),
                      displayName: f.get("name"),
                      email: f.get("email") || "",
                      phone: f.get("phone") || "",
                      avatar: f.get("avatar") || "",
                      ...(f.get("password")
                        ? { password: f.get("password") }
                        : {}),
                    }),
                  "用户已创建",
                )
              )
                setCreating(false);
            }}
          >
            <p className="subtle">
              创建普通用户账号，文档和知识库默认保持私有。
            </p>
            <label>
              用户名（账号） *
              <input
                name="login"
                required
                minLength={3}
                maxLength={160}
                autoComplete="off"
                placeholder="至少 3 个字符"
              />
            </label>
            <label>
              昵称{accountPolicy?.fields?.displayName.required ? " *" : ""}
              <input
                name="name"
                required={accountPolicy?.fields?.displayName.required}
                maxLength={160}
                placeholder="协作者看到的昵称"
              />
            </label>
            {(["email", "phone"] as const).map((key) => (
              <label key={key}>
                {key === "email" ? "邮箱" : "手机号"}
                {accountPolicy?.fields?.[key].required
                  ? " *"
                  : ""}
                <input
                  name={key}
                  type={key === "email" ? "email" : "tel"}
                  required={
                    !!accountPolicy?.fields?.[key].required
                  }
                  placeholder={
                    key === "email" ? "name@example.com" : "+86 13800138000"
                  }
                />
              </label>
            ))}
            <label>
              头像地址{accountPolicy?.fields?.avatar.required ? " *" : ""}
              <input
                required={accountPolicy?.fields?.avatar.required}
                name="avatar"
                type="url"
                placeholder="https://…"
                maxLength={2048}
              />
            </label>
            {accountPolicy?.passwordEnabled && <label>
              初始密码 *
              <input
                name="password"
                type="password"
                required={!!accountPolicy?.passwordEnabled}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                placeholder="至少 12 个字符"
              />
            </label>}
            {error && <Feedback message={error} tone="error" />}
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                创建账号
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {passwordTarget && (
        <Dialog
          title="重置密码"
          close={() => {
            if (!busy) {
              setError("");
              setPasswordTarget(null);
            }
          }}
          className="modal-compact"
        >
          <form
            className="admin-account-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const next = String(form.get("password") ?? "");
              const again = String(form.get("confirm") ?? "");
              if (next !== again) {
                setError("两次输入的密码不一致");
                return;
              }
              if (
                await act(
                  () =>
                    api("/admin/users/" + passwordTarget.id + "/password", "POST", {
                      password: next,
                    }),
                  "密码已重置，该用户需要用新密码重新登录",
                )
              )
                setPasswordTarget(null);
            }}
          >
            <p>
              为「{passwordTarget.display_name}」设置新密码。对方当前的登录会全部退出。请把新密码告知对方，这里不会再次显示。
            </p>
            <label>
              新密码 *
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                placeholder="至少 12 个字符"
              />
            </label>
            <label>
              再次输入 *
              <input
                name="confirm"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            {error && <Feedback message={error} tone="error" />}
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setPasswordTarget(null);
                }}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                确认重置
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {target && (
        <Dialog
          title={
            target.status === "active"
              ? "停用用户"
              : target.status === "pending"
                ? "审核新用户"
                : "启用用户"
          }
          close={() => {
            if (!busy) setTarget(null);
          }}
          className="modal-compact"
        >
          <p>
            确认{target.status === "active" ? "停用" : "启用"}「
            {target.display_name}」？
            {target.status === "active"
              ? "停用后，该用户将无法登录，已有会话也会失效。用户的文档不会被删除。"
              : "该用户将可以重新登录本站。"}
          </p>
          {error && <Feedback message={error} tone="error" />}
          <footer>
            <button disabled={busy} onClick={() => setTarget(null)}>
              取消
            </button>
            {target.status === "pending" && (
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
                  if (
                    await act(
                      () =>
                        api("/admin/users/" + target.id, "PATCH", {
                          status: "disabled",
                        }),
                      "申请已拒绝，账号已停用",
                    )
                  )
                    setTarget(null);
                }}
              >
                拒绝申请
              </button>
            )}
            <button
              disabled={busy}
              className={target.status === "active" ? "danger" : "primary"}
              onClick={async () => {
                if (
                  await act(
                    () =>
                      api("/admin/users/" + target.id, "PATCH", {
                        status:
                          target.status === "active" ? "disabled" : "active",
                      }),
                    "用户状态已更新",
                  )
                )
                  setTarget(null);
              }}
            >
              {target.status === "pending"
                ? "审核通过"
                : `确认${target.status === "active" ? "停用" : "启用"}`}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
