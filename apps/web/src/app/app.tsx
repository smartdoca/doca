import { BrowserClipperConnect } from "@web/features/browser-clipper/browser-clipper-connect.js";
import { BrowserClipperSettings } from "@web/features/browser-clipper/browser-clipper-settings.js";
import { McpSettings } from "@web/features/mcp/mcp-settings.js";
import { ResourceAccessTag } from "@web/features/documents/resource-access-tag.js";
import { TitleInput } from "@web/features/documents/title-input.js";
import { PluginSlot } from "@web/plugins/extensions.js";
import { PluginPageHeader } from "@web/plugins/page-header.js";
import { extensionViews } from "@web/plugins/extension-ui.js";
import { MobilePluginPage } from "@web/plugins/mobile-page.js";
import { NavigationArea, MoreNavigation, LeftNavigation, navigateToDefaultHome, useNavigationLayout } from "@web/plugins/navigation.js";
import { isAdminNavigationPath } from "@smartdoca/web-plugin-registry";
import { WorkspaceHome } from "@web/features/workspace/home.js";

import { pluginRouteScope } from "./plugin-route-scope.js";

import type { MessageKey } from "@doca/i18n";
import { AIProvider } from "@web/features/ai/ai-context.js";
import { publishNotificationUnread } from "@web/shared/notification-unread.js";
import { useI18n } from "@web/shared/i18n.js";
import { AIDocumentLayout } from "@web/features/ai/ai-document-layout.js";
import { LazyContent } from "@web/shared/components/lazy-content.js";
import "@web/features/account/account-menu.css";
import { AccountMenu } from "@web/features/account/account-menu.js";
import { LocaleSwitch } from "@web/features/account/locale-switch.js";
import { AccountLogin } from "@web/features/auth/account-login.js";
import { rememberLoginDocument, takeLoginDocument } from "@web/features/auth/login-return.js";
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
} from "@web/features/documents/access-tasks.js";
import { LibraryFavorite } from "@web/features/documents/library-favorite.js";
import { DocumentReferences } from "@web/features/documents/document-references.js";
import { PinnedDocuments } from "@web/features/workspace/pinned-nav.js";
import { DocumentReactionButtons } from "@web/features/documents/document-reactions.js";
import { LibrarySettings, LibraryLanding, LibrarySystemPage, librarySettingsUrl } from "@web/features/documents/library.js";
import {
  CommentComposer,
  CommentMessage,
  parsedComment,
  CommentPublicationStatus,
  type CommentPublication,
} from "@web/features/comments/rich-comments.js";
import { Select } from "@web/shared/components/select.js";
import { useCommentPages } from "@web/features/comments/use-comment-pages.js";
import { realtime } from "@web/features/documents/realtime.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { setCurrentUserId } from "@web/shared/components/user-mention.js";
import { lazy, Suspense, useEffect, useLayoutEffect, useState, useRef, useMemo, useSyncExternalStore } from "react";
import { loadBootstrap } from "@web/shared/bootstrap.js";
import { SiteLogo } from "@web/shared/components/site-logo.js";
import { documentFavicon } from "@web/shared/utils/document-favicon.js";
import { splitTitleIcon } from "@web/shared/utils/resource-title.js";
import { loadWebPlugins } from "@web/plugins/load.js";
import { cacheStartupDocument, clearDocumentStartupCache, documentStartupCacheKey, forgetStartupDocument, invalidateStartupIdentity, readDocumentStartup, readStartupAccount } from "@web/shared/document-startup-cache.js";
import { Plus, Search, Users, Settings, Bell, ShieldCheck, ThumbsUp, LogOut, FolderOpen, FolderSymlink, ArrowLeft, PanelLeft, LockKeyhole, UserRound, BookOpenCheck } from "lucide-react";
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
import { AuthCompletion } from "@web/features/auth/authentication.js";
import { DocumentTree } from "@web/features/documents/tree.js";
import { Dashboard, GlobalSearch } from "@web/features/workspace/dashboard.js";
import { Avatar, Profile, PersonalSettings } from "@web/features/account/profile.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import "@web/styles/globals.css";
import type { FileLocation } from "@web/features/files/files.js";
import { MobileTicketRedeem, postMobileEditor } from "@web/features/mobile/ticket-redeem.js";
import { SubscribeLibraryHost } from "@web/features/knowledge/subscribe-library.js";
import {
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
const Admin = lazy(() => import("@web/features/admin/admin.js").then((module) => ({ default: module.Admin })));
const GroupsPage = lazy(() => import("@web/features/groups/groups.js").then(module => ({ default: module.GroupsPage })));
const KnowledgeBooksPage = lazy(() => import("@web/features/knowledge-books/knowledge-books.js").then((module) => ({ default: module.KnowledgeBooksPage })));
const DiscoveryPage = lazy(() => import("@web/features/discovery/discovery.js").then((module) => ({ default: module.DiscoveryPage })));
const AIChat = lazy(() => import("@web/features/ai/ai-chat-host.js").then((module) => ({ default: module.AIChat })));
const DocumentEditor = lazy(() =>
  import("@web/features/documents/document-editor.js").then((m) => ({ default: m.DocumentEditor })),
);

const titleKeys: Record<string, MessageKey> = {
  groups: "groups.title",
  "knowledge-books": "books.title",
  home: "workspace.home",
  documents: "home.title",
  discover: "workspace.publicResources",
  collected: "discovery.collected",
  todos: "nav.tickets",
  tickets: "nav.tickets",
  ai: "nav.assistant",

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
  kind: "document" | "library";
  role: string;
};
export function App() {
  if(location.hash.startsWith("#/m/plugins/")) return <MobilePluginPage/>;
  return <WorkspaceApp/>;
}
function WorkspaceApp() {
  const navigationRevision = useSyncExternalStore(webPluginRegistry.navigation.subscribe, webPluginRegistry.navigation.snapshot);
  const routesRevision = useSyncExternalStore(webPluginRegistry.routes.subscribe, webPluginRegistry.routes.snapshot);
  const pluginNavigation = useMemo(() => webPluginRegistry.navigation.list(), [navigationRevision]);
  const pluginNavigationByScope = useMemo(
    () => new Map(pluginNavigation.map((item) => [item.scope, item])),
    [pluginNavigation],
  );
  const pluginNavigationRef = useRef(pluginNavigationByScope);
  pluginNavigationRef.current = pluginNavigationByScope;
  const [startup] = useState(() => readDocumentStartup(location.hash));
  const [bootstrapVerified, setBootstrapVerified] = useState(false);
  const detailAccount = useRef(startup?.bootstrap.user?.id);
  const { locale, t, reloadLocale } = useI18n();
  const navigationLayout = useNavigationLayout();
  const [navigationCollapsed, setNavigationCollapsed] = useNavigationCollapse("doca.navigation.collapsed");
  const [adminNavigationCollapsed, setAdminNavigationCollapsed] = useNavigationCollapse("doca.admin-navigation.collapsed");
  const desktopNavigation = useDesktopNavigation();
  useDismissMenus();
  const [createAnchor, setCreateAnchor] = useState<DOMRect | null>(null);
  const [templateFormat, setTemplateFormat] = useState<Resource["format"] | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(startup?.bootstrap ?? null),
    [siteLogoUrl, setSiteLogoUrl] = useState<string | null>(null),
    [fatal, setFatal] = useState(""),
    [navigationOpen, setNavigationOpen] = useState(false),
    [me, setMe] = useState<Me | null>(null),
    [libraryInfo, setLibraryInfo] = useState<Resource | null>(startup?.library ?? null),
    [heldLibraryId, setHeldLibraryId] = useState<string | null>(null),
    [hash, setHash] = useState(location.hash),
    [refresh, setRefresh] = useState(0),
    [scope, setScope] = useState(() => {
      const path = location.hash.replace(/^#/, "").split("?")[0] || "/home";
      const matchedRoute = webPluginRegistry.resolveRoute(
        path.startsWith("/m/plugins/") ? path.slice(2) : path,
      );
      if (matchedRoute)
        return pluginRouteScope(matchedRoute.contribution.id);
      const route = path.slice(1).split(/[/?]/)[0]!;
      if (route === "knowledge") return "libraries";
      return titleKeys[route] || pluginNavigationByScope.has(route)
        ? route
        : "home";
    }),
    [detail, setDetail] = useState<Detail | null>(startup?.detail ?? null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [importProgress, setImportProgress] = useState<ImportProgress | null>(null),
    [createMode, setCreateMode] = useState<"create" | "import">("create"),
    [loading, setLoading] = useState(false),
    [modal, setModal] = useState(""),
    [resourceTitle, setResourceTitle] = useState(""),
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
    if (modal === "create") setResourceTitle("");
    else if (modal === "rename") setResourceTitle(detail?.resource.title ?? "");
  }, [modal, detail?.resource.id]);
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  useEffect(() => {
    if (bootstrapVerified && bootstrap?.user && detail && detailAccount.current === bootstrap.user.id)
      cacheStartupDocument(bootstrap.user.id, detail, libraryInfo);
  }, [bootstrapVerified, bootstrap, detail, libraryInfo]);
  useEffect(()=>{const action=(event:Event)=>{if((event as CustomEvent).detail==="doca.search")setModal("search")};window.addEventListener("doca-navigation-action",action);return()=>window.removeEventListener("doca-navigation-action",action)},[]);
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
            location.hash = "/r/" + r.id;
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
    preferencesPage = hash === "#/preferences",
    mcpPage = hash === "#/mcp",
    browserClipperPage = hash === "#/browser-assistant";
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
  const commentPageRequests = useRef(new Set<string>());
  async function loadMoreComments() {
    if (
      !detail ||
      detail.commentsNextCursor == null
    )
      return;
    const requestedCursor = detail.commentsNextCursor;
    const requestKey = `${detail.resource.id}:${requestedCursor}`;
    if (commentPageRequests.current.has(requestKey)) return;
    commentPageRequests.current.add(requestKey);
    try {
      const page = await api<{
        items: Detail["comments"];
        nextCursor?: string | null;
      }>(
        `/resources/${detail.resource.id}/comments?cursor=${encodeURIComponent(requestedCursor)}`,
      );
      setDetail((d) =>
        d?.resource.id === detail.resource.id &&
        d.commentsNextCursor === requestedCursor
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
      commentPageRequests.current.delete(requestKey);
    }
  }
  const libraryIdFromDetail =
    resourceId && detail?.resource?.id === resourceId
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

  const currentDetail = detail?.resource.id === resourceId && detailAccount.current === bootstrap?.user?.id ? detail : null;
  const [loginResource, setLoginResource] = useState<string | null>(null);
  useEffect(() => {
    if (!bootstrap?.user && resourceId && loginResource === resourceId)
      rememberLoginDocument(hash);
    else if (bootstrap && !bootstrap.user && !resourceId &&
      hash !== "#/auth/complete" && hash !== "#/auth/error")
      takeLoginDocument();
  }, [bootstrap?.user, resourceId, loginResource, hash]);
  const bookContextId = /^#\/knowledge-books\/([0-9a-f-]{36})(?:\?|$)/i.exec(hash)?.[1];
  const [bookContext, setBookContext] = useState<{ userId: string; resource: Resource }>();
  useEffect(() => {
    const contextUserId = bootstrap?.user?.id;
    setBookContext((current) => current?.resource.id === bookContextId && current?.userId === contextUserId ? current : undefined);
    if (!bookContextId || !contextUserId) return;
    const controller = new AbortController();
    void api<Detail>(`/resources/${bookContextId}`, "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.resource.knowledgeBook)
          setBookContext({ userId: contextUserId, resource: value.resource });
      })
      .catch(() => { if (!controller.signal.aborted) setBookContext(undefined); });
    return () => controller.abort();
  }, [bookContextId, bootstrap?.user?.id, refresh]);
  const assistantResource = bookContextId
    ? bookContext?.resource.id === bookContextId && bookContext?.userId === bootstrap?.user?.id ? bookContext.resource : undefined
    : currentDetail?.resource;
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
    const account = bootstrapRef.current?.user?.id;
    const m = await api<Me>("/me");
    if (bootstrapRef.current?.user?.id !== account) return;
    if (m.user.id !== account) {
      clearDocumentStartupCache();
      setMe(null);
      setDetail(null);
      setLibraryInfo(null);
      setBootstrap(await loadBootstrap(true));
      return;
    }
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
    if (!bootstrap?.siteName) return;
    const siteTitle = t("app.documentTitle", { site: bootstrap.siteName });
    const { text: resourceTitle } = splitTitleIcon(currentDetail?.resource.title.trim() ?? "");
    if (resourceId) {
      document.title = resourceTitle || `${t("nav.opening")} · ${bootstrap.siteName}`;
      return;
    }
    if (!bootstrap.user) {
      document.title = siteTitle;
      return;
    }
    const path = hash.slice(1).split("?")[0] || "/home";
    const routeTitleKey = titleKeys[path.slice(1).split("/")[0]!];
    const navigation = navigationLayout.entries.find((entry) => entry.webPath === hash.slice(1))
      ?? navigationLayout.entries.find((entry) => entry.webPath === path);
    const pluginNavigation = pluginNavigationByScope.get(scope);
    let pageTitle = navigation?.title[locale]
      ?? (pluginNavigation && activePluginIds.has(pluginNavigation.pluginId)
        ? pluginMessage(locale, pluginNavigation.labelKey)
        : routeTitleKey ? t(routeTitleKey) : "");
    if (path === "/files") {
      const folder = fileTrail[0]?.type === "system"
        ? fileTrail.at(-1)
        : undefined;
      pageTitle = folder && !(folder.type === "system" && folder.id === "root")
        ? folder.name
        : t("nav.files");
    } else if (sharedFolderId) {
      pageTitle = fileTrail[0]?.id === sharedFolderId
        ? fileTrail.at(-1)?.name ?? sharedFolderName
        : sharedFolderName;
    } else if (bookContextId && bookContext?.resource.id === bookContextId && bookContext.userId === bootstrap.user.id) {
      pageTitle = bookContext.resource.title;
    }
    const { text } = splitTitleIcon(pageTitle.trim());
    document.title = text ? `${text} · ${bootstrap.siteName}` : siteTitle;
  }, [bootstrap?.siteName, bootstrap?.user?.id, t, locale, hash, resourceId,
    currentDetail?.resource.title, navigationLayout, pluginNavigationByScope, scope,
    bootstrap?.plugins, fileTrail, sharedFolderId, sharedFolderName, bookContextId, bookContext]);
  useEffect(() => {
    const href = documentFavicon(currentDetail?.resource ?? null) ?? siteLogoUrl ?? "/favicon.svg";
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!href || !icon) return;
    const originalHref = icon.href;
    const originalType = icon.type;
    icon.removeAttribute("type");
    icon.href = href;
    return () => { icon.href = originalHref; icon.type = originalType; };
  }, [siteLogoUrl, currentDetail?.resource.title, currentDetail?.resource.kind, currentDetail?.resource.format]);
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
  }, [containingLibraryId, refresh, bootstrap?.user?.id]);
  const reload = async () => {
    setRefresh((n) => n + 1);
  };
  const signedIn = !!bootstrap?.user;
  useEffect(() => { extensionViews.close(); }, [bootstrap?.user?.id]);
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
    let active = true, loadingBootstrap = false, generation = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (refresh = true) => {
      if (loadingBootstrap || !active) return;
      clearTimeout(retry);
      loadingBootstrap = true;
      const requestGeneration = generation;
      void loadBootstrap(refresh)
        .then((b) => {
          if (!active || requestGeneration !== generation) return;
          if (bootstrapRef.current?.user?.id !== b.user?.id) {
            setDetail(null);
            setLibraryInfo(null);
          }
          setBootstrap(b);
          setSiteLogoUrl(b.siteLogoUrl);
          setBootstrapVerified(true);
          setFatal("");
          void loadWebPlugins(b).catch(e => console.error("Plugin discovery failed", e));
        })
        .catch((e) => {
          if (!active || requestGeneration !== generation) return;
          if (!bootstrapRef.current) setFatal(e.message);
          retry = setTimeout(() => load(), 3000);
        })
        .finally(() => {
          loadingBootstrap = false;
          if (active && requestGeneration !== generation) retry = setTimeout(() => load(), 3000);
        });
    };
    const discardSession = () => {
      generation++;
      setBootstrapVerified(false);
      setDetail(null);
      setLibraryInfo(null);
      setBootstrap(b => b ? { ...b, user: null } : null);
      load();
    };
    const expired = () => {
      clearDocumentStartupCache();
      discardSession();
    };
    const reloadBootstrap = () => load();
    const online = () => { load(); setRefresh(n => n + 1); };
    const storage = (event: StorageEvent) => {
      if (event.key !== documentStartupCacheKey) return;
      if (!event.newValue || readStartupAccount() !== bootstrapRef.current?.user?.id) {
        invalidateStartupIdentity();
        discardSession();
      }
    };
    const changed = () => {
      setHash(location.hash);
      setNavigationOpen(false);
      setModal("");
      const path = location.hash.replace(/^#/, "").split("?")[0] || "/home";
      const matchedRoute = webPluginRegistry.resolveRoute(
        path.startsWith("/m/plugins/") ? path.slice(2) : path,
      );
      if (matchedRoute) {
        setScope(pluginRouteScope(matchedRoute.contribution.id));
        setError("");
        return;
      }
      const route = path.slice(1).split(/[/?]/)[0]!;
      if (route === "knowledge") {
        location.hash = "/libraries";
        setScope("libraries");
      } else if (titleKeys[route]) setScope(route);
      else if (pluginNavigationRef.current.has(route)) setScope(route);
      else
      setError("");
    };
    load(false);
    window.addEventListener("hashchange", changed);
    window.addEventListener("session-expired", expired);
    window.addEventListener("profile-required", reloadBootstrap);
    window.addEventListener("site-branding-changed", reloadBootstrap);
    window.addEventListener("online", online);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      clearTimeout(retry);
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("profile-required", reloadBootstrap);
      window.removeEventListener("site-branding-changed", reloadBootstrap);
      window.removeEventListener("online", online);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    const path = hash.replace(/^#/, "").split("?")[0] || "/home";
    const route = webPluginRegistry.resolveRoute(path);
    if (route) setScope(pluginRouteScope(route.contribution.id));
  }, [hash, routesRevision]);
  useEffect(() => {
    if (!resourceId) setDetail(null);
    if (!resourceId) return;
    if (!bootstrap) return;
    const controller = new AbortController();
    const requestAccount = bootstrap.user?.id;
    setLoginResource(null);
    const stored = readDocumentStartup(hash);
    const cached = stored?.bootstrap.user?.id === requestAccount ? stored : null;
    if (detail?.resource.id !== resourceId && cached) {
      detailAccount.current = requestAccount;
      setDetail(cached.detail);
      setLibraryInfo(cached.library);
    }
    if (detail?.resource.id !== resourceId && !cached) setLoading(true);
    let retry: ReturnType<typeof setTimeout> | undefined;
    void api<Detail>(
      `/resources/${resourceId}`,
      "GET",
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    )
      .then(async (d) => {
        if (d.resource.knowledgeBook) { location.hash = `/knowledge-books/${d.resource.id}`; return; }
        if (controller.signal.aborted) return;
        detailAccount.current = requestAccount;
        setDetail(d);
        setLoading(false);
        if (targetComment && /^[a-f0-9-]{36}$/.test(targetComment)) {
          try {
            const context = await api<{ items: Detail["comments"] }>(
              `/resources/${resourceId}/comments?target=${targetComment}`,
              "GET",
              undefined,
              controller.signal,
            );
            d = { ...d, comments: [
              ...new Map(
                [...d.comments, ...context.items].map((c) => [c.id, c]),
              ).values(),
            ] };
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
          if ([401, 403, 404].includes(e.status)) {
            setLoginResource(resourceId);
            forgetStartupDocument(resourceId);
            setDetail(null);
          }
          else
            setDetail((previous) =>
              previous?.resource.id === resourceId ? previous : null,
            );
          if (![401, 403, 404].includes(e.status)) retry = setTimeout(() => setRefresh(n => n + 1), 3000);
          setError(
            e.status && e.status >= 500 ? "服务暂时不可用，已保留当前文档" : "",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => { clearTimeout(retry); controller.abort(); };
  }, [resourceId, refresh, !!bootstrap, bootstrap?.user?.id, targetComment]);
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
  function create(kind: "document" | "library", parent?: Resource, mode: "create" | "import" = "create") {
    setCreateMode(mode);
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
          `/resources?scope=all&kind=library${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        rows.push(...p.items);
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      setTargets(rows);
      setModal("move");
    });
  }
  const pluginRoutePath = hash.replace(/^#/, "").split("?")[0] || "/home";
  const matchedPluginRoute = webPluginRegistry.resolveRoute(pluginRoutePath.startsWith("/m/plugins/") ? pluginRoutePath.slice(2) : pluginRoutePath);
  const pluginRoute =
    matchedPluginRoute &&
    activePluginIds.has(matchedPluginRoute.contribution.pluginId)
      ? matchedPluginRoute
      : undefined;
  const unavailablePluginRoute =
    !!matchedPluginRoute && !pluginRoute;
  const adminPluginPage = isAdminNavigationPath(
    navigationLayout.entries,
    pluginRoutePath,
  );
  const renderedPluginRoute = pluginRoute?.contribution.render(
      {
        PageHeader: PluginPageHeader,
        sharedFolderName,
        onFileNavigationChange: setFileTrail,
      },
      pluginRoute.match,
    );
  useEffect(() => {
    if(!hash.startsWith("#/browser-connect?") || !bootstrap || bootstrap.user) return;
    sessionStorage.setItem("doca.browser-login.pending",hash);
    const state=new URLSearchParams(hash.split("?")[1]).get("state");
    window.postMessage({source:"doca-browser-auth",state,status:"login-required"},location.origin);
  },[hash,bootstrap]);
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
          const browserPending=sessionStorage.getItem("doca.browser-login.pending");
          if(browserPending?.startsWith("#/browser-connect?")) {location.hash=browserPending;return;}
          const token = rememberedShareToken();
          const documentLocation = takeLoginDocument();
          location.hash = ["linked", "security_verified"].includes(status)
            ? "/account"
            : documentLocation ?? (token ? "/s/" + token : "/home");
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

  if (!bootstrap.user && resourceId && !currentDetail && loginResource !== resourceId)
    return <main className="auth">{t("shell.connecting")}</main>;
  if (!bootstrap.user && (!resourceId || loginResource === resourceId))
    return (
      <Login
        bootstrap={bootstrap}
        siteLogoUrl={siteLogoUrl}
        logged={async () => {
          setBootstrap(await api("/bootstrap"));
          const documentLocation = takeLoginDocument();
          const token = rememberedShareToken();
          if (resourceId) return;
          if (hash.split("?")[0] === "#/shared-files/join" || hash.startsWith("#/browser-connect?")) return;
          if(token) location.hash = "/s/" + token;
          else if (documentLocation) location.hash = documentLocation;
          else await navigateToDefaultHome().catch(()=>{location.hash="/home"});
        }}
      />
    );
  if(hash.startsWith("#/browser-connect?") && bootstrap.user) return <BrowserClipperConnect/>;
  if (hash.startsWith("#/m/plugins/") && bootstrap.user) return <main className="mobile-plugin-page">{renderedPluginRoute ?? <p>{t("navigation.unavailable")}</p>}</main>;
  if (shareInvitation)
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="share-invitation-title">
          <h1 id="share-invitation-title">{t("shell.inviteTitle")}</h1>
          <p>
            {t("shell.inviteBody", {
              kind: shareInvitation.kind === "library" ? t("shell.inviteKind.library") : t("shell.inviteKind.document"),
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
                    location.hash = "/r/" + r.id;
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
    (!(adminPage || adminPluginPage) || !!bootstrap.forcedLoginMethod)
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
  if (user && (adminPage || adminPluginPage || accountPage || preferencesPage || mcpPage || browserClipperPage))
    return (
      <div className={`settings-shell ${(adminPage || adminPluginPage) && adminNavigationCollapsed ? "admin-navigation-collapsed" : ""}`}>
        <header className="settings-shell-header">
          {(adminPage || adminPluginPage) && <button className="icon" title={adminNavigationCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} aria-label={adminNavigationCollapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")} aria-expanded={!adminNavigationCollapsed} onClick={() => setAdminNavigationCollapsed(!adminNavigationCollapsed)}><PanelLeft size={19} /></button>}
          <BackLink fallback="/home" className="settings-back">
            <ArrowLeft size={18} /> {t("account.workspace")}
          </BackLink>
          <div className="global-header-tools">
          <NavigationArea slot="web.topRight" action="other"/>
          <MoreNavigation />
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
            <LazyContent><Admin activePluginIds={activePluginIds} /></LazyContent>
          ) : (
            <section className="empty">
              {t("shell.adminOnly")}<a href="#/home">{t("shell.homeLink")}</a>
            </section>
          )
        ) : adminPluginPage ? (
          user.admin ? (
            <section className="admin-console">
              <div className="admin-layout">
                <nav className="admin-nav" aria-label={t("admin.nav")}>
                  <NavigationArea slot="web.admin" />
                  <div className="admin-nav-note">
                    <LockKeyhole size={16} />
                    <p>{t("admin.navNote")}</p>
                  </div>
                </nav>
                <main className="admin-content">
                  {unavailablePluginRoute ? (
                    <section className="empty">
                      <p>{t("shell.pluginUnavailable")}</p>
                      <a href="#/admin">{t("admin.title")}</a>
                    </section>
                  ) : (
                    renderedPluginRoute
                  )}
                </main>
              </div>
            </section>
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
              <a className={mcpPage ? "active" : ""} href="#/mcp"><Settings size={18} />{t("mcp.title")}</a>
              <a className={browserClipperPage ? "active" : ""} href="#/browser-assistant"><Settings size={18} />{t("clipper.title")}</a>
              <p>{t("shell.settingsHint")}</p>
            </aside>
            <main className="personal-settings-content">
              {me ? (
                browserClipperPage ? <BrowserClipperSettings /> : mcpPage ? <McpSettings /> : accountPage ? (
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
    <AIProvider userId={user?.id} resource={assistantResource} hash={hash} contextLoading={!!bookContextId && !assistantResource} onResourcesChanged={() => setRefresh((n) => n + 1)}>
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
                <SiteLogo url={siteLogoUrl} />
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
              <LeftNavigation />
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
            knowledgeEnabled={false}
            accountActions={!!user}
            create={(r) => create("document", r)}
            changed={() => setRefresh((n) => n + 1)}
          />}
        </aside>
      )}
      <main className="workspace">
        {user && <NavigationArea slot="web.right"/>}
        <header className={`topbar ${documentHeader ? "" : "workspace-topbar"}`}>
          <div className="document-topbar-title">
            {pluginRoute && <div id="plugin-page-header-title" className="plugin-page-header-title" />}
            {user && !resourceId && <NavigationArea slot="web.top"/>}
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
            {librarySystemPage && <div className="files-topbar-title knowledge-topbar-title"><BookOpenCheck size={20}/><h1>{t("nav.librarySystem")}</h1></div>}
            {!resourceId && scope === "knowledge-books" && <div id="knowledge-books-header-title" />}
            {!resourceId && scope === "ai" && <div id="ai-header-slot" />}

            {!resourceId && pluginRoute && (scope === "files" || scope === "shared-files") && user && (
              <div className="files-topbar-title">
                {scope === "shared-files" ? <FolderSymlink size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
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
                  detail.resource.kind === "document" &&
                  ["rich_text", "markdown", "spreadsheet", "canvas", "presentation"].includes(
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
                {resourceId && detail?.resource.id === resourceId && detail.resource.kind === "document" && <ResourceAccessTag state={detail.resource.access_state} />}
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
            {pluginRoute && <div id="plugin-page-header-actions" className="plugin-page-header-actions" />}
            {!resourceId && scope === "knowledge-books" && <div id="knowledge-books-header-actions" />}

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
                <NavigationArea slot="web.topRight" action="other" />
                <MoreNavigation />

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
          disabled={false}
          format={detail?.resource.kind === "document" ? detail.resource.format : undefined}
          surface={
            scope === "knowledge-books" ? "knowledge" : !resourceId && user && (scope === "files" || (scope === "shared-files" && !!sharedFolderId))
              ? "files"
              : undefined
          }
        >
        {resourceId && <div id="editor-toolbar-slot" hidden={documentMode.readOnly} />}
        {user && detail?.resource.kind === "document" && <PluginSlot slot="document.toolbar" scope="document" resource={detail.resource} />}
        {user && libraryInfo && <PluginSlot slot="library.toolbar" scope="library" resource={libraryInfo} />}
        {error && <Feedback message={error} tone="error" />}
        <div className="plugin-content-layout">
        <div
          className={
            "main-scroll" +
            (pluginRoute
              ? " plugin-scroll-host"
              : !resourceId && scope === "knowledge-books"
                ? " knowledge-books-scroll-host"
              : !resourceId && scope === "home"
                ? " workspace-home-scroll"
                : !resourceId && scope !== "trash"
                  ? " dashboard-scroll-host"
                  : "")
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
            <><NavigationArea slot="web.home"/><WorkspaceHome name={user.display_name} /></>
          ) : !resourceId && (scope === "discover" || scope === "collected") && user ? (
            <LazyContent><DiscoveryPage key={scope + hash} collected={scope === "collected"} /></LazyContent>
          ) : !resourceId && scope === "groups" && user ? (
            <LazyContent><GroupsPage key={user.id} userId={user.id} hash={hash} /></LazyContent>
          ) : !resourceId && scope === "knowledge-books" && (user || /^#\/knowledge-books\/[0-9a-f-]{36}/i.test(hash)) ? (
            <LazyContent><KnowledgeBooksPage id={hash.replace(/^#\/knowledge-books\/?/, "").split("?")[0] || undefined} /></LazyContent>
          ) : !resourceId && scope === "ai" ? (
            <LazyContent><AIChat full /></LazyContent>
          ) : ticketsPage ? (
            <Tickets ticketId={ticketId} />
          ) : resourceId ? (
            loading && !currentDetail ? (
              <div className="empty">{t("nav.opening")}</div>
            ) : currentDetail ? (
              <>
                {currentDetail.resource.kind === "library" ? (
                  librarySettingsPage ? (
                    <LibrarySettings detail={currentDetail} changed={reload} />
                  ) : librarySystemPage ? (
                    <LibrarySystemPage detail={currentDetail} changed={reload} />
                  ) : (
                    <LibraryLanding
                      resource={currentDetail.resource}
                      create={() => create("document", currentDetail.resource)}
                    />
                  )
                ) : (
                  <Suspense fallback={<p className="empty">{t("shell.loadingEditor")}</p>}>
                    <DocumentEditor
                      detail={currentDetail}
                      targetComment={targetComment}
                      loadMoreComments={loadMoreComments}
                      user={user}
                      changed={() => setRefresh((n) => n + 1)}
                      discussion={!["spreadsheet", "canvas", "presentation"].includes(currentDetail.resource.format) && (
                        <Comments
                          key={currentDetail.resource.id}
                          targetComment={targetComment}
                          loadMoreComments={loadMoreComments}
                          detail={{
                            ...currentDetail,
                            comments: currentDetail.comments.filter(
                              (c) => !c.anchor && !currentDetail.comments.some(
                                (root) => root.anchor && root.id === c.parent_id,
                              ),
                            ),
                          }}
                          user={user}
                          act={act}
                          busy={busy}
                        />
                      )}
                    />
                  </Suspense>
                )}

                {user && currentDetail.resource.kind === "document" && <>
                  <PluginSlot slot="document.status" scope="document" resource={currentDetail.resource} />
                  <PluginSlot slot="resource.details" scope="document" resource={currentDetail.resource} />
                </>}
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
              upload={() => create("document", undefined, "import")}
              changed={() => setRefresh((n) => n + 1)}
            />
          )}
        </div>
        {user && !loading && detail?.resource.kind === "document" && <PluginSlot slot="document.sidebar" scope="document" resource={detail.resource} />}
        </div>
        </AIDocumentLayout>
      </main>
      {createAnchor && (
        <CreatePopover
          key={createMode}
          initialMode={createMode}
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
            <label htmlFor="resource-dialog-title">{t("shell.name")}</label>
            <TitleInput id="resource-dialog-title" name="title" required autoFocus maxLength={160} value={resourceTitle} onValueChange={setResourceTitle} placeholder={t("shell.namePlaceholder")} />
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
    </div>
    </AIProvider>
    </DocumentModeContext.Provider>
  );
}
function Login({
  bootstrap,
  siteLogoUrl,
  logged,
}: {
  bootstrap: Bootstrap;
  siteLogoUrl: string | null;
  logged: () => Promise<void>;
}) {
  return <AccountLogin bootstrap={bootstrap} siteLogoUrl={siteLogoUrl} logged={logged} />;
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
  const [publication, setPublication] = useState<CommentPublication | null>(null);
  useCommentPages(detail.resource.id, true, detail.commentsNextCursor, loadMoreComments);
  useEffect(() => {
    const index = detail.comments.findIndex((c) => c.id === targetComment);
    if (index < 0) return;
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
      <CommentPublicationStatus publication={publication} comments={detail.comments} />
      {detail.comments.map((c) => (
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
                setPublication({ id: c.id, previousVersion: c.version });
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
                const created = await api<{ id: string }>(`/resources/${r.id}/comments`, "POST", {
                  richBody,
                  parentId: c.id,
                });
                setPublication({ id: created.id });
                setReply(null);
                await act(async () => {});
              }}
            />
          )}
        </article>
      ))}
      {user && rank >= 2 ? (
        <CommentComposer
          resourceId={r.id}
          disabled={busy}
          submit={async (richBody) => {
            const created = await api<{ id: string }>(`/resources/${r.id}/comments`, "POST", {
              richBody,
              parentId: null,
            });
            setPublication({ id: created.id });
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
  const triggerRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ top: 56, right: 16, maxHeight: 560 });
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
    publishNotificationUnread(data.unread);
  }, [data.unread]);
  useEffect(() => () => publishNotificationUnread(0), []);
  useEffect(() => {
    const action = (event: Event) => {
      if ((event as CustomEvent).detail !== "doca.notifications") return;
      triggerRef.current = document.activeElement?.closest<HTMLElement>('[data-entry-id="doca.notifications"]')
        ?? panelRef.current?.closest(".global-header-tools")?.querySelector<HTMLElement>('[data-entry-id="doca.notifications"]')
        ?? null;
      setOpen((current) => !current);
      void load().catch((e) => setError(e.message));
    };
    const close = () => setOpen(false);
    window.addEventListener("doca-navigation-action", action);
    window.addEventListener("hashchange", close);
    return () => {
      window.removeEventListener("doca-navigation-action", action);
      window.removeEventListener("hashchange", close);
    };
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger?.isConnected) { setOpen(false); return; }
      const rect = trigger.getBoundingClientRect();
      const panel = panelRef.current?.querySelector<HTMLElement>(".notification-panel");
      const width = panel?.offsetWidth ?? Math.min(560, innerWidth - 24);
      const top = rect.bottom + 8;
      setPosition({
        top,
        right: Math.max(12, Math.min(innerWidth - rect.right, innerWidth - width - 12)),
        maxHeight: Math.max(80, Math.min(innerHeight * 0.7, innerHeight - top - 12)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    const header = triggerRef.current?.closest(".global-header-tools");
    if (header) observer.observe(header);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    const dismiss = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) setOpen(false);
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
        hidden
        className="icon notification-trigger"
        title={t("shell.notifications")}
        aria-label={`${t("shell.notifications")} ${t("shell.unread", { count: data.unread })}`}
        onClick={() => {
          triggerRef.current = panelRef.current?.querySelector("button") ?? null;
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
        <section className="notification-panel" style={position}>
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
                  "knowledge_book.failed": t("notify.knowledgeBook.failed"),
                  "knowledge_book.review": t("notify.knowledgeBook.review"),
                  "knowledge_book.publication": t("notify.knowledgeBook.publication"),
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
