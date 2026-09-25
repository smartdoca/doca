import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import {
  Settings,
  ImagePlus,
  Pencil,
  Trash2,
  ArrowRightLeft,
  FilePlus2,
} from "lucide-react";
import { api, roleRank, type Detail, type Page, type Resource } from "@web/shared/api.js";
import { PermissionDialog, TransferDialog } from "@web/features/documents/dialogs.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Feedback } from "@web/shared/components/feedback.js";
import "./library-system.css";
export const librarySettingsUrl = (id: string) => `#/r/${id}?view=settings`;
export const librarySystemUrl = (id: string) => `#/r/${id}?view=system`;
export function LibraryLanding({
  resource,
  create,
}: {
  resource: Resource;
  create: () => void;
}) {
  const allowed = useEntitlements();
  const { locale } = useI18n();
  const [empty, setEmpty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      const all: Resource[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: Page = await api<Page>(
          `/resources?scope=all&kind=document&libraryId=${resource.id}&offset=${offset}`,
          "GET",
          undefined,
          c.signal,
        );
        all.push(...page.items);
        offset = page.nextOffset;
      }
      const ids = new Set(all.map((r) => r.id));
      const first = all
        .filter((r) => !r.parent_id || !ids.has(r.parent_id))
        .sort(
          (a, b) =>
            a.title.localeCompare(b.title, htmlLang(locale)) || a.id.localeCompare(b.id),
        )[0];
      if (c.signal.aborted) return;
      if (first) location.replace(`#/r/${first.id}`);
      else setEmpty(true);
    })().catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => c.abort();
  }, [resource.id]);
  return (
    <div className="empty">
      {error ? (
        <Feedback tone="error" message={error} />
      ) : empty ? (
        <>
          <FilePlus2 size={38} />
          <h2>知识库还没有文档</h2>
          {roleRank(resource.role) >= 3 && (
            <button
              className="primary"
              hidden={!allowed("documents.create")}
              onClick={create}
            >
              创建第一篇文档
            </button>
          )}
        </>
      ) : (
        "正在打开第一篇文档…"
      )}
    </div>
  );
}
type SubscriptionItem = {
  id: string;
  sourceKind: string;
  sourceId: string;
  url: string;
  nodeId: string | null;
  nodeTitle: string;
  sourceTitle: string;
  status: string;
};
type SystemPayload = {
  items: SubscriptionItem[];
  guideText: string;
  splitMode: string;
  aiCurated: boolean;
};

const sourceLabel: Record<string, string> = { document: "文档", file: "文件", folder: "文件夹", mail: "邮件", mailbox: "邮箱", url: "链接" };

