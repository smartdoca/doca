import { AIProvider } from "@web/features/ai/ai-context.js";
import { readPageState } from "@web/features/page-state/client.js";
import { AIChat, AIDocumentLayout } from "@web/features/ai/ai-chat.js";
import "@web/features/account/account-menu.css";
import { MembershipLink } from "@web/features/settings/membership-link.js";
import { AccountMenu } from "@web/features/account/account-menu.js";
import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { AccountLogin } from "@web/features/auth/account-login.js";
import { AccountOnboarding } from "@web/features/auth/account-fields.js";
import { Feedback } from "@web/shared/components/feedback.js";
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
  librarySettingsUrl,
} from "@web/features/documents/library.js";
import {
  CommentComposer,
  CommentMessage,
  parsedComment,
} from "@web/features/comments/rich-comments.js";
import { Select } from "@web/shared/components/select.js";
import { realtime } from "@web/features/documents/realtime.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import React, { lazy, Suspense, useEffect, useState, useRef } from "react";
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
  ChevronRight,
  ThumbsUp,
  LogOut,
  FolderOpen,
  Mail,
  ArrowLeft,
  Home,
  Cloud,
  PanelLeft,
  UserRound,
  BrainCircuit,
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
import { Dashboard, GlobalSearch, CloudBackup } from "@web/features/workspace/dashboard.js";
import { Avatar, Profile, PersonalSettings } from "@web/features/account/profile.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import "@web/styles/globals.css";
import { FileIcon } from "@web/features/documents/document-controls.js";
import { FilesExplorer, SharedFoldersPage, type FileLocation } from "@web/features/files/files.js";
import { MailApp } from "@web/features/mail/mail.js";
import { MobileTicketRedeem, postMobileEditor } from "@web/features/mobile/ticket-redeem.js";
import { KnowledgeRelations } from "@web/features/knowledge/knowledge-relations.js";
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

