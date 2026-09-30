import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  File,
  Mail,
  CalendarDays,
  MessageSquare,
  CheckSquare,
  Clock3,
  ListTodo,
  Sparkles,
  Bot,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { htmlLang } from "@doca/i18n";
import { CollectionAction } from "@web/features/discovery/collection-action.js";
import { listTime } from "@web/shared/utils/list-time.js";
import type { WorkspaceActivityPage } from "@core/modules/workspace/plugin-activity.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import "./home.css";

const activityIcons = {
  file: File,
  mail: Mail,
  calendar: CalendarDays,
  message: MessageSquare,
  task: CheckSquare,
  book: BookOpen,
  folder: FolderOpen,
};

const formatLabels = {
  rich_text: "shell.type.rich",
  spreadsheet: "shell.type.sheet",
  presentation: "shell.type.slides",
  markdown: "shell.type.markdown",
  canvas: "shell.type.canvas",
} as const;
type Overview = {
  ownedDocuments: number;
  libraries: number;
  todos: {
    kind: string;
    status: string;
    more: boolean;
    items: { id: string; title: string; updatedAt: string; href: string }[];
  }[];
};
export function WorkspaceHome({ name }: { name: string }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<WorkspaceActivityPage | null>(null);
  const [sources, setSources] = useState<WorkspaceActivityPage["sources"]>([]);
  const [kind, setKind] = useState("");
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages[pages.length - 1];
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [overviewError, setOverviewError] = useState("");
  useEffect(() => {
    let active = true;
    setOverviewError("");
    void api<Overview>("/workspace/overview")
      .then((x) => {
        if (active) setOverview(x);
      })
      .catch((e) => {
        if (active) setOverviewError(e.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setRecent(null);
    setError("");
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    if (kind) query.set(kind.includes(".") ? "source" : "kind", kind);
    void api<WorkspaceActivityPage>(
      `/workspace/activity?${query}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((x) => {
        if (active) {
          setRecent(x);
          setSources(x.sources);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [kind, cursor, revision]);
  return (
    <section className="workspace-home">
      <header className="workspace-welcome">
        <div>
          <p>
            {new Date().toLocaleDateString(htmlLang(locale), {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </p>
          <h1>{t("workspace.greeting", { name })}</h1>
          <span>{t("workspace.welcome")}</span>
        </div>
        <button
          className="icon"
          aria-label={t("workspace.refresh")}
          onClick={() => {
            setPages([null]);
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      <div className="workspace-columns">
        <section className="workspace-panel">
          <header>
            <h2>
              <Clock3 size={18} />
              {t("home.tab.recent")}
            </h2>
          </header>
          <div className="home-tabs" role="tablist">
            {["", "document", "library", "assistant", "folder", "file"].map(
              (k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={kind === k}
                  className={kind === k ? "active" : ""}
                  onClick={() => {
                    setKind(k);
                    setPages([null]);
                  }}
                >
                  {t(
                    k
                      ? (`workspace.kind.${k}` as Parameters<typeof t>[0])
                      : "workspace.all",
                  )}
                </button>
              ),
            )}
            {sources.map((source) => (
              <button
                key={source.id}
                role="tab"
                aria-selected={kind === source.id}
                className={kind === source.id ? "active" : ""}
                onClick={() => {
                  setKind(source.id);
                  setPages([null]);
                }}
              >
                {source.title[locale]}
              </button>
            ))}
          </div>
          {!!recent?.unavailableSources.length && (
            <p role="status" className="subtle">
              {t("workspace.recentUnavailable")}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {!recent && !error && <p className="empty">{t("common.loading")}</p>}
          {recent?.items.length === 0 && (
            <p className="empty">{t("workspace.noRecent")}</p>
          )}
          <div className="workspace-recent">
            {recent?.items.map((item) => {
              const Icon =
                item.kind === "plugin"
                  ? activityIcons[item.icon]
                  : item.kind === "library"
                    ? BookOpen
                    : item.kind === "assistant"
                      ? Bot
                      : item.kind === "folder"
                        ? FolderOpen
                        : File;
              return (
                <div
                  key={JSON.stringify([
                    item.kind === "plugin" ? item.sourceId : item.kind,
                    item.id,
                  ])}
                >
                  {(item.kind === "document" || item.kind === "library") &&
                  item.format !== null ? (
                    <FileIcon r={{ kind: item.kind, format: item.format }} />
                  ) : (
                    <span
                      className={`file-glyph workspace-glyph-${item.kind}`}
                      aria-hidden="true"
                    >
                      <Icon size={19} />
                    </span>
                  )}
                  <a href={item.href}>
                    <strong>{item.title}</strong>
                    <small>
                      <span>
                        {item.kind === "document" && item.format !== null
                          ? t(formatLabels[item.format])
                          : item.kind === "plugin"
                            ? item.sourceTitle[locale]
                            : t(`workspace.kind.${item.kind}`)}
                      </span>
                      {item.kind === "document" && item.inLibrary && (
                        <span
                          className="workspace-recent-source"
                          title={item.libraryName ?? t("home.libraryDoc")}
                        >
                          <BookOpen size={12} aria-hidden="true" />
                          <span>
                            {item.libraryName ?? t("home.libraryDoc")}
                          </span>
                        </span>
                      )}
                      <span>
                        {listTime(item.visited_at, Date.now(), locale)}
                      </span>
                    </small>
                  </a>
                  {item.kind !== "plugin" &&
                    item.public &&
                    item.kind !== "file" && (
                      <CollectionAction
                        id={item.id}
                        kind={item.kind}
                        collected={item.collected}
                        changed={() => {
                          setPages([null]);
                          setRevision((n) => n + 1);
                        }}
                        onError={setError}
                      />
                    )}
                  <a className="icon" href={item.href} aria-label={item.title}>
                    <ArrowUpRight size={16} />
                  </a>
                </div>
              );
            })}
          </div>
          {recent && (pages.length > 1 || recent.nextCursor !== null) && (
            <footer className="workspace-pagination">
              <button
                disabled={pages.length === 1}
                onClick={() => setPages((old) => old.slice(0, -1))}
              >
                {t("discovery.previous")}
              </button>
              <button
                disabled={recent.nextCursor === null}
                onClick={() => setPages((old) => [...old, recent.nextCursor])}
              >
                {t("discovery.next")}
              </button>
            </footer>
          )}
        </section>
        <aside>
          <a className="workspace-ai" href="#/ai">
            <Sparkles size={24} />
            <h2>{t("nav.assistant")}</h2>
            <p>{t("workspace.aiHint")}</p>
            <ArrowUpRight size={20} />
          </a>
          <section className="workspace-panel workspace-todos">
            <header>
              <h2>
                <ListTodo size={18} />
                {t("workspace.pending")}
              </h2>
            </header>
            {overviewError && <p role="alert">{overviewError}</p>}
            {!overview && !overviewError && <p>{t("common.loading")}</p>}
            {overview?.todos.map((group) => (
              <div key={group.kind}>
                <h3>
                  {t(
                    group.kind === "tickets"
                      ? "workspace.tickets"
                      : "workspace.curation",
                  )}{" "}
                  <span>
                    {group.status === "ready"
                      ? `${group.items.length}${group.more ? "+" : ""}`
                      : "—"}
                  </span>
                </h3>
                {group.status === "error" ? (
                  <p role="alert">{t("workspace.todoError")}</p>
                ) : group.items.length === 0 ? (
                  <p className="subtle">{t("workspace.noTodos")}</p>
                ) : (
                  group.items.slice(0, 5).map((item) => (
                    <a key={item.id} href={item.href}>
                      <span>{item.title}</span>
                      <ArrowUpRight size={14} />
                    </a>
                  ))
                )}
                {group.items.length > 5 && (
                  <a
                    href={
                      group.kind === "tickets"
                        ? "#/tickets"
                        : group.items[5]!.href
                    }
                  >
                    {t("workspace.viewMore")}
                  </a>
                )}
              </div>
            ))}
          </section>
        </aside>
      </div>
    </section>
  );
}
