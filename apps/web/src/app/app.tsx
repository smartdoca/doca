import { WorkspaceHome } from "@web/features/workspace/home.js";
import { DiscoveryPage } from "@web/features/discovery/discovery.js";
import { KnowledgePublicPage } from "@web/features/knowledge/knowledge-public-page.js";
import { KnowledgeCurationToggle } from "@web/features/documents/library-relations.js";
import { KnowledgeAssistants } from "@web/features/knowledge/knowledge-assistants.js";
import type { MessageKey } from "@doca/i18n";
import { AIProvider } from "@web/features/ai/ai-context.js";
import { useI18n } from "@web/shared/i18n.js";
import { AIChat, AIDocumentLayout } from "@web/features/ai/ai-chat.js";
import "@web/features/account/account-menu.css";
import { AccountMenu } from "@web/features/account/account-menu.js";
import { LocaleSwitch } from "@web/features/account/locale-switch.js";
import { AccountLogin } from "@web/features/auth/account-login.js";
import { AccountOnboarding } from "@web/features/auth/account-fields.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { BackLink } from "@web/shared/components/back-link.js";
import {
  createImportedDocument,
  type ImportProgress,
} from "@web/features/documents/file-transfer.js";
import { DocumentPeople } from "@web/features/documents/document-people.js";
import { DocumentName } from "@web/features/documents/document-name.js";
import {
  AccessGate,
  AccessTasks,
  RequestAccess,
  TodoIcon,
} from "@web/features/documents/access-tasks.js";
import { LibraryFavorite } from "@web/features/documents/library-favorite.js";
import { DocumentReferences } from "@web/features/documents/document-references.js";
import { PinnedDocuments } from "@web/features/workspace/pinned-nav.js";
import { DocumentReactionButtons } from "@web/features/documents/document-reactions.js";
import {
  LibrarySettings,
  LibraryLanding,
  LibrarySystemPage,
  LibraryQaPage,
  librarySettingsUrl,
  librarySystemUrl,
  libraryQaUrl,
} from "@web/features/documents/library.js";
import {
  CommentComposer,
  CommentMessage,
  parsedComment,
} from "@web/features/comments/rich-comments.js";
import { Select } from "@web/shared/components/select.js";
import { realtime } from "@web/features/documents/realtime.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { setCurrentUserId } from "@web/shared/components/user-mention.js";
import React, { lazy, Suspense, useEffect, useState, useRef, useMemo } from "react";
import {
  BookOpen,
  Sparkles,
  Feather,
  Plus,
  Search,
  Clock,
  Users,
  Trash2,
  Settings,
  Bell,
  MoreHorizontal,
  ShieldCheck,
  ThumbsUp,
  LogOut,
  FolderOpen,
  ArrowLeft,
  Home,
  PanelLeft,
  UserRound,
  BookOpenCheck,
  Bot,
  Network,
  MessageSquare,
} from "lucide-react";
import {
  api,
  roleRank,
  type Bootstrap,
  type Resource,
  type Page,
  type Detail,
  type User,
  type Me,
} from "@web/shared/api.js";
import {
  Dialog,
  PermissionDialog,
  TransferDialog,
  MoveDialog,
} from "@web/features/documents/dialogs.js";
import { Admin } from "@web/features/admin/admin.js";
import { AuthCompletion, ExternalLoginOptions } from "@web/features/auth/authentication.js";
import { DocumentTree } from "@web/features/documents/tree.js";
import { Dashboard, GlobalSearch } from "@web/features/workspace/dashboard.js";
import { Avatar, Profile, PersonalSettings } from "@web/features/account/profile.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import "@web/styles/globals.css";
import { FileIcon } from "@web/features/documents/document-controls.js";
import type { FileLocation } from "@web/features/files/files.js";
import { MobileTicketRedeem, postMobileEditor } from "@web/features/mobile/ticket-redeem.js";
import { SubscribeLibraryHost } from "@web/features/knowledge/subscribe-library.js";
import {
  pluginInstalled,
  pluginMessage,
  webPluginRegistry,
} from "@web/plugins/registry.js";
import "@web/features/files/files.css";
import "@web/features/workspace/workspace.css";
import "@web/styles/theme.css";
import "@web/features/settings/settings-shell.css";
import "@web/features/documents/document-layout.css";
import { TemplatePicker } from "@web/features/documents/template-picker.js";
import {
  CreatePopover,
  DocumentMore,
  LastEdited,
  LikePeople,
  relativeTime,
  useDismissMenus,
} from "@web/features/documents/document-experience.js";
import "@web/features/documents/document-experience.css";
import "@web/styles/platform-polish.css";
import "@web/features/workspace/workspace-density.css";
import "@web/features/documents/document-tree.css";
import { DocumentModeContext, DocumentModeSwitch, useDocumentModeState } from "@web/features/documents/document-mode.js";
import "@web/features/workspace/navigation-collapse.css";
import { useDesktopNavigation, useNavigationCollapse } from "@web/features/workspace/navigation-collapse.js";
const DocumentEditor = lazy(() =>
  import("@web/features/documents/document-editor.js").then((m) => ({ default: m.DocumentEditor })),
);
const QuickNotes = lazy(() => import("@web/features/quick-notes/quick-notes.js").then(m => ({ default: m.QuickNotes })));
const QuickNotesFloat = lazy(() => import("@web/features/quick-notes/quick-notes-float.js").then(m => ({ default: m.QuickNotesFloat })));

const titleKeys: Record<string, MessageKey> = {
  home: "workspace.home",
  documents: "home.title",
  discover: "workspace.publicResources",
  collected: "discovery.collected",
  todos: "nav.tickets",
  tickets: "nav.tickets",
  ai: "nav.assistant",
  "knowledge-assistants": "knowledge.assistants",
  notes: "nav.notes",
  preferences: "account.settings",
  shared: "nav.shared",
  favorites: "nav.favorites",
  all: "nav.recent",
  trash: "nav.trash",
};
const errorText = (e: unknown, fallback: string) => {
  if (!(e instanceof Error)) return fallback;
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code ?? "")
      : "";
  return code ? `${e.message}（${code}）` : e.message;
};
const shareTokenFromHash = (value: string) =>
  /^#\/s\/([A-Za-z0-9_-]{43})$/.exec(value)?.[1] ?? null;
