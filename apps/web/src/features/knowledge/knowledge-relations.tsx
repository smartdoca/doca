import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FileText, FolderOpen, Library, Mail, Search, X } from "lucide-react";
import { api } from "@web/shared/api.js";
import "./knowledge-relations.css";

type Source = { kind: string; id: string; title: string; chunks: number; copies?: number; words?: string };
type KnowledgeLink = {
  id: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
  score: number;
  reason: string;
  fromTitle: string;
  toTitle: string;
};
type Gap = { id: string; query: string; status: string; detail: string; created_at: string };
type Topic = { label: string; sources: Source[] };
type WebSource = { title: string; url: string; snippet: string; terms?: string[]; lead?: boolean };
type Freshness = "any" | "day" | "week" | "month" | "year";
type SearchLanguage = "any" | "zh" | "en";
type Capture = {
  gap: Gap;
  query: string;
  site: string;
  exclude: string;
  freshness: Freshness;
  language: SearchLanguage;
  searched: string;
  sources: WebSource[];
  selected: string[];
  step: "form" | "results";
};
type Graph = { sources: Source[]; links: KnowledgeLink[]; gaps: Gap[]; topics?: Topic[] };
type Hit = { id: string; title: string; text: string; sourceKind: string; sourceId: string; score: number; terms?: string[] };
type Focus = { kind: string; id: string } | null;

const kindLabel: Record<string, string> = {
  document: "文档",
  file: "文件",
  mail: "邮件",
  folder: "文件夹",
  library: "知识库",
};

const kindRank: Record<string, number> = { document: 0, library: 1, folder: 2, file: 3, mail: 4 };

function parseFocus(hash: string): Focus {
  const source = new URLSearchParams(hash.split("?")[1] ?? "").get("source");
  const split = source?.match(/^([a-z]+):([0-9a-f-]{36})$/i);
  if (!split) return null;
  return { kind: split[1]!, id: split[2]! };
}

function openOriginal(kind: string, id: string) {
  if (kind === "document" || kind === "library") location.hash = `/r/${id}`;
  else if (kind === "mail") location.hash = "/mail";
  else location.hash = "/files";
}

function gapMatches(gap: Gap, title: string, label: string) {
  const query = gap.query.trim().toLocaleLowerCase();
  const name = title.trim().toLocaleLowerCase();
  if (query.length >= 2 && (name.includes(query) || query.includes(name))) return true;
  return label.trim().length >= 2 && query.includes(label.trim().toLocaleLowerCase());
}

function compactSources(sources: Source[]) {
  const grouped = new Map<string, Source>();
  for (const source of sources) {
    const title = (source.title || "未命名").trim() || "未命名";
    const key = `${source.kind}:${title.toLocaleLowerCase()}`;
    const current = grouped.get(key);
    if (!current) grouped.set(key, { ...source, title, copies: 1 });
    else {
      current.chunks += source.chunks;
      current.copies = (current.copies ?? 1) + 1;
    }
  }
  return [...grouped.values()].sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) || b.chunks - a.chunks);
}

function compactLinks(links: KnowledgeLink[]) {
  const grouped = new Map<string, KnowledgeLink>();
  for (const link of links) {
    const from = link.fromTitle || kindLabel[link.from_kind] || "";
    const to = link.toTitle || kindLabel[link.to_kind] || "";
    if (from && from === to && link.from_kind === link.to_kind) continue;
    const key = `${link.relation}:${from.toLocaleLowerCase()}:${to.toLocaleLowerCase()}`;
    if (!grouped.has(key)) grouped.set(key, link);
  }
  return [...grouped.values()];
}

