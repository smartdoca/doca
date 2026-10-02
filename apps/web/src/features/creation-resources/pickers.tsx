import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useI18n } from "@web/shared/i18n.js";
import { api, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import type {
  CreationResourceCard,
  ResourceProviderDescriptor,
  ResourcePage,
  ResourceTag,
  ResourceType,
  TemplateSelection,
  TemplatePayload,
  JsonObject,
  ResourceSort,
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
      choose={async (selection) => {
        const key = JSON.stringify(selection.ref);
        if (!operations.current.has(key))
          operations.current.set(key, crypto.randomUUID());
        const file = await send<{
          fileId: string;
          name: string;
          mime: string;
          size: number;
        }>("materials.import", {
          ref: selection.ref,
          operationKey: operations.current.get(key),
        });
        const reference = {
          id: file.fileId,
          name: file.name,
          mime: file.mime,
          size: file.size,
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
}: {
  kind: "templates" | "materials";
  contract?: ResourceType;
  contentType?: ResourceType;
  close: () => void;
  choose: (selection: TemplateSelection) => void | Promise<void>;
  blank?: () => void | Promise<void>;
  request?: ResourceRequest;
}) {
  const { t, locale } = useI18n();
  const [providers, setProviders] = useState<
      readonly ResourceProviderDescriptor[]
    >([]),
    [tags, setTags] = useState<readonly ResourceTag[]>([]);
  const [providerId, setProviderId] = useState(""),
    [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState<ResourceSort>("updated");
  const [items, setItems] = useState<readonly CreationResourceCard[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<CreationResourceCard | null>(null),
    [parameters, setParameters] = useState<Record<string, unknown>>({}),
    [preview, setPreview] = useState<TemplatePayload | null>(null);
  const [rawParameters, setRawParameters] = useState("{}");
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const filter = {
    ...(contract ? { contract } : {}),
    ...(contentType ? { contentType } : {}),
    ...(providerId ? { providerId } : {}),
    query,
    tags: tag ? [tag] : [],
    sort,
  };
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    const abort = new AbortController();
    setProviderId("");
    send<readonly ResourceProviderDescriptor[]>(
      `${kind}.providers`,
      {
        ...(contract ? { contract } : {}),
        ...(contentType ? { contentType } : {}),
      },
      abort.signal,
    )
      .then(setProviders)
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
    const timer = window.setTimeout(() => {
      send<ResourcePage>(
        `${kind}.search`,
        { ...filter, limit: 24 },
        abort.signal,
      )
        .then((page) => {
          if (generation.current !== version || abort.signal.aborted) return;
          setItems(page.items);
          setCursor(page.nextCursor);
          setPartial(!page.complete);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [kind, filterKey, send]);
  useEffect(() => {
    const abort = new AbortController();
    send<{ items: readonly ResourceTag[]; complete: boolean }>(
      `${kind}.tags`,
      {
        ...(contract ? { contract } : {}),
        ...(contentType ? { contentType } : {}),
        ...(providerId ? { providerId } : {}),
      },
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        setTags(result.items);
        if (!result.complete) setPartial(true);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [
    kind,
    providerId,
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
  function select(card: CreationResourceCard) {
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
      await choose({ ref: selected.ref, parameters: values() });
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
  const supported = providerId
    ? (providers.find((p) => p.id === providerId)?.sorts ?? [])
    : ["updated", "name"].filter((s) =>
        providers.every((p) => p.sorts.includes(s as ResourceSort)),
      );
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
            <select
              aria-label={t("resources.source")}
              value={providerId}
              disabled={busy}
              onChange={(e) => {
                setProviderId(e.target.value);
                setTag("");
                setSort("updated");
              }}
            >
              <option value="">{t("resources.allSources")}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title[locale]}
                </option>
              ))}
            </select>
            <select
              aria-label={t("resources.sort")}
              value={sort}
              disabled={busy}
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
          {partial && (
            <Feedback tone="warning" message={t("resources.partial")} />
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
          <p>{selected.summary}</p>
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
