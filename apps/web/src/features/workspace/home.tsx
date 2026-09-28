import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  FileText,
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
import type { RecentItem } from "@core/modules/workspace/activity.js";
import "./home.css";
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
  const [recent, setRecent] = useState<{
    items: RecentItem[];
    nextOffset: number | null;
  } | null>(null);
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
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
    void api<{ items: RecentItem[]; nextOffset: number | null }>(
      `/workspace/recent?offset=${offset}${kind ? `&kind=${kind}` : ""}`,
    )
      .then((x) => {
        if (active) setRecent(x);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [kind, offset, revision]);
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
          onClick={() => setRevision((n) => n + 1)}
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
                    setOffset(0);
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
          </div>
          {error && <p role="alert">{error}</p>}
          {!recent && !error && <p className="empty">{t("common.loading")}</p>}
          {recent?.items.length === 0 && (
            <p className="empty">{t("workspace.noRecent")}</p>
          )}
          <div className="workspace-recent">
            {recent?.items.map((item) => {
              const Icon =
                item.kind === "library"
                  ? BookOpen
                  : item.kind === "assistant"
                    ? Bot
                    : item.kind === "folder"
                      ? FolderOpen
                      : FileText;
              return (
                <div key={`${item.kind}:${item.id}`}>
                  <Icon size={19} />
                  <a href={item.href}>
                    <strong>{item.title}</strong>
                    <small>
                      {t(`workspace.kind.${item.kind}`)} ·{" "}
                      {listTime(item.visited_at, Date.now(), locale)}
                    </small>
                  </a>
                  {item.public && item.kind !== "file" && (
                    <CollectionAction
                      id={item.id}
                      kind={item.kind}
                      collected={item.collected}
                      changed={() => setRevision((n) => n + 1)}
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
          {recent && (offset > 0 || recent.nextOffset !== null) && (
            <footer className="workspace-pagination">
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                {t("discovery.previous")}
              </button>
              <button
                disabled={recent.nextOffset === null}
                onClick={() => setOffset(recent.nextOffset!)}
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