const rememberedShareToken = () => {
  const current = shareTokenFromHash(location.hash);
  if (current) {
    try { sessionStorage.setItem("doca.pending-share-token", current); } catch {}
    return current;
  }
  try { return sessionStorage.getItem("doca.pending-share-token"); } catch { return null; }
};
type ShareInvitation = {
  pending: true;
  id: string;
  title: string;
  kind: "document" | "library" | "assistant";
  role: string;
};
export function App() {
  // Installed bundles finish loading before mount, after this module is imported.
  const pluginNavigation = useMemo(() => webPluginRegistry.navigation.list(), []);
  const pluginNavigationByScope = useMemo(
    () => new Map(pluginNavigation.map((item) => [item.scope, item])),
    [pluginNavigation],
  );
  const { locale, t, reloadLocale } = useI18n();
  const [navigationCollapsed, setNavigationCollapsed] = useNavigationCollapse("doca.navigation.collapsed");
  const [adminNavigationCollapsed, setAdminNavigationCollapsed] = useNavigationCollapse("doca.admin-navigation.collapsed");
  const desktopNavigation = useDesktopNavigation();
  useDismissMenus();
  const [createAnchor, setCreateAnchor] = useState<DOMRect | null>(null);
  const [templateFormat, setTemplateFormat] = useState<Resource["format"] | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null),
    [fatal, setFatal] = useState(""),
    [navigationOpen, setNavigationOpen] = useState(false),
    [me, setMe] = useState<Me | null>(null),
    [libraryInfo, setLibraryInfo] = useState<Resource | null>(null),
    [heldLibraryId, setHeldLibraryId] = useState<string | null>(null),
    [hash, setHash] = useState(location.hash),
    [refresh, setRefresh] = useState(0),
    [scope, setScope] = useState(() => {
      const route = location.hash.slice(2).split(/[/?]/)[0]!;
      if (route === "knowledge") return "libraries";
      return titleKeys[route] || pluginNavigationByScope.has(route)
        ? route
        : "home";
    }),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [importProgress, setImportProgress] = useState<ImportProgress | null>(null),
    [loading, setLoading] = useState(false),
    [modal, setModal] = useState(""),
    [searchSeed, setSearchSeed] = useState(""),
    [shareInvitation, setShareInvitation] = useState<ShareInvitation | null>(null),
    [targets, setTargets] = useState<Resource[]>([]),
    [fileTrail, setFileTrail] = useState<FileLocation[]>([{ type: "system", id: "root", name: "我的文件夹" }]),
    [creation, setCreation] = useState<{
      kind: "document" | "library";
      parentId: string | null;
      libraryId: string | null;
    }>({ kind: "document", parentId: null, libraryId: null });
  useEffect(() => {
    const token = shareTokenFromHash(hash);
    if (token) {
      try { sessionStorage.setItem("doca.pending-share-token", token); } catch {}
    }
    if (!token || !bootstrap?.user) return;
    let active = true;
    void api<{ id: string; kind?: string; pending?: false; alreadyHasAccess?: boolean } | ShareInvitation>(
      "/share/redeem",
      "POST",
      { token, accept: false },
    )
      .then(async (r) => {
        if (active) {
          if (r.pending) {
            setShareInvitation(r);
          } else {
            if (r.alreadyHasAccess) {
              const consume = window.confirm(
                "你已经拥有不低于此链接的权限。是否登记为此分享链接的成员？",
              );
              if (consume) {
                r = await api<{ id: string; kind?: string }>("/share/redeem", "POST", {
                  token,
                  accept: true,
                  consume: true,
                });
              }
            }
            try { sessionStorage.removeItem("doca.pending-share-token"); } catch {}
            location.hash = r.kind === "assistant" ? "/knowledge-assistants?bot=" + r.id : "/r/" + r.id;
          }
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [hash, bootstrap?.user?.id]);
  const mobileResourceId = /^#\/m\/r\/([a-f0-9-]{36})(?:\?|$)/.exec(hash)?.[1],
    mobileShell = !!mobileResourceId,
    resourceId = mobileResourceId ?? /^#\/r\/([a-f0-9-]{36})(?:\?|$)/.exec(hash)?.[1],
    sharedFolderId = /^#\/shared-files\/([a-f0-9-]{36})(?:\?|$)/.exec(hash)?.[1],
    adminPage = hash.split("?")[0] === "#/admin",
    accountPage = hash === "#/account",
    preferencesPage = hash === "#/preferences";
  const ticketId = /^#\/tickets\/([a-f0-9-]{36})$/.exec(hash)?.[1];
  const ticketsPage = !!ticketId || hash.split("?")[0] === "#/tickets" || hash === "#/todos";
  const targetComment = new URLSearchParams(hash.split("?")[1] ?? "").get(
    "comment",
  );
  const sharedFolderName = (() => {
    const params = new URLSearchParams(hash.split("?")[1] ?? "");
    const direct = params.get("name");
    if (direct) return direct;
    try {
      const path = JSON.parse(params.get("path") ?? "[]") as FileLocation[];
      return path[0]?.name || t("nav.sharedFiles");
    } catch { return t("nav.sharedFiles"); }
  })();
  async function loadMoreComments() {
    if (
      !detail ||
      detail.commentsNextCursor == null ||
      busy
    )
      return;
    setBusy(true);
    try {
      const page = await api<{
        items: Detail["comments"];
        nextCursor?: string | null;
      }>(
        `/resources/${detail.resource.id}/comments?cursor=${encodeURIComponent(detail.commentsNextCursor)}`,
      );
      setDetail((d) =>
        d?.resource.id === detail.resource.id
          ? {
              ...d,
              comments: [
                ...new Map(
                  [...d.comments, ...page.items].map((c) => [c.id, c]),
                ).values(),
              ],
              commentsNextCursor: page.nextCursor,
            }
          : d,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setImportProgress(null);
    }
  }
  const libraryIdFromDetail =
    detail?.resource.id === resourceId
      ? detail.resource.kind === "library"
        ? detail.resource.id
        : (detail.resource.library_id ?? null)
      : undefined;
  const containingLibraryId =
    libraryIdFromDetail !== undefined ? libraryIdFromDetail : resourceId ? heldLibraryId : null;
  useEffect(() => {
    if (!resourceId) setHeldLibraryId(null);
    else if (libraryIdFromDetail !== undefined) setHeldLibraryId(libraryIdFromDetail);
  }, [resourceId, libraryIdFromDetail]);
  const currentLibraryId = containingLibraryId || undefined;
  const libraryView = new URLSearchParams(hash.split("?")[1]).get("view");
  const libraryRole =
    libraryInfo && libraryInfo.id === currentLibraryId
      ? libraryInfo.role
      : detail?.resource.kind === "library" &&
          detail.resource.id === currentLibraryId
        ? detail.resource.role
        : "none";
  const canManageLibrary = roleRank(libraryRole) >= 4;
  const librarySettingsPage = libraryView === "settings" && canManageLibrary;
  const librarySystemPage = libraryView === "system" && canManageLibrary;
  const libraryQaPage = libraryView === "qa";
  const currentDetail = detail?.resource.id === resourceId ? detail : null;
  const sharedPersonalView = !!(
    bootstrap?.user &&
    currentDetail?.resource.kind === "document" &&
    !currentDetail.resource.library_id &&
    currentDetail.resource.owner_id !== bootstrap.user.id
  );
  const personalDocumentPage = !!(
    currentDetail?.resource.kind === "document" &&
    !currentDetail.resource.library_id
  );
  const documentHeader = !!resourceId && currentDetail?.resource.kind !== "library";
  const documentMode = useDocumentModeState(`${resourceId ?? ""}:${bootstrap?.user?.id ?? "anonymous"}`, !!bootstrap?.user && !!currentDetail && roleRank(currentDetail.resource.role) >= 3);
  const libraryTitle =
    libraryInfo && libraryInfo.id === currentLibraryId
      ? libraryInfo.title
      : detail?.resource.kind === "library" &&
          detail.resource.id === currentLibraryId
        ? detail.resource.title
        : t("nav.loadingLibrary");
  const activePluginIds = new Set(
    bootstrap?.plugins.map((plugin) => plugin.id) ?? [],
  );
  const scopeTitle = titleKeys[scope];
  const scopedPluginNavigation = pluginNavigationByScope.get(scope);
  const pluginScopeTitle =
    scopedPluginNavigation &&
    activePluginIds.has(scopedPluginNavigation.pluginId)
      ? scopedPluginNavigation.labelKey
      : undefined;
  const headerTitle = resourceId
    ? currentDetail
      ? librarySettingsPage && currentDetail.resource.kind === "library"
        ? t("nav.librarySettings")
        : librarySystemPage && currentDetail.resource.kind === "library"
          ? t("nav.librarySystem")
          : libraryQaPage && currentDetail.resource.kind === "library"
            ? t("nav.libraryQa")
            : currentDetail.resource.title
      : t("nav.opening")
    : ticketsPage
      ? t("nav.tickets")
      : scopeTitle
        ? t(scopeTitle)
        : pluginScopeTitle
          ? pluginMessage(locale, pluginScopeTitle)
        : "";
  function openFileTrail(index: number) {
    const nextTrail = fileTrail.slice(0, index + 1).map(({ type, id, name }) => ({ type, id, name }));
    const path = encodeURIComponent(JSON.stringify(nextTrail));
    location.hash = `${sharedFolderId ? `/shared-files/${sharedFolderId}` : "/files"}?path=${path}`;
  }
  useEffect(() => {
    if (!detail?.resource.id) return;
    const timer = setTimeout(() => setRefresh((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [detail?.resource.id, detail?.resource.title]);
  async function refreshMe() {
    const m = await api<Me>("/me");
    setMe(m);
    setBootstrap((b) => (b ? { ...b, user: m.user } : b));
  }
  useEffect(() => {
    setCurrentUserId(bootstrap?.user?.id ?? null);
  }, [bootstrap?.user?.id]);
  useEffect(() => {
    if (!bootstrap?.user) {
      setMe(null);
      return;
    }
    void refreshMe().catch((e) => setError(e.message));
  }, [bootstrap?.user?.id, accountPage]);
  useEffect(() => {
    if (!bootstrap?.user) return;
    return realtime.retain();
  }, [bootstrap?.user?.id]);
  useEffect(
    () =>
      realtime.subscribe((m) => {
        if (m.type === "policy.changed") setRefresh((n) => n + 1);
        if (m.metadata && m.room) {
          const { lastEditorName, lastEditedAt, ...metadata } = m.metadata;
          setDetail((d) =>
            d && d.resource.id === m.room
              ? {
                  ...d,
                  lastEditorName,
                  lastEditedAt,
                  resource: { ...d.resource, ...metadata },
                }
              : d,
          );
        }
      }),
    [],
  );
  useEffect(() => {
    if (mobileShell) document.documentElement.dataset.editorShell = "mobile";
    else delete document.documentElement.dataset.editorShell;
    return () => {
      delete document.documentElement.dataset.editorShell;
    };
  }, [mobileShell]);
  useEffect(() => {
    if (!mobileShell) return;
    postMobileEditor({
      type: "document",
      title: currentDetail?.resource.title ?? "",
      format: currentDetail?.resource.format,
    });
  }, [mobileShell, currentDetail?.resource.title, currentDetail?.resource.format]);
  useEffect(() => {
    document.documentElement.dataset.theme = me?.preferences.theme ?? "light";
    document.documentElement.dataset.density =
      me?.preferences.density ?? "comfortable";
  }, [me?.preferences]);
  useEffect(() => {
    if (!bootstrap) return;
    void reloadLocale(bootstrap.defaultLocale, !!bootstrap.user);
    window.dispatchEvent(new Event("doca-discovery-policy"));
  }, [bootstrap?.user?.id, bootstrap?.defaultLocale, reloadLocale]);
  useEffect(() => {
    if (bootstrap?.siteName)
      document.title = t("app.documentTitle", { site: bootstrap.siteName });
  }, [bootstrap?.siteName, t]);
  useEffect(() => {
    if (!bootstrap?.user) return;
    const beat = () => {
      if (document.visibilityState === "visible")
        void api("/me/heartbeat", "POST").catch(() => {});
    };
    beat();
    const timer = setInterval(beat, 60000);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [bootstrap?.user?.id]);
  useEffect(() => {
    if (resourceId && bootstrap?.user)
      void api(`/resources/${resourceId}/visit`, "POST").catch(() => {});
  }, [resourceId, bootstrap?.user?.id]);
  useEffect(() => {
    setLibraryInfo((previous) =>
      previous?.id === containingLibraryId ? previous : null,
    );
    if (!containingLibraryId) return;
    const c = new AbortController();
    void api<Detail>(
      `/resources/${containingLibraryId}`,
      "GET",
      undefined,
      c.signal,
    )
      .then((d) => {
        if (!c.signal.aborted)
          setLibraryInfo(roleRank(d.resource.role) >= 1 ? d.resource : null);
      })
      .catch(() => {});
    return () => c.abort();
  }, [containingLibraryId, refresh]);
  const reload = async () => {
    setRefresh((n) => n + 1);
  };
  const signedIn = !!bootstrap?.user;
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (!signedIn) return;
      if (document.documentElement.dataset.editorShell === "mobile") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal("search");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [signedIn]);
  useEffect(() => {
    const load = () =>
      void api<Bootstrap>("/bootstrap")
        .then((b) => {
          setBootstrap(b);
        })
        .catch((e) => setFatal(e.message));
    const changed = () => {
      setHash(location.hash);
      setNavigationOpen(false);
      setModal("");
      const route = location.hash.slice(2).split(/[/?]/)[0]!;
      if (route === "knowledge") {
        location.hash = "/libraries";
        setScope("libraries");
      } else if (titleKeys[route]) setScope(route);
      else if (pluginNavigationByScope.has(route)) setScope(route);
      else
      setError("");
    };
    load();
    window.addEventListener("hashchange", changed);
    window.addEventListener("session-expired", load);
    window.addEventListener("profile-required", load);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("session-expired", load);
      window.removeEventListener("profile-required", load);
    };
  }, []);
  useEffect(() => {
    if (!resourceId) setDetail(null);
    if (!resourceId) return;
    const controller = new AbortController();
    if (detail?.resource.id !== resourceId) setLoading(true);
    void api<Detail>(
      `/resources/${resourceId}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(async (d) => {
        if (targetComment && /^[a-f0-9-]{36}$/.test(targetComment)) {
          try {
            const context = await api<{ items: Detail["comments"] }>(
              `/resources/${resourceId}/comments?target=${targetComment}`,
              "GET",
              undefined,
              controller.signal,
            );
            d.comments = [
              ...new Map(
                [...d.comments, ...context.items].map((c) => [c.id, c]),
              ).values(),
            ];
          } catch (e) {
            if (!controller.signal.aborted)
              setError("目标评论不存在或已不可访问");
          }
        }
        const libId =
          d.resource.kind === "library" ? d.resource.id : d.resource.library_id;
        let lib = d.resource.kind === "library" ? d.resource : null;
        if (libId && !lib) {
          try {
            lib = (
              await api<Detail>(
                `/resources/${libId}`,
                "GET",
                undefined,
                controller.signal,
              )
            ).resource;
          } catch {}
        }
        if (!controller.signal.aborted) {
          setLibraryInfo(lib);
          setDetail(d);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.name !== "AbortError") {
          if ([401, 403, 404].includes(e.status)) setDetail(null);
          else
            setDetail((previous) =>
              previous?.resource.id === resourceId ? previous : null,
            );
          setError(
            e.status && e.status >= 500 ? "服务暂时不可用，已保留当前文档" : "",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resourceId, refresh, bootstrap?.user?.id, targetComment]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorText(e, t("common.failed")));
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: string, path = `/${next}`) {
    location.hash = path;
    setScope(next);
  }
  function create(kind: "document" | "library", parent?: Resource) {
    setCreation({
      kind,
      parentId: parent?.kind === "document" ? parent.id : null,
      libraryId:
        parent?.kind === "library" ? parent.id : (parent?.library_id ?? null),
    });
    if (kind === "document")
      setCreateAnchor(
        (document.activeElement as HTMLElement)?.getBoundingClientRect() ??
          new DOMRect(220, 80, 0, 0),
      );
    else setModal("create");
  }
  async function prepareMove() {
    await act(async () => {
      const rows: Resource[] = [];
      let cursor: string | undefined;
      do {
        const p: Page = await api<Page>(
          `/resources?scope=all${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        rows.push(
          ...p.items.filter(
            (x) =>
              roleRank(x.role) >= 4 &&
              (x.kind === "library" ||
                (x.kind === "document" && !!x.library_id)),
          ),
        );
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      setTargets(rows);
      setModal("move");
    });
  }
  const pluginRoutePath = hash.replace(/^#/, "").split("?")[0] || "/home";
  const matchedPluginRoute = webPluginRegistry.resolveRoute(pluginRoutePath);
  const pluginRoute =
    matchedPluginRoute &&
    activePluginIds.has(matchedPluginRoute.contribution.pluginId)
      ? matchedPluginRoute
      : undefined;
  const unavailablePluginRoute =
    !!matchedPluginRoute && !pluginRoute;
  const renderedPluginRoute = pluginRoute?.contribution.render(
      {
        sharedFolderName,
        onFileNavigationChange: setFileTrail,
      },
      pluginRoute.match,
    );
  if (fatal)
    return (
      <main className="auth">
        <div className="auth-card">
          <h1>{t("shell.offline")}</h1>
          <p role="alert">{fatal}</p>
          <button onClick={() => location.reload()}>{t("shell.retry")}</button>
        </div>
      </main>
    );
  if (!bootstrap) return <main className="auth">{t("shell.connecting")}</main>;
  if (hash.startsWith("#/m/auth")) return <MobileTicketRedeem />;
  if (ticketsPage && !bootstrap.user)
    return (
      <main>
        <Tickets ticketId={ticketId} />
      </main>
    );
  if (hash === "#/auth/complete")
    return (
      <AuthCompletion
        done={async (status) => {
          setBootstrap(await api("/bootstrap"));
          const token = rememberedShareToken();
          location.hash = ["linked", "security_verified"].includes(status)
            ? "/account"
            : token
              ? "/s/" + token
              : "/home";
        }}
      />
    );
  if (hash === "#/auth/error")
    return (
      <main className="auth">
        <section className="auth-card">
          <h2>{t("shell.authFailed")}</h2>
          <p>
            {t("shell.authFailedBody")}
          </p>
          <BackLink fallback={bootstrap.user ? "/account" : "/home"}>
            {bootstrap.user ? t("shell.backProfile") : t("shell.backLogin")}
          </BackLink>
        </section>
      </main>
    );
  const publicBotId = new URLSearchParams(hash.split("?")[1]).get("bot");
  const embeddedKnowledgeBot = /^\/knowledge\/embed\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
  if(embeddedKnowledgeBot)return <KnowledgePublicPage botId={embeddedKnowledgeBot} channel="embed" authenticated={!!bootstrap.user}/>;
  if(!bootstrap.user&&scope==="knowledge-assistants"&&publicBotId&&/^[a-f0-9-]{36}$/.test(publicBotId))return <KnowledgePublicPage botId={publicBotId}/>;
  if (!bootstrap.user && !resourceId)
    return (
      <Login
        bootstrap={bootstrap}
        logged={async () => {
          setBootstrap(await api("/bootstrap"));
          const token = rememberedShareToken();
          location.hash = token ? "/s/" + token : "/home";
        }}
      />
    );
  if (shareInvitation)
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="share-invitation-title">
          <h1 id="share-invitation-title">{t("shell.inviteTitle")}</h1>
          <p>
            {t("shell.inviteBody", {
              kind: shareInvitation.kind === "assistant" ? t("nav.libraryQa") : shareInvitation.kind === "library" ? t("shell.inviteKind.library") : t("shell.inviteKind.document"),
              title: shareInvitation.title,
              role: shareInvitation.role,
            })}
          </p>
          <p className="subtle">
            {t("shell.inviteHint")}
          </p>
          <div className="auth-actions">
            <button
              className="primary"
              onClick={() => {
                const token = rememberedShareToken();
                if (!token) {
                  setError(t("shell.inviteExpired"));
                  return;
                }
                void api<{ id: string; kind?: string }>("/share/redeem", "POST", {
                  token,
                  accept: true,
                })
                  .then((r) => {
                    setShareInvitation(null);
                    try { sessionStorage.removeItem("doca.pending-share-token"); } catch {}
                    location.hash = r.kind === "assistant" ? "/knowledge-assistants?bot=" + r.id : "/r/" + r.id;
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              {t("shell.inviteAccept")}
            </button>
            <button
              onClick={() => {
                setShareInvitation(null);
                try { sessionStorage.removeItem("doca.pending-share-token"); } catch {}
                location.hash = "/home";
              }}
            >
              {t("shell.inviteLater")}
            </button>
          </div>
          <Feedback message={error} tone="error" />
        </section>
      </main>
    );
  if (
    bootstrap.user &&
    bootstrap.needsProfile &&
    (!adminPage || !!bootstrap.forcedLoginMethod)
  )
    return (
      <AccountOnboarding
        done={async () => {
          setBootstrap(await api("/bootstrap"));
          await reload();
        }}
      />
    );
  const user = bootstrap.user;

  const displayName = user?.display_name || user?.public_id || user?.id || "用户";
  if (user && (adminPage || accountPage || preferencesPage))
    return (
      <div className={`settings-shell ${adminPage && adminNavigationCollapsed ? "admin-navigation-collapsed" : ""}`}>
        <header className="settings-shell-header">
          {adminPage && <button className="icon" title={adminNavigationCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} aria-label={adminNavigationCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} aria-expanded={!adminNavigationCollapsed} onClick={() => setAdminNavigationCollapsed(!adminNavigationCollapsed)}><PanelLeft size={19} /></button>}
          <BackLink fallback="/home" className="settings-back">
            <ArrowLeft size={18} /> {t("account.workspace")}
          </BackLink>
          <div className="global-header-tools">
          <TodoIcon />
          <Notifications />
          <LocaleSwitch />
          <AccountMenu
            showWorkspaceLink
            refresh={refreshMe}
            user={user}
            me={me}
            onError={setError}
            logout={() => void api("/auth/logout", "POST")
              .then(() => {
                setBootstrap({ ...bootstrap, user: null });
                setMe(null);
                location.hash = "/home";
              })
              .catch((e) => setError(e.message))}
          />
          </div>
        </header>
        {error && <Feedback message={error} tone="error" />}
        {adminPage ? (
          user.admin ? (
            <Admin activePluginIds={activePluginIds} />
          ) : (
            <section className="empty">
              {t("shell.adminOnly")}<a href="#/home">{t("shell.homeLink")}</a>
            </section>
          )
        ) : (
          <div className="personal-settings-layout">
            <aside className="personal-settings-nav">
              <div className="settings-identity">
                <Avatar
                  name={displayName}
                  avatar={me?.preferences.avatar}
                  assetId={me?.preferences.avatar_asset_id}
                />
                <strong>{displayName}</strong>
                <small>{t("shell.yourAccount")}</small>
              </div>
              <a className={accountPage ? "active" : ""} href="#/account">
                <UserRound size={18} />
                {t("shell.profileSecurity")}
              </a>
              <a
                className={preferencesPage ? "active" : ""}
                href="#/preferences"
              >
                <Settings size={18} />
                {t("settings.appearance")}
              </a>
              <p>{t("shell.settingsHint")}</p>
            </aside>
            <main className="personal-settings-content">
              {me ? (
                accountPage ? (
                  <Profile
                    me={me}
                    saved={refreshMe}
                    passwordForm={
                      <Account
                        user={user}
                        logout={() =>
                          setBootstrap({ ...bootstrap, user: null })
                        }
                      />
                    }
                  />
                ) : (
                  <PersonalSettings me={me} saved={refreshMe} />
                )
              ) : (
                <p className="empty">{t("shell.loadingSettings")}</p>
              )}
            </main>
          </div>
        )}
      </div>
    );
  return (
    <DocumentModeContext.Provider value={documentMode}>
    <AIProvider userId={user?.id} resource={detail?.resource} hash={hash} onResourcesChanged={() => setRefresh((n) => n + 1)}>
    <div
      className={`app-shell ${mobileShell ? "mobile-editor-shell" : ""} ${(!user && !currentLibraryId) || sharedPersonalView ? "public-view" : ""} ${personalDocumentPage ? "personal-document-view" : ""} ${resourceId ? "document-view" : ""} ${["spreadsheet", "canvas", "presentation"].includes(detail?.resource.format ?? "") ? "spreadsheet-view surface-view" : ""} ${navigationOpen ? "navigation-expanded" : ""} ${navigationCollapsed ? "navigation-collapsed" : ""}`}
    >
      {(user || currentLibraryId) && !sharedPersonalView && !personalDocumentPage && !mobileShell && (
        <aside
          className={`sidebar ${currentLibraryId ? "library-sidebar" : ""}`}
        >
          <div className="library-brand-row">
            {currentLibraryId ? (
              user ? (
              <BackLink
                fallback="/libraries"
                className="brand"
                title={libraryTitle}
              >
                <span className="library-back-arrow">
                  <ArrowLeft size={20} />
                </span>
                <span title={libraryTitle}>{libraryTitle}</span>
              </BackLink>
              ) : (
              <a href={`#/r/${currentLibraryId}`} className="brand" title={libraryTitle}>
                <span title={libraryTitle}>{libraryTitle}</span>
              </a>
              )
            ) : (
              <a
                href="#/home"
                className="brand"
                title={bootstrap.siteName}
              >
                <span className="brand-symbol"><BookOpen size={22} /></span>
                <span title={bootstrap.siteName}>{bootstrap.siteName}</span>
              </a>
            )}
            {user && currentLibraryId && (
              <LibraryFavorite key={currentLibraryId} id={currentLibraryId} />
            )}
            <button
              className="icon navigation-toggle sidebar-navigation-toggle"
              title={desktopNavigation || navigationOpen ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
              aria-label={desktopNavigation || navigationOpen ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
              aria-expanded={desktopNavigation ? !navigationCollapsed : navigationOpen}
              onClick={() => desktopNavigation ? setNavigationCollapsed(true) : setNavigationOpen(!navigationOpen)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          {user && <button className="sidebar-search" onClick={() => setModal("search")}>
            <Search size={17} />
            <span>{t("common.search")}</span>
            <kbd>⌘ K</kbd>
          </button>}
          {currentLibraryId && canManageLibrary && (
            <nav>
              <a
                className={librarySettingsPage ? "active" : ""}
                href={librarySettingsUrl(currentLibraryId)}
              >
                <Settings size={18} />
                {t("nav.librarySettings")}
              </a>
              <a
                className={librarySystemPage ? "active" : ""}
                href={librarySystemUrl(currentLibraryId)}
              >
                <BookOpenCheck size={18} />
                {t("nav.librarySystem")}
              </a>

            </nav>
          )}
          {user && !currentLibraryId && (
            <nav>
              <button
                type="button"
                className="sidebar-create-entry"
                title={t("nav.create")}
                aria-label={t("nav.create")}
                aria-haspopup="dialog"
                onClick={() => create("document")}
              >
                <span className="sidebar-create-plus" aria-hidden="true">
                  <Plus size={16} strokeWidth={2.6} />
                </span>
                <span className="sidebar-create-label">{t("nav.create")}</span>
              </button>
              <PinnedDocuments refresh={refresh} />
              {([
                ...pluginNavigation
                  .filter((item) => activePluginIds.has(item.pluginId))
                  .map((item) => ({
                  key: item.scope,
                  label: item.labelKey,
                  plugin: true as const,
                  Icon: item.icon ?? Home,
                  order: item.order ?? 0,
                  path: item.path,
                })),

                { key: "home", label: "workspace.home", plugin: false as const, Icon: Home, order: 10, path: "/home" },
                { key: "discover", label: "workspace.publicResources", plugin: false as const, Icon: Search, order: 75, path: "/discover" },
                { key: "ai", label: "nav.assistant", plugin: false as const, Icon: Sparkles, order: 20, path: "/ai" },
                { key: "notes", label: "nav.notes", plugin: false as const, Icon: Feather, order: 70, path: "/notes" },
                { key: "trash", label: "nav.trash", plugin: false as const, Icon: Trash2, order: 80, path: "/trash" },
              ])
                .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
                .map(({ key, label, plugin, Icon, path }) => {
                  const I = Icon as typeof Home;
                  return (
                    <button
                      key={key}
                      className={`${key === "ai" ? "ai-navigation-entry" : ""} ${key === "trash" ? "sidebar-trash-navigation-entry" : ""} ${!resourceId && scope === key ? "active" : ""}`}
                      onClick={() => {
                        navigate(key, path);
                        if (key === "notes") window.dispatchEvent(new CustomEvent("doca-notes-float-attention"));
                      }}
                    >
                      <I size={16} />
                      {plugin
                        ? pluginMessage(locale, label)
                        : t(label as MessageKey)}
                    </button>
                  );
                })}
            </nav>
          )}
          {currentLibraryId && <div className="sidebar-tree-heading">
            <button
              onClick={() => { location.hash = "/r/" + currentLibraryId; }}
            >
              {t("nav.contents")}
            </button>
            {libraryInfo && roleRank(libraryInfo.role) >= 3 && <button
              className="icon"
              aria-label={t("nav.newLibraryDocument")}
              onClick={() => create("document", libraryInfo)}
            >
              <Plus size={17} />
            </button>}
          </div>}
          {currentLibraryId && <DocumentTree
            key={(user?.id ?? "anonymous") + ":" + currentLibraryId}
            refresh={refresh}
            userId={user?.id ?? "anonymous"}
            selected={resourceId}
            libraryId={currentLibraryId}
            knowledgeEnabled={!!libraryInfo?.ai_curated && roleRank(libraryInfo.role) >= 4}
            accountActions={!!user}
            create={(r) => create("document", r)}
            changed={() => setRefresh((n) => n + 1)}
          />}
        </aside>
      )}
      <main className="workspace">
        <header className={`topbar ${documentHeader ? "" : "workspace-topbar"}`}>
          <div className="document-topbar-title">
            {(user || currentLibraryId) && desktopNavigation && navigationCollapsed && (
              <button
                className="icon navigation-toggle"
                title={(desktopNavigation ? !navigationCollapsed : navigationOpen) ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
                aria-label={(desktopNavigation ? !navigationCollapsed : navigationOpen) ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
                aria-expanded={desktopNavigation ? !navigationCollapsed : navigationOpen}
                onClick={() => desktopNavigation ? setNavigationCollapsed(!navigationCollapsed) : setNavigationOpen(!navigationOpen)}
              >
                <PanelLeft size={19} />
              </button>
            )}
            {personalDocumentPage && (
              <BackLink
                fallback="/documents"
                className="icon document-back-button"
                aria-label={t("workspace.backDocuments")}
                title={t("workspace.backDocuments")}
              >
                <ArrowLeft size={19} />
              </BackLink>
            )}
            {(librarySystemPage || libraryQaPage || (!resourceId && scope === "knowledge-assistants")) && <div className="files-topbar-title knowledge-topbar-title">{librarySystemPage ? <BookOpenCheck size={20}/> : <Bot size={20}/>}<h1>{t(librarySystemPage ? "nav.librarySystem" : "knowledge.assistants")}</h1>{librarySystemPage && detail && <KnowledgeCurationToggle detail={detail} changed={reload}/>}</div>}
            {!resourceId && scope === "ai" && <div id="ai-header-slot" />}

            {!resourceId && scope === "notes" && user && (
              <div className="files-topbar-title">
                <Feather size={17} aria-hidden="true" />
                <strong>{t("nav.notes")}</strong>
                <span id="notes-header-slot" />
              </div>
            )}
            {!resourceId && (scope === "files" || scope === "shared-files") && user && (
              <div className="files-topbar-title">
                {scope === "shared-files" ? <Users size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
                <strong>{scope === "shared-files" ? (sharedFolderId ? sharedFolderName : t("nav.sharedFiles")) : t("nav.files")}</strong>
                {(scope === "files" || sharedFolderId) && <><span className="files-topbar-separator">/</span>
                <nav aria-label={t("nav.folderPath")}>
                  {fileTrail.slice(sharedFolderId ? 1 : 0).map((item, index) => {
                    const label = item.type === "system" && item.id === "root" ? t("nav.files") : item.name;
                    return (
                    <span key={`${item.type}:${item.id}`}>
                      {index > 0 && <span className="files-topbar-chevron">/</span>}
                      <button type="button" title={label} onClick={() => openFileTrail(index + (sharedFolderId ? 1 : 0))}>
                        {label.length > 18 ? `…${label.slice(-17)}` : label}
                      </button>
                    </span>
                    );
                  })}
                </nav></>}
              </div>
            )}
            {documentHeader && <div className="document-title-lines">
              <div className="document-name-line">
                <div
                  className="document-name-value"
                  key="document-title"
                  data-resource-title={resourceId ?? scope}
                >
                  {detail &&
                  detail.resource.id === resourceId &&
                  ["spreadsheet", "canvas", "presentation"].includes(
                    detail.resource.format,
                  ) &&
                  roleRank(detail.resource.role) >= 3 && !documentMode.readOnly ? (
                    <DocumentName
                      key={resourceId}
                      resource={detail.resource}
                      changed={() => setRefresh((n) => n + 1)}
                    />
                  ) : (
                    <strong title={headerTitle}>{headerTitle}</strong>
                  )}
                </div>
                {resourceId &&
                  detail &&
                  detail.resource.kind === "document" &&
                  detail.resource.id === resourceId &&
                  user && (
                    <DocumentReactionButtons
                      resource={{
                        ...detail.resource,
                        favorite: detail.favorite,
                        pinned: detail.pinned,
                      }}
                      size={18}
                      onChange={(patch) =>
                        setDetail((current) =>
                          current?.resource.id === resourceId ? { ...current, ...patch } : current,
                        )
                      }
                      onError={setError}
                    />
                  )}
                {resourceId && detail?.resource.id === resourceId &&
                  detail.resource.kind === "document" && (
                    <LastEdited key={resourceId} detail={detail} currentUserId={user?.id} />
                  )}
              </div>
              {librarySettingsPage &&
                currentDetail?.resource.kind === "library" && (
                  <span className="library-settings-owner">
                    {currentDetail.resource.title}
                    {currentDetail.resource.owner_id && (
                      <>
                        {" "}
                        · {t("shell.owner")}{" "}
                        <UserBadge
                          id={currentDetail.resource.owner_id}
                          name={currentDetail.ownerName}
                        />
                      </>
                    )}
                  </span>
                )}
            </div>}
          </div>
          <div className="inline document-topbar-actions">

            {!resourceId && scope === "shared-files" && sharedFolderId && <span id="files-header-actions" />}
            {resourceId &&
              detail?.resource.id === resourceId &&
              detail.resource.kind === "document" && (
                <DocumentPeople key={`people:${resourceId}`} id={resourceId} />
              )}
            {resourceId && <span id="document-search-slot" />}
            {resourceId &&
              detail &&
              detail.resource.kind === "document" &&
              detail.resource.id === resourceId && (
                <>
                  {
                    <div className="resource-actions">
                      <button
                        className="primary share-button"
                        data-permissions-trigger
                        onClick={() =>
                          setModal(modal === "permissions" ? "" : "permissions")
                        }
                      >
                        <ShieldCheck size={16} />
                        {t("shell.share")}
                      </button>
                      <DocumentModeSwitch />
                      {user && (
                        <DocumentMore
                          entryChanged={async () => {
                            await reload();
                          }}
                          detail={detail}
                          move={() => void prepareMove()}
                          transfer={() => setModal("transfer")}
                          remove={() => setModal("trash")}
                        />
                      )}
                    </div>
                  }
                </>
              )}
            {user ? (
              <div className="global-header-tools">
                {scope === "knowledge-assistants" && <span id="knowledge-share-slot" />}
                <TodoIcon />
                <Notifications />
                <LocaleSwitch />
                <AccountMenu
                  refresh={refreshMe}
                  user={user}
                  me={me}
                  onError={setError}
                  logout={() => void api("/auth/logout", "POST")
                    .then(() => {
                      setBootstrap({ ...bootstrap, user: null });
                      setMe(null);
                      location.hash = "/home";
                    })
                    .catch((e) => setError(e.message))}
                />
              </div>
            ) : (
              <a href="#/home">{t("shell.signIn")}</a>
            )}
          </div>
        </header>
        <AIDocumentLayout
          disabled={librarySystemPage || libraryQaPage || scope === "knowledge-assistants"}
          format={detail?.resource.kind === "document" ? detail.resource.format : undefined}
          surface={
            !resourceId && user && (scope === "files" || (scope === "shared-files" && !!sharedFolderId))
              ? "files"
              : undefined
          }
        >
        {resourceId && <div id="editor-toolbar-slot" hidden={documentMode.readOnly} />}
        {error && <Feedback message={error} tone="error" />}
        <div
          className={
            "main-scroll" +
            (!resourceId && scope === "home" ? " workspace-home-scroll" : !resourceId && scope !== "trash" ? " dashboard-scroll-host" : "")
          }
        >
          {user && <SubscribeLibraryHost />}

          {!resourceId && user && unavailablePluginRoute ? (
            <section className="empty">
              <p>{t("shell.pluginUnavailable")}</p>
              <a href="#/home">{t("shell.homeLink")}</a>
            </section>
          ) : !resourceId &&
            user &&
            pluginRoute &&
            renderedPluginRoute !== undefined ? (
            renderedPluginRoute
          ) : !resourceId && scope === "home" && user ? (
            <WorkspaceHome name={user.display_name} />
          ) : !resourceId && (scope === "discover" || scope === "collected") && user ? (
            <DiscoveryPage key={scope + hash} collected={scope === "collected"} />
          ) : !resourceId && scope === "knowledge-assistants" && user ? (
            <KnowledgeAssistants />
          ) : !resourceId && scope === "ai" ? (
            <AIChat full />
          ) : !resourceId && scope === "notes" && user ? (
            <Suspense fallback={<p className="empty">{t("shell.loadingNotes")}</p>}><QuickNotes key={user.id} userId={user.id} changed={() => setRefresh(n => n + 1)} /></Suspense>
          ) : ticketsPage ? (
            <Tickets ticketId={ticketId} />
          ) : resourceId ? (
            loading ? (
              <div className="empty">{t("nav.opening")}</div>
            ) : detail ? (
              <>
                {detail.resource.kind === "library" ? (
                  librarySettingsPage ? (
                    <LibrarySettings detail={detail} changed={reload} />
                  ) : librarySystemPage ? (
                    <LibrarySystemPage detail={detail} changed={reload} />
                  ) : libraryQaPage ? (
                    <LibraryQaPage detail={detail} changed={reload} />
                  ) : (
                    <LibraryLanding
                      resource={detail.resource}
                      create={() => create("document", detail.resource)}
                    />
                  )
                ) : (
                  <Suspense fallback={<p className="empty">{t("shell.loadingEditor")}</p>}>
                    <DocumentEditor
                      detail={detail}
                      targetComment={targetComment}
                      loadMoreComments={loadMoreComments}
                      user={user}
                      changed={() => setRefresh((n) => n + 1)}
                    />
                  </Suspense>
                )}

                {detail.resource.kind === "document" &&
                  !["spreadsheet", "canvas", "presentation"].includes(
                    detail.resource.format,
                  ) && (
                    <Comments
                      key={detail.resource.id}
                      targetComment={targetComment}
                      loadMoreComments={loadMoreComments}
                      detail={{
                        ...detail,
                        comments: detail.comments.filter(
                          (c) =>
                            !c.anchor &&
                            !detail.comments.some(
                              (root) => root.anchor && root.id === c.parent_id,
                            ),
                        ),
                      }}
                      user={user}
                      act={act}
                      busy={busy}
                    />
                  )}
              </>
            ) : (
              <AccessGate key={resourceId} id={resourceId} user={!!user} />
            )
          ) : (
            <Dashboard key={scope}
              section={scope}
              currentUserId={user?.id}
              refresh={refresh}
              preferences={me?.preferences}
              create={create}
              changed={() => setRefresh((n) => n + 1)}
            />
          )}
        </div>
        </AIDocumentLayout>
      </main>
      {createAnchor && (
        <CreatePopover
          rect={createAnchor}
          close={() => setCreateAnchor(null)}
          busy={busy}
          progress={importProgress}
          choose={(format, file) => {
            if (!file) {
              setCreateAnchor(null);
              setTemplateFormat(format);
              return;
            }
            void act(async () => {
              setImportProgress({ phase: "parsing", message: t("shell.preparingImport") });
              const input = {
                ...creation,
                title:
                  file.name.replace(/\.(canvas\.)?[^.]+$/, "").slice(0, 200) ||
                  t("shell.untitled"),
                format,
              };
              const r = await createImportedDocument(input, file, (next) =>
                setImportProgress(next),
              );
              setCreateAnchor(null);
              location.hash = "/r/" + r.id;
            });
          }}
        />
      )}
      {templateFormat && (
        <TemplatePicker
          format={templateFormat}
          parentId={creation.parentId}
          libraryId={creation.libraryId}
          close={() => setTemplateFormat(null)}
          created={(id) => {
            setTemplateFormat(null);
            setRefresh((n) => n + 1);
            location.hash = "/r/" + id;
          }}
        />
      )}
      {user && modal === "search" && (
        <GlobalSearch
          close={() => { setModal(""); setSearchSeed(""); }}
          initialQuery={searchSeed}
          initialLibraryIds={currentLibraryId ? [currentLibraryId] : []}
        />
      )}
      {modal === "cover" && detail && (
        <CoverDialog
          resource={detail.resource}
          close={() => setModal("")}
          saved={() => setRefresh((n) => n + 1)}
        />
      )}
      {modal === "trash" && detail && (
        <ResourceActionDialog
          resource={detail.resource}
          action="trash"
          close={() => setModal("")}
          saved={() => {
            setRefresh((n) => n + 1);
          }}
        />
      )}
      {(modal === "create" || modal === "rename") && (
        <Dialog
          title={
            modal === "rename"
              ? t("shell.rename")
              : creation.kind === "library"
                ? t("shell.createLibrary")
                : t("shell.createDocument")
          }
          close={() => setModal("")}
          className="modal-compact"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void act(async () => {
                if (modal === "rename" && detail) {
                  await api(`/resources/${detail.resource.id}`, "PATCH", {
                    title: data.get("title"),
                    version: detail.resource.version,
                  });
                } else {
                  const r = await api<Resource>("/resources", "POST", {
                    ...creation,
                    title: data.get("title"),
                    format: data.get("format") ?? "rich_text",
                  });
                  location.hash = `/r/${r.id}`;
                }
                setModal("");
              });
            }}
          >
            <label>
              {t("shell.name")}
              <input
                name="title"
                required
                autoFocus
                maxLength={160}
                defaultValue={modal === "rename" ? detail?.resource.title : ""}
                placeholder={t("shell.namePlaceholder")}
              />
            </label>
            {modal === "create" && creation.kind === "document" && (
              <label>
                {t("shell.docType")}
                <Select name="format">
                  <option value="rich_text">{t("shell.type.rich")}</option>
                  <option value="spreadsheet">{t("shell.type.sheet")}</option>
                  <option value="markdown">Markdown</option>
                  <option value="canvas">{t("shell.type.canvas")}</option>
                  <option value="presentation">{t("shell.type.slides")}</option>
                </Select>
              </label>
            )}
            <p className="subtle">
              {creation.parentId || creation.libraryId
                ? t("shell.inheritAccess")
                : t("shell.privateAccess")}
            </p>
            {error && <Feedback message={error} tone="error" />}
            <footer>
              <button type="button" onClick={() => setModal("")}>
                {t("common.cancel")}
              </button>
              <button className="primary" disabled={busy}>
                {t("common.confirm")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {modal === "permissions" && detail && (
        <PermissionDialog
          authenticated={!!user}
          detail={detail}
          close={() => setModal("")}
          saved={reload}
        />
      )}{" "}
      {modal === "transfer" && detail && (
        <TransferDialog
          resource={detail.resource}
          close={() => setModal("")}
          saved={async () => {
            navigate("home");
            await reload();
          }}
        />
      )}
      {modal === "move" && detail && (
        <MoveDialog
          resource={detail.resource}
          targets={targets}
          close={() => setModal("")}
          saved={reload}
        />
      )}
      {user && !mobileShell && (
        <Suspense fallback={null}>
          <QuickNotesFloat userId={user.id} />
        </Suspense>
      )}
    </div>
    </AIProvider>
    </DocumentModeContext.Provider>
  );
}
function Login({
  bootstrap,
  logged,
}: {
  bootstrap: Bootstrap;
  logged: () => Promise<void>;
}) {
  return <AccountLogin bootstrap={bootstrap} logged={logged} />;
}
function Comments({
  detail,
  user,
  act,
  busy,
  targetComment,
  loadMoreComments,
}: {
  detail: Detail;
  user: User | null;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(10);
  useEffect(() => {
    const index = detail.comments.findIndex((c) => c.id === targetComment);
    if (index < 0) return;
    setVisibleCount((n) => Math.max(n, index + 1));
    const t = setTimeout(
      () =>
        document
          .getElementById(`comment-${targetComment}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      100,
    );
    return () => clearTimeout(t);
  }, [targetComment, detail.comments.length]);
  const r = detail.resource,
    rank = roleRank(r.role);
  return (
    <section className="discussion">
      <DocumentReferences id={r.id} />
      <div className="like-area">
        <button
          className={detail.liked ? "liked" : ""}
          disabled={!user || busy}
          aria-label={detail.liked ? t("shell.unlike") : t("shell.like")}
          onClick={() =>
            void act(() =>
              api(`/resources/${r.id}/reaction`, "PUT", {
                kind: "like",
                enabled: !detail.liked,
              }),
            )
          }
        >
          <ThumbsUp size={26} />
        </button>
        <p>
          {detail.likes
            ? t("shell.likes", { count: detail.likes })
            : t("shell.likePrompt")}
        </p>
        <LikePeople detail={detail} />
      </div>
      <h2>
        {t("shell.pageComments")}{" "}
        <small>{detail.comments.filter((c) => !c.deleted_at).length}</small>
      </h2>
      {detail.comments.slice(0, visibleCount).map((c) => (
        <article
          id={`comment-${c.id}`}
          className={`whole-comment ${c.parent_id ? "reply" : ""} ${targetComment === c.id ? "notification-target" : ""}`}
          key={c.id}
        >
          <CommentMessage
            comment={c}
            user={user}
            rank={rank}
            reply={
              !c.parent_id && !c.resolved
                ? () => {
                    setReply(c.id);
                    setEditing(null);
                  }
                : undefined
            }
            edit={() => {
              setEditing(c.id);
              setReply(null);
            }}
            act={(patch) => {
              void act(() =>
                api(`/resources/${r.id}/comments/${c.id}`, "PATCH", {
                  version: c.version,
                  ...patch,
                }),
              );
            }}
          />
          {editing === c.id && (
            <CommentComposer
              key={c.id}
              resourceId={r.id}
              autoFocus
              initial={parsedComment(c)}
              close={() => setEditing(null)}
              disabled={busy}
              submit={async (richBody) => {
                await api(`/resources/${r.id}/comments/${c.id}`, "PATCH", {
                  version: c.version,
                  richBody,
                });
                setEditing(null);
                await act(async () => {});
              }}
            />
          )}
          {reply === c.id && (
            <CommentComposer
              key={"reply" + c.id}
              autoFocus
              resourceId={r.id}
              replyTo={c}
              close={() => setReply(null)}
              disabled={busy}
              submit={async (richBody) => {
                await api(`/resources/${r.id}/comments`, "POST", {
                  richBody,
                  parentId: c.id,
                });
                setReply(null);
                await act(async () => {});
              }}
            />
          )}
        </article>
      ))}
      {visibleCount < detail.comments.length && (
        <button
          className="comments-load-more"
          onClick={() => setVisibleCount((n) => n + 10)}
        >
          {t("shell.moreComments")}
        </button>
      )}
      {visibleCount >= detail.comments.length &&
        detail.commentsNextCursor != null && (
          <button
            className="comments-load-more"
            disabled={busy}
            onClick={() => void loadMoreComments?.()}
          >
            {t("shell.laterComments")}
          </button>
        )}
      {user && rank >= 2 ? (
        <CommentComposer
          resourceId={r.id}
          disabled={busy}
          submit={async (richBody) => {
            await api(`/resources/${r.id}/comments`, "POST", {
              richBody,
              parentId: null,
            });
            await act(async () => {});
          }}
        />
      ) : (
        <p className="subtle">
          {user ? t("shell.readOnlyComment") : t("shell.signInToComment")}
        </p>
      )}
    </section>
  );
}
function Notifications() {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<{
      items: {
        id: string;
        type: string;
        ticket_id?: string | null;
        resource_id: string | null;
        read_at: string | null;
        created_at: string;
        actor_id: string | null;
        actorName: string | null;
        href?: string;
        description?: string;
        pluginId?: string;
        grantedPermission?: { role?: string; includeDescendants?: boolean };
        title: string;
        comment_id: string | null;
      }[];
      unread: number;
      nextOffset?: number | null;
    }>({ items: [], unread: 0 }),
    [error, setError] = useState("");
  async function load() {
    setData(await api("/notifications"));
  }
  useEffect(() => {
    const dismiss = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    void load().catch(() => {});
    const unsubscribe = realtime.subscribe((m) => {
      if (m.type === "notifications.changed" || m.type === "connected")
        void load().catch(() => {});
    });
    const timer = setInterval(() => { void load().catch(() => {}); }, 30000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  return (
    <div className="notifications" ref={panelRef}>
      <button
        className="icon notification-trigger"
        title={t("shell.notifications")}
        aria-label={`${t("shell.notifications")} ${t("shell.unread", { count: data.unread })}`}
        onClick={() => {
          setOpen(!open);
          void load().catch((e) => setError(e.message));
        }}
      >
        <Bell size={20} />
        {data.unread > 0 && (
          <b className="notification-count" aria-hidden="true">
            {data.unread > 99 ? "99+" : data.unread}
          </b>
        )}
      </button>
      {open && (
        <section className="notification-panel">
          <header className="notification-heading">
            <h3>{t("shell.notifications")}</h3>
            <button
              className="text-button"
              disabled={!data.unread}
              onClick={() =>
                void api("/notifications/read-all", "POST", {})
                  .then(load)
                  .catch((e) => setError(e.message))
              }
            >
              {t("shell.markRead")}
            </button>
          </header>
          {error && <Feedback message={error} tone="error" />}
          {!data.items.length && <p>{t("shell.noNotifications")}</p>}
          {data.items.map((n) => {
            const baseDescription = n.description ??
              (
                {
                  "comment.created": t("notify.comment.created"),
                  "comment.mentioned": t("notify.comment.mentioned"),
                  "document.mentioned": t("notify.document.mentioned"),
                  "favorite.added": t("notify.favorite.added"),
                  "like.added": t("notify.like.added"),
                  "resource.permissions_changed": t("notify.resource.permissions_changed"),
                  "resource.invited": t("notify.resource.invited"),
                  "access.requested": t("notify.access.requested"),
                  "access.approved": t("notify.access.approved"),
                  "access.rejected": t("notify.access.rejected"),
                  "invitation.accepted": t("notify.invitation.accepted"),
                  "invitation.rejected": t("notify.invitation.rejected"),
                  "resource.transferred": t("notify.resource.transferred"),
                  "ticket.updated": t("notify.ticket.updated"),
                  "ticket.reminded": t("notify.ticket.reminded"),
                  "access.cancelled": t("notify.access.cancelled"),
                  "invitation.cancelled": t("notify.invitation.cancelled"),
                } as Record<string, string>
              )[n.type] ?? t("notify.fallback");
            const grantedRole = n.grantedPermission?.role;
            const roleLabel = ({
              reader: t("role.reader"),
              commenter: t("role.commenter"),
              editor: t("role.editor"),
              manager: t("role.manager"),
            } as Record<string, string>)[grantedRole ?? ""] ?? grantedRole;
            const description = grantedRole ? `${baseDescription} · ${roleLabel}（${n.grantedPermission?.includeDescendants ? t("role.scope.descendants") : t("role.scope.node")}）` : baseDescription;
            const documentTitle = n.title || (n.ticket_id ? t("shell.ticket") : t("shell.unnamed"));
            const href = n.href ?? (n.ticket_id
              ? `#/tickets/${n.ticket_id}`
              : n.type === "resource.invited" || n.type.startsWith("access.")
                ? "#/tickets"
                : `#/r/${n.resource_id}${n.comment_id ? `?comment=${encodeURIComponent(n.comment_id)}` : ""}`);
            return (
              <div
                key={n.id}
                className={"notification-row" + (n.read_at ? "" : " unread")}
              >
                <div className="notification-person">
                  <span
                    title={`${n.actorName ?? t("shell.system")} ${description} · ${documentTitle}`}
                  >
                    <strong>{n.actorName ?? t("shell.system")}</strong> {description}
                    <span className="notification-document">
                      {documentTitle}
                    </span>
                  </span>
                </div>
                <small title={n.created_at}>{relativeTime(n.created_at)}</small>
                {(n.href || n.ticket_id || n.resource_id) && (
                  <a
                    href={href}
                    onClick={() => {
                      setOpen(false);
                      void api("/notifications/read", "POST", { ids: [n.id] })
                        .then(load)
                        .catch((e) => setError(e.message));
                      if (location.hash === href) {
                        window.dispatchEvent(new HashChangeEvent("hashchange"));
                        if (n.comment_id)
                          setTimeout(
                            () =>
                              document
                                .getElementById(`comment-${n.comment_id}`)
                                ?.scrollIntoView({
                                  block: "center",
                                  behavior: "smooth",
                                }),
                            100,
                          );
                      }
                    }}
                  >
                    {t("shell.view")}
                  </a>
                )}
              </div>
            );
          })}
          {data.nextOffset != null && (
            <button
              className="text-button"
              onClick={() => {
                void api<typeof data>(
                  "/notifications?offset=" + data.nextOffset,
                )
                  .then((page) =>
                    setData((v) => ({
                      ...page,
                      items: [...v.items, ...page.items],
                    })),
                  )
                  .catch((e) => setError(e.message));
              }}
            >
              {t("shell.olderNotifications")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
function Account({ user, logout }: { user: User; logout: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="password-section">
      <form
        className="settings-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          try {
            await api("/auth/password", "POST", {
              newPassword: f.get("new"),
            });
            logout();
            location.hash = "/mine";
          } catch (e) {
            setError(errorText(e, t("common.failed")));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{t("shell.changePassword")}</h2>
        <p className="subtle">{t("shell.changePasswordHint")}</p>

        <label>
          {t("shell.newPassword")}
          <input
            name="new"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        {error && <Feedback message={error} tone="error" />}
        <button className="primary" disabled={busy}>
          {t("shell.changePasswordSubmit")}
        </button>
      </form>
      <button
        onClick={() =>
          void api("/auth/logout", "POST")
            .then(() => {
              logout();
              location.hash = "/mine";
            })
            .catch((e) => setError(e.message))
        }
      >
        <LogOut size={16} />
        {t("account.signOut")}
      </button>
    </section>
  );
}
import { Tickets } from "@web/features/tickets/tickets.js";
