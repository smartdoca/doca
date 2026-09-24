import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { DocumentAuthor } from "@web/features/documents/document-author.js";
import { useEffect, useState } from "react";
import {
  BookOpen,
  FileText,
  Table2,
  Presentation,
  Plus,
  Search,
  Cloud,
  FolderOpen,
  Trash2,
  MoreHorizontal,
  ArrowUpDown,
  ArrowUpRight,
  ImagePlus,
  Pencil,
  Settings,
} from "lucide-react";
import {
  api,
  roleRank,
  type Page,
  type Resource,
  type Preferences,
} from "@web/shared/api.js";
import { GlobalSearch } from "@web/features/search/search.js";
export { GlobalSearch } from "@web/features/search/search.js";
import { FileIcon, TypeFilter } from "@web/features/documents/document-controls.js";
import { DocumentReactionButtons, type ReactionChange } from "@web/features/documents/document-reactions.js";
import { HoverTip } from "@web/shared/components/hover-tip.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import { assetUrl } from "@web/shared/api.js";
import { librarySettingsUrl } from "@web/features/documents/library.js";
import { listTime as date } from "@web/shared/utils/list-time.js";
import { EmptyTrash, FileTrash, TrashPreview } from "@web/features/trash/trash.js";

const empty: Page = { items: [], total: 0, nextOffset: null };
export function Dashboard({
  section,
  refresh,
  preferences,
  create,
  changed,
  currentUserId,
}: {
  section: string;
  refresh: number;
  preferences?: Preferences;
  create: (kind: "document" | "library") => void;
  changed: () => void;
  currentUserId?: string;
}) {
  const allowed = useEntitlements();
  const [tab, setTab] = useState("recent"),
    [format, setFormat] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [sort, setSort] = useState("visited_at"),
    [order, setOrder] = useState("desc"),
    [data, setData] = useState<Page>(empty),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [operation, setOperation] = useState<{
      resource: Resource;
      action: "rename" | "trash" | "restore" | "cover";
    } | null>(null),
    [localRefresh, setLocalRefresh] = useState(0),
    [preview, setPreview] = useState<Resource | null>(null);
  const libraries = section === "libraries",
    trash = section === "trash",
    mine = section === "mine",
    scope = libraries
      ? "libraries"
      : trash
        ? "trash"
        : mine
          ? "mine"
          : tab === "favorite-libraries"
            ? "favorites"
            : tab;
  const libraryCards =
    libraries || (!trash && !mine && tab === "favorite-libraries");
  const [loadedQuery, setLoadedQuery] = useState("");
  useEffect(() => {
    if (preferences) {
      setSort(tab === "recent" ? "visited_at" : preferences.default_sort);
      setOrder(preferences.sort_order);
    }
  }, [preferences?.default_sort, preferences?.sort_order, tab]);
  const query = new URLSearchParams({
    scope,
    sort,
    order,
    ...(!trash ? { kind: libraryCards ? "library" : "document" } : {}),
    ...(!libraryCards && format ? { format } : {}),
  }).toString();
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api<Page>("/resources?" + query, "GET", undefined, c.signal)
        .then((d) => {
          if (!c.signal.aborted) {
            setData(d);
            setLoadedQuery(query);
          }
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [query, refresh, localRefresh]);
  useEffect(() => {
    const onReaction = (event: Event) => {
      const change = (event as CustomEvent<ReactionChange>).detail;
      if (!change?.id) return;
      const drop =
        (scope === "favorites" && change.favorite === false) ||
        (scope === "pins" && change.pinned === false);
      setData((old) => {
        const present = old.items.some((item) => item.id === change.id);
        if (drop && present)
          return {
            ...old,
            total: Math.max(0, old.total - 1),
            items: old.items.filter((item) => item.id !== change.id),
          };
        if (
          !present &&
          change.resource &&
          ((scope === "favorites" && change.favorite) || (scope === "pins" && change.pinned))
        )
          return {
            ...old,
            total: old.total + 1,
            items: [{ ...change.resource } as Resource, ...old.items],
          };
        return {
          ...old,
          items: old.items.map((item) =>
            item.id === change.id
              ? {
                  ...item,
                  ...(change.favorite !== undefined ? { favorite: change.favorite } : {}),
                  ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
                }
              : item,
          ),
        };
      });
    };
    window.addEventListener("resource-reaction", onReaction);
    return () => window.removeEventListener("resource-reaction", onReaction);
  }, [scope]);
  async function mutate(r: Resource, action: "rename" | "trash" | "restore") {
    document
      .querySelectorAll<HTMLDetailsElement>("details.menu[open]")
      .forEach((x) => (x.open = false));
    setOperation({ resource: r, action });
  }
  async function more() {
    if (data.nextOffset === null) return;
    setLoading(true);
    try {
      const p = await api<Page>(
        "/resources?" + query + "&offset=" + data.nextOffset,
      );
      setData((old) => ({ ...p, items: [...old.items, ...p.items] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const heading = libraries
    ? "知识库"
    : trash
      ? "回收站"
      : mine
        ? "个人文档"
        : "主页";
  const home = !libraries && !trash && !mine;
  const tableHeader = (
    <div className="document-table-head">
      <span>标题</span>
      <span>位置</span>
      <span>所有者</span>
      <button onClick={() => setSort("created_at")}>创建时间</button>
      <button
        onClick={() =>
          setSort(sort === "visited_at" ? "updated_at" : "visited_at")
        }
      >
        {sort === "visited_at" ? "最近访问" : "修改时间"}
      </button>
      <span />
    </div>
  );
  return (
    <section
      className={`dashboard${!libraries && !trash && !mine ? " dashboard-home" : ""}`}
    >
      {preview && (
        <TrashPreview resource={preview} close={() => setPreview(null)} />
      )}
      {searchOpen && (
        <GlobalSearch
          close={() => setSearchOpen(false)}
          initialLocation="library"
        />
      )}
      {operation &&
        (operation.action === "cover" ? (
          <CoverDialog
            resource={operation.resource}
            close={() => setOperation(null)}
            saved={() => {
              setLocalRefresh((n) => n + 1);
              changed();
            }}
          />
        ) : (
          <ResourceActionDialog
            resource={operation.resource}
            action={operation.action}
            close={() => setOperation(null)}
            saved={() => {
              setLocalRefresh((n) => n + 1);
              changed();
            }}
          />
        ))}
      {!trash && (
        <div className="quick-actions">
          <button
            hidden={
              !allowed(libraries ? "libraries.create" : "documents.create")
            }
            onClick={() => create(libraries ? "library" : "document")}
          >
            <span className="quick-icon">
              <Plus size={23} />
            </span>
            <span>
              <strong>{libraries ? "新建知识库" : "新建文档"}</strong>
              <small>
                {libraries ? "让零散的资料变成知识" : "记录想法，开始轻量协作"}
              </small>
            </span>
            <ArrowUpRight size={17} />
          </button>
          <button
            hidden={!libraries && !allowed("libraries.create")}
            onClick={() =>
              libraries ? (location.hash = "/home") : create("library")
            }
          >
            <span className="quick-icon green">
              <BookOpen size={22} />
            </span>
            <span>
              <strong>{libraries ? "返回工作台" : "创建知识库"}</strong>
              <small>
                {libraries
                  ? "查看最近访问和共享内容"
                  : "整理项目资料，邀请协作者"}
              </small>
            </span>
            <ArrowUpRight size={17} />
          </button>
        </div>
      )}
      <div className="dashboard-controls">
        {!libraries && !trash && !mine && (
          <div className="home-tabs" role="tablist" aria-label="主页内容">
            {[
              ["recent", "最近访问"],
              ["owned", "归我所有"],
              ["shared", "与我共享"],
              ["favorites", "收藏文档"],
              ["favorite-libraries", "收藏知识库"],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? "active" : ""}
                onClick={() => {
                  setTab(key!);
                  if (key === "recent") setSort("visited_at");
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="dashboard-toolbar">
          {libraries ? (
            <h2>
              全部知识库 <small>{data.total}</small>
            </h2>
          ) : (
            <span className="subtle">{data.total} 项内容</span>
          )}
          <div className="grow" />
          {trash && (
            <EmptyTrash
              done={() => {
                setLocalRefresh((n) => n + 1);
                changed();
              }}
            />
          )}
          {libraries && (
            <button
              className="library-search-button"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
              搜索知识库内文档
            </button>
          )}
          {!libraryCards && <TypeFilter value={format} change={setFormat} />}
          <label className="sort-select">
            <ArrowUpDown size={15} />
            <Select
              aria-label="排序字段"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="visited_at">访问时间</option>
              <option value="created_at">创建时间</option>
              <option value="updated_at">修改时间</option>
            </Select>
          </label>
          <Select
            aria-label="排序顺序"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          >
            <option value="desc">最新在前</option>
            <option value="asc">最早在前</option>
          </Select>
        </div>
        {home && !libraryCards && tableHeader}
      </div>
        {error && <Feedback message={error} tone="error" />}
      {trash && <FileTrash />}
      <div className="dashboard-results" key={scope + format}>
        {loadedQuery !== query || (loading && !data.items.length) ? (
          <div className="empty">正在加载…</div>
        ) : !data.items.length ? (
          <div className="empty">
            <FolderOpen size={38} />
            <h3>
              {scope === "recent"
                ? "还没有访问记录"
                : libraries
                  ? "创建你的第一个知识库"
                  : "这里暂时没有内容"}
            </h3>
            <p>
              {scope === "recent"
                ? "打开个人文档或知识库中的文档后，会显示在这里。"
                : "新建内容，或调整筛选条件。"}
            </p>
          </div>
        ) : libraryCards ? (
          <div className="library-grid">
            {data.items.map((r, i) => (
              <article className="library-card" key={r.id}>
                <button
                  className={
                    "library-cover cover-" +
                    (i % 4) +
                    (r.cover_asset_id ? " has-image" : "")
                  }
                  onClick={() => {
                    location.hash = "/r/" + r.id;
                  }}
                >
                  {r.cover_asset_id && (
                    <img
                      className="library-cover-image"
                      src={assetUrl(r.cover_asset_id)}
                      alt=""
                    />
                  )}
                  <BookOpen size={30} />
                  <strong>{r.title}</strong>
                  <span>
                    知识库 ·{" "}
                    {r.owner_id && (
                      <DocumentAuthor
                        id={r.owner_id}
                        name={r.ownerName}
                        currentUserId={currentUserId}
                      />
                    )}
                  </span>
                </button>
                <div className="library-card-footer">
                  <small>更新于 {date(r.updated_at)}</small>
                  <a
                    className="icon"
                    aria-label={r.title + "的设置"}
                    href={librarySettingsUrl(r.id)}
                  >
                    <Settings size={18} />
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="document-table">
            {!home && tableHeader}
            {data.items.map((r) => (
              <div
                className="document-table-row"
                key={r.id}
                onClick={(e) => {
                  if (
                    (e.target as HTMLElement).closest(
                      "button,a,input,select,[role=button]",
                    )
                  )
                    return;
                  if (trash) setPreview(r);
                  else location.hash = "/r/" + r.id;
                }}
              >
                <div className="table-title-cell">
                  <button
                    className="table-title"
                    onClick={() => {
                      if (trash) setPreview(r);
                      else location.hash = "/r/" + r.id;
                    }}
                  >
                    <FileIcon r={r} />
                    <span>{r.title}</span>
                  </button>
                  {home && (
                    <span className="table-row-actions">
                      <DocumentReactionButtons resource={r} size={14} onError={setError} />
                      {r.role === "owner" && (
                        <HoverTip label="删除">
                          <button
                            className="icon is-delete"
                            aria-label={"删除" + r.title}
                            onClick={() => void mutate(r, "trash")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </HoverTip>
                      )}
                    </span>
                  )}
                </div>
                <span
                  className={`table-location ${r.inLibrary || r.library_id || r.kind === "library" ? "in-library" : "personal"}`}
                  title={
                    r.libraryName ?? (r.inLibrary ? "知识库文档" : "个人文档")
                  }
                >
                  {r.inLibrary || r.library_id || r.kind === "library" ? (
                    <BookOpen size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>
                    {r.libraryName ??
                      (r.kind === "library"
                        ? "知识库"
                        : r.inLibrary || r.library_id
                          ? "知识库文档"
                          : "个人文档")}{" "}
                  </span>
                </span>
                <span className="table-owner">
                  {r.owner_id && (
                    <DocumentAuthor
                      id={r.owner_id}
                      name={r.ownerName}
                      currentUserId={currentUserId}
                    />
                  )}
                </span>
                <time title={new Date(r.created_at).toLocaleString("zh-CN")}>
                  {date(r.created_at)}
                </time>
                <time
                  title={
                    (sort === "visited_at" ? r.visited_at : r.updated_at)
                      ? new Date(
                          (sort === "visited_at"
                            ? r.visited_at
                            : r.updated_at)!,
                        ).toLocaleString("zh-CN")
                      : undefined
                  }
                >
                  {date(sort === "visited_at" ? r.visited_at : r.updated_at)}
                </time>
                {trash ? (
                  <button onClick={() => void mutate(r, "restore")}>
                    恢复
                  </button>
                ) : (
                  <button
                    className="icon"
                    aria-label={"打开" + r.title}
                    onClick={() => {
                      location.hash = "/r/" + r.id;
                    }}
                  >
                    <ArrowUpRight size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {data.nextOffset !== null && (
          <button
            className="load-more"
            disabled={loading}
            onClick={() => void more()}
          >
            加载更多
          </button>
        )}
      </div>
    </section>
  );
}
export function CloudBackup() {
  return (
    <section className="dashboard">
      <div className="dashboard-heading">
        <h1>云备份</h1>
        <span className="tag">尚未启用</span>
      </div>
      <div className="backup-layout">
        <aside>
          <h3>备份目录</h3>
          <div>
            <FileText size={17} />
            个人文档
          </div>
          <div>
            <BookOpen size={17} />
            知识库
          </div>
        </aside>
        <div className="backup-empty">
          <Cloud size={58} />
          <h2>你的桌面资料，安全留一份</h2>
          <p>这里将展示桌面端备份的个人文档和知识库目录。</p>
          <p className="subtle">
            目前尚无桌面同步接入，这里不是在线文档库。备份文件只用于恢复，复制成独立文档后才能编辑。
          </p>
          <span className="tag">云端主体完成后再接入备份与恢复</span>
        </div>
      </div>
    </section>
  );
}
