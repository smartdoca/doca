import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useI18n } from "@web/shared/i18n.js";
import { api, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import type {
  CreationResourceResult,
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
    [tag, setTag] = useState(""),
    [sort, setSort] = useState<ResourceSort>("updated");
  const [items, setItems] = useState<readonly CreationResourceResult[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [partial, setPartial] = useState(false),
    [tagsPartial, setTagsPartial] = useState(false);
  const [selected, setSelected] = useState<CreationResourceResult | null>(null),
    [parameters, setParameters] = useState<Record<string, unknown>>({}),
    [preview, setPreview] = useState<TemplatePayload | null>(null);
  const [searchMode, setSearchMode] = useState<"keyword" | "smart">("keyword");
  const [truncated, setTruncated] = useState(false);
  const [retrievalFailures, setRetrievalFailures] = useState<
    ResourceRetrievalPage["failures"]
  >([]);
  const [matchText, setMatchText] = useState<Record<string, string>>({});
  const initialSourceKey = JSON.stringify(initialProviderIds);
  useEffect(() => {
    setProviderIds(initialProviderIds);
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
    tags: tag ? [tag] : [],
    sort,
  };
  const filterKey = JSON.stringify([filter, searchMode]);
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
            const result = await send<ResourceRetrievalPage>(
              `${kind}.retrieve`,
              { ...retrieval, query: query.trim(), mode: "auto", topK: 20 },
              abort.signal,
            );
            const described = await Promise.allSettled(
              result.items.map((hit) =>
                send<CreationResourceResult>(
                  `${kind}.describe`,
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
            const page = await send<ResourcePage>(
              `${kind}.search`,
              { ...filter, limit: 24 },
              abort.signal,
            );
            if (generation.current !== version || abort.signal.aborted) return;
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
    send<{ items: readonly ResourceTag[]; complete: boolean }>(
      `${kind}.tags`,
      {
        ...(contract ? { contract } : {}),
        ...(contentType ? { contentType } : {}),
        ...(providerIds ? { providerIds } : {}),
      },
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
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
      const page = await send<ResourcePage>(
        `${kind}.search`,
        { ...filter, cursor, limit: 24 },
        controller.current?.signal,
      );
      if (version !== generation.current) return;
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
    setTag("");
    setSort("updated");
    onSourcesChange?.(ids);
  }
  const nativeFormat = preview?.contentType.id.startsWith("doca.native.")
    ? (preview.contentType.id.slice(12) as Resource["format"])
    : null;
  return (
    <Dialog
      title={
        selected?.title ??
        t(kind === "templates" ? "resources.templates" : "resources.materials")
      }
      close={busy ? () => {} : close}
      className="modal-gallery"
    >
      {!selected && (
        <>
          <div className="resource-filters">
            <input
              aria-label={t("resources.search")}
              placeholder={t("resources.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={busy}
            />
            <details className="resource-source-picker">
              <summary>
                {t("resources.source")} ·{" "}
                {providerIds === undefined
                  ? t("resources.allSources")
                  : t("resources.selectedSources", {
                      count: providerIds.length,
                    })}
              </summary>
              <fieldset disabled={busy}>
                <legend>{t("resources.source")}</legend>
                <button type="button" onClick={() => changeSources(undefined)}>
                  {t("resources.allSources")}
                </button>
                <button type="button" onClick={() => changeSources([])}>
                  {t("resources.clearSources")}
                </button>
                {providers.map((p) => (
                  <label key={p.id}>
                    <input
                      type="checkbox"
                      aria-label={p.title[locale]}
                      checked={
                        providerIds === undefined || providerIds.includes(p.id)
                      }
                      onChange={(event) => {
                        const ids = new Set(
                          providerIds ?? providers.map((source) => source.id),
                        );
                        if (event.target.checked) ids.add(p.id);
                        else ids.delete(p.id);
                        changeSources([...ids].sort());
                      }}
                    />
                    <span>
                      <strong>{p.title[locale]}</strong>
                      {p.description && <small>{p.description[locale]}</small>}
                    </span>
                  </label>
                ))}
              </fieldset>
            </details>
            <select
              aria-label={t("resources.searchMode")}
              value={searchMode}
              disabled={busy}
              onChange={(e) =>
                setSearchMode(e.target.value as "keyword" | "smart")
              }
            >
              <option value="keyword">{t("resources.keywordSearch")}</option>
              <option value="smart">{t("resources.smartSearch")}</option>
            </select>
            <select
              aria-label={t("resources.sort")}
              value={sort}
              disabled={busy || (searchMode === "smart" && !!query.trim())}
              onChange={(e) => setSort(e.target.value as ResourceSort)}
            >
              {supported.map((s) => (
                <option key={s} value={s}>
                  {t(`resources.sort.${s}` as "resources.sort.updated")}
                </option>
              ))}
            </select>
          </div>
          <div className="resource-tags">
            <button
              className={!tag ? "active" : ""}
              disabled={busy}
              onClick={() => setTag("")}
            >
              {t("resources.allTags")}
            </button>
            {tags.map((x) => (
              <button
                className={tag === x.id ? "active" : ""}
                key={x.id}
                disabled={busy}
                onClick={() => setTag(x.id)}
              >
                {x.title[locale]}
              </button>
            ))}
          </div>
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
                onClick={() => select(item)}
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
        </>
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
                      <input
                        type="checkbox"
                        checked={parameters[key] === true}
                        disabled={busy}
                        onChange={(e) => {
                          setParameters((old) => ({
                            ...old,
                            [key]: e.target.checked,
                          }));
                          setPreview(null);
                        }}
                      />
                    ) : schema.type === "string" && schema.enum ? (
                      <select
                        value={String(parameters[key] ?? "")}
                        disabled={busy}
                        onChange={(e) => {
                          setParameters((old) => ({
                            ...old,
                            [key]: e.target.value,
                          }));
                          setPreview(null);
                        }}
                      >
                        <option value="">{t("resources.choose")}</option>
                        {schema.enum.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
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
