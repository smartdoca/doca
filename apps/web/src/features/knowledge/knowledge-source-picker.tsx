import {
  Link2,
  FileText,
  BookOpen,
  Folder,
  File,
  ArrowLeft,
  ChevronRight,
  Check,
} from "lucide-react";
import { resolveDocumentReferences } from "./document-source-input.js";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import type { KnowledgeSourceSelection } from "@smartdoca/web-plugin-registry";
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
  const [kind, setKind] = useState(initial?.sourceKind ?? ""),
    [name, setName] = useState(initial?.title ?? "");
  const [documents, setDocuments] = useState(
    initial?.sourceKind === "document" ? initial.sourceIds.join("\n") : "",
  );
  const [loading, setLoading] = useState(false);
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
    setLoading(true);
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
        if (!controller.signal.aborted) {
          setRows(x);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [kind, folder.id, folder.type, libraryId]);
  const choices = [
    ...new Set([
      "url",
      "library",
      "document",
      "folder",
      "file",
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
  const parsed = resolveDocumentReferences(documents, rows);
  const chosen = kind === "document" ? parsed.ids : selected;
  const icons: Record<string, typeof Link2> = {
    url: Link2,
    document: FileText,
    library: BookOpen,
    folder: Folder,
    file: File,
  };
  return (
    <div className="library-source-picker source-wizard">
      {!kind ? (
        <>
          <p className="source-wizard-hint">{t("sourcePicker.chooseType")}</p>
          <div className="source-type-grid">
            {choices.map((k) => {
              const Icon = icons[k] ?? File;
              return (
                <button type="button" key={k} onClick={() => setKind(k)}>
                  <span className="source-type-icon">
                    <Icon size={22} />
                  </span>
                  <strong>{label(k)}</strong>
                  <ChevronRight size={16} />
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="source-wizard-heading">
            {!initial && (
              <button
                type="button"
                className="icon"
                aria-label={t("library.relations.back")}
                disabled={busy}
                onClick={() => {
                  setKind("");
                  setSelected([]);
                  setUrl("");
                  setDocuments("");
                  setFolder({ type: "system", id: "root" });
                }}
              >
                <ArrowLeft size={17} />
              </button>
            )}
            <strong>{label(kind)}</strong>
            <small>{t("sourceGroup.hint")}</small>
          </div>
          <div className="source-wizard-body">
            <label>
              {t("sourceGroup.name")}
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("sourceGroup.nameExample")}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            {kind === "url" ? (
              <textarea
                className="source-paste-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label={t("sourceGroup.links")}
                placeholder={t("sourceGroup.links")}
              />
            ) : kind === "document" ? (
              <>
                <textarea
                  className="source-paste-input"
                  value={documents}
                  onChange={(e) => setDocuments(e.target.value)}
                  aria-label={t("sourcePicker.documents")}
                  placeholder={t("sourcePicker.documentsHint")}
                />
                {!!parsed.unresolved.length && !loading && (
                  <p className="source-input-warning">
                    {t("sourcePicker.unresolved", {
                      count: parsed.unresolved.length,
                    })}
                  </p>
                )}
                <div className="source-selected-tags">
                  {parsed.ids.map((id) => (
                    <span key={id}>
                      <Check size={13} />
                      {rows.find((row) => row.id === id)?.label}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <>
                {folder.id !== "root" && (
                  <button
                    type="button"
                    onClick={() => setFolder({ type: "system", id: "root" })}
                  >
                    <ArrowLeft size={14} />
                    {t("library.relations.back")}
                  </button>
                )}
                <div className="source-resource-list">
                  {rows.map((row) => (
                    <div className="source-resource-row" key={row.id}>
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
                        {row.enter ? (
                          <Folder size={17} />
                        ) : kind === "library" ? (
                          <BookOpen size={17} />
                        ) : (
                          <File size={17} />
                        )}
                        <span>{row.label}</span>
                      </label>
                      {row.enter && (
                        <button
                          type="button"
                          aria-label={
                            t("library.relations.open") + " " + row.label
                          }
                          onClick={() =>
                            setFolder({ type: "folder", id: row.id })
                          }
                        >
                          <ChevronRight size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!rows.length && !loading && (
                  <p>{t("library.relations.pickEmpty")}</p>
                )}
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
            <details className="source-guide-optional">
              <summary>{t("knowledge.sourceGuide")}</summary>
              <textarea
                rows={3}
                value={guide}
                onChange={(e) => setGuide(e.target.value)}
                placeholder={t("sourceGroup.guideHint")}
              />
            </details>
          </div>
          <footer className="source-wizard-footer">
            <span>
              {t("sourceGroup.selected", {
                count: kind === "url" ? urls.length : chosen.length,
              })}
            </span>
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                loading ||
                !name.trim() ||
                !(kind === "url" ? urls.length : chosen.length) ||
                (kind === "document" && !!parsed.unresolved.length)
              }
              onClick={() => bind(kind, chosen, urls, name, guide)}
            >
              {t(initial ? "sourceGroup.save" : "sourceGroup.create")}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