export function LibrarySystemPage({
  detail,
  changed,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const { t } = useI18n();
  const resource = detail.resource;
  const curated = Number(resource.ai_curated) === 1;
  const [guideText, setGuideText] = useState("");
  const [splitMode, setSplitMode] = useState("source");
  const [items, setItems] = useState<SubscriptionItem[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canMaintain = roleRank(resource.role) >= 4;
  const splitKey = (splitMode === "content" || splitMode === "outline" || splitMode === "custom" ? splitMode : "source") as "source" | "content" | "outline" | "custom";
  const splitKeys = { source: "library.split.source", content: "library.split.content", outline: "library.split.outline", custom: "library.split.custom" } as const;
  const statusKeys = { pending: "library.status.pending", active: "library.status.active", stale: "library.status.stale", missing: "library.status.missing" } as const;

  function apply(payload: SystemPayload) {
    setGuideText(payload.guideText);
    setSplitMode(payload.splitMode);
    setItems(payload.items);
  }

  async function reloadList() {
    apply(await api<SystemPayload>(`/knowledge/libraries/${resource.id}/subscriptions`));
  }

  useEffect(() => {
    const controller = new AbortController();
    void api<SystemPayload>(`/knowledge/libraries/${resource.id}/subscriptions`, "GET", undefined, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) apply(payload);
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
      });
    return () => controller.abort();
  }, [resource.id, curated]);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await changed();
      await reloadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("library.curated.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="library-system">
      <header>
        <h2>{t("nav.librarySystem")}</h2>
        <p>{t("library.curated.body")}</p>
        {curated && <p>{t("library.system.split", { mode: t(splitKeys[splitKey]) })}</p>}
      </header>
      {error && <Feedback tone="error" message={error} />}
      <div className="library-system-columns">
        <section>
          <h3>{t("library.system.guideLabel")}</h3>
          {curated ? (
            <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/guide`, "POST", { markdown: guideText }); }); }}>
              <textarea value={guideText} onChange={(event) => setGuideText(event.target.value)} aria-label={t("library.system.guideLabel")} readOnly={!canMaintain} />
              {canMaintain && <button type="submit" className="primary" disabled={busy}>{t("library.system.saveGuide")}</button>}
              {canMaintain && <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/curation`, "POST", { enabled: false }); })}>{t("library.curated.disable")}</button>}
            </form>
          ) : (
            <>
              <p className="library-system-empty">{t("library.system.pending")}</p>
              {canMaintain && <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/curation`, "POST", { enabled: true }); })}>{t("library.curated.enable")}</button>}
            </>
          )}
        </section>
        <section>
          <h3>{t("library.system.links")}</h3>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <strong>{item.nodeTitle || item.sourceTitle || item.url || sourceLabel[item.sourceKind]}</strong>
                <small>{sourceLabel[item.sourceKind] ?? item.sourceKind} · {t(statusKeys[item.status === "stale" || item.status === "missing" || item.status === "pending" ? item.status : "active"])}</small>
                {item.nodeId && <button type="button" onClick={() => { location.hash = `/r/${item.nodeId}`; }}>{item.nodeTitle || t("library.system.nodes")}</button>}
                {canMaintain && item.status === "pending" && (
                  <span>
                    <button type="button" className="primary" disabled={busy || !curated} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/confirm`, "POST"); })}>{t("library.system.confirm")}</button>
                    <button type="button" disabled={busy} onClick={() => void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions/${item.id}/dismiss`, "POST"); })}>{t("library.system.dismiss")}</button>
                  </span>
                )}
              </li>
            ))}
            {!items.length && <li className="library-system-empty">{t("library.system.emptySubscriptions")}</li>}
          </ul>
          {canMaintain && (
            <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/knowledge/libraries/${resource.id}/subscriptions`, "POST", { sourceKind: "url", url: url.trim() }); setUrl(""); }); }}>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" aria-label={t("library.system.linkLabel")} />
              <button type="submit" className="primary" disabled={busy || !url.trim()}>{t("library.system.addLink")}</button>
            </form>
          )}
        </section>
      </div>
    </section>
  );
}

export function LibrarySettings({
  detail,
  changed,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const [action, setAction] = useState<
    "cover" | "rename" | "trash" | "transfer" | null
  >(null);
  const r = detail.resource,
    manager = roleRank(r.role) >= 4;
  const close = () => setAction(null);
  return (
    <section className="library-settings-page">
      <section className="settings-card">
        <h3>基本信息</h3>
        <div className="library-setting-actions">
          <button disabled={!manager} onClick={() => setAction("cover")}>
            <ImagePlus size={18} />
            设置封面
          </button>
          <button disabled={!manager} onClick={() => setAction("rename")}>
            <Pencil size={18} />
            重命名
          </button>
          <button
            disabled={r.role !== "owner"}
            onClick={() => setAction("transfer")}
          >
            <ArrowRightLeft size={18} />
            移交所有权
          </button>
          <button
            disabled={r.role !== "owner"}
            className="danger"
            onClick={() => setAction("trash")}
          >
            <Trash2 size={18} />
            删除知识库
          </button>
        </div>
      </section>
      <PermissionDialog
        key={r.id}
        embedded
        detail={detail}
        close={() => {}}
        saved={changed}
      />
      {action === "cover" && (
        <CoverDialog resource={r} close={close} saved={() => void changed()} />
      )}
      {(action === "rename" || action === "trash") && (
        <ResourceActionDialog
          resource={r}
          action={action}
          close={close}
          saved={() => {
            if (action === "trash") location.hash = "/libraries";
            void changed();
          }}
        />
      )}
      {action === "transfer" && (
        <TransferDialog resource={r} close={close} saved={changed} />
      )}
    </section>
  );
}
