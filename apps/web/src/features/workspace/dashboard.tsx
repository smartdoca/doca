import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { useI18n } from "@web/shared/i18n.js";
import { htmlLang } from "@doca/i18n";
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
import { Dialog } from "@web/features/documents/dialogs.js";
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
  const { locale, t } = useI18n();
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
    [preview, setPreview] = useState<Resource | null>(null),
    [purgeTarget, setPurgeTarget] = useState<Resource | null>(null),
    [purgeBusy, setPurgeBusy] = useState(false);
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
    ? t("home.libraries")
    : trash
      ? t("nav.trash")
      : mine
        ? t("home.mine")
        : t("home.title");
  const home = !libraries && !trash && !mine;
  const tableHeader = (
    <div className="document-table-head">
      <span>{t("home.titleColumn")}</span>
      <span>{t("home.location")}</span>
      <span>{t("home.owner")}</span>
      <button onClick={() => setSort("created_at")}>{t("home.created")}</button>
      <button
        onClick={() =>
          setSort(sort === "visited_at" ? "updated_at" : "visited_at")
        }
      >
        {sort === "visited_at" ? t("home.visited") : t("home.modified")}
      </button>
      <span />
    </div>
  );
  return (
    <section
      className={`dashboard${trash ? " dashboard-trash" : ""}${!libraries && !trash && !mine ? " dashboard-home" : ""}`}
    >
      {preview && (
        <TrashPreview resource={preview} close={() => setPreview(null)} />
      )}
      {purgeTarget && (
        <Dialog
          title={t("home.purge")}
          close={() => {
            if (!purgeBusy) setPurgeTarget(null);
          }}
          className="modal-compact"
        >
          <p className="warning">
            {t("home.purgeBody", { title: purgeTarget.title })}
          </p>
          <Feedback message={error} tone="error" />
          <footer>
            <button
              type="button"
              disabled={purgeBusy}
              onClick={() => setPurgeTarget(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={purgeBusy}
              onClick={async () => {
                setPurgeBusy(true);
                setError("");
                try {
                  await api(`/resources/${purgeTarget.id}/purge`, "POST", {
                    version: purgeTarget.version,
                  });
                  setPurgeTarget(null);
                  setLocalRefresh((n) => n + 1);
                  changed();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setPurgeBusy(false);
                }
              }}
            >
              {purgeBusy ? t("home.purging") : t("home.purge")}
            </button>
          </footer>
        </Dialog>
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
              <strong>{libraries ? t("home.newLibrary") : t("home.newDocument")}</strong>
              <small>
                {libraries ? t("home.newLibraryHint") : t("home.newDocumentHint")}
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
              <strong>{libraries ? t("home.backWorkspace") : t("home.createLibrary")}</strong>
              <small>
                {libraries
                  ? t("home.backWorkspaceHint")
                  : t("home.createLibraryHint")}
              </small>
            </span>
            <ArrowUpRight size={17} />
          </button>
        </div>
      )}
      <div className="dashboard-controls">
        {!libraries && !trash && !mine && (
          <div className="home-tabs" role="tablist" aria-label={t("home.tabs")}>
            {(
              [
                ["recent", "home.tab.recent"],
                ["owned", "home.tab.owned"],
                ["shared", "home.tab.shared"],
                ["favorites", "home.tab.favorites"],
                ["favorite-libraries", "home.tab.libraries"],
              ] as const
            ).map(([key, label]) => (
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
                {t(label)}
              </button>
            ))}
          </div>
        )}
        <div className="dashboard-toolbar">
          {libraries ? (
            <h2>
              {t("home.allLibraries")} <small>{data.total}</small>
            </h2>
          ) : (
            <span className="subtle">{t("home.itemCount", { count: data.total })}</span>
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
              {t("home.searchLibraries")}
            </button>
          )}
          {!libraryCards && <TypeFilter value={format} change={setFormat} />}
          <label className="sort-select">
            <ArrowUpDown size={15} />
            <Select
              aria-label={t("home.sortField")}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="visited_at">{t("settings.sort.visited")}</option>
              <option value="created_at">{t("home.created")}</option>
              <option value="updated_at">{t("home.modified")}</option>
            </Select>
          </label>
          <Select
            aria-label={t("home.sortOrder")}
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          >
            <option value="desc">{t("settings.order.newest")}</option>
            <option value="asc">{t("settings.order.oldest")}</option>
          </Select>
        </div>
        {home && !libraryCards && tableHeader}
      </div>
        {error && <Feedback message={error} tone="error" />}
      {trash && <FileTrash />}
      <div className="dashboard-results" key={scope + format}>
        {loadedQuery !== query || (loading && !data.items.length) ? (
          <div className="empty">{t("common.loading")}</div>
        ) : !data.items.length ? (
          <div className="empty">
            <FolderOpen size={38} />
            <h3>
              {scope === "recent"
                ? t("home.emptyRecent")
                : libraries
                  ? t("home.emptyLibrary")
                  : t("home.empty")}
            </h3>
            <p>
              {scope === "recent"
                ? t("home.emptyRecentHint")
                : t("home.emptyHint")}
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
                    {t("home.libraries")} ·{" "}
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
                  <small>{t("common.updatedAt", { date: date(r.updated_at) })}</small>
                  <a
                    className="icon"
                    aria-label={t("home.settingsFor", { title: r.title })}
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
                    <span>{r.title}{r.kind === "library" && r.ai_curated ? ` · ${t("home.aiCurated")}` : ""}</span>
                  </button>
                  {home && (
                    <span className="table-row-actions">
                      <DocumentReactionButtons resource={r} size={14} onError={setError} />
                      {r.role === "owner" && (
                        <HoverTip label={t("common.delete")}>
                          <button
                            className="icon is-delete"
                            aria-label={t("home.deleteNamed", { title: r.title })}
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
                    r.libraryName ?? (r.inLibrary ? t("home.libraryDoc") : t("home.personalDoc"))
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
                        ? t("home.libraries")
                        : r.inLibrary || r.library_id
                          ? t("home.libraryDoc")
                          : t("home.personalDoc"))}{" "}
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
                <time title={new Date(r.created_at).toLocaleString(htmlLang(locale))}>
                  {date(r.created_at)}
                </time>
                <time
                  title={
                    (sort === "visited_at" ? r.visited_at : r.updated_at)
                      ? new Date(
                          (sort === "visited_at"
                            ? r.visited_at
                            : r.updated_at)!,
                        ).toLocaleString(htmlLang(locale))
                      : undefined
                  }
                >
                  {date(sort === "visited_at" ? r.visited_at : r.updated_at)}
                </time>
                {trash ? (
                  <div className="trash-row-actions">
                    <button
                      type="button"
                      onClick={() => void mutate(r, "restore")}
                    >
                      {t("common.restore")}
                    </button>
                    {roleRank(r.role) >= 5 && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setPurgeTarget(r)}
                      >
                        {t("common.delete")}
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    className="icon"
                    aria-label={t("home.openNamed", { title: r.title })}
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
            {t("common.more")}
          </button>
        )}
      </div>
    </section>
  );
}
export function CloudBackup() {
  const { t } = useI18n();
  return (
    <section className="dashboard">
      <div className="dashboard-heading">
        <h1>{t("backup.title")}</h1>
        <span className="tag">{t("backup.off")}</span>
      </div>
      <div className="backup-layout">
        <aside>
          <h3>{t("backup.folders")}</h3>
          <div>
            <FileText size={17} />
            {t("home.mine")}
          </div>
          <div>
            <BookOpen size={17} />
            {t("home.libraries")}
          </div>
        </aside>
        <div className="backup-empty">
          <Cloud size={58} />
          <h2>{t("backup.headline")}</h2>
          <p>{t("backup.body")}</p>
          <p className="subtle">
            {t("backup.note")}
          </p>
          <span className="tag">{t("backup.later")}</span>
        </div>
      </div>
    </section>
  );
}
