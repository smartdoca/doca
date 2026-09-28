import { BookmarkPlus, BookmarkCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import {
  publicResourceKinds,
  type PublicResourceKind,
  type PublicMode,
} from "@core/modules/deployment/policies.js";
import "./discovery.css";
export type DiscoveryPolicy = {
  publicDiscovery: boolean;
  publicModes: Record<PublicResourceKind, PublicMode>;
};
export function useDiscoveryPolicy() {
  const [policy, setPolicy] = useState<DiscoveryPolicy | null>(null);
  useEffect(() => {
    const load = () =>
      void api<DiscoveryPolicy>("/discovery/policy")
        .then(setPolicy)
        .catch(() => setPolicy(null));
    load();
    window.addEventListener("focus", load);
    window.addEventListener("doca-discovery-policy", load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("doca-discovery-policy", load);
    };
  }, []);
  return policy;
}
type Item = {
  id: string;
  title: string;
  kind: PublicResourceKind;
  collected: boolean;
  updated_at: string;
  href?: string;
};
type Page = { items: Item[]; total: number; nextOffset: number | null };
const resourceHref = (item: Item) =>
  item.href ?? (item.kind === "assistant"
    ? `#/knowledge-assistants?bot=${item.id}`
    : item.kind === "folder"
      ? `#/shared-files/${item.id}`
      : `#/r/${item.id}`);
export function DiscoveryPage({ collected: initialCollected = false }: { collected?: boolean }) {
  const { t } = useI18n();
  const policy = useDiscoveryPolicy();
  const [kind, setKind] = useState(
    new URLSearchParams(location.hash.split("?")[1]).get("kind") ?? "",
  );
  const [tab, setTab] = useState(initialCollected ? "collected" : "recent");
  const collected = tab === "collected";
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const enabled = !!policy;
  useEffect(() => {
    setOffset(0);
    setSelected([]);
  }, [kind, q, tab]);
  useEffect(() => {
    let active = true;
    setPage(null);
    setError("");
    if (!enabled) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        q,
        offset: String(offset),
        collected: String(collected),
        ...(kind ? { kind } : {}),
      });
      void api<Page>(tab === "recent" ? `/workspace/recent?publicOnly=true&q=${encodeURIComponent(q)}&offset=${offset}${kind ? `&kind=${kind}` : ""}` : `/discovery/resources?${params}`)
        .then((p) => {
          if (active) setPage(p);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, policy, kind, q, offset, tab, revision]);
  async function update(items: Item[], collect: boolean) {
    setBusy(true);
    setError("");
    try {
      for (const item of items)
        await api(`/discovery/entries/${item.kind}/${item.id}`, "PUT", {
          collected: collect,
        });
      setSelected([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setRevision((v) => v + 1);
    }
  }
  if (!policy) return null;
  if (!enabled)
    return <section className="empty">{t("discovery.closed")}</section>;
  return (
    <section className="discovery-page">
      <header>
        <div>
          <h1>{t("workspace.publicResources")}</h1>
          <p className="subtle">
            {t("workspace.publicHelp")}
          </p>
        </div>
      </header>
      <div className="home-tabs resource-filter-tabs" role="tablist">
        {([['recent','workspace.browsed'],...(policy.publicDiscovery ? [['discover','discovery.title']] : []),['collected','workspace.saved']] as const).map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} className={tab===key?'active':''} onClick={()=>{setTab(key);setKind("");}}>{t(label as Parameters<typeof t>[0])}</button>)}
      </div>
      <div className="discovery-controls">
        <Select
          aria-label={t("discovery.type")}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">{t("discovery.all")}</option>
          {publicResourceKinds
            .filter((k) => tab !== "discover" || policy.publicModes[k] !== "link")
            .map((k) => (
              <option key={k} value={k}>
                {t(`discovery.kind.${k}`)}
              </option>
            ))}
        </Select>
        <input
          type="search"
          aria-label={t("discovery.search")}
          placeholder={t("discovery.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {collected && (
          <button
            disabled={busy || !selected.length}
            onClick={() =>
              void update(
                page?.items.filter((i) => selected.includes(i.id)) ?? [],
                false,
              )
            }
          >
            {t("discovery.removeSelected")}
          </button>
        )}
      </div>
      <Feedback tone="error" message={error} />
      {!page && !error && <p>{t("common.loading")}</p>}
      {page && !page.items.length && (
        <p className="empty">{t("discovery.empty")}</p>
      )}
      <ul className="discovery-list">
        {page?.items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            {collected && (
              <input
                type="checkbox"
                aria-label={item.title}
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked
                      ? [...ids, item.id]
                      : ids.filter((id) => id !== item.id),
                  )
                }
              />
            )}
            <div>
              <a href={resourceHref(item)}>{item.title}</a>
              <small>
                {t(`discovery.kind.${item.kind}`)}
                {(item.kind === "folder" || item.kind === "library") &&
                  ` · ${t("discovery.futureContent")}`}
              </small>
            </div>
            <button
              className="collection-action"
              aria-label={t(item.collected ? "discovery.remove" : "discovery.collect")}
              title={t(item.collected ? "discovery.remove" : "discovery.collect")}
              aria-pressed={item.collected}
              disabled={busy}
              onClick={() => void update([item], !item.collected)}
            >
              {item.collected ? <BookmarkCheck size={17}/> : <BookmarkPlus size={17}/>}
            </button>
          </li>
        ))}
      </ul>
      {page && (
        <footer>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t("discovery.previous")}
          </button>
          <span>{page.total ?? ""}</span>
          <button
            disabled={page.nextOffset === null}
            onClick={() => setOffset(page.nextOffset!)}
          >
            {t("discovery.next")}
          </button>
        </footer>
      )}
    </section>
  );
}
