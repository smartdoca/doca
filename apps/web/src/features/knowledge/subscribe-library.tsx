import {Select} from "@web/shared/components/select.js";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import { api, roleRank, type Resource } from "@web/shared/api.js";

export type SubscribeTarget = { kind: "document" | "file" | "folder" | "url"; id: string; title: string; url?: string };

export function SubscribeLibraryHost() {
  const [target, setTarget] = useState<SubscribeTarget | null>(null);
  useEffect(() => {
    const onSubscribe = (event: Event) => {
      const detail = (event as CustomEvent<SubscribeTarget>).detail;
      if (detail?.kind && detail.title) setTarget(detail);
    };
    window.addEventListener("doca-subscribe-library", onSubscribe);
    return () => window.removeEventListener("doca-subscribe-library", onSubscribe);
  }, []);
  if (!target) return null;
  return <SubscribeLibraryDialog target={target} close={() => setTarget(null)} />;
}

export function SubscribeLibraryDialog({ target, close }: { target: SubscribeTarget; close: () => void }) {
const { t } = useI18n();

  const [libraries, setLibraries] = useState<Resource[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Resource[] }>("/resources?scope=all&kind=library", "GET", undefined, controller.signal)
      .then((page) => {
        const manageable = page.items.filter((item) => roleRank(item.role) >= 4);
        setLibraries(manageable);
        setLibraryId(manageable[0]?.id ?? "");
      })
      .catch((cause) => {
        if ((cause as { name?: string }).name !== "AbortError") setError(cause instanceof Error ? cause.message : "知识库加载失败");
      });
    return () => controller.abort();
  }, []);

  async function submit() {
    if (!libraryId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/knowledge/libraries/${libraryId}/subscriptions`, "POST", {
        sourceKind: target.kind,
        sourceId: target.kind === "url" ? undefined : target.id,
        url: target.kind === "url" ? target.url || target.title : undefined,
      });
      close();
      location.hash = `/r/${libraryId}?view=system`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "收入知识库失败");
      setBusy(false);
    }
  }

  return (
    <div className="file-info-backdrop" role="presentation" onClick={close}>
      <section className="file-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("doc.collect")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>{t("doc.collect")}</strong>
            <span>{target.title}</span>
          </div>
          <button className="icon" onClick={close} aria-label={t("dialog.close")}>×</button>
        </header>
        {libraries.length ? (
          <label className="subscribe-library-pick">
            <span>放到哪个知识库</span>
            <Select value={libraryId} onChange={(event) => setLibraryId(event.target.value)}>
              {libraries.map((library) => <option key={library.id} value={library.id}>{library.title}</option>)}
            </Select>
          </label>
        ) : <p>还没有你能管理的知识库。先新建一个，再把来源收进去。</p>}
        <p>提交后出现在知识体系页。确认加入之后，才写进文档树。</p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button className="secondary" onClick={close}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy || !libraryId} onClick={() => void submit()}>收入</button>
        </footer>
      </section>
    </div>
  );
}
