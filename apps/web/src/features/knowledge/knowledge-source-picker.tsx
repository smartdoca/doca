import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import type { KnowledgeSourceSelection } from "@doca/web-plugin-registry";
import { pluginMessage, webPluginRegistry } from "@web/plugins/registry.js";
const knownSelections = new Set<KnowledgeSourceSelection>([
  "document",
  "file",
  "folder",
  "url",
  "config",
]);

function sourceSelection(source: {
  sourceKind: string;
  selection?: KnowledgeSourceSelection;
}): KnowledgeSourceSelection {
  if (source.selection && knownSelections.has(source.selection))
    return source.selection;
  if (
    source.sourceKind === "document" ||
    source.sourceKind === "file" ||
    source.sourceKind === "folder" ||
    source.sourceKind === "url"
  )
    return source.sourceKind;
  return "config";
}

export function SourcePicker({
  libraryId,
  locale,
  busy,
  bind,
  initial,
}: {
  libraryId: string;
  locale: string;
  busy: boolean;
  bind: (
    sourceKind: string,
    sourceIds: string[],
    urls: string[],
    title: string,
    guide: string,
  ) => void;
  initial?: {
    sourceKind: string;
    title: string;
    sourceIds: string[];
    urls: string[];
    guide?: string;
  };
}) {
  const { t } = useI18n();
  const sources = webPluginRegistry.knowledgeSources.list();
  const [kind, setKind] = useState(initial?.sourceKind ?? "url"),
    [name, setName] = useState(initial?.title ?? "");
  const [guide, setGuide] = useState(initial?.guide ?? "");
  const [selected, setSelected] = useState<string[]>(initial?.sourceIds ?? []),
    [url, setUrl] = useState(initial?.urls.join("\n") ?? "");
  const [rows, setRows] = useState<
    Array<{ id: string; label: string; bindable: boolean; enter: boolean }>
  >([]);
  const [folder, setFolder] = useState<{
    type: "system" | "folder";
    id: string;
  }>({ type: "system", id: "root" });
  const [error, setError] = useState("");
  const active = sources.find((x) => x.sourceKind === kind);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setRows([]);
    const load = async () => {
      if (kind === "document" || kind === "library") {
        const all: typeof rows = [];
        let cursor: string | undefined;
        do {
          const page: {
            items: Array<{
              id: string;
              title: string;
              library_id?: string | null;
              libraryName?: string;
            }>;
            nextCursor?: string | null;
          } = await api<{
            items: Array<{
              id: string;
              title: string;
              library_id?: string | null;
              libraryName?: string;
            }>;
            nextCursor?: string | null;
          }>(
            `/resources?scope=all&kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            "GET",
            undefined,
            controller.signal,
          );
          all.push(
            ...page.items
              .filter((x) => x.id !== libraryId && x.library_id !== libraryId)
              .map((x) => ({
                id: x.id,
                label: [x.libraryName, x.title].filter(Boolean).join(" / "),
                bindable: true,
                enter: false,
              })),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !controller.signal.aborted);
        return all;
      }
      if (kind === "file" || kind === "folder") {
        const page = await api<{
          folders: Array<{
            id: string;
            name: string;
            virtual?: boolean;
            type: string;
          }>;
          files: Array<{ id: string; name: string }>;
        }>(
          `/files?parentType=${folder.type}&parentId=${encodeURIComponent(folder.id)}`,
          "GET",
          undefined,
          controller.signal,
        );
        return [
          ...page.folders
            .filter((x) => !x.virtual && x.type === "folder")
            .map((x) => ({
              id: x.id,
              label: x.name,
              bindable: kind === "folder",
              enter: true,
            })),
          ...(kind === "file"
            ? page.files.map((x) => ({
                id: x.id,
                label: x.name,
                bindable: true,
                enter: false,
              }))
            : []),
        ];
      }
      return [];
    };
    void load()
      .then((x) => {
        if (!controller.signal.aborted) setRows(x);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [kind, folder.id, folder.type, libraryId]);
  const choices = [
    ...new Set([
      "url",
      "library",
      "document",
      ...sources.map((x) => x.sourceKind),
    ]),
  ];
  const label = (k: string) => {
    const source = sources.find((x) => x.sourceKind === k);
    return k === "library"
      ? t("sourceGroup.libraries")
      : source?.labelKey
        ? pluginMessage(locale, source.labelKey)
        : k;
  };
  const urls = [
    ...new Set(
      url
        .split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  return (
    <div className="library-source-picker">
      <p>{t("sourceGroup.hint")}</p>
      <label>
        {t("sourceGroup.name")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sourceGroup.nameExample")}
        />
      </label>
      <div className="library-system-tabs">
        {choices.map((k) => (
          <button
            type="button"
            key={k}
            disabled={!!initial && k !== initial.sourceKind}
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setSelected([]);
              setUrl("");
              setFolder({ type: "system", id: "root" });
            }}
          >
            {label(k)}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {kind === "url" ? (
        <textarea
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          rows={8}
          aria-label={t("sourceGroup.links")}
          placeholder={t("sourceGroup.links")}
        />
      ) : (
        <>
          {folder.id !== "root" && (
            <button
              type="button"
              onClick={() => setFolder({ type: "system", id: "root" })}
            >
              {t("library.relations.back")}
            </button>
          )}
          <ul className="library-system-links knowledge-picker-results">
            {rows.map((row) => (
              <li key={row.id}>
                <label>
                  {row.bindable && (
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked
                            ? [...old, row.id]
                            : old.filter((id) => id !== row.id),
                        )
                      }
                    />
                  )}{" "}
                  {row.label}
                </label>
                {row.enter && (
                  <button
                    type="button"
                    onClick={() => setFolder({ type: "folder", id: row.id })}
                  >
                    {t("library.relations.open")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!rows.length && <p>{t("library.relations.pickEmpty")}</p>}
          {active &&
            sourceSelection(active) === "config" &&
            active.render(undefined, {
              render: () => null,
              bind: (target) => {
                if (target.sourceId)
                  setSelected((old) => [
                    ...new Set([...old, target.sourceId!]),
                  ]);
                if (target.url) setUrl((old) => old + "\n" + target.url);
              },
            })}
        </>
      )}
      <label>
        {t("knowledge.sourceGuide")}
        <textarea
          rows={4}
          value={guide}
          onChange={(e) => setGuide(e.target.value)}
          placeholder={t("sourceGroup.guideHint")}
        />
      </label>
      <p>
        {t("sourceGroup.selected", {
          count: kind === "url" ? urls.length : selected.length,
        })}
      </p>
      <button
        type="button"
        className="primary"
        disabled={
          busy ||
          !name.trim() ||
          !(kind === "url" ? urls.length : selected.length)
        }
        onClick={() => bind(kind, selected, urls, name, guide)}
      >
        {t(initial ? "sourceGroup.save" : "sourceGroup.create")}
      </button>
    </div>
  );
}
