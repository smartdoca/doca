import { NavigationArea } from "@web/plugins/navigation.js";
import { NavigationSettings } from "./navigation.js";
import { Plugins } from "./plugins.js";
import {
  loginMethodLabel,
  type LoginMethodLabel,
} from "@web/shared/utils/system-labels.js";
import { htmlLang } from "@doca/i18n";
import { AIAdmin } from "@web/features/ai/ai-admin.js";
import { RegistrationReviews } from "@web/features/admin/registration-reviews.js";
import type { AccountOptions } from "@web/features/auth/account-fields.js";
import { AdminAccountEditor } from "@web/features/account/account-settings.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Webhooks } from "@web/features/admin/webhooks.js";
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
import { pluginMessage, webPluginRegistry } from "@web/plugins/registry.js";

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
  timedLevel: {
    id: string;
    name: string;
    color?: string;
    icon?: string;
  } | null;
  timedLevelExpiresAt: number | null;
  loginMethodDetails: LoginMethodLabel[];
  last_login_at?: string | null;
};
type OnlineMember = Pick<
  Member,
  "id" | "display_name" | "public_id" | "login" | "last_login_at"
>;
type Settings = {
  default_locale: string;
  default_timezone: string;
  site_name: string;
  registration: number;
  revision: number;
};
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
    ],
  },
  {
    id: "content",
    group: "admin.group.content" as MessageKey,
    items: [
      { id: "access", label: "admin.access", Icon: LockKeyhole },
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
      {
        id: "platform",
        label: "admin.platform",
        order: 10,
        Icon: SettingsIcon,
      },
      { id: "navigation", label: "navigation.title", order: 21, Icon: SettingsIcon },
      { id: "plugins", label: "plugins.title", order: 20, Icon: SettingsIcon },
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
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
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
  const platformTab = platformSections.some(
    ([id]) => id === params.get("platform"),
  )
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
    [accountPolicy, setAccountPolicy] = useState<AccountOptions | null>(null);
  const [tab, setTab] = useState(() => readAdminRoute().tab),
    [platformTab, setPlatformTab] = useState(
      () => readAdminRoute().platformTab,
    ),
    [accessTab, setAccessTab] = useState(() => readAdminRoute().accessTab),
    [stats, setStats] = useState<{
      documents: number;
      libraries: number;
      users: number;
      online: number;
    } | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [users, setUsers] = useState<Member[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [onlineUsers, setOnlineUsers] = useState<OnlineMember[]>([]),
    [onlineNext, setOnlineNext] = useState<number | null>(null),
    [onlineLoading, setOnlineLoading] = useState(false),
    [onlineRevision, setOnlineRevision] = useState(0),
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
        if (m.type === "stats") {
          setStats((s) => (s ? { ...s, online: m.online } : s));
          setOnlineRevision((value) => value + 1);
        }
      }),
    [],
  );
  useEffect(() => {
    if (tab !== "overview" || stats?.online === undefined) return;
    const controller = new AbortController();
    setOnlineLoading(true);
    void api<{ items: OnlineMember[]; nextOffset: number | null }>(
      "/admin/online-users",
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        setOnlineUsers(data.items);
        setOnlineNext(data.nextOffset);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOnlineLoading(false);
      });
    return () => controller.abort();
  }, [tab, stats?.online, onlineRevision, refresh]);
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
        void api<{
          items: Member[];
          nextCursor?: string | null;
        }>(
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
            setNextCursor(d.nextCursor ?? null);
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
  const loginTime = (value?: string | null) =>
    value
      ? new Intl.DateTimeFormat(htmlLang(locale), {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : t("users.noLoginRecord");
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
          <NavigationArea slot="web.admin"/>
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
              <section className="admin-card admin-online-card">
                <div className="card-heading">
                  <div>
                    <h3>{t("admin.onlineUsers")}</h3>
                    <small>{t("admin.onlineUsersHint")}</small>
                  </div>
                  <span className="status-badge success">
                    {stats?.online ?? 0}
                  </span>
                </div>
                <div className="admin-online-list">
                  {onlineLoading && !onlineUsers.length ? (
                    <div className="empty">{t("common.loading")}</div>
                  ) : !onlineUsers.length ? (
                    <div className="empty">{t("admin.onlineEmpty")}</div>
                  ) : (
                    onlineUsers.map((user) => (
                      <div className="admin-online-user" key={user.id}>
                        <UserBadge id={user.id} name={user.display_name}>
                          <span>
                            <strong>{user.display_name}</strong>
                            <small>@{user.public_id ?? user.login}</small>
                          </span>
                        </UserBadge>
                        <span className="subtle">
                          {t("users.lastLoginValue", {
                            time: loginTime(user.last_login_at),
                          })}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {onlineNext !== null && (
                  <button
                    className="load-more"
                    disabled={onlineLoading}
                    onClick={async () => {
                      setOnlineLoading(true);
                      try {
                        const data = await api<{
                          items: OnlineMember[];
                          nextOffset: number | null;
                        }>(`/admin/online-users?offset=${onlineNext}`);
                        setOnlineUsers((current) => [
                          ...current,
                          ...data.items.filter(
                            (item) => !current.some(({ id }) => id === item.id),
                          ),
                        ]);
                        setOnlineNext(data.nextOffset);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setOnlineLoading(false);
                      }
                    }}
                  >
                    {t("admin.loadMoreOnline")}
                  </button>
                )}
              </section>
              <section className="admin-card">
                <div className="card-heading">
                  <h3>{t("admin.services")}</h3>
                  <span className="subtle">
                    {settings?.site_name ?? "Doca"}
                  </span>
                </div>
                <button
                  className="service-row"
                  onClick={() => navigateAdmin({ tab: "login" })}
                >
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
                  <span className="status-badge success">
                    {t("admin.enabled")}
                  </span>
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
                <button
                  className="service-row"
                  onClick={() => navigateAdmin({ tab: "hooks" })}
                >
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
          {tab === "templates" && <TemplateSettings />}
          {tab === "registration" && <RegistrationReviews />}
          {tab === "users" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.users")}</h2>
                  <p>{t("users.intro")}</p>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setError("");
                    setCreating(true);
                  }}
                >
                  <Plus size={16} />
                  {t("users.create")}
                </button>
              </div>
              <section className="admin-card users-card">
                <div className="admin-users-toolbar">
                  <strong>
                    {t("users.list")}{" "}
                    <span className="subtle">{stats?.users ?? "—"}</span>
                  </strong>

                  <label className="search-field">
                    <Search size={16} />
                    <input
                      aria-label={t("users.search")}
                      placeholder={t("users.searchPlaceholder")}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </label>
                  <Select
                    aria-label={t("users.statusFilter")}
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">{t("ticket.statusAll")}</option>
                    <option value="pending">{t("users.pending")}</option>
                    <option value="active">{t("users.active")}</option>
                    <option value="disabled">{t("users.disabled")}</option>
                  </Select>
                </div>
                <div className="admin-users-table">
                  <div className="admin-user-row table-head">
                    <span>{t("users.user")}</span>
                    <span>{t("authAdmin.login")}</span>
                    <span>{t("users.role")}</span>
                    <span>{t("users.status")}</span>
                    <span>{t("users.lastLogin")}</span>
                    <span>{t("users.actions")}</span>
                  </div>
                  {loading ? (
                    <div className="empty">{t("common.loading")}</div>
                  ) : !users.length ? (
                    <div className="empty">{t("users.noMatches")}</div>
                  ) : (
                    users.map((u) => (
                      <div className="admin-user-row" key={u.id}>
                        <div className="member-identity">
                          <UserBadge id={u.id} name={u.display_name}>
                            <span>
                              <strong>{u.display_name}</strong>
                              <small>@{u.public_id ?? u.login}</small>
                            </span>
                          </UserBadge>
                        </div>
                        <span
                          className="member-login"
                          title={u.loginMethodDetails
                            .map((method) => loginMethodLabel(method, t))
                            .join(locale === "zh" ? "、" : ", ")}
                        >
                          {u.loginMethodDetails
                            .map((method) => loginMethodLabel(method, t))
                            .join(locale === "zh" ? "、" : ", ") ||
                            t("users.noMethods")}
                        </span>
                        <span className="member-role">
                          {u.admin ? (
                            <ShieldCheck size={14} />
                          ) : (
                            <UserRound size={14} />
                          )}{" "}
                          {u.admin ? t("admin.badge") : t("users.regular")}
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
                              ? t("users.active")
                              : u.status === "pending"
                                ? t("users.pending")
                                : t("users.disabled")}
                          </span>
                        </span>
                        <span className="member-last-login">
                          {loginTime(u.last_login_at)}
                        </span>
                        <span className="admin-member-actions">
                          <button
                            className="text-action"
                            onClick={() => setAccountTarget(u.id)}
                          >
                            {t("time.edited")}
                          </button>
                          {(!accountPolicy ||
                            accountPolicy.passwordEnabled) && (
                            <button
                              className="text-action"
                              onClick={() => {
                                setError("");
                                setPasswordTarget(u);
                              }}
                            >
                              {t("login.reset")}
                            </button>
                          )}

                          {u.status === "pending" ? (
                            <button
                              className="text-action"
                              onClick={() =>
                                navigateAdmin({ tab: "registration" })
                              }
                            >
                              {t("users.review")}
                            </button>
                          ) : !u.admin ? (
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
                                ? t("users.disable")
                                : u.status === "pending"
                                  ? t("users.approve")
                                  : t("users.enable")}
                            </button>
                          ) : (
                            <span className="subtle">—</span>
                          )}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {nextCursor !== null && (
                  <button
                    className="load-more"
                    disabled={loading}
                    onClick={async () => {
                      setLoading(true);
                      try {
                        const d = await api<{
                          items: Member[];
                          nextCursor?: string | null;
                        }>(
                          "/admin/users?" +
                            new URLSearchParams({
                              cursor: nextCursor,
                              ...(q.trim() ? { q: q.trim() } : {}),
                              ...(statusFilter ? { status: statusFilter } : {}),
                            }),
                        );
                        setUsers((old) => [...old, ...d.items]);
                        setNextCursor(d.nextCursor ?? null);
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    {t("users.loadMore")}
                  </button>
                )}
              </section>
            </>
          )}
          {tab === "ai" && <AIAdmin />}
          {tab === "file-recognition" && <FileRecognitionSettings />}
          {accountTarget && (
            <AdminAccountEditor
              userId={accountTarget}
              close={() => setAccountTarget(null)}
              saved={() => setRefresh((n) => n + 1)}
            />
          )}

          {tab === "login" && (
            <>
              <div className="admin-section-heading">
                <div>
                  <h2>{t("admin.login")}</h2>
                  <p>{t("users.authIntro")}</p>
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
                          defaultLocale: f.get("defaultLocale"),
                          defaultTimezone: f.get("defaultTimezone"),
                          registrationEnabled: !!settings.registration,
                          revision: settings.revision,
                        }),
                      t("users.siteSaved"),
                    );
                  }}
                >
                  <div className="card-heading">
                    <h3>{t("admin.general")}</h3>
                  </div>
                  <label className="site-name-field">
                    {t("users.siteName")}
                    <input
                      name="siteName"
                      defaultValue={settings.site_name}
                      required
                      maxLength={160}
                    />
                  </label>
                  <label>
                    {t("admin.defaultLocale")}
                    <Select
                      name="defaultLocale"
                      defaultValue={settings.default_locale ?? "zh"}
                    >
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </Select>
                    <small>{t("admin.defaultLocaleHint")}</small>
                  </label>
                  <label>
                    {t("admin.defaultTimezone")}
                    <input
                      name="defaultTimezone"
                      list="site-timezones"
                      defaultValue={
                        settings.default_timezone ?? "Asia/Shanghai"
                      }
                      required
                      maxLength={100}
                    />
                    <datalist id="site-timezones">
                      {Array.from(
                        new Set([
                          "UTC",
                          "Asia/Shanghai",
                          ...Intl.supportedValuesOf("timeZone"),
                        ]),
                      ).map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                    </datalist>
                    <small>{t("admin.defaultTimezoneHint")}</small>
                  </label>
                  <div className="admin-form-footer">
                    <span />
                    <button className="primary" disabled={busy}>
                      {t("services.saveSettings")}
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
          {tab === "plugins" && <Plugins />}
          {tab === "navigation" && <NavigationSettings />}
          {tab === "hooks" && <Webhooks />}
        </main>
      </div>
      {creating && (
        <Dialog
          title={t("users.create")}
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
                  t("users.created"),
                )
              )
                setCreating(false);
            }}
          >
            <p className="subtle">{t("users.createHelp")}</p>
            <label>
              {t("users.usernameRequired")}
              <input
                name="login"
                required
                minLength={3}
                maxLength={160}
                autoComplete="off"
                placeholder={t("users.usernameHint")}
              />
            </label>
            <label>
              {t("login.nickname")}
              {accountPolicy?.fields?.displayName.required ? " *" : ""}
              <input
                name="name"
                required={accountPolicy?.fields?.displayName.required}
                maxLength={160}
                placeholder={t("users.displayNameHint")}
              />
            </label>
            {(["email", "phone"] as const).map((key) => (
              <label key={key}>
                {key === "email" ? t("fields.email") : t("login.phone")}
                {accountPolicy?.fields?.[key].required ? " *" : ""}
                <input
                  name={key}
                  type={key === "email" ? "email" : "tel"}
                  required={!!accountPolicy?.fields?.[key].required}
                  placeholder={
                    key === "email" ? "name@example.com" : "+86 13800138000"
                  }
                />
              </label>
            ))}
            <label>
              {t("fields.avatar")}
              {accountPolicy?.fields?.avatar.required ? " *" : ""}
              <input
                required={accountPolicy?.fields?.avatar.required}
                name="avatar"
                type="url"
                placeholder="https://…"
                maxLength={2048}
              />
            </label>
            {accountPolicy?.passwordEnabled && (
              <label>
                {t("users.initialPassword")}
                <input
                  name="password"
                  type="password"
                  required={!!accountPolicy?.passwordEnabled}
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  placeholder={t("users.passwordHint")}
                />
              </label>
            )}
            {error && <Feedback message={error} tone="error" />}
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                {t("common.cancel")}
              </button>
              <button className="primary" disabled={busy}>
                {t("login.createAccount")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {passwordTarget && (
        <Dialog
          title={t("login.reset")}
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
                setError(t("users.passwordMismatch"));
                return;
              }
              if (
                await act(
                  () =>
                    api(
                      "/admin/users/" + passwordTarget.id + "/password",
                      "POST",
                      {
                        password: next,
                      },
                    ),
                  t("users.passwordReset"),
                )
              )
                setPasswordTarget(null);
            }}
          >
            <p>
              {t("users.resetWarning", { name: passwordTarget.display_name })}
            </p>
            <label>
              {t("users.newPassword")}
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                placeholder={t("users.passwordHint")}
              />
            </label>
            <label>
              {t("users.repeatPassword")}
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
                {t("common.cancel")}
              </button>
              <button className="primary" disabled={busy}>
                {t("users.confirmReset")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {target && (
        <Dialog
          title={
            target.status === "active"
              ? t("users.disableTitle")
              : target.status === "pending"
                ? t("users.reviewTitle")
                : t("users.enableTitle")
          }
          close={() => {
            if (!busy) setTarget(null);
          }}
          className="modal-compact"
        >
          <p>
            {t(
              target.status === "active"
                ? "users.disableQuestion"
                : "users.enableQuestion",
              { name: target.display_name },
            )}{" "}
            {target.status === "active"
              ? t("users.disableHelp")
              : t("users.enableHelp")}
          </p>
          {error && <Feedback message={error} tone="error" />}
          <footer>
            <button disabled={busy} onClick={() => setTarget(null)}>
              {t("common.cancel")}
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
                      t("users.rejected"),
                    )
                  )
                    setTarget(null);
                }}
              >
                {t("users.reject")}
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
                    t("users.statusSaved"),
                  )
                )
                  setTarget(null);
              }}
            >
              {target.status === "pending"
                ? t("users.approve")
                : t(
                    target.status === "active"
                      ? "users.confirmDisable"
                      : "users.confirmEnable",
                  )}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