const titles: Record<string, string> = {
  todos: "工单",
  tickets: "工单",
  home: "在线文档",
  ai: "AI 助手",
  notes: "随手记",
  backups: "云备份",
  preferences: "系统设置",
  libraries: "知识库",
  knowledge: "知识关系",
  files: "我的文件夹",
  "shared-files": "共享文件夹",
  mail: "邮箱",
  shared: "与我共享",
  favorites: "我的收藏",
  all: "最近更新",
  trash: "回收站",
};
const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return "操作失败";
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
  const [navigationCollapsed, setNavigationCollapsed] = useNavigationCollapse("doca.navigation.collapsed");
  const [adminNavigationCollapsed, setAdminNavigationCollapsed] = useNavigationCollapse("doca.admin-navigation.collapsed");
  const desktopNavigation = useDesktopNavigation();
  const allowed = useEntitlements();
  useDismissMenus();
  const [createAnchor, setCreateAnchor] = useState<DOMRect | null>(null);
  const [templateFormat, setTemplateFormat] = useState<Resource["format"] | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null),
    [fatal, setFatal] = useState(""),
    [navigationOpen, setNavigationOpen] = useState(false),
    [me, setMe] = useState<Me | null>(null),
    [libraryInfo, setLibraryInfo] = useState<Resource | null>(null),
    [hash, setHash] = useState(location.hash),
    [refresh, setRefresh] = useState(0),
    [scope, setScope] = useState(() => {
      const route = location.hash.slice(2).split(/[/?]/)[0]!;
      if (import.meta.env.DEV && route === "mail-preview") return "mail";
      return titles[route] ? route : "home";
    }),
    [q, setQ] = useState(""),
    [format, setFormat] = useState(""),
    [page, setPage] = useState<Page>({ items: [], total: 0, nextOffset: null }),
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
    void api<{ id: string; pending?: false; alreadyHasAccess?: boolean } | ShareInvitation>(
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
                r = await api<{ id: string }>("/share/redeem", "POST", {
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
    mailId = /^#\/mail\/([a-f0-9-]{36})(?:\?|$)/.exec(hash)?.[1],
    mailPreview = import.meta.env.DEV && hash.split("?")[0] === "#/mail-preview",
    mailPage = hash.split("?")[0] === "#/mail" || hash.startsWith("#/mail/") || mailPreview,
    adminPage = hash.split("?")[0] === "#/admin",
    accountPage = hash === "#/account",
    preferencesPage = hash === "#/preferences",
    backupPage = hash === "#/backups";
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
      return path[0]?.name || "共享文件夹";
    } catch { return "共享文件夹"; }
  })();
  async function loadMoreComments() {
    if (!detail || detail.commentsNextOffset == null || busy) return;
    setBusy(true);
    try {
      const page = await api<{
        items: Detail["comments"];
        nextOffset: number | null;
      }>(
        `/resources/${detail.resource.id}/comments?offset=${detail.commentsNextOffset}`,
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
              commentsNextOffset: page.nextOffset,
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
  const containingLibraryId =
    detail?.resource.kind === "library"
      ? detail.resource.id
      : detail?.resource.library_id;
  const currentLibraryId =
    detail?.resource.kind === "library"
      ? detail.resource.id
      : libraryInfo && libraryInfo.id === containingLibraryId
        ? libraryInfo.id
        : undefined;
  const librarySettingsPage =
    new URLSearchParams(hash.split("?")[1]).get("view") === "settings";
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
        : "正在加载知识库…";
  const headerTitle = resourceId
    ? currentDetail
      ? librarySettingsPage && currentDetail.resource.kind === "library"
        ? "知识库设置"
        : currentDetail.resource.title
      : "正在打开…"
    : ticketsPage
      ? "工单"
      : titles[scope];
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
    if (!bootstrap?.user) {
      setMe(null);
      return;
    }
    void refreshMe().catch((e) => setError(e.message));
  }, [bootstrap?.user?.id, accountPage]);
  useEffect(() => {
    if (!bootstrap?.user) return;
    const refresh = () => {
      void refreshMe().catch((e) => setError(e.message));
    };
    window.addEventListener("entitlements-updated", refresh);
    window.addEventListener("focus", refresh);
    const expiresAt = me?.entitlements?.expiresAt;
    const wait = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
    const timer = Number.isFinite(wait) && wait > 0
      ? setTimeout(refresh, Math.min(wait + 50, 2147483647))
      : undefined;
    return () => {
      window.removeEventListener("entitlements-updated", refresh);
      window.removeEventListener("focus", refresh);
      if (timer) clearTimeout(timer);
    };
  }, [bootstrap?.user?.id, me?.entitlements?.expiresAt]);
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
    if (!bootstrap?.user) return;
    let active = true;
    void readPageState<"zh" | "en">("ui.locale").then((item) => {
      if (!active || (item?.value !== "zh" && item?.value !== "en")) return;
      document.documentElement.lang = item.value === "zh" ? "zh-CN" : "en";
    }).catch(() => undefined);
    const onPageState = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
      if (detail?.key !== "ui.locale") return;
      if (detail.value === "zh" || detail.value === "en")
        document.documentElement.lang = detail.value === "zh" ? "zh-CN" : "en";
    };
    window.addEventListener("doca-page-state", onPageState);
    return () => {
      active = false;
      window.removeEventListener("doca-page-state", onPageState);
    };
  }, [bootstrap?.user?.id]);
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
  const selectedLibrary =
    detail?.resource.kind === "library" ? detail.resource.id : null;
  const reload = async () => {
    setRefresh((n) => n + 1);
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.editorShell === "mobile") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal("search");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    const load = () =>
      void api<Bootstrap>("/bootstrap")
        .then((b) => {
          setBootstrap(b);
          document.title = `${b.siteName} · 文档与知识库`;
        })
        .catch((e) => setFatal(e.message));
    const changed = () => {
      setHash(location.hash);
      setNavigationOpen(false);
      setModal("");
      const route = location.hash.slice(2).split(/[/?]/)[0]!;
      if (import.meta.env.DEV && route === "mail-preview") setScope("mail");
      else if (titles[route]) setScope(route);
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
  useEffect(() => {
    if (!bootstrap?.user || !selectedLibrary) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        scope: selectedLibrary ? "all" : scope,
        q,
        ...(format ? { format } : {}),
        ...(selectedLibrary ? { libraryId: selectedLibrary } : {}),
      });
      void api<Page>(
        `/resources?${params}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then(setPage)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, q, format, selectedLibrary, refresh, bootstrap?.user?.id]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: string) {
    location.hash = "/" + next;
    setScope(next);
    setQ("");
    setFormat("");
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
      let offset: number | null = 0;
      while (offset !== null) {
        const p: Page = await api<Page>(
          `/resources?scope=all&offset=${offset}`,
        );
        rows.push(
          ...p.items.filter(
            (x) =>
              roleRank(x.role) >= 4 &&
              (x.kind === "library" ||
                (x.kind === "document" && !!x.library_id)),
          ),
        );
        offset = p.nextOffset;
      }
      setTargets(rows);
      setModal("move");
    });
  }
  if (fatal)
    return (
      <main className="auth">
        <div className="auth-card">
          <h1>暂时无法连接服务</h1>
          <p role="alert">{fatal}</p>
          <button onClick={() => location.reload()}>重试</button>
        </div>
      </main>
    );
  if (!bootstrap) return <main className="auth">正在连接 Doca…</main>;
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
          <h2>未完成身份验证</h2>
          <p>
            授权被取消、流程已过期或身份源校验失败。请重新发起登录或绑定；如反复失败，请让管理员检查凭据和回调地址。
          </p>
          <a href={bootstrap.user ? "#/account" : "#/home"}>
            返回{bootstrap.user ? "个人信息" : "登录页"}
          </a>
        </section>
      </main>
    );
  if (import.meta.env.DEV && hash.split("?")[0] === "#/mail-preview" && !bootstrap.user)
    return (
      <div className="mail-preview-shell">
        <header className="topbar workspace-topbar">
          <div className="document-topbar-title">
            <div className="files-topbar-title">
              <Mail size={17} aria-hidden="true" />
              <strong>邮箱</strong>
              <span className="files-topbar-separator">/</span>
              <span id="mail-header-mailbox" />
            </div>
          </div>
          <div className="inline document-topbar-actions">
            <span id="mail-header-actions" className="mail-header-actions" />
            <div className="global-header-tools">
              <TodoIcon />
            </div>
          </div>
        </header>
        <MailApp preview />
      </div>
    );
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
          <h1 id="share-invitation-title">收到一份分享邀请</h1>
          <p>
            {shareInvitation.kind === "library" ? "知识库" : "文档"}「
            {shareInvitation.title}」邀请你以“{shareInvitation.role}”身份访问。
          </p>
          <p className="subtle">
            接受后，这份内容会加入你的共享列表，并按邀请权限开放。
          </p>
          <div className="auth-actions">
            <button
              className="primary"
              onClick={() => {
                const token = rememberedShareToken();
                if (!token) {
                  setError("邀请链接已失效，请重新打开分享链接");
                  return;
                }
                void api<{ id: string }>("/share/redeem", "POST", {
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
              接受并打开
            </button>
            <button
              onClick={() => {
                setShareInvitation(null);
                try { sessionStorage.removeItem("doca.pending-share-token"); } catch {}
                location.hash = "/home";
              }}
            >
              暂不接受
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
          {adminPage && <button className="icon" title={adminNavigationCollapsed ? "展开管理导航" : "收起管理导航"} aria-label={adminNavigationCollapsed ? "展开管理导航" : "收起管理导航"} aria-expanded={!adminNavigationCollapsed} onClick={() => setAdminNavigationCollapsed(!adminNavigationCollapsed)}><PanelLeft size={19} /></button>}
          <a href="#/home" className="settings-back">
            <ArrowLeft size={18} /> 返回工作台
          </a>
          <div className="global-header-tools">
          {!adminPage && <MembershipLink vip={me?.entitlements?.vip} onError={setError} />}
          <TodoIcon />
          <Notifications />
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
            <Admin />
          ) : (
            <section className="empty">
              此页面仅限管理员访问。<a href="#/home">返回主页</a>
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
                <small>你的个人账号</small>
              </div>
              <a className={accountPage ? "active" : ""} href="#/account">
                <UserRound size={18} />
                个人信息与安全
              </a>
              <a
                className={preferencesPage ? "active" : ""}
                href="#/preferences"
              >
                <Settings size={18} />
                外观与使用偏好
              </a>
              <p>这里的设置只影响你的账号，不会更改其他用户的工作环境。</p>
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
                <p className="empty">正在加载设置…</p>
              )}
            </main>
          </div>
        )}
      </div>
    );
  return (
    <DocumentModeContext.Provider value={documentMode}>
    <AIProvider userId={user?.id} resource={detail?.resource.kind === "document" ? detail.resource : undefined} hash={hash} onResourcesChanged={() => setRefresh((n) => n + 1)}>
    <div
      className={`app-shell ${mobileShell ? "mobile-editor-shell" : ""} ${!user || sharedPersonalView ? "public-view" : ""} ${personalDocumentPage ? "personal-document-view" : ""} ${resourceId ? "document-view" : ""} ${["spreadsheet", "canvas", "presentation"].includes(detail?.resource.format ?? "") ? "spreadsheet-view surface-view" : ""} ${navigationOpen ? "navigation-expanded" : ""} ${navigationCollapsed ? "navigation-collapsed" : ""}`}
    >
      {user && !sharedPersonalView && !personalDocumentPage && !mobileShell && (
        <aside
          className={`sidebar ${currentLibraryId ? "library-sidebar" : ""}`}
        >
          <div className="library-brand-row">
            <a
              href={currentLibraryId ? "#/libraries" : "#/home"}
              className="brand"
              title={currentLibraryId ? libraryTitle : bootstrap.siteName}
            >
              <span
                className={
                  currentLibraryId ? "library-back-arrow" : "brand-symbol"
                }
              >
                {currentLibraryId ? (
                  <ArrowLeft size={20} />
                ) : (
                  <BookOpen size={22} />
                )}
              </span>
              <span
                title={currentLibraryId ? libraryTitle : bootstrap.siteName}
              >
                {currentLibraryId ? libraryTitle : bootstrap.siteName}
              </span>
            </a>
            {currentLibraryId && (
              <LibraryFavorite key={currentLibraryId} id={currentLibraryId} />
            )}
            <button
              className="icon navigation-toggle sidebar-navigation-toggle"
              title={desktopNavigation || navigationOpen ? "收起侧边导航" : "展开侧边导航"}
              aria-label={desktopNavigation || navigationOpen ? "收起侧边导航" : "展开侧边导航"}
              aria-expanded={desktopNavigation ? !navigationCollapsed : navigationOpen}
              onClick={() => desktopNavigation ? setNavigationCollapsed(true) : setNavigationOpen(!navigationOpen)}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <button className="sidebar-search" onClick={() => setModal("search")}>
            <Search size={17} />
            <span>搜索</span>
            <kbd>⌘ K</kbd>
          </button>
          {currentLibraryId && (
            <nav>
              {!librarySettingsPage && <><button className="ai-navigation-entry" onClick={() => navigate("ai")}><Sparkles size={16} />AI 助手</button><button onClick={() => navigate("notes")}><Feather size={16} />随手记</button></>}
              <a
                className={librarySettingsPage ? "active" : ""}
                href={librarySettingsUrl(currentLibraryId)}
              >
                <Settings size={18} />
                知识库设置
              </a>
            </nav>
          )}
          {!currentLibraryId && (
            <nav>
              <button
                type="button"
                className="sidebar-create-entry"
                hidden={!allowed("documents.create")}
                title="创作"
                aria-label="创作"
                aria-haspopup="dialog"
                onClick={() => create("document")}
              >
                <span className="sidebar-create-plus" aria-hidden="true">
                  <Plus size={16} strokeWidth={2.6} />
                </span>
                <span className="sidebar-create-label">创作</span>
              </button>
              <PinnedDocuments refresh={refresh} />
              {[
                ["home", "在线文档", Home],
                ["ai", "AI 助手", Sparkles],
                ["notes", "随手记", Feather],
                ["libraries", "知识库", BookOpen],
                ["knowledge", "知识关系", BrainCircuit],
                ["files", "我的文件夹", FolderOpen],
                ["shared-files", "共享文件夹", Users],
                ["mail", "邮箱", Mail],
                ["trash", "回收站", Trash2],
                ["backups", "云备份", Cloud],
              ]
                .filter(
                  ([key]) => key !== "backups" || allowed("backup.upload"),
                )
                .map(([key, title, Icon]) => {
                  const I = Icon as typeof Home;
                  return (
                    <button
                      key={key as string}
                      className={`${key === "ai" ? "ai-navigation-entry" : ""} ${key === "trash" ? "sidebar-trash-navigation-entry" : ""} ${!resourceId && (scope === key || (key === "mail" && mailPage)) ? "active" : ""}`}
                      onClick={() => navigate(key as string)}
                    >
                      <I size={16} />
                      {title as string}
                    </button>
                  );
                })}
            </nav>
          )}
          {currentLibraryId && <div className="sidebar-tree-heading">
            <button
              onClick={() => { location.hash = "/r/" + currentLibraryId; }}
            >
              目录
            </button>
            <button className="tree-organize" onClick={() => { location.hash = `/knowledge?source=library:${currentLibraryId}`; }}>
              整理建议
            </button>
            <button
              className="icon"
              hidden={!allowed("documents.create")}
              aria-label="新建知识库文档"
              disabled={!libraryInfo || roleRank(libraryInfo.role) < 3}
              onClick={() => create("document", libraryInfo ?? undefined)}
            >
              <Plus size={17} />
            </button>
          </div>}
          {currentLibraryId && <DocumentTree
            key={user.id + ":" + currentLibraryId}
            refresh={refresh}
            userId={user.id}
            selected={resourceId}
            libraryId={currentLibraryId}
            create={(r) => create("document", r)}
            changed={() => setRefresh((n) => n + 1)}
          />}
        </aside>
      )}
      <main className="workspace">
        <header className={`topbar ${documentHeader ? "" : "workspace-topbar"}`}>
          <div className="document-topbar-title">
            {user && desktopNavigation && navigationCollapsed && (
              <button
                className="icon navigation-toggle"
                title={(desktopNavigation ? !navigationCollapsed : navigationOpen) ? "收起侧边导航" : "展开侧边导航"}
                aria-label={(desktopNavigation ? !navigationCollapsed : navigationOpen) ? "收起侧边导航" : "展开侧边导航"}
                aria-expanded={desktopNavigation ? !navigationCollapsed : navigationOpen}
                onClick={() => desktopNavigation ? setNavigationCollapsed(!navigationCollapsed) : setNavigationOpen(!navigationOpen)}
              >
                <PanelLeft size={19} />
              </button>
            )}
            {personalDocumentPage && (
              <button
                className="icon document-back-button"
                aria-label="返回主页"
                title="返回主页"
                onClick={() => { location.hash = "/home"; }}
              >
                <ArrowLeft size={19} />
              </button>
            )}
            {!resourceId && scope === "ai" && <div id="ai-header-slot" />}
            {!resourceId && (scope === "mail" || mailPage) && user && (
              <div className="files-topbar-title">
                <Mail size={17} aria-hidden="true" />
                <strong>邮箱</strong>
                <span className="files-topbar-separator">/</span>
                <span id="mail-header-mailbox" />
              </div>
            )}
            {!resourceId && scope === "knowledge" && user && (
              <div className="files-topbar-title">
                <BrainCircuit size={17} aria-hidden="true" />
                <strong>知识关系</strong>
              </div>
            )}
            {!resourceId && (scope === "files" || scope === "shared-files") && user && (
              <div className="files-topbar-title">
                {scope === "shared-files" ? <Users size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
                <strong>{scope === "shared-files" ? (sharedFolderId ? sharedFolderName : "共享文件夹") : "我的文件夹"}</strong>
                {(scope === "files" || sharedFolderId) && <><span className="files-topbar-separator">/</span>
                <nav aria-label="文件夹路径">
                  {fileTrail.slice(sharedFolderId ? 1 : 0).map((item, index) => (
                    <span key={`${item.type}:${item.id}`}>
                      {index > 0 && <span className="files-topbar-chevron">/</span>}
                      <button type="button" title={item.name} onClick={() => openFileTrail(index + (sharedFolderId ? 1 : 0))}>
                        {item.name.length > 18 ? `…${item.name.slice(-17)}` : item.name}
                      </button>
                    </span>
                  ))}
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
                        · 所有者{" "}
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
            {!resourceId && (scope === "mail" || mailPage) && user && <span id="mail-header-actions" className="mail-header-actions" />}
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
                        分享与权限
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
                <MembershipLink vip={me?.entitlements?.vip} onError={setError} />
                <TodoIcon />
                <Notifications />
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
              <a href="#/home">登录 Doca</a>
            )}
          </div>
        </header>
        <AIDocumentLayout
          format={detail?.resource.kind === "document" ? detail.resource.format : undefined}
          surface={
            !resourceId && user && (scope === "files" || (scope === "shared-files" && !!sharedFolderId))
              ? "files"
              : !resourceId && user && (scope === "mail" || mailPage)
                ? "mail"
                : undefined
          }
        >
        {resourceId && <div id="editor-toolbar-slot" hidden={documentMode.readOnly} />}
        {error && <Feedback message={error} tone="error" />}
        <div
          className={
            "main-scroll" +
            (!resourceId && !backupPage && !["knowledge", "trash"].includes(scope) ? " dashboard-scroll-host" : "")
          }
        >
          {!resourceId && scope === "knowledge" && user ? (
            <KnowledgeRelations />
          ) : !resourceId && scope === "files" && user ? (
            <FilesExplorer onNavigationChange={setFileTrail} />
          ) : !resourceId && scope === "shared-files" && sharedFolderId && user ? (
            <FilesExplorer key={sharedFolderId} initialRoot={{ type: "folder", id: sharedFolderId, name: sharedFolderName }} routeBase={`/shared-files/${sharedFolderId}`} sharedRoot onNavigationChange={setFileTrail} />
          ) : !resourceId && scope === "shared-files" && user ? (
            <SharedFoldersPage />
          ) : !resourceId && (scope === "mail" || mailPage) && user ? (
            <MailApp mailboxId={mailId} preview={mailPreview} />
          ) : !resourceId && scope === "ai" ? (
            <AIChat full />
          ) : !resourceId && scope === "notes" && user ? (
            <Suspense fallback={<p className="empty">正在加载随手记…</p>}><QuickNotes key={user.id} userId={user.id} changed={() => setRefresh(n => n + 1)} /></Suspense>
          ) : ticketsPage ? (
            <Tickets ticketId={ticketId} />
          ) : backupPage ? (
            <CloudBackup />
          ) : resourceId ? (
            loading ? (
              <div className="empty">正在打开…</div>
            ) : detail ? (
              <>
                {detail.resource.kind === "library" ? (
                  librarySettingsPage ? (
                    <LibrarySettings detail={detail} changed={reload} />
                  ) : (
                    <LibraryLanding
                      resource={detail.resource}
                      create={() => create("document", detail.resource)}
                    />
                  )
                ) : (
                  <Suspense fallback={<p className="empty">正在加载编辑器…</p>}>
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
            <Dashboard
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
              setImportProgress({ phase: "parsing", message: "正在准备导入…" });
              const input = {
                ...creation,
                title:
                  file.name.replace(/\.(canvas\.)?[^.]+$/, "").slice(0, 200) ||
                  "未命名",
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
      {modal === "search" && (
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
            navigate("trash");
          }}
        />
      )}
      {(modal === "create" || modal === "rename") && (
        <Dialog
          title={
            modal === "rename"
              ? "重命名"
              : creation.kind === "library"
                ? "创建知识库"
                : "创建文档"
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
              名称
              <input
                name="title"
                required
                autoFocus
                maxLength={160}
                defaultValue={modal === "rename" ? detail?.resource.title : ""}
                placeholder="给内容起个名字"
              />
            </label>
            {modal === "create" && creation.kind === "document" && (
              <label>
                文档类型
                <Select name="format">
                  <option value="rich_text">文档</option>
                  <option value="spreadsheet">表格</option>
                  <option value="markdown">Markdown</option>
                  <option value="canvas">无限画板</option>
                  <option value="presentation">演示文稿</option>
                </Select>
              </label>
            )}
            <p className="subtle">
              {creation.parentId || creation.libraryId
                ? "默认继承所在目录的权限。"
                : "默认只有你能访问，之后可以邀请协作者。"}
            </p>
            {error && <Feedback message={error} tone="error" />}
            <footer>
              <button type="button" onClick={() => setModal("")}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                确定
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
  async function loadMore() {
    if (page.nextOffset === null) return;
    try {
      const params = new URLSearchParams({
        scope: selectedLibrary ? "all" : scope,
        q,
        offset: String(page.nextOffset),
        ...(format ? { format } : {}),
        ...(selectedLibrary ? { libraryId: selectedLibrary } : {}),
      });
      const d = await api<Page>(`/resources?${params}`);
      setPage({ ...d, items: [...page.items, ...d.items] });
    } catch (e) {
      setError(errorText(e));
    }
  }
}
function ResourceList({
  page,
  open,
  restore,
  loadMore,
}: {
  page: Page;
  open: (id: string) => void;
  restore: (r: Resource) => void;
  loadMore: () => void;
}) {
  return (
    <div className="resource-list">
      {!page.items.length ? (
        <div className="empty">
          <FolderOpen size={40} />
          <h3>这里还没有内容</h3>
          <p>新建内容，或调整搜索和筛选条件。</p>
        </div>
      ) : (
        <>
          <div className="list-header">
            <span>名称</span>
            <span>访问权限</span>
            <span>更新时间</span>
            <span />
          </div>
          {page.items.map((r) => (
            <div className="resource-row" key={r.id}>
              <button
                className="resource-name"
                disabled={!!r.deleted_at}
                onClick={() => open(r.id)}
              >
                <FileIcon r={r} />
                <span>
                  {r.title}
                  {r.kind === "library" && <small>知识库</small>}
                </span>
              </button>
              <span className="tag">
                {r.access_mode === "inherit"
                  ? "继承上级"
                  : r.visibility === "public"
                    ? "公开阅读"
                    : r.visibility === "authenticated"
                      ? "登录可见"
                      : "仅受邀者"}
              </span>
              <time>{new Date(r.updated_at).toLocaleDateString()}</time>
              {r.deleted_at ? (
                <button onClick={() => restore(r)}>恢复</button>
              ) : (
                <button
                  className="icon"
                  aria-label={`打开${r.title}`}
                  onClick={() => open(r.id)}
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </div>
          ))}
          {page.nextOffset !== null && (
            <button className="load-more" onClick={loadMore}>
              加载更多
            </button>
          )}
        </>
      )}
    </div>
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
          aria-label={detail.liked ? "取消点赞" : "点赞"}
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
            ? `${detail.likes} 人觉得有帮助`
            : "觉得有帮助，就点个赞吧"}
        </p>
        <LikePeople detail={detail} />
      </div>
      <h2>
        全文评论{" "}
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
          加载更多评论
        </button>
      )}
      {visibleCount >= detail.comments.length &&
        detail.commentsNextOffset != null && (
          <button
            className="comments-load-more"
            disabled={busy}
            onClick={() => void loadMoreComments?.()}
          >
            加载后续评论
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
          {user ? "你当前只有阅读权限。" : "登录并获得评论权限后即可参与讨论。"}
        </p>
      )}
    </section>
  );
}
function Notifications() {
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
    return unsubscribe;
  }, []);
  return (
    <div className="notifications" ref={panelRef}>
      <button
        className="icon notification-trigger"
        title="通知"
        aria-label={`通知 ${data.unread} 条未读`}
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
            <h3>通知</h3>
            <button
              className="text-button"
              disabled={!data.unread}
              onClick={() =>
                void api("/notifications/read-all", "POST", {})
                  .then(load)
                  .catch((e) => setError(e.message))
              }
            >
              全部已读
            </button>
          </header>
          {error && <Feedback message={error} tone="error" />}
          {!data.items.length && <p>暂时没有新通知</p>}
          {data.items.map((n) => {
            const baseDescription =
              (
                {
                  "comment.created": "评论了文档",
                  "comment.mentioned": "在评论中提及了你",
                  "document.mentioned": "在文档中提及了你",
                  "favorite.added": "收藏了文档",
                  "like.added": "赞了文档",
                  "resource.permissions_changed": "邀请你协作",
                  "resource.invited": "邀请你加入协作，请接受邀请",
                  "access.requested": "申请文档权限，待你处理",
                  "access.approved": "通过了你的权限申请",
                  "access.rejected": "未通过你的权限申请",
                  "invitation.accepted": "接受了协作邀请",
                  "invitation.rejected": "拒绝了协作邀请",
                  "resource.transferred": "文档已转交给你",
                  "ticket.updated": "工单状态已更新",
                  "ticket.reminded": "提醒你处理工单",
                  "access.cancelled": "权限申请已撤销",
                  "invitation.cancelled": "协作邀请已撤销",
                } as Record<string, string>
              )[n.type] ?? "文档动态更新";
            const grantedRole = n.grantedPermission?.role;
            const description = grantedRole ? `${baseDescription} · ${{ reader: "可阅读", commenter: "可评论", editor: "可编辑", manager: "可管理" }[grantedRole] ?? grantedRole}（${n.grantedPermission?.includeDescendants ? "包含子文档" : "仅当前节点"}）` : baseDescription;
            const documentTitle = n.title || (n.ticket_id ? "工单" : "未命名");
            const href = n.ticket_id
              ? `#/tickets/${n.ticket_id}`
              : n.type === "resource.invited" || n.type.startsWith("access.")
                ? "#/tickets"
                : `#/r/${n.resource_id}${n.comment_id ? `?comment=${encodeURIComponent(n.comment_id)}` : ""}`;
            return (
              <div
                key={n.id}
                className={"notification-row" + (n.read_at ? "" : " unread")}
              >
                <div className="notification-person">
                  <span
                    title={`${n.actorName ?? "系统"} ${description} · ${documentTitle}`}
                  >
                    <strong>{n.actorName ?? "系统"}</strong> {description}
                    <span className="notification-document">
                      {documentTitle}
                    </span>
                  </span>
                </div>
                <small title={n.created_at}>{relativeTime(n.created_at)}</small>
                {(n.ticket_id || n.resource_id) && (
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
                    查看
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
              加载更早的通知
            </button>
          )}
        </section>
      )}
    </div>
  );
}
function Account({ user, logout }: { user: User; logout: () => void }) {
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
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>修改密码</h2>
        <p className="subtle">成功后撤销所有设备上的登录会话。</p>

        <label>
          新密码
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
          修改密码并退出
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
        退出登录
      </button>
    </section>
  );
}
import { Tickets } from "@web/features/tickets/tickets.js";