export function KnowledgeRelations() {
  const [hash, setHash] = useState(location.hash);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [focusLinks, setFocusLinks] = useState<KnowledgeLink[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const focus = parseFocus(hash);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void (async () => {
      try {
        if (focus) {
          const related = await api<{ links: KnowledgeLink[] }>("/knowledge/related", "POST", focus, controller.signal);
          if (!controller.signal.aborted) setFocusLinks(related.links);
        } else setFocusLinks([]);
        const next = await api<Graph>("/knowledge/graph", "GET", undefined, controller.signal);
        if (!controller.signal.aborted) setGraph(next);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "知识关系加载失败");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [focus?.kind, focus?.id]);

  const sources = useMemo(() => compactSources(graph?.sources ?? []), [graph]);
  const topics = useMemo(() => (
    graph?.topics?.length
      ? graph.topics.map((topic) => ({ label: topic.label, sources: compactSources(topic.sources) }))
      : sources.map((source) => ({ label: source.title, sources: [source] }))
  ), [graph, sources]);
  const currentTopic = focus ? topics.find((topic) => topic.sources.some((source) => source.kind === focus.kind && source.id === focus.id)) : undefined;
  const focusSource = currentTopic?.sources.find((source) => source.kind === focus?.kind && source.id === focus?.id);
  const sameTopic = (currentTopic?.sources ?? []).filter((source) => source.kind !== focus?.kind || source.id !== focus?.id);
  const links = useMemo(() => compactLinks(focusLinks), [focusLinks]);
  const organizeLinks = links.filter((link) => link.relation === "organize");
  const relatedGaps = (graph?.gaps ?? []).filter((gap) => focusSource && gapMatches(gap, focusSource.title, currentTopic?.label ?? ""));
  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const source of sources) tally.set(source.kind, (tally.get(source.kind) ?? 0) + 1);
    return ["document", "file", "mail", "library", "folder"]
      .filter((kind) => tally.has(kind))
      .map((kind) => ({ kind, count: tally.get(kind) ?? 0 }));
  }, [sources]);

  async function search(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ items: Hit[] }>("/knowledge/search", "POST", { query: text });
      setHits(result.items);
      setGraph(await api<Graph>("/knowledge/graph"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检索失败");
    } finally {
      setBusy(false);
    }
  }

  async function feedback(hit: Hit, judgment: "useful" | "irrelevant") {
    setError("");
    try {
      await api("/knowledge/feedback", "POST", { chunkId: hit.id, judgment, query });
      const result = await api<{ items: Hit[] }>("/knowledge/search", "POST", { query });
      setHits(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "反馈没有记下");
    }
  }

  async function hide(linkId: string) {
    setError("");
    try {
      await api(`/knowledge/links/${linkId}/hide`, "POST");
      setFocusLinks((current) => current.filter((link) => link.id !== linkId));
      setGraph(await api<Graph>("/knowledge/graph"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "忽略失败");
    }
  }

  function openCapture(gap: Gap) {
    const detail = safeDetail(gap.detail);
    const sources = detail?.sources ?? [];
    setError("");
    setCapture({
      gap,
      query: detail?.query || gap.query,
      site: detail?.site ?? "",
      exclude: detail?.exclude ?? "",
      freshness: detail?.freshness ?? "any",
      language: detail?.language ?? "any",
      searched: detail?.searched ?? "",
      sources,
      selected: sources.filter((source) => source.lead).map((source) => source.url),
      step: gap.status === "ready" && sources.length ? "results" : "form",
    });
  }

  async function expandCapture() {
    if (!capture || capture.query.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      const detail = await api<Capture & { sources: WebSource[] }>(`/knowledge/gaps/${capture.gap.id}/expand`, "POST", {
        query: capture.query.trim(),
        site: capture.site.trim(),
        exclude: capture.exclude.trim(),
        freshness: capture.freshness,
        language: capture.language,
      });
      setCapture({
        ...capture,
        searched: detail.searched,
        sources: detail.sources,
        selected: detail.sources.filter((source) => source.lead).map((source) => source.url),
        step: "results",
        gap: { ...capture.gap, status: "ready" },
      });
      setGraph(await api<Graph>("/knowledge/graph"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "联网补充失败");
    } finally {
      setBusy(false);
    }
  }

  async function fillCapture() {
    if (!capture) return;
    const chosen = capture.sources.filter((source) => capture.selected.includes(source.url));
    if (!chosen.length) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<{ id: string }>("/resources", "POST", {
        kind: "document",
        format: "markdown",
        title: capture.query.trim() || capture.gap.query,
        markdown: captureMarkdown(capture.query.trim() || capture.gap.query, chosen),
      });
      await api(`/knowledge/gaps/${capture.gap.id}/fill`, "POST", { documentId: created.id, urls: chosen.map((source) => source.url) });
      setCapture(null);
      setGraph(await api<Graph>("/knowledge/graph"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "收入知识库失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="knowledge-relations">
      <header>
        <p>原文保持不动。按主题看关系，点开一条再看同主题、整理建议和相关缺口。</p>
        <form onSubmit={(event) => void search(event)}>
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在你能看的文档、文件、邮件里查找" aria-label="查找知识" />
          <button type="submit" disabled={busy || !query.trim()}>查找</button>
        </form>
      </header>
      {error && <p className="knowledge-relations-error" role="alert">{error}</p>}
      {focus && (
        <div className="knowledge-focus">
          <strong>当前：{kindLabel[focus.kind] ?? focus.kind}</strong>
          <button onClick={() => openOriginal(focus.kind, focus.id)}>打开原文</button>
          <button onClick={() => { location.hash = "/knowledge"; }}>看全部</button>
        </div>
      )}
      {!focus && (
        <div className="knowledge-stats" aria-label="知识规模">
          {counts.length === 0 && <span>{busy ? "正在整理…" : "还没有可显示的知识片段。"}</span>}
          {counts.map((item) => (
            <span key={item.kind}><b>{item.count}</b>{kindLabel[item.kind]}</span>
          ))}
          {(graph?.gaps.length ?? 0) > 0 && <span><b>{graph?.gaps.length}</b>缺口</span>}
        </div>
      )}
      {!focus && (
        <div className="knowledge-topics">
          {topics.map((topic) => (
            <section key={`${topic.label}:${topic.sources[0]?.id ?? topic.label}`}>
              <h2>{topic.label} <small>{topic.sources.length} 条</small></h2>
              <ul>
                {topic.sources.slice(0, 8).map((source) => (
                  <li key={`${source.kind}:${source.id}`} className="knowledge-source">
                    <button onClick={() => { location.hash = `/knowledge?source=${source.kind}:${source.id}`; }}>
                      <KindIcon kind={source.kind} />
                      <span>
                        <strong title={source.title}>{source.title}</strong>
                        <small>{kindLabel[source.kind] ?? source.kind} · {source.chunks} 块{(source.copies ?? 1) > 1 ? ` · ${source.copies} 份` : ""}{source.words ? ` · 共用 ${source.words}` : ""}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!topics.length && <p className="knowledge-empty">{busy ? "正在整理来源…" : "还没有可显示的知识片段。"}</p>}
        </div>
      )}
      {focus && (
        <div className="knowledge-columns">
          <section>
            <h2>同主题 <small>{sameTopic.length ? `${sameTopic.length} 条` : ""}</small></h2>
            <ul>
              {sameTopic.map((source) => (
                <li key={`${source.kind}:${source.id}`} className="knowledge-source">
                  <button onClick={() => { location.hash = `/knowledge?source=${source.kind}:${source.id}`; }}>
                    <KindIcon kind={source.kind} />
                    <span>
                      <strong title={source.title}>{source.title}</strong>
                      <small>{kindLabel[source.kind] ?? source.kind}{source.words ? ` · 共用 ${source.words}` : ""}</small>
                    </span>
                  </button>
                </li>
              ))}
              {!sameTopic.length && <li className="knowledge-empty">没有共用实词的其他条目。</li>}
            </ul>
          </section>
          <section>
            <h2>整理建议 <small>{organizeLinks.length ? `${organizeLinks.length} 条` : ""}</small></h2>
            <ul>
              {organizeLinks.map((link) => (
                <li key={link.id} className="knowledge-link">
                  <div className="knowledge-copy">
                    <div className="knowledge-line">
                      <i className="is-organize">整理</i>
                      <strong title={`${link.fromTitle} → ${link.toTitle}`}>{link.fromTitle || kindLabel[link.from_kind]} → {link.toTitle || kindLabel[link.to_kind]}</strong>
                    </div>
                    {link.reason && <p>{link.reason}</p>}
                  </div>
                  <button onClick={() => void hide(link.id)}>忽略</button>
                </li>
              ))}
              {!organizeLinks.length && <li className="knowledge-empty">没有需要确认的归类建议。确认建议不会移动文件。</li>}
            </ul>
          </section>
          <section>
            <h2>相关缺口 <small>{relatedGaps.length ? `${relatedGaps.length} 条` : ""}</small></h2>
            <ul>
              {relatedGaps.map((gap) => <GapRow key={gap.id} gap={gap} busy={busy} onOpen={openCapture} />)}
              {!relatedGaps.length && <li className="knowledge-empty">这条主题下还没有未收录的问题。</li>}
            </ul>
          </section>
        </div>
      )}
      <section className="knowledge-gaps">
        <h2>资料缺口 <small>{graph?.gaps.length ? `${graph.gaps.length} 条` : ""}</small></h2>
        <ul>
          {(graph?.gaps ?? []).map((gap) => <GapRow key={gap.id} gap={gap} busy={busy} onOpen={openCapture} />)}
          {!graph?.gaps.length && <li className="knowledge-empty">本地找不到时，缺口会出现在这里。联网结果要你确认后才入库。</li>}
        </ul>
      </section>
      {capture && (
        <CapturePanel
          capture={capture}
          busy={busy}
          onChange={setCapture}
          onSearch={() => void expandCapture()}
          onSave={() => void fillCapture()}
          onClose={() => setCapture(null)}
        />
      )}
      {hits && (
        <section className="knowledge-hits" aria-label="检索结果">
          <header><h2>检索结果</h2><button onClick={() => setHits(null)} aria-label="关闭检索结果"><X size={14} /></button></header>
          {!hits.length && <p className="knowledge-empty">没有命中。这个问题已记成资料缺口。</p>}
          {hits.map((hit) => (
            <article key={hit.id}>
              <header>
                <strong title={hit.title}>{hit.title}</strong>
                <small>{kindLabel[hit.sourceKind] ?? hit.sourceKind} · {hit.score.toFixed(2)}</small>
              </header>
              {!!hit.terms?.length && <p className="knowledge-terms">命中：{hit.terms.join("、")}</p>}
              <p>{hit.text.slice(0, 220)}</p>
              <footer>
                <button onClick={() => void feedback(hit, "useful")}>有用</button>
                <button onClick={() => void feedback(hit, "irrelevant")}>无关</button>
                <button onClick={() => { location.hash = `/knowledge?source=${hit.sourceKind}:${hit.sourceId}`; }}>查看关系</button>
              </footer>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}

function GapRow({ gap, busy, onOpen }: { gap: Gap; busy: boolean; onOpen: (gap: Gap) => void }) {
  const detail = gap.status === "ready" ? safeDetail(gap.detail) : null;
  const count = detail?.sources?.length ?? 0;
  const status = gap.status === "filled" ? "已收入知识库" : gap.status === "covered" ? "已有资料" : gap.status === "ready" ? `已找到 ${count} 条，请选择后收录` : "本地没有足够资料";
  return (
    <li className="knowledge-gap">
      <div className="knowledge-copy">
        <strong title={gap.query}>{gap.query}</strong>
        <p>{status}</p>
      </div>
      {gap.status === "open" && <button disabled={busy} onClick={() => onOpen(gap)}>联网补充</button>}
      {gap.status === "ready" && <button disabled={busy} onClick={() => onOpen(gap)}>选择收录</button>}
    </li>
  );
}

function CapturePanel({ capture, busy, onChange, onSearch, onSave, onClose }: {
  capture: Capture;
  busy: boolean;
  onChange: (capture: Capture) => void;
  onSearch: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const chosen = capture.sources.filter((source) => capture.selected.includes(source.url));
  return (
    <section className="knowledge-capture" aria-label="联网补充">
      <header>
        <h2>{capture.step === "form" ? "联网补充" : "选择要收录的结果"}</h2>
        <button type="button" onClick={onClose} aria-label="关闭联网补充"><X size={14} /></button>
      </header>
      {capture.step === "form" ? (
        <form onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <label><span>搜索什么</span><textarea value={capture.query} onChange={(event) => onChange({ ...capture, query: event.target.value })} rows={2} maxLength={240} /></label>
          <label><span>只搜这些网站</span><input value={capture.site} onChange={(event) => onChange({ ...capture, site: event.target.value })} placeholder="example.com，多个用空格分开" /></label>
          <label><span>排除这些词</span><input value={capture.exclude} onChange={(event) => onChange({ ...capture, exclude: event.target.value })} placeholder="不想出现的词，用空格分开" /></label>
          <div className="knowledge-capture-limits">
            <label><span>时间</span>
              <select value={capture.freshness} onChange={(event) => onChange({ ...capture, freshness: event.target.value as Freshness })}>
                <option value="any">不限</option>
                <option value="day">最近一天</option>
                <option value="week">最近一周</option>
                <option value="month">最近一月</option>
                <option value="year">最近一年</option>
              </select>
            </label>
            <label><span>语言</span>
              <select value={capture.language} onChange={(event) => onChange({ ...capture, language: event.target.value as SearchLanguage })}>
                <option value="any">不限</option>
                <option value="zh">中文</option>
                <option value="en">英文</option>
              </select>
            </label>
          </div>
          <footer>
            <button type="submit" disabled={busy || capture.query.trim().length < 2}>开始搜索</button>
          </footer>
        </form>
      ) : (
        <div className="knowledge-capture-results">
          {capture.searched && <p className="knowledge-capture-query">实际搜索：{capture.searched}</p>}
          {!capture.sources.length && <p className="knowledge-empty">没有符合这些限制的公开结果。</p>}
          <ul>
            {capture.sources.map((source) => {
              const checked = capture.selected.includes(source.url);
              return (
                <li key={source.url}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onChange({
                        ...capture,
                        selected: checked ? capture.selected.filter((url) => url !== source.url) : [...capture.selected, source.url],
                      })}
                    />
                    <span>
                      <strong>{source.title}</strong>
                      <small>{sourceHost(source.url)}{source.terms?.length ? ` · 命中：${source.terms.join("、")}` : " · 未对上实词"}</small>
                      <em>{source.snippet}</em>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <footer>
            <button type="button" onClick={() => onChange({ ...capture, step: "form" })}>修改限制</button>
            <button type="button" disabled={!capture.sources.length || capture.selected.length === capture.sources.length} onClick={() => onChange({ ...capture, selected: capture.sources.map((source) => source.url) })}>全选</button>
            <button type="button" disabled={!capture.selected.length} onClick={() => onChange({ ...capture, selected: [] })}>全不选</button>
            <button type="button" className="primary" disabled={busy || !chosen.length} onClick={onSave}>收入选中的 {chosen.length} 条</button>
          </footer>
        </div>
      )}
    </section>
  );
}

function captureMarkdown(query: string, sources: WebSource[]) {
  return [
    `# ${query}`,
    "",
    "以下内容来自公开网页，由你勾选后收入知识库。",
    "",
    ...sources.flatMap((source) => [`## ${source.title}`, "", source.snippet, "", `来源：${source.url}`, ""]),
  ].join("\n");
}

function sourceHost(url: string) {
  try { return new URL(url).hostname; } catch { return url; }
}

function safeDetail(detail: string) {
  try {
    return JSON.parse(detail) as {
      query?: string;
      site?: string;
      exclude?: string;
      freshness?: Freshness;
      language?: SearchLanguage;
      searched?: string;
      sources?: WebSource[];
    };
  } catch {
    return null;
  }
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "file") return <FolderOpen size={15} />;
  if (kind === "mail") return <Mail size={15} />;
  if (kind === "library" || kind === "folder") return <Library size={15} />;
  return <FileText size={15} />;
}
