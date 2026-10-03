import { Popover, Select } from "antd";
import { Search, X, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useI18n } from "@web/shared/i18n.js";
import { api, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import type {
  CreationResourceResult,
  MaterialSearchPage,
  MaterialRetrievalPage,
  MaterialCollectionResult,
  MaterialTagPage,
  ResourceRetrievalPage,
  ResourceProviderDescriptor,
  ResourcePage,
  ResourceTag,
  ResourceType,
  TemplateSelection,
  TemplatePayload,
  JsonObject,
  ResourceSort,
  ResourceSourceInfo,
} from "@smartdoca/plugin-contracts";
import type {
  PluginTemplatePickerProps,
  PluginMaterialPickerProps,
} from "@smartdoca/plugin-sdk/web";
import "./pickers.css";
const Surface = lazy(() =>
  import("@web/features/documents/template-surfaces.js").then((m) => ({
    default: m.TemplateSurface,
  })),
);
export type ResourceRequest = <T>(
  operation: string,
  input: unknown,
  signal?: AbortSignal,
) => Promise<T>;
const request: ResourceRequest = (operation, input, signal) =>
  api(
    `/creation-resources/${operation.replace(".", "/")}`,
    "POST",
    input,
    signal,
  );
export function CreationTemplatePicker(
  props: PluginTemplatePickerProps & { request?: ResourceRequest },
) {
  return (
    <ResourceBrowser
      kind="templates"
      {...props}
      choose={props.select}
      blank={props.blank}
    />
  );
}
export function MaterialPicker(
  props: PluginMaterialPickerProps & { request?: ResourceRequest },
) {
  const send = props.request ?? request;
  const operations = useRef(new Map<string, string>());
  return (
    <ResourceBrowser
      kind="materials"
      close={props.close}
      request={send}
      contentType={props.contentType}
      providerIds={props.providerIds}
      onSourcesChange={props.onSourcesChange}
      choose={async (selection) => {
        const key = JSON.stringify(selection.ref);
        if (!operations.current.has(key))
          operations.current.set(key, crypto.randomUUID());
        const file = await send<{
          fileId: string;
          name: string;
          mime: string;
          size: number;
          source: ResourceSourceInfo;
        }>("materials.import", {
          ref: selection.ref,
          operationKey: operations.current.get(key),
        });
        const reference = {
          id: file.fileId,
          name: file.name,
          mime: file.mime,
          size: file.size,
          source: file.source,
        };
        if (props.accept && !props.accept(reference))
          throw new Error("Unsupported material type");
        await props.select(reference);
      }}
    />
  );
}
function ResourceBrowser({
  kind,
  contract,
  contentType,
  close,
  choose,
  blank,
  request: send = request,
  providerIds: initialProviderIds,
  onSourcesChange,
}: {
  kind: "templates" | "materials";
  contract?: ResourceType;
  contentType?: ResourceType;
  close: () => void;
  choose: (
    selection: TemplateSelection,
    resource: CreationResourceResult,
  ) => void | Promise<void>;
  blank?: () => void | Promise<void>;
  request?: ResourceRequest;
  providerIds?: readonly string[];
  onSourcesChange?: (providerIds: readonly string[] | undefined) => void;
}) {
  const { t, locale } = useI18n();
  const [providers, setProviders] = useState<
      readonly ResourceProviderDescriptor[]
    >([]),
    [tags, setTags] = useState<readonly ResourceTag[]>([]);
  const [providerIds, setProviderIds] = useState<readonly string[] | undefined>(
      initialProviderIds,
    ),
    [query, setQuery] = useState(""),
    [draftQuery, setDraftQuery] = useState(""),
    [searchAttempt, setSearchAttempt] = useState(0),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState<ResourceSort>("updated");
  const [items, setItems] = useState<
      readonly (CreationResourceResult | MaterialCollectionResult)[]
    >([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [partial, setPartial] = useState(false),
    [tagsPartial, setTagsPartial] = useState(false);
  const [selected, setSelected] = useState<CreationResourceResult | null>(null),
    [parameters, setParameters] = useState<Record<string, unknown>>({}),
    [preview, setPreview] = useState<TemplatePayload | null>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<"keyword" | "smart">("keyword");
  const [truncated, setTruncated] = useState(false);
  const [retrievalFailures, setRetrievalFailures] = useState<
    ResourceRetrievalPage["failures"]
  >([]);
  const [matchText, setMatchText] = useState<Record<string, string>>({});
  const [materialTab, setMaterialTab] = useState<"materials" | "collections">(
    "materials",
  );
  const [collectionScope, setCollectionScope] =
    useState<MaterialCollectionResult | null>(null);
  const collectionView =
    kind === "materials" && materialTab === "collections" && !collectionScope;
  const browseQuery = useRef("");
  function leaveCollection() {
    setCollectionScope(null);
    setMaterialTab("collections");
    setQuery(browseQuery.current);
    setDraftQuery(browseQuery.current);
    setTag("");
  }
  async function openCollection(item: MaterialCollectionResult) {
    setBusy(true);
    setError("");
    try {
      const current = await send<MaterialCollectionResult>(
        "materials.collectionDescribe",
        item.ref,
        controller.current?.signal,
      );
      browseQuery.current = query;
      setCollectionScope(current);
      setMaterialTab("materials");
      setQuery("");
      setDraftQuery("");
      setTag("");
    } catch (error) {
      if (!controller.current?.signal.aborted)
        setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const initialSourceKey = JSON.stringify(initialProviderIds);
  useEffect(() => {
    setProviderIds(initialProviderIds);
    setCollectionScope(null);
    setTag("");
    setSort("updated");
  }, [initialSourceKey]);
  const [rawParameters, setRawParameters] = useState("{}");
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const filter = {
    ...(contract ? { contract } : {}),
    ...(contentType ? { contentType } : {}),
    ...(providerIds ? { providerIds } : {}),
    query,
    ...(collectionView
      ? { collectionTags: tag ? [tag] : [] }
      : { tags: tag ? [tag] : [] }),
    ...(collectionScope ? { collectionRefs: [collectionScope.ref] } : {}),
    sort,
  };
  const filterKey = JSON.stringify([
    filter,
    searchMode,
    materialTab,
    searchAttempt,
  ]);
  useEffect(() => {
    const abort = new AbortController();
    send<readonly ResourceProviderDescriptor[]>(
      `${kind}.providers`,
      {
        ...(contract ? { contract } : {}),
        ...(contentType ? { contentType } : {}),
      },
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) setProviders(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [
    kind,
    contract?.id,
    contract?.version,
    contentType?.id,
    contentType?.version,
    send,
  ]);
  useEffect(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const version = ++generation.current;
    setLoading(true);
    setItems([]);
    setCursor(null);
    setError("");
    setSelected(null);
    setPartial(false);
    setTruncated(false);
    setRetrievalFailures([]);
    setMatchText({});
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (query.trim() && searchMode === "smart") {
            const { sort: _sort, ...retrieval } = filter;
            const response = await send<
              ResourceRetrievalPage | MaterialRetrievalPage
            >(
              `${kind}.retrieve`,
              {
                ...retrieval,
                query: query.trim(),
                mode: "auto",
                topK: 20,
                ...(kind === "materials" ? { target: materialTab } : {}),
              },
              abort.signal,
            );
            const result =
              "materials" in response ? response[materialTab] : response;
            const described = await Promise.allSettled(
              result.items.map((hit) =>
                send<CreationResourceResult | MaterialCollectionResult>(
                  collectionView
                    ? "materials.collectionDescribe"
                    : `${kind}.describe`,
                  hit.ref,
                  abort.signal,
                ),
              ),
            );
            if (generation.current !== version || abort.signal.aborted) return;
            setItems(
              described.flatMap((value) =>
                value.status === "fulfilled" ? [value.value] : [],
              ),
            );
            setPartial(
              !result.complete ||
                described.some((value) => value.status === "rejected"),
            );
            setTruncated(result.truncated);
            setRetrievalFailures(result.failures);
            setMatchText(
              Object.fromEntries(
                result.items
                  .filter((hit) => hit.matchText)
                  .map((hit) => [JSON.stringify(hit.ref), hit.matchText!]),
              ),
            );
          } else {
            const { collectionRefs: _refs, ...memberFilter } = filter;
            const response = await send<ResourcePage | MaterialSearchPage>(
              collectionScope ? "materials.collectionItems" : `${kind}.search`,
              collectionScope
                ? { ...memberFilter, ref: collectionScope.ref, limit: 24 }
                : {
                    ...filter,
                    limit: 24,
                    ...(kind === "materials" ? { target: materialTab } : {}),
                  },
              abort.signal,
            );
            if (generation.current !== version || abort.signal.aborted) return;
            const page =
              "materials" in response ? response[materialTab] : response;
            setItems(page.items);
            setCursor(page.nextCursor);
            setPartial(!page.complete);
          }
        } catch (e) {
          if (!abort.signal.aborted) setError((e as Error).message);
        } finally {
          if (!abort.signal.aborted) setLoading(false);
        }
      })();
    }, 150);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [kind, filterKey, send]);
  useEffect(() => {
    const abort = new AbortController();
    setTagsPartial(false);
    setTags([]);
    send<
      { items: readonly ResourceTag[]; complete: boolean } | MaterialTagPage
    >(
      `${kind}.tags`,
      {
        ...(contract ? { contract } : {}),
        ...(contentType ? { contentType } : {}),
        ...(providerIds ? { providerIds } : {}),
        ...(collectionScope ? { collectionRefs: [collectionScope.ref] } : {}),
      },
      abort.signal,
    )
      .then((response) => {
        if (abort.signal.aborted) return;
        const result =
          "materials" in response ? response[materialTab] : response;
        setTags(result.items);
        setTagsPartial(!result.complete);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [
    kind,
    JSON.stringify(providerIds),
    materialTab,
    JSON.stringify(collectionScope?.ref),
    contract?.id,
    contract?.version,
    contentType?.id,
    contentType?.version,
    send,
  ]);
  async function more() {
    if (!cursor || loading) return;
    const version = generation.current;
    setLoading(true);
    try {
      const { collectionRefs: _refs, ...memberFilter } = filter;
      const response = await send<ResourcePage | MaterialSearchPage>(
        collectionScope ? "materials.collectionItems" : `${kind}.search`,
        collectionScope
          ? { ...memberFilter, ref: collectionScope.ref, cursor, limit: 24 }
          : kind === "materials"
            ? {
                ...filter,
                target: materialTab,
                cursors: { [materialTab]: cursor },
                limit: 24,
              }
            : { ...filter, cursor, limit: 24 },
        controller.current?.signal,
      );
      if (version !== generation.current) return;
      const page = "materials" in response ? response[materialTab] : response;
      setItems((old) => [...old, ...page.items]);
      setCursor(page.nextCursor);
      setPartial(!page.complete);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  function select(card: CreationResourceResult) {
    setSelected(card);
    setPreview(null);
    const values: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(
      card.parameters.properties ?? {},
    ))
      if (schema.default !== undefined) values[key] = schema.default;
    setParameters(values);
    setRawParameters(JSON.stringify(values, null, 2));
  }
  function values(): JsonObject {
    if (!selected) return {};
    const complex = Object.values(selected.parameters.properties ?? {}).some(
      (p) => p.type === "array" || p.type === "object" || p.type === "null",
    );
    return (complex ? JSON.parse(rawParameters) : parameters) as JsonObject;
  }
  async function useSelected() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await choose({ ref: selected.ref, parameters: values() }, selected);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function showPreview() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      setPreview(
        await send<TemplatePayload>(
          "templates.read",
          { ref: selected.ref, parameters: values() },
          controller.current?.signal,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedProviders = providers.filter(
    (p) => !providerIds || providerIds.includes(p.id),
  );
  const supported = (
    selectedProviders.length === 1
      ? selectedProviders[0]!.sorts
      : (["updated", "name"] as const)
  ).filter((value) => selectedProviders.every((p) => p.sorts.includes(value)));
  function changeSources(ids: readonly string[] | undefined) {
    setProviderIds(ids);
    setCollectionScope(null);
    setTag("");
    setSort("updated");
    onSourcesChange?.(ids);
  }
  const popupContainer = (trigger: HTMLElement) =>
    trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  const smartResults = searchMode === "smart" && !!query.trim();
  const advancedFiltersActive =
    !!query.trim() || sort !== "updated" || searchMode !== "keyword";
  const resultTitle = t(
    kind === "templates"
      ? "resources.templates"
      : collectionView
        ? "resources.collections"
        : "resources.materialItems",
  );
  function clearQuery() {
    setDraftQuery("");
    setQuery("");
  }
  function resetAdvancedFilters() {
    clearQuery();
    setSearchMode("keyword");
    setSort("updated");
  }
  const nativeFormat = preview?.contentType.id.startsWith("doca.native.")
    ? (preview.contentType.id.slice(12) as Resource["format"])
    : null;
  return (
    <Dialog
      title={
        selected?.title ??
        collectionScope?.title ??
        t(kind === "templates" ? "resources.templates" : "resources.materials")
      }
      close={busy ? () => {} : close}
      className="modal-gallery resource-browser"
    >
      {!selected && (
        <div className="resource-browser-view">
          {kind === "materials" &&
            (collectionScope ? (
              <div className="resource-collection-heading">
                <button disabled={busy} onClick={leaveCollection}>
                  {t("resources.backToCollections")}
                </button>
                <strong>{collectionScope.title}</strong>
                <span>{collectionScope.source.title[locale]}</span>
              </div>
            ) : (
              <div
                className="resource-tabs"
                role="tablist"
                aria-label={t("resources.materials")}
              >
                {(["materials", "collections"] as const).map((tab) => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={materialTab === tab}
                    disabled={busy}
                    onClick={() => {
                      setMaterialTab(tab);
                      setTag("");
                    }}
                  >
                    {t(
                      tab === "materials"
                        ? "resources.materialItems"
                        : "resources.collections",
                    )}
                  </button>
                ))}
              </div>
            ))}
          <div className="resource-browse-filters">
            <div
              className="resource-browse-row"
              role="group"
              aria-label={t("resources.source")}
            >
              <span className="resource-browse-label">
                {t("resources.source")}
              </span>
              <div className="resource-browse-options">
                <button
                  type="button"
                  aria-pressed={providerIds === undefined}
                  disabled={busy}
                  onClick={() => {
                    if (providerIds !== undefined) changeSources(undefined);
                  }}
                >
                  {t("resources.all")}
                </button>
                {providers.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    aria-pressed={providerIds?.includes(provider.id) ?? false}
                    title={provider.description?.[locale]}
                    disabled={busy}
                    onClick={() => {
                      const current = providerIds ?? [];
                      changeSources(
                        current.includes(provider.id)
                          ? current.filter((id) => id !== provider.id)
                          : [...current, provider.id].sort(),
                      );
                    }}
                  >
                    {provider.title[locale]}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="resource-browse-row"
              role="group"
              aria-label={t("resources.tags")}
            >
              <span className="resource-browse-label">
                {t("resources.tags")}
              </span>
              <div className="resource-browse-options">
                <button
                  type="button"
                  aria-pressed={!tag}
                  disabled={busy}
                  onClick={() => setTag("")}
                >
                  {t("resources.all")}
                </button>
                {tags.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={tag === item.id}
                    disabled={busy}
                    onClick={() => setTag(item.id)}
                  >
                    {item.title[locale]}
                  </button>
                ))}
              </div>
              <Popover
                placement="bottom"
                trigger="click"
                open={filtersOpen}
                onOpenChange={setFiltersOpen}
                getPopupContainer={popupContainer}
                content={
                  <div
                    className="resource-advanced-filters"
                    role="region"
                    aria-label={t("resources.filters")}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setFiltersOpen(false);
                        filterToggle.current?.focus();
                      }
                    }}
                  >
                    <div className="resource-advanced-heading">
                      <strong>{t("resources.filters")}</strong>
                      <button
                        type="button"
                        className="resource-filter-reset"
                        disabled={
                          busy || (!advancedFiltersActive && !draftQuery)
                        }
                        onClick={resetAdvancedFilters}
                      >
                        {t("search.reset")}
                      </button>
                    </div>
                    <form
                      className="resource-search-input"
                      role="search"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (busy || !draftQuery.trim()) return;
                        setQuery(draftQuery.trim());
                        setSearchAttempt((n) => n + 1);
                        setFiltersOpen(false);
                        filterToggle.current?.focus();
                      }}
                    >
                      <input
                        aria-label={t("resources.search")}
                        placeholder={t(
                          collectionScope
                            ? "resources.searchCollectionPlaceholder"
                            : kind === "templates"
                              ? searchMode === "smart"
                                ? "resources.templateSmartPlaceholder"
                                : "resources.templateSearchPlaceholder"
                              : searchMode === "smart"
                                ? "resources.materialSmartPlaceholder"
                                : "resources.materialSearchPlaceholder",
                        )}
                        value={draftQuery}
                        maxLength={1000}
                        onChange={(event) => setDraftQuery(event.target.value)}
                        disabled={busy}
                      />
                      {draftQuery && (
                        <button
                          type="button"
                          className="resource-search-clear"
                          aria-label={t("resources.clearQuery")}
                          disabled={busy}
                          onClick={clearQuery}
                        >
                          <X size={16} aria-hidden="true" />
                        </button>
                      )}
                      <Select
                        className="resource-search-mode"
                        variant="borderless"
                        aria-label={t("resources.searchMode")}
                        value={searchMode}
                        disabled={busy}
                        getPopupContainer={popupContainer}
                        onChange={setSearchMode}
                        options={[
                          {
                            value: "keyword",
                            label: t("resources.keywordSearch"),
                          },
                          { value: "smart", label: t("resources.smartSearch") },
                        ]}
                      />
                      <button
                        type="submit"
                        className="resource-search-submit"
                        aria-label={t("common.search")}
                        title={t("common.search")}
                        disabled={
                          busy ||
                          !draftQuery.trim() ||
                          (loading && draftQuery.trim() === query.trim())
                        }
                      >
                        {loading ? (
                          <LoaderCircle
                            size={16}
                            className="resource-search-spinner"
                            aria-hidden="true"
                          />
                        ) : (
                          <Search size={16} aria-hidden="true" />
                        )}
                      </button>
                    </form>
                    <div className="resource-filter-field">
                      <span>{t("resources.sort")}</span>
                      <Select
                        aria-label={t("resources.sort")}
                        value={smartResults ? "relevance" : sort}
                        disabled={busy || smartResults}
                        getPopupContainer={popupContainer}
                        onChange={(value) => setSort(value as ResourceSort)}
                        options={
                          smartResults
                            ? [
                                {
                                  value: "relevance",
                                  label: t("resources.sort.relevance"),
                                },
                              ]
                            : supported.map((value) => ({
                                value,
                                label: t(
                                  `resources.sort.${value}` as "resources.sort.updated",
                                ),
                              }))
                        }
                      />
                    </div>
                  </div>
                }
              >
                <button
                  type="button"
                  className="resource-filter-toggle"
                  ref={filterToggle}
                  aria-label={t("resources.filters")}
                  aria-expanded={filtersOpen}
                  data-active={advancedFiltersActive || undefined}
                  title={t("resources.filters")}
                  disabled={busy}
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                </button>
              </Popover>
            </div>
          </div>
          <div className="resource-results-heading">
            <div className="resource-results-title">
              <strong>{collectionScope?.title ?? resultTitle}</strong>
              {query && (
                <button
                  type="button"
                  className="resource-query-summary"
                  title={query}
                  aria-label={t("resources.clearQuery")}
                  disabled={busy}
                  onClick={clearQuery}
                >
                  <Search size={12} aria-hidden="true" />
                  <span>{query}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <span role="status" aria-live="polite">
              {loading
                ? t("resources.loading")
                : t("resources.loadedCount", { count: items.length })}
            </span>
          </div>
          <div className="resource-results">
            {error && <Feedback tone="error" message={error} />}{" "}
            {(partial || tagsPartial) && (
              <Feedback tone="warning" message={t("resources.partial")} />
            )}
            {retrievalFailures.length > 0 && (
              <ul className="resource-failures">
                {retrievalFailures.map((failure) => (
                  <li key={failure.providerId}>
                    {providers.find((p) => p.id === failure.providerId)?.title[
                      locale
                    ] ?? failure.providerId}
                    ：
                    {t(
                      `resources.retrieval.${failure.code}` as "resources.retrieval.unsupported",
                    )}
                  </li>
                ))}
              </ul>
            )}
            {truncated && (
              <p className="resource-retrieval-limit">
                {t("resources.retrievalLimit")}
              </p>
            )}
            <div className="template-grid">
              {blank && (
                <button
                  className="template-blank"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void Promise.resolve()
                      .then(blank)
                      .catch((e) => {
                        setError(e.message);
                        setBusy(false);
                      });
                  }}
                >
                  <strong>{t("resources.blank")}</strong>
                  <span>{t("resources.blankHelp")}</span>
                </button>
              )}
              {items.map((item) => (
                <button
                  className="template-card"
                  key={JSON.stringify(item.ref)}
                  disabled={busy}
                  onClick={() =>
                    "parameters" in item
                      ? select(item)
                      : void openCollection(item)
                  }
                >
                  {item.preview && (
                    <div className="resource-card-cover">
                      <img
                        src={item.preview}
                        alt={item.title}
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  )}
                  <strong>{item.title}</strong>
                  {"count" in item && item.count !== undefined && (
                    <small>
                      {t("resources.collectionCount", { count: item.count })}
                    </small>
                  )}
                  <span>{item.summary}</span>
                  <span
                    className="resource-card-source"
                    title={item.source.description?.[locale]}
                  >
                    {item.source.title[locale]}
                  </span>
                </button>
              ))}
            </div>
            {!loading && !items.length && <p>{t("resources.empty")}</p>}
            {loading && <p>{t("resources.loading")}</p>}
            {cursor && (
              <button disabled={loading || busy} onClick={() => void more()}>
                {t("resources.more")}
              </button>
            )}
          </div>
        </div>
      )}
      {selected && (
        <section className="resource-selection">
          {error && <Feedback tone="error" message={error} />}
          <div className="resource-source-info">
            <strong>
              {t("resources.source")} · {selected.source.title[locale]}
            </strong>
            {selected.source.description && (
              <p>{selected.source.description[locale]}</p>
            )}
          </div>
          <p>{selected.summary}</p>
          {matchText[JSON.stringify(selected.ref)] && (
            <p>{matchText[JSON.stringify(selected.ref)]}</p>
          )}
          <small>{selected.license}</small>
          {kind === "materials" && "collections" in selected && (
            <p>
              {t("resources.collectionMembership", {
                count: (
                  selected as import("@smartdoca/plugin-contracts").MaterialResult
                ).collections.length,
              })}
            </p>
          )}
          {kind === "templates" &&
            (Object.values(selected.parameters.properties ?? {}).some(
              (p) =>
                p.type === "array" || p.type === "object" || p.type === "null",
            ) ? (
              <label>
                {t("resources.parameters")}
                <textarea
                  value={rawParameters}
                  disabled={busy}
                  onChange={(e) => {
                    setRawParameters(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            ) : (
              Object.entries(selected.parameters.properties ?? {}).map(
                ([key, schema]) => (
                  <label key={key}>
                    {schema.description ?? key}
                    {selected.parameters.required?.includes(key) ? " *" : ""}
                    {schema.type === "boolean" ? (
                      <Select
                        aria-label={schema.description ?? key}
                        value={
                          typeof parameters[key] === "boolean"
                            ? String(parameters[key])
                            : undefined
                        }
                        placeholder={t("resources.choose")}
                        allowClear
                        disabled={busy}
                        getPopupContainer={popupContainer}
                        options={[
                          { value: "true", label: t("resources.booleanTrue") },
                          {
                            value: "false",
                            label: t("resources.booleanFalse"),
                          },
                        ]}
                        onChange={(value) => {
                          setParameters((old) => {
                            const next = { ...old };
                            if (value === undefined) delete next[key];
                            else next[key] = value === "true";
                            return next;
                          });
                          setPreview(null);
                        }}
                      />
                    ) : schema.type === "string" && schema.enum ? (
                      <Select
                        aria-label={schema.description ?? key}
                        value={
                          parameters[key] === undefined
                            ? undefined
                            : String(parameters[key])
                        }
                        placeholder={t("resources.choose")}
                        allowClear
                        disabled={busy}
                        getPopupContainer={popupContainer}
                        options={schema.enum.map((value) => ({
                          value,
                          label: value,
                        }))}
                        onChange={(value) => {
                          setParameters((old) => {
                            const next = { ...old };
                            if (value === undefined) delete next[key];
                            else next[key] = value;
                            return next;
                          });
                          setPreview(null);
                        }}
                      />
                    ) : (
                      <input
                        type={schema.type === "string" ? "text" : "number"}
                        value={String(parameters[key] ?? "")}
                        disabled={busy}
                        onChange={(e) => {
                          setParameters((old) => {
                            const next = { ...old };
                            if (e.target.value === "") delete next[key];
                            else
                              next[key] =
                                schema.type === "string"
                                  ? e.target.value
                                  : Number(e.target.value);
                            return next;
                          });
                          setPreview(null);
                        }}
                      />
                    )}
                  </label>
                ),
              )
            ))}
          {preview && nativeFormat && preview.assets.length === 0 && (
            <div className="resource-preview">
              <Suspense fallback={<p>{t("resources.loading")}</p>}>
                <Surface
                  format={nativeFormat}
                  content={preview.content}
                  readOnly
                />
              </Suspense>
            </div>
          )}
          {selected.preview &&
            (!preview || !nativeFormat || preview.assets.length > 0) && (
              <img
                className="resource-preview-cover"
                src={selected.preview}
                alt={selected.title}
              />
            )}
          <footer>
            <button
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setPreview(null);
                setError("");
              }}
            >
              {t("resources.back")}
            </button>
            {kind === "templates" && (
              <button disabled={busy} onClick={() => void showPreview()}>
                {t("resources.preview")}
              </button>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => void useSelected()}
            >
              {t("resources.use")}
            </button>
          </footer>
        </section>
      )}
    </Dialog>
  );
}
