import { openSearchDocument } from "./document-search-navigation.js";
import { searchableSources, contentQuerySources } from "./content-search.js";
import type { ContentItem, ContentSourceDescriptor } from "@smartdoca/plugin-sdk/content";
import { htmlLang } from "@doca/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Search, ArrowUpRight, Folder, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { SearchOwnerFilter, type SearchOwner } from "@web/features/search/search-owner-filter.js";
import { api, assetUrl, fileUrl, type FileItem, type Page, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Select } from "antd";
import { FileIcon } from "@web/features/documents/document-controls.js";
import {
  searchIntent,
  searchResultLayout,
} from "@core/modules/discovery/search-intent.js";
import { textMentionsTopic } from "@core/modules/discovery/search-excerpts.js";
import { FileGlyph, type FileLocation } from "@web/features/files/files.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";
import "@web/features/search/search.css";

const searchPopupContainer = (trigger: HTMLElement) =>
  trigger.closest<HTMLElement>(".ant-popover") ?? document.body;
type SearchPage = Omit<Page, "items"> & {
  items: (Resource & {
    summary?: string;
    summaryMatches?: SearchMatch[];
    titleMatches?: SearchMatch[];
  })[];
  notice?: string;
  mode?: string;
  nextOffset?: number | null;
};
type SearchMatch = { start: number; length: number };
type FileSearchResult = {
  storageObjectId: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  parentType: string;
  parentId: string;
  updatedAt: string;
  description?: string | null;
  locations: Array<{ id: string; name: string; parentType: string; parentId: string; navigation: FileLocation[]; sharedRoot?: { id: string; name: string } | null }>;
};

function openFileLocation(location: FileSearchResult["locations"][number]) {
  if (location.parentType === "document") {
    window.location.hash = `/r/${location.parentId}`;
    return;
  }
  const path = encodeURIComponent(JSON.stringify(location.navigation));
  const base = location.sharedRoot ? `/shared-files/${location.sharedRoot.id}?name=${encodeURIComponent(location.sharedRoot.name)}&` : "/files?";
  window.location.hash = `${base}path=${path}&focus=${encodeURIComponent(location.id)}`;
}

function SearchDocumentIcon({ resource }: { resource: Resource }) {
  if (resource.cover_asset_id) return <span className="search-document-cover"><img src={assetUrl(resource.cover_asset_id)} alt="" loading="lazy" /></span>;
  return <FileIcon r={resource} />;
}
function MatchedText({
  text,
  matches = [],
}: {
  text: string;
  matches?: SearchMatch[];
}) {
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (
      !Number.isInteger(match.start) ||
      !Number.isInteger(match.length) ||
      match.start < cursor ||
      match.length <= 0 ||
      match.start + match.length > text.length
    )
      continue;
    parts.push(text.slice(cursor, match.start));
    parts.push(
      <mark key={match.start}>
        {text.slice(match.start, match.start + match.length)}
      </mark>,
    );
    cursor = match.start + match.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
function fileAsGlyph(file: FileSearchResult): FileItem {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    locked: false,
    version: 1,
    created_at: file.updatedAt,
    updated_at: file.updatedAt,
    ai_description: file.description ?? null,
    ai_status: file.description ? "ready" : "skipped",
    preview_url: fileUrl(file.id),
  };
}

function documentIdsOf(file: FileSearchResult) {
  return file.locations
    .filter((location) => location.parentType === "document")
    .map((location) => location.parentId);
}
function CompactResultText({ text, query }: { text: string; query: string }) {
  const normalized = query.toLocaleLowerCase()
    .replace(/(图片|照片|图像|文件|文档|帮我|搜索|查找|找一下|找一张|找一个|一张|一只|一个|关于|相关)/g, " ")
    .replace(/(.)\1+/gu, "$1")
    .trim();
  const terms = [...new Set([query.trim().toLocaleLowerCase(), normalized, ...normalized.split(/[\s,，。！？、]+/u)].filter(Boolean))].sort((a, b) => b.length - a.length);
  const lower = text.toLocaleLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
  const max = 128;
  const start = hit < 0 ? 0 : Math.max(0, hit - 36);
  const core = text.slice(start, start + max);
  const excerpt = `${start ? "…" : ""}${core}${start + max < text.length ? "…" : ""}`;
  const matches: SearchMatch[] = [];
  const excerptLower = excerpt.toLocaleLowerCase();
  for (const term of terms) {
    let offset = 0;
    while (term && (offset = excerptLower.indexOf(term, offset)) >= 0) {
      if (!matches.some((match) => offset < match.start + match.length && offset + term.length > match.start)) matches.push({ start: offset, length: term.length });
      offset += term.length;
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return <MatchedText text={excerpt} matches={matches} />;
}
const empty: SearchPage = { items: [], total: 0, nextOffset: null };
type SearchPanelProps = {
  initialLibraryIds?: string[];
  initialLocation?: "all" | "personal" | "library";
  initialQuery?: string;
  select: (resource: Resource, query: string) => void;
  compact?: boolean;
};

export function GlobalSearch({
  close,
  select,
  ...props
}: Omit<SearchPanelProps, "select" | "compact"> & {
  close: () => void;
  select?: (resource: Resource) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={t("search.title")} close={close} className="search-dialog">
      <SearchPanel
        {...props}
        select={(resource, query) => {
          if (select) select(resource);
          else openSearchDocument(resource, query);
          close();
        }}
      />
    </Dialog>
  );
}

// The global dialog and AI reference popover share search, filters and pagination.
export function SearchPanel({
  initialLibraryIds = [],
  initialLocation = "all",
  initialQuery = "",
  select,
  compact = false,
}: SearchPanelProps) {
  const { t, locale } = useI18n();
  const [publicDiscovery, setPublicDiscovery] = useState(false);
  useEffect(() => {
    void api<{ publicModes: Record<string,string> }>("/discovery/policy")
      .then((p) => setPublicDiscovery(Object.values(p.publicModes).includes("search")))
      .catch(() => {});
  }, []);
  const [q, setQ] = useState(initialQuery),
    [aiSearch, setAiSearch] = useState(false),
    [submitted, setSubmitted] = useState(""),
    [searchAttempt, setSearchAttempt] = useState(0),
    [contentMode, setContentMode] = useState<"all" | "documents" | "files">("all"),
    [format, setFormat] = useState(""),
    [scope, setScope] = useState("all"),
    [location, setLocation] = useState(
      initialLibraryIds.length ? "library" : initialLocation,
    ),
    [libraryIds, setLibraryIds] = useState(initialLibraryIds),
    [owners, setOwners] = useState<SearchOwner[]>([]),
    [visitedDays, setVisitedDays] = useState(0),
    [likedOnly, setLikedOnly] = useState(false),
    [favoritesOnly, setFavoritesOnly] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false),
    [libraries, setLibraries] = useState<Resource[]>([]),
    [libraryError, setLibraryError] = useState(""),
    [librariesLoading, setLibrariesLoading] = useState(true),
    [libraryRetry, setLibraryRetry] = useState(0),
    [data, setData] = useState<SearchPage>(empty),
    [fileResults, setFileResults] = useState<FileSearchResult[]>([]),
    [error, setError] = useState(""),
    [aiUnavailable, setAiUnavailable] = useState(""),
    [loading, setLoading] = useState(false);
  const [contentResults, setContentResults] = useState<ContentItem[]>([]);
  const [contentSearchError, setContentSearchError] = useState("");
  const [contentSources, setContentSources] = useState<ContentSourceDescriptor[]>([]);
  const [contentCatalogError, setContentCatalogError] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const searchLoading = loading || contentLoading;
  useEffect(() => {
    if (compact) return;
    const controller = new AbortController();
    setContentCatalogError("");
    void api<{ items: ContentSourceDescriptor[] }>("/content/sources?purpose=search", "GET", undefined, controller.signal)
      .then(catalog => {
        if (!controller.signal.aborted) {
          const sources = searchableSources(catalog.items);
          setContentSources(sources);
          setSelectedSourceId(current => sources.some(source => source.id === current) ? current : null);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setContentCatalogError(t("content.searchUnavailable")); });
    return () => controller.abort();
  }, [compact, searchAttempt, t]);
  const filtersId = useId();
  const resultList = useRef<HTMLDivElement>(null);
  const typeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const types: { value: string; label: string; sourceId?: string }[] = [
    { value: "all", label: t("search.type.all") },
    { value: "documents", label: t("workspace.kind.document") },
    { value: "files", label: t("search.type.files") },
    ...contentSources.map(source => ({ value: `source:${source.id}`, sourceId: source.id, label: locale === "zh" ? source.title.zh : source.title.en })),
  ];
  const documentTypes: { value: string; label: MessageKey }[] = [
    { value: "", label: "doc.filter.all" },
    { value: "rich_text", label: "shell.type.rich" },
    { value: "markdown", label: "shell.type.markdown" },
    { value: "spreadsheet", label: "shell.type.sheet" },
    { value: "presentation", label: "shell.type.slides" },
    { value: "canvas", label: "search.type.canvas" },
  ];
  const filterCount =
    Number(format !== "") +
    Number(scope !== "all") +
    Number(location !== "all") +
    libraryIds.length +
    owners.length +
    Number(visitedDays > 0) +
    Number(likedOnly) +
    Number(favoritesOnly);
  function resetFilters() {
    setFormat("");
    setScope("all");
    setLocation("all");
    setLibraryIds([]);
    setOwners([]);
    setVisitedDays(0);
    setLikedOnly(false);
    setFavoritesOnly(false);
  }
  const searchText = aiSearch ? submitted : q;
  const intent = searchIntent(searchText);
  const layout = selectedSourceId
    ? { nestFiles: false, showDocuments: false, showFileHits: false, format: "", formatConflict: false }
    : searchResultLayout(intent, contentMode, format);
  const selectedType = selectedSourceId ? `source:${selectedSourceId}` : contentMode;
  function selectType(type: (typeof types)[number]) {
    setSelectedSourceId(type.sourceId ?? null);
    setContentMode(type.sourceId ? "all" : type.value as "all" | "documents" | "files");
    setFormat("");
    if (type.sourceId) {
      resetFilters();
      setFiltersOpen(false);
    }
  }
  const retrievalText = intent.topic || searchText;
  const recent =
    !selectedSourceId &&
    !aiSearch &&
    !searchText.trim() &&
    !format &&
    scope === "all" &&
    location === "all" &&
    !libraryIds.length &&
    !owners.length &&
    !visitedDays &&
    !likedOnly &&
    !favoritesOnly;
  const waitingForAiQuery = aiSearch && !submitted.trim();
  const params = new URLSearchParams({
    q: searchText,
    mode: aiSearch ? "ai" : "keyword",
    scope: recent ? "recent" : scope,
    ...(layout.format ? { format: layout.format } : {}),
    ...(visitedDays ? { visitedWithinDays: String(visitedDays) } : {}),
    ...(likedOnly ? { likedOnly: "true" } : {}),
    ...(favoritesOnly ? { favoritesOnly: "true" } : {}),
    ...(location !== "all" ? { location } : {}),
  });
  owners.forEach((u) => params.append("ownerIds", u.id));
  libraryIds.forEach((id) => params.append("libraryIds", id));
  const fileParams = new URLSearchParams({
    q: retrievalText,
    limit: "50",
    mode: aiSearch ? "ai" : "keyword",
    ...(scope !== "all" ? { scope } : {}),
    ...(location !== "all" ? { location } : {}),
  });
  owners.forEach((u) => fileParams.append("ownerIds", u.id));
  libraryIds.forEach((id) => fileParams.append("libraryIds", id));
  const query = params.toString(),
    currentQuery = useRef(query);
  currentQuery.current = query;
  useEffect(() => {
    const c = new AbortController();
    setLibrariesLoading(true);
    setLibraryError("");
    void (async () => {
      const all: Resource[] = [];
      let cursor: string | undefined;
      do {
        const p: Page = await api(
          "/resources?scope=libraries" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          "GET",
          undefined,
          c.signal,
        );
        all.push(...p.items);
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      if (!c.signal.aborted) setLibraries(all);
    })()
      .catch((e) => {
        if (e.name !== "AbortError") setLibraryError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLibrariesLoading(false);
      });
    return () => c.abort();
  }, [libraryRetry]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(!waitingForAiQuery);
    setError("");
    setAiUnavailable("");
    setData(empty);
    setFileResults([]);
    if (resultList.current) resultList.current.scrollTop = 0;
    if (waitingForAiQuery) return () => c.abort();
    const timer = setTimeout(
      () =>
        void Promise.all([
          layout.showDocuments
            ? api<SearchPage>("/search/documents?" + query, "GET", undefined, c.signal).catch((e) => {
                if (e.name === "AbortError") throw e;
                if (aiSearch) {
                  setAiUnavailable(e.message);
                  return empty;
                }
                throw e;
              })
            : Promise.resolve(empty),
          (layout.showFileHits || layout.nestFiles) &&
          searchText.trim()
            ? api<{ items: FileSearchResult[] }>("/files/search?" + fileParams, "GET", undefined, c.signal)
            : Promise.resolve({ items: [] as FileSearchResult[] }),

        ])
          .then(([page, files]) => {
            if (!c.signal.aborted) {
              setData(page);
              setFileResults(files.items);
            }
          })
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
          })
          .finally(() => {
            if (!c.signal.aborted) setLoading(false);
          }),
      180,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [aiSearch, waitingForAiQuery, contentMode, selectedSourceId, query, searchAttempt, fileParams.toString()]);
  useEffect(() => {
    const controller = new AbortController();
    setContentResults([]);
    setContentSearchError("");
    setContentLoading(false);
    const sources = contentQuerySources(contentSources, { compact, contentMode, selectedSourceId, filterCount });
    if (!sources.length || !searchText.trim() || waitingForAiQuery) return () => controller.abort();
    setContentLoading(true);
    const timer = setTimeout(() => void (async () => {
      const results = await Promise.allSettled(sources.map(source =>
        api<{ items: ContentItem[] }>("/content/search", "POST", { sourceId: source.id, purpose: "search", config: {}, query: searchText, cursor: null, limit: 20 }, controller.signal)));
      if (controller.signal.aborted) return;
      setContentResults(results.flatMap(result => result.status === "fulfilled" ? result.value.items : []));
      if (results.some(result => result.status === "rejected")) setContentSearchError(t("content.searchUnavailable"));
    })().catch(() => { if (!controller.signal.aborted) setContentSearchError(t("content.searchUnavailable")); }).finally(() => { if (!controller.signal.aborted) setContentLoading(false); }), 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [compact, contentMode, selectedSourceId, contentSources, filterCount, searchText, waitingForAiQuery, searchAttempt, t]);
  async function openContent(item: ContentItem) {
    try {
      const target = await api<{ path: string; fingerprint: string } | null>("/content/resolve", "POST", { ref: item.ref, purpose: "search" });
      if (!target) throw new Error(t("content.unavailable"));
      window.location.hash = target.path;
    } catch (reason) { setContentSearchError((reason as Error).message); }
  }
  async function more() {
    if (data.nextCursor == null && data.nextOffset == null) return;
    setLoading(true);
    try {
      const page = data.nextCursor
        ? "&cursor=" + encodeURIComponent(data.nextCursor)
        : "&offset=" + data.nextOffset;
      const p = await api<SearchPage>(
        "/search/documents?" + query + page,
      );
      if (currentQuery.current === query)
        setData((old) => ({ ...p, total: p.total ?? old.total, items: [...old.items, ...p.items] }));
    } catch (e) {
      if (currentQuery.current === query) setError((e as Error).message);
    } finally {
      if (currentQuery.current === query) setLoading(false);
    }
  }
  const { nestFiles, showFileHits } = layout;
  const matchesEvidence = (file: FileSearchResult) =>
    (!intent.media || intent.media !== "image" || file.mime.startsWith("image/")) &&
    textMentionsTopic(
      [file.name, file.description].filter(Boolean).join("\n"),
      intent.topic || searchText,
    );
  const filesByDocument = new Map<string, FileSearchResult[]>();
  if (nestFiles) {
    const docIds = new Set(data.items.map((item) => item.id));
    for (const file of fileResults) {
      if (!matchesEvidence(file)) continue;
      const parents = documentIdsOf(file).filter((id) => docIds.has(id));
      if (!parents.length) continue;
      for (const id of parents) {
        const list = filesByDocument.get(id) ?? [];
        if (!list.some((item) => item.storageObjectId === file.storageObjectId))
          list.push(file);
        filesByDocument.set(id, list);
      }
    }
  }
  const leftoverFiles = showFileHits
    ? fileResults.filter((file) => {
        if (!matchesEvidence(file)) return false;
        return !documentIdsOf(file).some((id) => filesByDocument.has(id));
      })
    : [];
  const resultCount = data.items.length + leftoverFiles.length + contentResults.length;
  return (
    <div className={`global-search ${compact ? "search-panel-compact" : ""} ${aiSearch ? "search-ai" : "search-keyword"}`}>
      <form
        className="search-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim() && !searchLoading) {
            setSubmitted(q.trim());
            setSearchAttempt((n) => n + 1);
          }
        }}
      >
        <Search size={21} />
        <input
          autoFocus
          aria-label={aiSearch ? t("search.queryAi") : t("search.query")}
          placeholder={aiSearch ? t("search.placeholderAi") : t("search.placeholder")}
          maxLength={500}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="search-mode-switch" role="tablist" aria-label={t("search.mode")}>
          <button
            type="button"
            role="tab"
            aria-selected={!aiSearch}
            onClick={() => {
              setAiSearch(false);
              setSubmitted("");
              setAiUnavailable("");
            }}
          >
            {t("search.keyword")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={aiSearch}
            onClick={() => {
              setAiSearch(true);
              setSubmitted("");
              setAiUnavailable("");
            }}
          >
            <Sparkles size={13} />
            AI
          </button>
        </div>
        <button
          type="submit"
          className="primary"
          disabled={!q.trim() || searchLoading}
        >
          {t("search.ai")}
        </button>
      </form>
      {aiSearch && (
        <p className="search-ai-hint">
          {t("search.aiHint")}
        </p>
      )}
      <div className="search-type-bar">
        <div className="search-type-tabs" role="tablist" aria-label={t("search.types")}>
          {types.map((type, index) => (
            <button
              key={type.value}
              type="button"
              role="tab"
              aria-selected={selectedType === type.value}
              tabIndex={selectedType === type.value ? 0 : -1}
              ref={(el) => {
                typeButtons.current[index] = el;
              }}
              onClick={() => {
                selectType(type);
              }}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight"
                    ? (index + 1) % types.length
                    : e.key === "ArrowLeft"
                      ? (index + types.length - 1) % types.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? types.length - 1
                          : -1;
                if (next >= 0) {
                  e.preventDefault();
                  selectType(types[next]!);
                  typeButtons.current[next]?.focus();
                }
              }}
            >
              {type.label}
            </button>
          ))}
        </div>
        {!selectedSourceId && <button
          className="search-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <SlidersHorizontal size={15} />
          {filterCount ? t("search.filtersCount", { count: filterCount }) : t("search.filters")}
        </button>}
      </div>
      <div className={`search-body ${selectedSourceId ? "search-source-body" : ""}`}>
        <div className="search-main">
          <div className="search-result-heading" role="status">
            <span>
              {waitingForAiQuery
                ? t("search.lookingAi")
                : searchLoading && !resultCount
                  ? t("search.looking")
                  : recent
                    ? t("search.recentHeading")
                  : !contentResults.length && leftoverFiles.length && data.items.length
                    ? t("search.foundMixed", { documents: data.items.length, files: leftoverFiles.length })
                  : !contentResults.length && layout.showDocuments && !layout.showFileHits && data.items.length
                    ? t("search.foundDocs", { count: data.items.length })
                  : !contentResults.length && layout.showFileHits && !layout.showDocuments && leftoverFiles.length
                    ? t("search.foundFiles", { count: leftoverFiles.length })
                    : t("search.foundItems", { count: resultCount })}
            </span>
            <span>
              {waitingForAiQuery
                ? ""
                : aiSearch && searchText.trim()
                  ? t("search.sortSemantic")
                  : searchText.trim()
                    ? t("search.sortKeyword")
                    : t("search.permittedOnly")}
            </span>
          </div>
          <div
            className="search-results"
            ref={resultList}
            aria-busy={searchLoading}
            aria-label={t("search.results")}
          >
            {error && (
              <p className="search-inline-error" role="alert">
                {error}
              </p>
            )}
            {contentCatalogError && <p role="status">{contentCatalogError}</p>}
            {contentSearchError && <p role="status">{contentSearchError}</p>}
            {contentResults.map(item => <button className="search-content-result" key={JSON.stringify(item.ref)} onClick={() => void openContent(item)}>
              <strong>{item.title}</strong>
              <span><CompactResultText text={item.excerpt ?? ""} query={searchText} /></span>
            </button>)}
            {aiUnavailable && (
              <div className="search-ai-empty" role="status">
                <Sparkles size={22} />
                <strong>{t("search.aiDown")}</strong>
                <p>{t("search.aiDownHint")}</p>
                {fileResults.length ? (
                  <p>{t("search.aiDownFiles")}</p>
                ) : null}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setAiSearch(false);
                    setAiUnavailable("");
                  }}
                >
                  {t("search.useKeyword")}
                </button>
              </div>
            )}
            {waitingForAiQuery && (
              <div className="search-ai-empty" role="status">
                <Sparkles size={22} />
                <strong>{t("search.describe")}</strong>
                <p>{t("search.describeHint")}</p>
              </div>
            )}
            {data.notice && (
              <p className="search-notice" role="status">
                {data.notice}
              </p>
            )}
            {layout.showDocuments && data.items.map((r) => {
              const evidence = nestFiles ? filesByDocument.get(r.id) ?? [] : [];
              return (
                <div className="search-hit" key={r.id}>
                  <button
                    className="search-result"
                    onClick={() => {
                      select(r, aiSearch ? "" : searchText.trim());
                    }}
                  >
                    <SearchDocumentIcon resource={r} />
                    <span>
                      <strong>
                        <MatchedText text={r.title} matches={r.titleMatches} />
                      </strong>
                      <span className="search-result-summary">
                        <MatchedText
                          text={r.summary || t("search.noSummary")}
                          matches={r.summaryMatches}
                        />
                      </span>
                      <small>
                        {r.libraryName ?? (r.inLibrary ? t("search.libraryDoc") : t("search.personalDoc"))}
                        {r.aiCurated ? ` · ${t("search.aiCurated")}` : ""}{" "}
                        ·{" "}
                        {r.owner_id && (
                          <UserBadge id={r.owner_id} name={r.ownerName} />
                        )}{" "}
                        · {t("search.updated", { date: new Date(r.updated_at).toLocaleDateString(htmlLang(locale)) })}
                        {evidence.length ? ` · ${t("search.matchedFiles", { count: evidence.length })}` : ""}
                      </small>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                  {evidence.length > 0 && (
                    <div className="search-result-evidence">
                      <span>{t("search.inDocument")}</span>
                      {evidence.slice(0, 4).map((file) => {
                        const location =
                          file.locations.find(
                            (item) =>
                              item.parentType === "document" && item.parentId === r.id,
                          ) ?? file.locations[0];
                        return (
                          <button
                            key={file.storageObjectId}
                            type="button"
                            title={file.name}
                            onClick={() => location && openFileLocation(location)}
                          >
                            <FileGlyph file={fileAsGlyph(file)} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {layout.showFileHits && leftoverFiles.length > 0 && <div className="search-file-group"><strong>{t("search.files")}</strong>{leftoverFiles.map((file) => <div className="search-file-card" key={file.storageObjectId}>
              <button className="search-result search-file-result" onClick={() => file.locations[0] && openFileLocation(file.locations[0])}>
                <FileGlyph file={fileAsGlyph(file)} />
                <span><strong><CompactResultText text={file.name} query={searchText} /></strong><span className="search-result-summary"><CompactResultText text={file.description || file.mime} query={searchText} /></span><small>{t("search.places", { count: file.locations.length })} · {t("search.updated", { date: new Date(file.updatedAt).toLocaleDateString(htmlLang(locale)) })}</small></span>
                <ArrowUpRight size={15} />
              </button>
              <div className="search-file-locations"><span>{t("search.locations")}</span>{file.locations.map((location) => <button key={location.id} onClick={() => openFileLocation(location)} title={location.navigation.map((item) => item.name).join(" / ")}><Folder size={12} />{location.navigation.map((item) => item.name).join(" / ") || location.name}</button>)}</div>
            </div>)}</div>}

            {!searchLoading &&
              !error &&
              !waitingForAiQuery &&
              !aiUnavailable &&
              !contentCatalogError &&
              !contentSearchError &&
              !resultCount && (
              <p className="empty">
                {aiSearch
                  ? t("search.emptyAi")
                  : t("search.empty")}
              </p>
            )}
            {(data.nextCursor != null || data.nextOffset != null) && (
              <button
                className="load-more"
                disabled={loading}
                onClick={() => void more()}
              >
                {loading ? t("common.loading") : t("search.moreDocs")}
              </button>
            )}
          </div>
        </div>
        {!selectedSourceId && <aside
          id={filtersId}
          className={`search-sidebar ${filtersOpen ? "is-open" : ""}`}
          aria-label={t("search.extraFilters")}
        >
          <div className="search-sidebar-heading">
            <strong>{filterCount ? t("search.filterTitleCount", { count: filterCount }) : t("search.filterTitle")}</strong>
            <button onClick={resetFilters}>{t("search.reset")}</button>
            <button
              className="search-sidebar-close"
              aria-label={t("search.hideFilters")}
              onClick={() => setFiltersOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          {contentMode !== "files" && (
            <div className="search-filter-field">
              <span>{t("doc.filterType")}</span>
              <Select
                aria-label={t("doc.filterType")}
                value={layout.format || format}
                onChange={(value) => {
                  setFormat(value);
                  if (value) setContentMode("documents");
                }}
                getPopupContainer={searchPopupContainer}
                options={documentTypes.map(type => ({ value: type.value, label: t(type.label) }))}
              />
            </div>
          )}
          <div className="search-filter-field">
            <span>{t("search.owner")}</span>
            <SearchOwnerFilter value={owners} onChange={setOwners} />
          </div>
          <div className="search-filter-field">
            <span>{t("search.scope")}</span>
            <Select
              aria-label={t("search.scope")}
              value={scope}
              onChange={setScope}
              getPopupContainer={searchPopupContainer}
              options={[
                { value: "all", label: t("discovery.searchAll") },
                { value: "personal", label: t("search.scopeMine") },
                { value: "owned", label: t("search.scopeOwned") },
                { value: "shared", label: t("search.scopeShared") },
                ...(publicDiscovery
                  ? [{ value: "public", label: t("discovery.searchPublic") }]
                  : []),
              ]}
            />
          </div>
          <div className="search-filter-field">
            <span>{t("search.location")}</span>
            <Select
              aria-label={t("search.location")}
              value={location}
              onChange={(value) => {
                setLocation(value);
                if (value !== "library") setLibraryIds([]);
              }}
              getPopupContainer={searchPopupContainer}
              options={[
                { value: "all", label: t("search.locationAll") },
                { value: "personal", label: t("search.locationPersonal") },
                { value: "library", label: t("search.locationLibrary") },
              ]}
            />
          </div>
          <div className="search-filter-field">
            <span>{t("search.library")}</span>
            <Select
              mode="multiple"
              allowClear
              showSearch
              aria-label={t("search.library")}
              placeholder={t("search.libraryPlaceholder")}
              value={libraryIds}
              loading={librariesLoading}
              optionFilterProp="label"
              maxCount={50}
              maxTagCount="responsive"
              getPopupContainer={searchPopupContainer}
              options={libraries.map((lib) => ({
                value: lib.id,
                label: lib.title,
              }))}
              onChange={(ids) => {
                setLibraryIds(ids);
                if (ids.length) setLocation("library");
              }}
              notFoundContent={
                librariesLoading ? t("common.loading") : t("search.libraryEmpty")
              }
            />
            {libraryError && (
              <>
                <p className="search-inline-error" role="alert">
                  {libraryError}
                </p>
                <button onClick={() => setLibraryRetry((n) => n + 1)}>
                  {t("search.libraryReload")}
                </button>
              </>
            )}
          </div>
          <fieldset className="search-visit-filter">
            <legend>{t("search.visited")}</legend>
            <div className="search-day-options">
              {[0, 1, 7, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={visitedDays === days}
                  onClick={() => setVisitedDays(days)}
                >
                  {days ? t("search.days", { count: days }) : t("search.anyTime")}
                </button>
              ))}
            </div>
            <label className="search-custom-days">
              <span>{t("search.recent")}</span>
              <input
                type="number"
                aria-label={t("search.visitedDays")}
                placeholder={t("search.anyTime")}
                min={1}
                max={3650}
                step={1}
                value={visitedDays || ""}
                onChange={(e) =>
                  setVisitedDays(
                    e.target.value
                      ? Math.min(
                          3650,
                          Math.max(1, Math.floor(Number(e.target.value) || 1)),
                        )
                      : 0,
                  )
                }
              />
              <span>{t("search.visitedWithin")}</span>
            </label>
          </fieldset>
          <fieldset className="search-reaction-filter">
            <legend>{t("search.activity")}</legend>
            <label>
              <input
                type="checkbox"
                checked={likedOnly}
                onChange={(e) => setLikedOnly(e.target.checked)}
              />
              {t("search.liked")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(e) => setFavoritesOnly(e.target.checked)}
              />
              {t("search.favorited")}
            </label>
          </fieldset>
        </aside>}
      </div>
    </div>
  );
}
