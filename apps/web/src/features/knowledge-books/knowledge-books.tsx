import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  BookOpenCheck,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  Search,
  FileText,
  Link2,
  Trash2,
  Plus,
  Layers,
} from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Segmented,
  Space,
  Switch,
  Tabs,
  Tag,
  Tree,
} from "antd";
import type { DataNode } from "antd/es/tree";
import type { MessageKey } from "@doca/i18n";
import type {
  BookArtifact,
  BookConfiguration,
  BookFeedbackInput,
  BookSourceInput,
  BookSourceBinding,
  BookWorkflow,
} from "@core/modules/knowledge-books/protocol.js";
import { BookRunList, type BookRunSummary } from "./book-run-list.js";
import { BookRunPipeline, type BookPipelineRun } from "./book-run-pipeline.js";
import { systemErrorMessage } from "@doca/i18n";
import {
  bookSourceInputSchema,
  bookSourceBindingKey,
} from "@core/modules/knowledge-books/protocol.js";
import { useAI } from "@web/features/ai/ai-context.js";
import type { ContentSourceDescriptor } from "@smartdoca/plugin-sdk/content";
import { api, type Detail } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import MarkdownPreview from "@web/features/documents/markdown-preview.js";
import { PermissionDialog } from "@web/features/documents/dialogs.js";
import { BookGraph } from "./book-graph.js";
import { BookReader } from "./book-reader.js";
import { BookWebSources } from "./book-web-sources.js";
import { bookPageTree, type BookPageNode } from "./book-reading-model.js";
import "./knowledge-books.css";

function Preview({ value }: { value: string }) {
  return (
    <div className="book-markdown">
      <MarkdownPreview value={value} />
    </div>
  );
}

function BookHeader({
  title,
  actions,
}: {
  title?: string;
  actions?: ReactNode;
}) {
  const bt = useBookText();
  const [slots, setSlots] = useState<{
    title: HTMLElement;
    actions: HTMLElement;
  }>();
  useEffect(() => {
    const title = document.getElementById("knowledge-books-header-title");
    const actions = document.getElementById("knowledge-books-header-actions");
    if (title && actions) setSlots({ title, actions });
  }, []);
  return (
    slots && (
      <>
        {createPortal(
          <div className="book-topbar-title">
            <BookOpenCheck size={20} />
            {title ? (
              <>
                <a href="#/knowledge-books">{bt("title")}</a>
                <ChevronRight size={14} />
                <h1 title={title}>{title}</h1>
              </>
            ) : (
              <h1>{bt("title")}</h1>
            )}
          </div>,
          slots.title,
        )}
        {createPortal(
          <div className="book-header-actions">{actions}</div>,
          slots.actions,
        )}
      </>
    )
  );
}

type Source = {
  id: string;
  revision: number;
  title: string;
  configuration: BookSourceInput | null;
  bindings: Array<{
    id: string;
    kind: BookSourceBinding["kind"];
    title: string;
  }>;
  status: "active" | "paused" | "removed";
  readable: boolean;
  canEdit: boolean;
  canRemove: boolean;
};
type Feedback = {
  origin: {
    method: "manual" | "assistant";
    actorId: string;
    createdAt: string;
  };
  id: string;
  revision: number;
  detail: BookFeedbackInput;
  status: "active" | "withdrawn";
  canEdit: boolean;
  authorId: string;
  canWithdraw: boolean;
  readable: boolean;
  createdAt: string;
};
type Release = {
  id: string;
  revision: number;
  artifact: BookArtifact | null;
  restricted: boolean;
};
type Run = BookRunSummary;
type Book = {
  detail: Detail;
  revision: number;
  configuration: BookConfiguration | null;
  publishedOnly: boolean;
  canEdit: boolean;
  canComment: boolean;
  canManage: boolean;
  sources: Source[];
  feedback: Feedback[];
  runs: Run[];
  releases: { id: string; revision: number }[];
  publishedRelease: Release | null;
};
type HumanTask = {
  instructions: string;
  nodeLabel: string;
  nodeType: string;
  criteria: BookConfiguration["criteria"];
  id: string;
  book_id: string;
  book_title: string;
  run_id: string;
  node_id: string;
  kind: "review" | "publication" | "repair";
  title: string;
  status: string;
  revision: number;
  stale: boolean;
  readable: boolean;
  output: {
    pages?: BookArtifact["pages"];
    checks?: BookArtifact["checks"];
    claims?: BookArtifact["claims"];
  } | null;
  error: string;
  resolution: { note: string; decision: string } | null;
};
function useBookError() {
  const { t } = useI18n();
  return (value: string) => systemErrorMessage(value, t);
}
function useBookText() {
  const { t } = useI18n();
  return (key: string, data?: Parameters<typeof t>[1]) => t(`books.${key}` as MessageKey, data);
}
const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function KnowledgeBooksPage({ id }: { id?: string }) {
  return id && id !== "tasks" ? (
    <KnowledgeBookPage key={id} id={id} />
  ) : (
    <KnowledgeBookList tasks={id === "tasks"} />
  );
}
function KnowledgeBookList({ tasks }: { tasks: boolean }) {
  const bt = useBookText();
  const [items, setItems] = useState<
    Array<{
      id: string;
      title: string;
      revision: number;
      published_release_id: string | null;
    }>
  >([]);
  const [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [title, setTitle] = useState("");
  const load = useCallback(async () => {
    try {
      setItems(
        (
          await api<{ items: typeof items }>(
            `/knowledge-books?offset=${offset}`,
          )
        ).items,
      );
    } catch (e) {
      setError(failure(e));
    }
  }, [offset]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="knowledge-books-page">
      <BookHeader
        actions={
          <>
            <Button href="#/knowledge-books/tasks">{bt("humanTasks")}</Button>
            <Button type="primary" onClick={() => setCreating(true)}>
              {bt("create")}
            </Button>
          </>
        }
      />
      <p className="book-lead">{tasks ? bt("humanTasks") : bt("lead")}</p>
      {error && <Alert type="error" showIcon message={error} />}
      {tasks ? (
        <BookHumanTasks />
      ) : (
        <div className="book-list-content">
          <div className="book-cards">
            {items.map((item) => (
              <Card
                key={item.id}
                title={
                  <a href={`#/knowledge-books/${item.id}`}>{item.title}</a>
                }
              >
                <Tag>
                  {item.published_release_id
                    ? bt("published")
                    : bt("unpublished")}
                </Tag>
                <p>
                  {bt("revision")} {item.revision}
                </p>
                <Button size="small" href={`#/knowledge-books/${item.id}`}>
                  {bt("openBook")}
                </Button>
              </Card>
            ))}
          </div>
          {!items.length && <Empty description={bt("empty")} />}
          <Space>
            <Button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              {bt("previous")}
            </Button>
            <Button
              disabled={items.length < 50}
              onClick={() => setOffset(offset + 50)}
            >
              {bt("next")}
            </Button>
          </Space>
        </div>
      )}
      <Modal
        title={bt("create")}
        open={creating}
        onCancel={() => setCreating(false)}
        confirmLoading={busy}
        okText={bt("create")}
        cancelText={bt("cancel")}
        onOk={async () => {
          setBusy(true);
          try {
            const value = await api<{ id: string }>(
              "/knowledge-books",
              "POST",
              { title },
            );
            setCreating(false);
            location.hash = `/knowledge-books/${value.id}`;
          } catch (e) {
            setError(failure(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form layout="vertical">
          <Form.Item label={bt("name")} required>
            <Input
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
function KnowledgeBookPage({ id }: { id: string }) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<"reading" | "review">("reading");
  const [taskLink, setTaskLink] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? ""));
  const [activeTab, setActiveTab] = useState(() => taskLink.has("task") ? "tasks" : taskLink.has("run") ? "runs" : "result"),
    [targetParagraph, setTargetParagraph] = useState<string | null>(null);
  const bt = useBookText(),
    be = useBookError(),
    ai = useAI();
  const [book, setBook] = useState<Book | null>(null),
    [draft, setDraft] = useState<BookConfiguration | null>(null),
    [dirty, setDirty] = useState(false);
  const draftRevision = useRef(0),
    dirtyRef = useRef(false);
  useEffect(() => {
    const changed = () => {
      const link = new URLSearchParams(location.hash.split("?")[1] ?? "");
      setTaskLink(link);
      if (link.has("task")) setActiveTab("tasks");
      else if (link.has("run")) setActiveTab("runs");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [permissions, setPermissions] = useState(false),
    [source, setSource] = useState<Source | "new" | null>(null),
    [feedback, setFeedback] = useState<Feedback | "new" | null>(null);
  const [release, setRelease] = useState<Release | null>(null),
    [pageId, setPageId] = useState<string>(),
    [anchor, setAnchor] = useState<{
      pageId: string | null;
      paragraphId: string | null;
    }>({ pageId: null, paragraphId: null });
  const [sourceQuery, setSourceQuery] = useState(""),
    [nodeId, setNodeId] = useState<string>(),
    [run, setRun] = useState<BookPipelineRun | null>(null);
  const load = useCallback(
    async (reset = true) => {
      let value: Book;
      try {
        value = await api<Book>(`/knowledge-books/${id}`);
      } catch (error) {
        if (
          [401, 403, 404].includes((error as { status?: number }).status ?? 0)
        ) {
          setBook(null);
          setDraft(null);
          setRelease(null);
        }
        throw error;
      }
      let selectedRelease = value.publishedRelease;
      if (
        release &&
        release.id !== book?.publishedRelease?.id &&
        value.releases.some((item) => item.id === release.id)
      ) {
        try {
          selectedRelease = await api<Release>(
            `/knowledge-books/${id}/releases/${release.id}`,
          );
        } catch (error) {
          setRelease(null);
          throw error;
        }
      }
      setBook(value);
      if (
        reset ||
        (!dirtyRef.current && draftRevision.current !== value.revision)
      ) {
        setDraft(value.configuration);
        setDirty(false);
        dirtyRef.current = false;
        draftRevision.current = value.revision;
      }
      setRelease((current) =>
        current?.id === selectedRelease?.id &&
        current?.restricted === selectedRelease?.restricted
          ? current
          : selectedRelease,
      );
    },
    [id, book?.publishedRelease?.id, release?.id],
  );
  useEffect(() => {
    void load().catch((e) => setError(failure(e)));
  }, [id]);
  useEffect(() => {
    const timer = setInterval(() => {
      void load(false).catch((e) => setError(failure(e)));
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!run) return;
    let active = true, refreshing = false;
    const refreshRun = () => {
      if (refreshing) return;
      refreshing = true;
      void api<NonNullable<typeof run>>(`/knowledge-books/${id}/runs/${run.id}`)
        .then(value => {
          if (!active) return;
          setRun(value);
          setBook(current => current ? { ...current, runs: current.runs.map(item => item.id === value.id ? { ...item, status: value.status, updated_at: value.updatedAt, started_at: value.startedAt, trigger: value.trigger } : item) } : current);
        })
        .catch(e => { if (active) setError(failure(e)); })
        .finally(() => { refreshing = false; });
    };
    const timer = setInterval(refreshRun, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [id, run?.id]);
  const openRun = useCallback(async (runId: string) => {
    const value = await api<BookPipelineRun>(`/knowledge-books/${id}/runs/${runId}`);
    setRun(value);
    setActiveTab("runs");
  }, [id]);
  useEffect(() => {
    if (taskLink.has("task")) return;
    const linkedRun = taskLink.get("run");
    if (linkedRun) void openRun(linkedRun).catch(e => setError(failure(e)));
  }, [openRun, taskLink]);
  useEffect(() => {
    if (activeTab === "runs" && !run && book?.runs[0]) void openRun(book.runs[0].id).catch(e => setError(failure(e)));
  }, [activeTab, book?.runs[0]?.id, run?.id, openRun]);
  const command = async <T,>(value: unknown) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<T>(
        `/knowledge-books/${id}/commands`,
        "POST",
        value,
      );
      await load(false);
      return result;
    } catch (e) {
      setError(failure(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const change = (value: BookConfiguration) => {
    setDraft(value);
    setDirty(true);
    dirtyRef.current = true;
  };
  useEffect(() => {
    if (activeTab === "result" && viewMode === "review" && targetParagraph)
      document
        .getElementById(`book-paragraph-${targetParagraph}`)
        ?.scrollIntoView({ block: "start" });
  }, [activeTab, viewMode, targetParagraph, release?.id, pageId]);
  if (book?.publishedOnly) return <PublishedBookView book={book} />;
  if (!book || !draft)
    return (
      <div className="knowledge-books-page">
        {error ? <Alert type="error" message={error} /> : bt("loading")}
      </div>
    );
  const page =
    release?.artifact?.pages.find((p) => p.id === pageId) ??
    release?.artifact?.pages[0];
  const editNode = draft.workflow.nodes.find((n) => n.id === nodeId);
  const updateNode = (value: typeof editNode) => {
    if (value)
      change({
        ...draft,
        workflow: {
          ...draft.workflow,
          nodes: draft.workflow.nodes.map((n) =>
            n.id === value.id ? value : n,
          ),
        },
      });
  };
  const renderFeedback = () => (
    <>
      <Space>
        <Button
          disabled={!book.canComment}
          onClick={() => {
            setAnchor({ pageId: null, paragraphId: null });
            setFeedback("new");
          }}
        >
          {bt("addFeedback")}
        </Button>
        <span>{bt("feedbackHelp")}</span>
      </Space>
      <div className="book-cards">
        {book.feedback.map((item) => (
          <Card
            key={item.id}
            title={bt(`feedback.${item.detail.kind}`)}
            extra={<Tag>{bt(item.status)}</Tag>}
          >
            <Tag>{bt(`origin.${item.origin.method}`)}</Tag>
            <p className="book-prewrap">
              {item.readable ? item.detail.content : bt("restricted")}
            </p>
            {item.detail.pageId && (
              <a
                onClick={() => {
                  setPageId(item.detail.pageId!);
                  setTargetParagraph(item.detail.paragraphId);
                  setViewMode("review");
                  setActiveTab("result");
                  void api<Release>(
                    `/knowledge-books/${id}/releases/${item.detail.releaseId}`,
                  )
                    .then(setRelease)
                    .catch((e) => setError(failure(e)));
                }}
              >
                {bt("targetParagraph")}
              </a>
            )}
            <p className="subtle">
              {new Date(item.createdAt).toLocaleString()}
            </p>
            <div className="book-card-actions">
              {item.canEdit && (
                <Button
                  type="text"
                  size="small"
                  onClick={() => setFeedback(item)}
                >
                  {bt("edit")}
                </Button>
              )}
              {item.canWithdraw && item.status !== "withdrawn" && (
                <Button
                  type="text"
                  size="small"
                  danger
                  onClick={() =>
                    void command({
                      operation: "feedback.withdraw",
                      id: item.id,
                      expectedRevision: item.revision,
                    }).catch(() => {})
                  }
                >
                  {bt("withdraw")}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
  return (
    <div className="knowledge-books-page">
      <BookHeader
        title={book.detail.resource.title}
        actions={
          <>
            <Button
              disabled={!ai?.userId}
              onClick={() => {
                ai?.addDocument(book.detail.resource);
                ai?.setComposerDraft(
                  `${bt("assistantPrompt")} ${book.detail.resource.title} (${id})`,
                );
                ai?.setOpen(true);
              }}
            >
              <Sparkles size={15} />
              {bt("assistant")}
            </Button>
            <Button
              onClick={() =>
                void load(!dirty).catch((e) => setError(failure(e)))
              }
            >
              {bt("refresh")}
            </Button>
            {book.canManage && (
              <button
                type="button"
                className="primary share-button"
                data-permissions-trigger
                onClick={() => setPermissions(true)}
              >
                <ShieldCheck size={16} />
                {t("shell.share")}
              </button>
            )}
            <Button
              disabled={!book.canEdit || busy || dirty}
              type="primary"
              onClick={() =>
                void command<{ id: string }>({ operation: "run.start" }).then(result => openRun(result.id)).catch(e => setError(failure(e)))
              }
            >
              {bt("run")}
            </Button>
          </>
        }
      />
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError("")}
        />
      )}
      <Tabs
        className="book-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        animated={false}
        destroyOnHidden
        items={[
          {
            key: "result",
            label: bt("result"),
            children: (
              <div className="book-result-tab">
                <Space className="book-toolbar">
                  <Select
                    aria-label={bt("release")}
                    style={{ minWidth: 170 }}
                    value={release?.id}
                    placeholder={bt("release")}
                    options={book.releases.map((r) => ({
                      value: r.id,
                      label: `${bt("release")} ${r.revision}`,
                    }))}
                    onChange={(value) =>
                      void api<Release>(
                        `/knowledge-books/${id}/releases/${value}`,
                      )
                        .then(setRelease)
                        .catch((e) => setError(failure(e)))
                    }
                  />
                  <Tag>{bt("readOnly")}</Tag>
                  <Segmented
                    aria-label={bt("viewMode")}
                    value={viewMode}
                    options={[
                      { value: "reading", label: bt("readingMode") },
                      { value: "review", label: bt("reviewMode") },
                    ]}
                    onChange={(value) =>
                      setViewMode(value as "reading" | "review")
                    }
                  />
                </Space>
                {release?.restricted ? (
                  <Alert type="warning" message={bt("restricted")} />
                ) : release?.artifact ? (
                  <div className="book-result">
                    <aside>
                      <BookDocumentTree
                        pages={release.artifact.pages}
                        selected={page?.id}
                        changed={setPageId}
                      />
                    </aside>
                    <article>
                      {page && (
                        <BookReader
                          key={`${release.id}:${page.id}:${viewMode}`}
                          page={page}
                          pages={release.artifact.pages}
                          navigate={setPageId}
                          reviewParagraph={
                            viewMode === "review"
                              ? (paragraph, preview) => (
                                  <section
                                    className="book-paragraph"
                                    id={`book-paragraph-${paragraph.id}`}
                                    key={paragraph.id}
                                  >
                                    {preview}
                                    <Space>
                                      <Button
                                        size="small"
                                        onClick={() => {
                                          setAnchor({
                                            pageId: page.id,
                                            paragraphId: paragraph.id,
                                          });
                                          setFeedback("new");
                                        }}
                                        disabled={!book.canComment}
                                      >
                                        {bt("addFeedback")}
                                      </Button>
                                      <Tag>
                                        {bt("evidenceCount")}{" "}
                                        {
                                          new Set(
                                            paragraph.claimIds.flatMap(
                                              (claimId) =>
                                                release.artifact!.claims.find(
                                                  (c) => c.id === claimId,
                                                )?.evidenceIds ?? [],
                                            ),
                                          ).size
                                        }
                                      </Tag>
                                    </Space>
                                    <details>
                                      <summary>{bt("decision")}</summary>
                                      <p>{paragraph.reason}</p>
                                      {paragraph.claimIds.map((claimId) => {
                                        const claim =
                                          release.artifact!.claims.find(
                                            (c) => c.id === claimId,
                                          );
                                        return (
                                          claim && (
                                            <div key={claimId}>
                                              <p>{claim.reason}</p>
                                              {claim.evidenceQuotes.map(
                                                (quote, index) => (
                                                  <blockquote key={index}>
                                                    <strong>
                                                      {
                                                        release.artifact!.evidence.find(
                                                          (e) =>
                                                            e.id ===
                                                            quote.evidenceId,
                                                        )?.title
                                                      }
                                                    </strong>
                                                    <p>{quote.quote}</p>
                                                  </blockquote>
                                                ),
                                              )}
                                            </div>
                                          )
                                        );
                                      })}
                                    </details>
                                  </section>
                                )
                              : undefined
                          }
                        />
                      )}
                    </article>
                  </div>
                ) : (
                  <Empty description={bt("noRelease")} />
                )}
              </div>
            ),
          },
          {
            key: "workflow",
            label: bt("workflow"),
            children: (
              <>
                <Form layout="vertical">
                  <Form.Item label={bt("goal")}>
                    <Input.TextArea
                      aria-label={bt("goal")}
                      value={draft.goal}
                      rows={5}
                      disabled={!book.canEdit}
                      onChange={(e) =>
                        change({ ...draft, goal: e.target.value })
                      }
                    />
                  </Form.Item>
                  <Space wrap>
                    <Form.Item label={bt("model")}>
                      <ModelSelect
                        value={draft.modelId}
                        disabled={!book.canEdit}
                        changed={(modelId) => change({ ...draft, modelId })}
                      />
                    </Form.Item>
                    <Form.Item label={bt("depth")}>
                      <InputNumber
                        min={1}
                        max={8}
                        value={draft.maxDocumentDepth}
                        disabled={!book.canEdit}
                        onChange={(value) =>
                          change({ ...draft, maxDocumentDepth: value ?? 4 })
                        }
                      />
                    </Form.Item>
                    <Form.Item label={bt("schedule")}>
                      <Select
                        value={draft.schedule}
                        disabled={!book.canEdit}
                        style={{ width: 160 }}
                        options={["off", "daily", "weekly"].map((value) => ({
                          value,
                          label: bt(`schedule.${value}`),
                        }))}
                        onChange={(schedule) => change({ ...draft, schedule })}
                      />
                    </Form.Item>
                    <Form.Item label={bt("autoPublish")}>
                      <Switch
                        checked={draft.autoPublish}
                        disabled={!book.canEdit}
                        onChange={(autoPublish) =>
                          change({ ...draft, autoPublish })
                        }
                      />
                    </Form.Item>
                  </Space>
                </Form>
                <BookGraph
                  workflow={draft.workflow}
                  editable={book.canEdit}
                  changed={(workflow) => change({ ...draft, workflow })}
                  selected={setNodeId}
                  added={(type, position) => {
                    const newId = `${type}-${crypto.randomUUID().slice(0, 8)}`;
                    change({
                      ...draft,
                      workflow: {
                        ...draft.workflow,
                        nodes: [
                          ...draft.workflow.nodes,
                          {
                            id: newId,
                            type,
                            label: "",
                            position,
                            parameters: {
                              instructions: "",
                              sourceIds: [],
                              criterionIds: [],
                              sourceWeight: 1,
                              feedbackWeight: 1,
                            },
                          },
                        ],
                      },
                    });
                    setNodeId(newId);
                  }}
                />
                <Space className="book-toolbar">
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={!dirty || !book.canEdit}
                    onClick={() =>
                      void command({
                        operation: "configuration.save",
                        expectedRevision: draftRevision.current,
                        configuration: draft,
                      })
                        .then(() => load())
                        .catch(() => {})
                    }
                  >
                    {bt("save")}
                  </Button>
                  {dirty && <Tag color="orange">{bt("unsaved")}</Tag>}
                </Space>
              </>
            ),
          },
          {
            key: "sources",
            label: bt("sources"),
            children: (
              <>
                <Space>
                  <Button
                    type="primary"
                    disabled={!book.canEdit}
                    onClick={() => setSource("new")}
                  >
                    {bt("addSource")}
                  </Button>
                  <span>{bt("sourceHelp")}</span>
                </Space>
                <Input
                  prefix={<Search size={14} />}
                  aria-label={bt("searchSources")}
                  placeholder={bt("searchSources")}
                  allowClear
                  value={sourceQuery}
                  onChange={(e) => setSourceQuery(e.target.value)}
                  className="book-source-search"
                  style={{ width: 360, maxWidth: "100%", marginTop: 16 }}
                />
                <div className="book-cards book-sources-grid">
                  {book.sources
                    .filter(
                      (item) =>
                        item.status !== "removed" &&
                        (!sourceQuery ||
                          [
                            item.title,
                            ...item.bindings.map((binding) => binding.title),
                          ].some((text) =>
                            text
                              .toLocaleLowerCase()
                              .includes(sourceQuery.toLocaleLowerCase()),
                          )),
                    )
                    .map((item) => (
                      <Card
                        key={item.id}
                        title={
                          <span className="book-source-heading">
                            <Layers size={16} />
                            <span
                              title={item.readable ? item.title : undefined}
                            >
                              {item.readable
                                ? item.title
                                : bt("restrictedSource")}
                            </span>
                          </span>
                        }
                        extra={
                          <Tag
                            color={
                              item.status === "active"
                                ? "green"
                                : item.status === "paused"
                                  ? "gold"
                                  : undefined
                            }
                          >
                            {bt(item.status)}
                          </Tag>
                        }
                      >
                        <p>
                          {item.configuration
                            ? t("books.bindingCount", {
                                count: item.configuration.items.length,
                              })
                            : bt("restricted")}
                        </p>
                        <div className="book-source-preview">
                          {item.configuration?.items
                            .slice(0, 3)
                            .map((binding) => (
                              <div key={binding.id}>
                                <Tag>{bt(`source.${binding.kind}`)}</Tag>
                                <span
                                  title={
                                    item.bindings.find(
                                      (item) => item.id === binding.id,
                                    )?.title
                                  }
                                >
                                  {item.bindings.find(
                                    (item) => item.id === binding.id,
                                  )?.title || bt(`source.${binding.kind}`)}
                                </span>
                              </div>
                            ))}
                          {!!item.configuration &&
                            item.configuration.items.length > 3 && (
                              <small>
                                {t("books.moreBindings", {
                                  count: item.configuration.items.length - 3,
                                })}
                              </small>
                            )}
                        </div>
                        <div className="book-source-actions">
                          {item.readable && (
                            <Button
                              type="text"
                              size="small"
                              onClick={() => setSource(item)}
                            >
                              {bt(item.canEdit ? "edit" : "inspect")}
                            </Button>
                          )}
                          {item.canRemove && item.status !== "removed" && (
                            <Button
                              type="text"
                              size="small"
                              icon={<Trash2 size={14} />}
                              danger
                              onClick={() =>
                                void command({
                                  operation: "source.remove",
                                  id: item.id,
                                  expectedRevision: item.revision,
                                }).catch(() => {})
                              }
                            >
                              {bt("remove")}
                            </Button>
                          )}
                        </div>
                      </Card>
                    ))}
                </div>
              </>
            ),
          },
          {
            key: "criteria",
            label: bt("criteria"),
            children: (
              <>
                <p className="book-section-note">{bt("criteriaHelp")}</p>
                <div className="book-cards book-criteria-grid">
                  {draft.criteria.map((criterion, index) => (
                    <Card
                      key={criterion.id}
                      title={`${bt("criterionLabel")} ${index + 1}`}
                    >
                      <Input.TextArea
                        autoSize={{ minRows: 4, maxRows: 12 }}
                        value={criterion.description}
                        disabled={!book.canEdit}
                        onChange={(e) =>
                          change({
                            ...draft,
                            criteria: draft.criteria.map((c) =>
                              c.id === criterion.id
                                ? { ...c, description: e.target.value }
                                : c,
                            ),
                          })
                        }
                      />
                      <div className="book-card-footer">
                        <label className="book-required-control">
                          <Switch
                            size="small"
                            checked={criterion.required}
                            disabled={!book.canEdit}
                            onChange={(required) =>
                              change({
                                ...draft,
                                criteria: draft.criteria.map((c) =>
                                  c.id === criterion.id
                                    ? { ...c, required }
                                    : c,
                                ),
                              })
                            }
                          />
                          {bt("required")}
                        </label>
                        <Button
                          type="text"
                          size="small"
                          disabled={!book.canEdit}
                          danger
                          onClick={() =>
                            change({
                              ...draft,
                              criteria: draft.criteria.filter(
                                (c) => c.id !== criterion.id,
                              ),
                              workflow: {
                                ...draft.workflow,
                                nodes: draft.workflow.nodes.map((node) => ({
                                  ...node,
                                  parameters: {
                                    ...node.parameters,
                                    criterionIds:
                                      node.parameters.criterionIds.filter(
                                        (id) => id !== criterion.id,
                                      ),
                                  },
                                })),
                              },
                            })
                          }
                        >
                          {bt("remove")}
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
                <Space>
                  <Button
                    disabled={!book.canEdit}
                    onClick={() =>
                      change({
                        ...draft,
                        criteria: [
                          ...draft.criteria,
                          {
                            id: `criterion-${crypto.randomUUID().slice(0, 8)}`,
                            description: "",
                            required: true,
                          },
                        ],
                      })
                    }
                  >
                    {bt("addCriterion")}
                  </Button>
                  <Button
                    type="primary"
                    disabled={!book.canEdit || !dirty}
                    loading={busy}
                    onClick={() =>
                      void command({
                        operation: "configuration.save",
                        expectedRevision: draftRevision.current,
                        configuration: draft,
                      })
                        .then(() => load())
                        .catch(() => {})
                    }
                  >
                    {bt("save")}
                  </Button>
                </Space>
              </>
            ),
          },
          {
            key: "assistant-cases",
            label: bt("assistantCases"),
            children: <BookAssistantCases resource={book.detail.resource} />,
          },
          {
            key: "feedback",
            label: bt("feedbackTitle"),
            children: renderFeedback(),
          },
          {
            key: "tasks",
            label: bt("humanTasks"),
            children: (
              <BookHumanTasks bookId={id} taskId={taskLink.get("task") ?? undefined} runId={taskLink.get("run") ?? undefined} changed={async nextRunId => { await load(false); if (nextRunId) await openRun(nextRunId); }} />
            ),
          },
          {
            key: "runs",
            label: bt("runs"),
            children: <div className="book-run-view">
              <BookRunList runs={book.runs} selected={run?.id} choose={value => void openRun(value).catch(e => setError(failure(e)))} />
              <div className="book-run-main">
              {run ? <BookRunPipeline key={run.id} run={run} canEdit={book.canEdit}
                cancel={() => void command({ operation: "run.cancel", runId: run.id }).then(() => openRun(run.id)).catch(() => {})}
                repair={() => { ai?.addDocument(book.detail.resource); ai?.setComposerDraft(bt("pipelineRepairPrompt", { bookId: id, runId: run.id })); ai?.setOpen(true); }}
                humanTasks={nodeId => <BookHumanTasks bookId={id} runId={run.id} nodeId={nodeId} changed={async nextRunId => { await load(false); await openRun(nextRunId ?? run.id); }} />}
              /> : <Empty description={bt("pipelineNoRuns")} />}
              </div>
            </div>,
          },
          {
            key: "provenance",
            label: bt("provenance"),
            children: release?.artifact ? (
              <ProvenanceView artifact={release.artifact} />
            ) : (
              <Empty description={bt("noRelease")} />
            ),
          },
        ]}
      />
      {permissions && (
        <PermissionDialog
          detail={book.detail}
          close={() => setPermissions(false)}
          saved={() => load(false)}
        />
      )}
      {source && (
        <BookSourceDialog
          bookId={id}
          value={source === "new" ? undefined : source}
          close={() => setSource(null)}
          saved={async (value) => {
            await command(value);
            setSource(null);
          }}
        />
      )}
      {feedback && (
        <BookFeedbackDialog
          value={feedback === "new" ? undefined : feedback}
          anchor={anchor}
          releaseId={release?.id ?? null}
          close={() => setFeedback(null)}
          saved={async (value) => {
            await command(value);
            setFeedback(null);
          }}
        />
      )}
      <Drawer
        open={!!editNode}
        title={editNode?.label || (editNode && bt(`node.${editNode.type}`))}
        onClose={() => setNodeId(undefined)}
        width={480}
      >
        {editNode && (
          <Form layout="vertical">
            <Form.Item label={bt("name")}>
              <Input
                value={editNode.label}
                disabled={!book.canEdit}
                onChange={(e) =>
                  updateNode({ ...editNode, label: e.target.value })
                }
              />
            </Form.Item>
            <Form.Item label={bt("instructions")}>
              <Input.TextArea
                rows={8}
                disabled={!book.canEdit}
                value={editNode.parameters.instructions}
                onChange={(e) =>
                  updateNode({
                    ...editNode,
                    parameters: {
                      ...editNode.parameters,
                      instructions: e.target.value,
                    },
                  })
                }
              />
            </Form.Item>
            {editNode.type === "sources" && (
              <Form.Item label={bt("selectedSources")}>
                <Select
                  mode="multiple"
                  disabled={!book.canEdit}
                  value={editNode.parameters.sourceIds}
                  options={book.sources
                    .filter((s) => s.status === "active")
                    .map((s) => ({
                      value: s.id,
                      label: s.title || bt("restrictedSource"),
                    }))}
                  onChange={(sourceIds) =>
                    updateNode({
                      ...editNode,
                      parameters: { ...editNode.parameters, sourceIds },
                    })
                  }
                />
              </Form.Item>
            )}
            {editNode.type === "acceptance" && (
              <Form.Item label={bt("selectedCriteria")}>
                <Select
                  mode="multiple"
                  disabled={!book.canEdit}
                  value={editNode.parameters.criterionIds}
                  options={draft.criteria.map((c) => ({
                    value: c.id,
                    label: c.description,
                  }))}
                  onChange={(criterionIds) =>
                    updateNode({
                      ...editNode,
                      parameters: { ...editNode.parameters, criterionIds },
                    })
                  }
                />
              </Form.Item>
            )}
            <Form.Item
              hidden={["feedback", "human_review", "publish"].includes(
                editNode.type,
              )}
              label={bt("sourceWeight")}
            >
              <InputNumber
                min={0}
                max={100}
                disabled={!book.canEdit}
                value={editNode.parameters.sourceWeight}
                onChange={(value) =>
                  updateNode({
                    ...editNode,
                    parameters: {
                      ...editNode.parameters,
                      sourceWeight: value ?? 1,
                    },
                  })
                }
              />
            </Form.Item>
            <Form.Item
              hidden={["sources", "human_review", "publish"].includes(
                editNode.type,
              )}
              label={bt("feedbackWeight")}
            >
              <InputNumber
                min={0}
                max={100}
                disabled={!book.canEdit}
                value={editNode.parameters.feedbackWeight}
                onChange={(value) =>
                  updateNode({
                    ...editNode,
                    parameters: {
                      ...editNode.parameters,
                      feedbackWeight: value ?? 1,
                    },
                  })
                }
              />
            </Form.Item>
            <Form.Item label={bt("inputs")}>
              <Select
                mode="multiple"
                disabled={!book.canEdit}
                value={draft.workflow.edges
                  .filter((e) => e.target === editNode.id)
                  .map((e) => e.source)}
                options={draft.workflow.nodes
                  .filter((n) => n.id !== editNode.id)
                  .map((n) => ({
                    value: n.id,
                    label: n.label || bt(`node.${n.type}`),
                  }))}
                onChange={(inputs) =>
                  change({
                    ...draft,
                    workflow: {
                      ...draft.workflow,
                      edges: [
                        ...draft.workflow.edges.filter(
                          (e) => e.target !== editNode.id,
                        ),
                        ...inputs.map((source) => ({
                          source,
                          target: editNode.id,
                        })),
                      ],
                    },
                  })
                }
              />
            </Form.Item>
            <Button
              danger
              disabled={!book.canEdit || editNode.type === "publish"}
              onClick={() => {
                change({
                  ...draft,
                  workflow: {
                    ...draft.workflow,
                    nodes: draft.workflow.nodes.filter(
                      (n) => n.id !== editNode.id,
                    ),
                    edges: draft.workflow.edges.filter(
                      (e) =>
                        e.source !== editNode.id && e.target !== editNode.id,
                    ),
                  },
                });
                setNodeId(undefined);
              }}
            >
              {bt("remove")}
            </Button>
          </Form>
        )}
      </Drawer>

    </div>
  );
}
function BookAssistantCases({ resource }: { resource: Detail["resource"] }) {
  const bt = useBookText(),
    ai = useAI();
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      title: string;
      updated_at: string;
      restricted?: boolean;
    }>
  >([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!ai?.userId) return;
    const items = await api<typeof sessions>(
      `/ai/sessions?resourceId=${resource.id}`,
    );
    setSessions(items.filter((item) => !item.restricted));
  }, [resource.id, ai?.userId]);
  useEffect(() => {
    void load().catch((error) => setError(failure(error)));
  }, [load]);
  return (
    <>
      <p className="book-section-note">{bt("assistantCasesHelp")}</p>
      <div className="book-cards">
        {["sources", "criteria", "feedback"].map((kind) => (
          <Card
            key={kind}
            className="book-assistant-case"
            title={bt(`case.${kind}.title`)}
          >
            <p>{bt(`case.${kind}.description`)}</p>
            <blockquote>{bt(`case.${kind}.prompt`)}</blockquote>
            <Button
              icon={<Sparkles size={15} />}
              disabled={!ai?.userId}
              onClick={() => {
                ai?.addDocument(resource);
                ai?.setComposerDraft(
                  `${bt(`case.${kind}.prompt`)}\n${bt("title")}：${resource.title} (${resource.id})`,
                );
                ai?.setOpen(true);
              }}
            >
              {bt("tryCase")}
            </Button>
          </Card>
        ))}
      </div>
      <div className="book-card-footer">
        <h3>{bt("myAssistantCases")}</h3>
        <Button
          size="small"
          onClick={() => void load().catch((error) => setError(failure(error)))}
        >
          {bt("refresh")}
        </Button>
      </div>
      <p className="book-section-note">{bt("myAssistantCasesHelp")}</p>
      {error && <Alert type="error" message={error} />}
      <div className="book-cards">
        {sessions.map((session) => (
          <Card key={session.id} size="small" title={session.title}>
            <p className="book-source-summary">
              {new Date(session.updated_at).toLocaleString()}
            </p>
            <Button
              size="small"
              onClick={() => {
                ai?.setSessionId(session.id);
                ai?.setOpen(true);
              }}
            >
              {bt("inspect")}
            </Button>
          </Card>
        ))}
      </div>
    </>
  );
}
function AcceptanceCheckList({
  checks,
  criteria,
}: {
  checks: BookArtifact["checks"];
  criteria: BookConfiguration["criteria"];
}) {
  const { t } = useI18n();
  const grouped = new Map<string, BookArtifact["checks"]>();
  for (const check of checks)
    grouped.set(check.criterionId, [
      ...(grouped.get(check.criterionId) ?? []),
      check,
    ]);
  return (
    <>
      {[...grouped].map(([criterionId, results]) => (
        <Alert
          key={criterionId}
          type={results.every((check) => check.passed) ? "success" : "error"}
          message={
            criteria.find((criterion) => criterion.id === criterionId)
              ?.description || criterionId
          }
          description={
            results.length === 1 ? (
              results[0]!.reason
            ) : (
              <Collapse
                ghost
                items={[
                  {
                    key: criterionId,
                    label: t("books.nodeCheckResults", {
                      count: results.length,
                    }),
                    children: results.map((result, index) => (
                      <p key={index}>{result.reason}</p>
                    )),
                  },
                ]}
              />
            )
          }
        />
      ))}
    </>
  );
}
function BookDocumentTree({
  pages,
  selected,
  changed,
}: {
  pages: BookArtifact["pages"];
  selected?: string;
  changed: (id: string) => void;
}) {
  const data = useMemo(() => pageTree(pages), [pages]);
  const folderKeys = (nodes: DataNode[]): string[] =>
    nodes.flatMap((node) =>
      node.children ? [String(node.key), ...folderKeys(node.children)] : [],
    );
  const [expanded, setExpanded] = useState<string[]>(() => folderKeys(data));
  useEffect(() => {
    const page = pages.find((item) => item.id === selected);
    if (!page) return;
    const directories = page.path.map(
      (_name, index) =>
        `folder:${JSON.stringify(page.path.slice(0, index + 1))}`,
    );
    setExpanded((keys) =>
      directories.every((key) => keys.includes(key))
        ? keys
        : [...new Set([...keys, ...directories])],
    );
  }, [pages, selected]);
  function firstDocument(
    node: DataNode,
    ancestors: string[] = [],
  ): { documentId: string; directories: string[] } | undefined {
    if (node.isLeaf)
      return { documentId: String(node.key), directories: ancestors };
    for (const child of node.children ?? []) {
      const found = firstDocument(child, [...ancestors, String(node.key)]);
      if (found) return found;
    }
  }
  return (
    <Tree
      blockNode
      treeData={data}
      selectedKeys={selected ? [selected] : []}
      expandedKeys={expanded}
      onExpand={(keys) => setExpanded(keys.map(String))}
      onSelect={(_keys, info) => {
        const found = firstDocument(info.node);
        if (!found) return;
        setExpanded((keys) => [...new Set([...keys, ...found.directories])]);
        changed(found.documentId);
      }}
    />
  );
}
function pageTree(pages: BookArtifact["pages"]): DataNode[] {
  const visit = (node: BookPageNode): DataNode => ({
    key: node.key,
    title: (
      <span className="book-tree-title" title={node.title}>
        {node.title}
      </span>
    ),
    isLeaf: !!node.page,
    children: node.children?.map(visit),
  });
  return bookPageTree(pages).map(visit);
}
function PublishedBookView({ book }: { book: Book }) {
  const bt = useBookText(),
    [pageId, setPageId] = useState<string>();
  const release = book.publishedRelease,
    artifact = release?.artifact,
    page =
      artifact?.pages.find((page) => page.id === pageId) ?? artifact?.pages[0];
  return (
    <section className="knowledge-books-page">
      <BookHeader
        title={book.detail.resource.title}
        actions={
          release && (
            <Tag>
              {bt("release")} {release.revision}
            </Tag>
          )
        }
      />
      {release?.restricted ? (
        <Alert type="warning" message={bt("restricted")} />
      ) : artifact ? (
        <Tabs
          className="book-tabs"
          animated={false}
          destroyOnHidden
          items={[
            {
              key: "result",
              label: bt("result"),
              children: (
                <div className="book-result">
                  <aside>
                    <BookDocumentTree
                      pages={artifact.pages}
                      selected={page?.id}
                      changed={setPageId}
                    />
                  </aside>
                  <article>
                    {page && (
                      <BookReader
                        key={page.id}
                        page={page}
                        pages={artifact.pages}
                        navigate={setPageId}
                      />
                    )}
                  </article>
                </div>
              ),
            },
            {
              key: "provenance",
              label: bt("provenance"),
              children: <ProvenanceView artifact={artifact} />,
            },
          ]}
        />
      ) : (
        <Empty description={bt("noRelease")} />
      )}
    </section>
  );
}
function ModelSelect({
  value,
  disabled,
  changed,
}: {
  value: string;
  disabled: boolean;
  changed: (value: string) => void;
}) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api<{ models: Array<{ id: string; name: string }> }>("/ai/options")
      .then((data) => setModels(data.models))
      .catch(() => {});
  }, []);
  return (
    <Select
      showSearch
      optionFilterProp="label"
      disabled={disabled}
      value={value || undefined}
      style={{ width: 260 }}
      options={models.map((model) => ({
        value: model.id,
        label: model.name || model.id,
      }))}
      onChange={changed}
    />
  );
}
export function BookSourceDialog({
  bookId,
  value,
  close,
  saved,
}: {
  bookId: string;
  value?: Source;
  close: () => void;
  saved: (value: unknown) => Promise<void>;
}) {
  const bt = useBookText();
  const [title, setTitle] = useState(value?.title ?? ""),
    [items, setItems] = useState<BookSourceBinding[]>(
      value?.configuration?.items ?? [],
    ),
    [labels, setLabels] = useState<Record<string, string>>(
      Object.fromEntries(
        (value?.bindings ?? []).map((binding) => [binding.id, binding.title]),
      ),
    ),
    [status, setStatus] = useState(value?.status ?? "active"),
    [editing, setEditing] = useState<string>(),
    [pickerRevision, setPickerRevision] = useState(0),
    [hasUnapplied, setHasUnapplied] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const readOnly = !!value && !value.canEdit;
  function accept(
    bindings: BookSourceBinding[],
    names: Record<string, string>,
  ) {
    const remaining = items.filter((binding) => binding.id !== editing);
    const scopes = new Set(remaining.map(bookSourceBindingKey));
    if (
      bindings.some((binding) => {
        const key = bookSourceBindingKey(binding);
        if (scopes.has(key)) return true;
        scopes.add(key);
        return false;
      })
    ) {
      setError(bt("duplicateBinding"));
      return;
    }
    if (remaining.length + bindings.length > 50) {
      setError(bt("bindingLimit"));
      return;
    }
    const index = editing
      ? items.findIndex((item) => item.id === editing)
      : remaining.length;
    const next = [...remaining];
    next.splice(index, 0, ...bindings);
    setItems(next);
    setLabels((old) => ({ ...old, ...names }));
    setEditing(undefined);
    setPickerRevision((revision) => revision + 1);
    setError("");
  }
  return (
    <Modal
      open
      title={bt(value ? "manageSource" : "addSource")}
      className="book-source-dialog"
      onCancel={close}
      width={760}
      confirmLoading={busy}
      okText={bt("save")}
      cancelText={bt("cancel")}
      okButtonProps={{
        disabled: !items.length || !title.trim() || hasUnapplied,
        style: readOnly ? { display: "none" } : undefined,
      }}
      onOk={async () => {
        const parsed = bookSourceInputSchema.safeParse({ version: 1, items });
        if (!parsed.success) {
          setError(bt("invalidBindings"));
          return;
        }
        setBusy(true);
        setError("");
        try {
          const configuration = parsed.data;
          await saved({
            operation: "source.save",
            id: value?.id,
            expectedRevision: value?.revision ?? 0,
            title,
            configuration,
            status,
          });
        } catch (error) {
          setError(failure(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <Alert type="error" message={error} />}
      <Form layout="vertical" component="div">
        <Form.Item label={bt("name")} required>
          <Input
            aria-label={bt("name")}
            value={title}
            maxLength={200}
            disabled={readOnly || busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Form.Item>
        <p className="book-section-note">{bt("bindingHelp")}</p>
        <div className="book-source-members" aria-label={bt("boundSources")}>
          {items.map((binding) => (
            <div
              className="book-source-member"
              key={binding.id}
              data-binding-id={binding.id}
            >
              <div className="book-source-member-label">
                <Tag>{bt(`source.${binding.kind}`)}</Tag>
                {binding.kind === "url" ? (
                  <a
                    href={binding.url}
                    target="_blank"
                    rel="noreferrer"
                    title={binding.url}
                  >
                    {binding.url}
                  </a>
                ) : binding.kind === "document" ||
                  binding.kind === "library" ? (
                  <a
                    href={`#/r/${binding.resourceId}`}
                    title={labels[binding.id]}
                  >
                    {labels[binding.id] || binding.resourceId}
                  </a>
                ) : (
                  <span title={labels[binding.id]}>
                    {labels[binding.id] ||
                      (binding.kind === "content"
                        ? binding.sourceId
                        : binding.kind === "manual"
                          ? binding.markdown.replace(/\s+/g, " ").slice(0, 65)
                          : binding.resourceId)}
                  </span>
                )}
              </div>
              {!readOnly && (
                <Space>
                  <Button
                    type="text"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      setEditing(binding.id);
                      setPickerRevision((revision) => revision + 1);
                    }}
                  >
                    {bt("edit")}
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<Trash2 size={14} />}
                    aria-label={bt("removeBinding")}
                    disabled={busy}
                    onClick={() => {
                      setItems((old) =>
                        old.filter((item) => item.id !== binding.id),
                      );
                      if (editing === binding.id) {
                        setEditing(undefined);
                        setPickerRevision((revision) => revision + 1);
                      }
                    }}
                  >
                    {bt("remove")}
                  </Button>
                </Space>
              )}
            </div>
          ))}
          {!items.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={bt("noBindings")}
            />
          )}
        </div>
        {!readOnly && (
          <BookSourceBindingPicker
            key={pickerRevision}
            bookId={bookId}
            value={items.find((item) => item.id === editing)}
            disabled={busy}
            selected={accept}
            draftChanged={setHasUnapplied}
            cancelEdit={() => {
              setEditing(undefined);
              setPickerRevision((revision) => revision + 1);
            }}
          />
        )}
        {hasUnapplied && (
          <p className="book-section-note">{bt("unappliedBindings")}</p>
        )}
        <Form.Item label={bt("sourceStatus")}>
          <Select
            value={status}
            disabled={readOnly || busy}
            options={["active", "paused", "removed"].map((value) => ({
              value,
              label: bt(value),
            }))}
            onChange={setStatus}
          />
        </Form.Item>
        <p className="book-section-note">{bt("sourceHelp")}</p>
      </Form>
    </Modal>
  );
}
function BookSourceBindingPicker({
  bookId,
  value,
  disabled,
  selected,
  cancelEdit,
  draftChanged,
}: {
  bookId: string;
  value?: BookSourceBinding;
  disabled: boolean;
  selected: (
    bindings: BookSourceBinding[],
    names: Record<string, string>,
  ) => void;
  cancelEdit: () => void;
  draftChanged: (dirty: boolean) => void;
}) {
  const bt = useBookText(),
    { locale } = useI18n();
  const [kind, setKind] = useState<BookSourceBinding["kind"]>(
      value?.kind ?? "document",
    ),
    [targets, setTargets] = useState<string[]>(
      value && "resourceId" in value ? [value.resourceId] : [],
    ),
    [names, setNames] = useState<Record<string, string>>({}),
    [text, setText] = useState(
      value?.kind === "url"
        ? value.url
        : value?.kind === "manual"
          ? value.markdown
          : "",
    ),
    [provider, setProvider] = useState(
      value?.kind === "content" ? value.sourceId : "",
    ),
    [config, setConfig] = useState<Record<string, any>>(
      value?.kind === "content" ? value.config : {},
    ),
    [choices, setChoices] = useState<Array<{ value: string; label: string }>>(
      [],
    ),
    [providers, setProviders] = useState<ContentSourceDescriptor[]>([]),
    [loading, setLoading] = useState(false),
    [webVerified, setWebVerified] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const current = { kind, targets, text, provider, config };
    const original = value
      ? {
          kind: value.kind,
          targets: "resourceId" in value ? [value.resourceId] : [],
          text:
            value.kind === "url"
              ? value.url
              : value.kind === "manual"
                ? value.markdown
                : "",
          provider: value.kind === "content" ? value.sourceId : "",
          config: value.kind === "content" ? value.config : {},
        }
      : null;
    draftChanged(
      original
        ? JSON.stringify(current) !== JSON.stringify(original)
        : !!targets.length || !!text || !!provider,
    );
  }, [kind, targets, text, provider, config, value, draftChanged]);
  useEffect(() => {
    const controller = new AbortController();
    setChoices([]);
    setError("");
    setLoading(true);
    async function load() {
      if (kind === "document" || kind === "library") {
        const items: typeof choices = [];
        let cursor: string | null = null;
        do {
          const page: {
            items: Array<{
              id: string;
              title: string;
              library_id: string | null;
            }>;
            nextCursor?: string | null;
          } = await api(
            `/resources?scope=all&kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            "GET",
            undefined,
            controller.signal,
          );
          items.push(
            ...page.items
              .filter(
                (item) => item.id !== bookId && item.library_id !== bookId,
              )
              .map((item) => ({ value: item.id, label: item.title })),
          );
          cursor = page.nextCursor ?? null;
        } while (cursor);
        setChoices(items);
      }
      if (kind === "content") {
        const response = await api<{ items: ContentSourceDescriptor[] }>(
          "/content/sources?purpose=knowledge",
          "GET",
          undefined,
          controller.signal,
        );
        setProviders(response.items);
      }
    }
    void load()
      .catch((error) => {
        if (!controller.signal.aborted) setError(failure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, bookId]);
  const descriptor = providers.find((item) => item.id === provider);
  const providerReady =
    descriptor &&
    Object.values(descriptor.configSchema.properties ?? {}).every(
      (field: any) =>
        ["string", "number", "integer", "boolean"].includes(field.type) ||
        (field.type === "array" && field.items?.type === "string"),
    ) &&
    ((descriptor.configSchema.required as string[] | undefined) ?? []).every(
      (key) =>
        config[key] !== undefined &&
        config[key] !== "" &&
        (!Array.isArray(config[key]) || config[key].length),
    );
  function add() {
    try {
      let bindings: BookSourceBinding[];
      const id = (index: number) =>
        index === 0 && value ? value.id : crypto.randomUUID();
      if (kind === "url")
        bindings = text
          .split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url, index) => ({ id: id(index), kind, url }));
      else if (kind === "manual")
        bindings = [{ id: id(0), kind, markdown: text }];
      else if (kind === "content")
        bindings = [{ id: id(0), kind, sourceId: provider, config }];
      else
        bindings = targets.map((resourceId, index) => ({
          id: id(index),
          kind,
          resourceId,
        }));
      const parsed = bookSourceInputSchema.safeParse({
        version: 1,
        items: bindings,
      });
      if (!parsed.success) {
        setError(bt(kind === "url" ? "invalidUrls" : "invalidBindings"));
        return;
      }
      if (
        bindings.some(
          (binding) =>
            binding.kind === "url" &&
            (!/^https?:$/.test(new URL(binding.url).protocol) ||
              new URL(binding.url).username ||
              new URL(binding.url).password),
        )
      ) {
        setError(bt("invalidUrls"));
        return;
      }
      const labels = Object.fromEntries(
        bindings.map((binding) => [
          binding.id,
          "resourceId" in binding
            ? (choices.find((item) => item.value === binding.resourceId)
                ?.label ??
              names[binding.resourceId] ??
              binding.resourceId)
            : binding.kind === "content"
              ? ((locale.startsWith("zh")
                  ? descriptor?.title.zh
                  : descriptor?.title.en) ?? binding.sourceId)
              : "",
        ]),
      );
      setError("");
      selected(bindings, labels);
    } catch (error) {
      setError(failure(error));
    }
  }
  return (
    <section className="book-binding-picker">
      <strong>{bt(value ? "editBinding" : "addBindings")}</strong>
      {error && <Alert type="error" message={error} />}
      <Form.Item label={bt("sourceKind")}>
        <Select
          aria-label={bt("sourceKind")}
          value={kind}
          disabled={disabled || !!value}
          options={[
            "document",
            "library",
            "file",
            "folder",
            "url",
            "manual",
            "content",
          ].map((kind) => ({ value: kind, label: bt(`source.${kind}`) }))}
          onChange={(kind) => {
            setKind(kind);
            setWebVerified(false);
            setTargets([]);
            setText("");
            setProvider("");
            setConfig({});
          }}
        />
      </Form.Item>
      {kind === "document" || kind === "library" ? (
        <Form.Item label={bt("chooseResources")}>
          <Select
            aria-label={bt("chooseResources")}
            mode="multiple"
            showSearch
            optionFilterProp="label"
            maxCount={50}
            loading={loading}
            value={targets}
            disabled={disabled || loading}
            options={choices}
            onChange={setTargets}
          />
        </Form.Item>
      ) : kind === "file" || kind === "folder" ? (
        <Form.Item label={bt("chooseResources")}>
          <FileSourcePicker
            kind={kind}
            value={targets}
            disabled={disabled}
            changed={(id, name) => {
              setNames((old) => ({ ...old, [id]: name }));
              setTargets((old) =>
                old.includes(id)
                  ? old.filter((item) => item !== id)
                  : [...old, id],
              );
            }}
          />
        </Form.Item>
      ) : kind === "content" ? (
        <>
          <Form.Item label={bt("provider")}>
            <Select
              aria-label={bt("provider")}
              loading={loading}
              value={provider || undefined}
              disabled={disabled || loading}
              options={providers.map((item) => ({
                value: item.id,
                label: locale.startsWith("zh") ? item.title.zh : item.title.en,
              }))}
              onChange={(id) => {
                setProvider(id);
                setConfig({});
              }}
            />
          </Form.Item>
          <ProviderConfiguration
            source={descriptor}
            value={config}
            disabled={disabled}
            changed={setConfig}
          />
        </>
      ) : kind === "url" ? (
        <Form.Item label={bt("bulkUrls")} help={bt("bulkUrlsHelp")}>
          <BookWebSources
            bookId={bookId}
            value={text}
            disabled={disabled}
            changed={setText}
            verified={setWebVerified}
          />
        </Form.Item>
      ) : (
        <Form.Item label={bt("sourceText")}>
          <Input.TextArea
            aria-label={bt("sourceText")}
            rows={6}
            maxLength={60000}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
          />
        </Form.Item>
      )}
      <Space>
        <Button
          icon={<Plus size={14} />}
          disabled={
            disabled ||
            loading ||
            (kind === "content" && !providerReady) ||
            (kind === "url" && !webVerified)
          }
          onClick={add}
        >
          {bt(value ? "updateBinding" : "addToSource")}
        </Button>
        <Button onClick={cancelEdit}>
          {bt(value ? "cancel" : "clearSelection")}
        </Button>
      </Space>
    </section>
  );
}
function BookFeedbackDialog({
  value,
  anchor,
  releaseId,
  close,
  saved,
}: {
  value?: Feedback;
  anchor: { pageId: string | null; paragraphId: string | null };
  releaseId: string | null;
  close: () => void;
  saved: (value: unknown) => Promise<void>;
}) {
  const bt = useBookText();
  const [kind, setKind] = useState<BookFeedbackInput["kind"]>(
      value?.detail.kind ?? "comment",
    ),
    [content, setContent] = useState(value?.detail.content ?? ""),
    [status, setStatus] = useState(value?.status ?? "active"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      open
      title={bt("addFeedback")}
      onCancel={close}
      okText={bt("save")}
      cancelText={bt("cancel")}
      confirmLoading={busy}
      onOk={async () => {
        setBusy(true);
        try {
          await saved({
            operation: "feedback.save",
            id: value?.id,
            expectedRevision: value?.revision ?? 0,
            status,
            detail: {
              kind,
              content,
              releaseId:
                value?.detail.releaseId ?? (anchor.pageId ? releaseId : null),
              pageId: value?.detail.pageId ?? anchor.pageId,
              paragraphId: value?.detail.paragraphId ?? anchor.paragraphId,
            },
          });
        } catch (e) {
          setError(failure(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Form layout="vertical">
        {error && <Alert type="error" message={error} />}
        <Form.Item label={bt("feedbackKind")}>
          <Select
            value={kind}
            options={["comment", "correction", "supplement", "question"].map(
              (value) => ({ value, label: bt(`feedback.${value}`) }),
            )}
            onChange={setKind}
          />
        </Form.Item>
        <Form.Item label={bt("feedbackContent")}>
          <Input.TextArea
            rows={7}
            aria-label={bt("feedbackContent")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </Form.Item>
        {value && (
          <Form.Item label={bt("sourceStatus")}>
            <Select
              value={status}
              options={["active", "withdrawn"].map((value) => ({
                value,
                label: bt(value),
              }))}
              onChange={setStatus}
            />
          </Form.Item>
        )}
        <p>{bt("feedbackHelp")}</p>
      </Form>
    </Modal>
  );
}
export function BookHumanTasks({
  bookId,
  taskId,
  runId,
  nodeId,
  changed,
}: {
  bookId?: string;
  taskId?: string;
  runId?: string;
  nodeId?: string;
  changed?: (nextRunId?: string) => Promise<unknown>;
}) {
  const bt = useBookText(),
    be = useBookError(),
    ai = useAI();
  const openedLink = useRef<string | undefined>(undefined);
  const [taskQuery, setTaskQuery] = useState(""),
    [status, setStatus] = useState("pending"),
    [kind, setKind] = useState("all"),
    [offset, setOffset] = useState(0),
    [items, setItems] = useState<HumanTask[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [task, setTask] = useState<HumanTask | null>(null),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const value = await api<{ items: HumanTask[]; nextOffset: number | null }>(
      `/knowledge-books/human-tasks?status=${status}&offset=${offset}&query=${encodeURIComponent(taskQuery)}${bookId ? `&bookId=${bookId}` : ""}${runId && (!taskId || openedLink.current !== taskId) ? `&runId=${encodeURIComponent(runId)}` : ""}${nodeId ? `&nodeId=${encodeURIComponent(nodeId)}` : ""}${kind === "all" ? "" : `&kind=${kind}`}`,
    );
    setItems(value.items);
    setNext(value.nextOffset);
    setTask((current) => current ? value.items.find((item) => item.id === current.id) ?? null : null);
    if (taskId && openedLink.current !== taskId) {
      const selected = value.items.find((item) => item.id === taskId);
      if (selected) { setTask(selected); setNote(""); openedLink.current = taskId; }
    }
  }, [bookId, status, offset, kind, taskQuery, taskId, runId, nodeId]);
  useEffect(() => {
    void load().catch((e) => setError(failure(e)));
    const timer = setInterval(
      () => void load().catch((e) => setError(failure(e))),
      10000,
    );
    return () => clearInterval(timer);
  }, [load]);
  const resolve = async (decision: string) => {
    if (!task) return;
    setBusy(true);
    try {
      const resolved = await api<{ id?: string }>(`/knowledge-books/human-tasks/${task.id}/resolve`, "POST", {
        expectedRevision: task.revision,
        decision,
        note,
      });
      await load();
      await changed?.(resolved.id);
      setTask(null);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="book-human-tasks">
      <Space wrap className="book-toolbar">
        <Input.Search
          placeholder={bt("searchTasks")}
          aria-label={bt("searchTasks")}
          allowClear
          onSearch={(value) => {
            setTaskQuery(value);
            setOffset(0);
          }}
          style={{ width: 280 }}
        />
        <Select
          aria-label={bt("taskStatus")}
          value={status}
          style={{ width: 180 }}
          options={["pending", "resolved", "cancelled", "superseded"].map(
            (value) => ({ value, label: bt(value) }),
          )}
          onChange={(value) => {
            setStatus(value);
            setOffset(0);
          }}
        />
        <Select
          aria-label={bt("taskKind")}
          value={kind}
          style={{ width: 180 }}
          options={["all", "review", "publication", "repair"].map((value) => ({
            value,
            label: bt(`task.${value}`),
          }))}
          onChange={(value) => {
            setKind(value);
            setOffset(0);
          }}
        />
        <Button onClick={() => void load().catch((e) => setError(failure(e)))}>
          {bt("refresh")}
        </Button>
      </Space>
      {error && <Alert type="error" message={error} />}
      <div className="book-cards">
        {items.map((item) => (
          <Card
            key={item.id}
            title={
              <a href={`#/knowledge-books/${item.book_id}`}>
                {item.book_title}
              </a>
            }
            extra={<Tag>{bt(`task.${item.kind}`)}</Tag>}
          >
            <p>{item.title}</p>
            <p>
              {bt("nodeLabel")} {item.nodeLabel || bt(`node.${item.nodeType}`)}
            </p>
            {item.stale && <Tag color="orange">{bt("staleTask")}</Tag>}
            <Button
              onClick={() => {
                setTask(item);
                setNote("");
              }}
            >
              {bt("inspect")}
            </Button>
          </Card>
        ))}
      </div>
      {!items.length && <Empty description={bt("noTasks")} />}
      <Space>
        <Button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          {bt("previous")}
        </Button>
        <Button disabled={next === null} onClick={() => setOffset(next!)}>
          {bt("next")}
        </Button>
      </Space>
      <Drawer
        open={!!task}
        title={task?.title || (task && bt(`task.${task.kind}`))}
        onClose={() => setTask(null)}
        width="75%"
      >
        {task && (
          <>
            {task.stale && <Alert type="warning" message={bt("staleTask")} />}
            {!task.readable && (
              <Alert type="warning" message={bt("restricted")} />
            )}
            {task.error && <Alert type="error" message={be(task.error)} />}
            <Button
              icon={<Sparkles size={15} />}
              disabled={!ai?.userId}
              onClick={() => {
                void api<Detail>(`/resources/${task.book_id}`).then((detail) => {
                  ai?.addDocument(detail.resource);
                  ai?.setComposerDraft(bt("repairPrompt", { bookId: task.book_id, taskId: task.id, runId: task.run_id }));
                  ai?.setOpen(true);
                  setTask(null);
                }).catch((e) => setError(failure(e)));
              }}
            >{bt("tryCase")}</Button>
            {task.instructions && (
              <Alert
                type="info"
                message={bt("instructions")}
                description={task.instructions}
              />
            )}
            {task.output?.checks && (
              <AcceptanceCheckList
                checks={task.output.checks}
                criteria={task.criteria}
              />
            )}
            {task.output?.pages?.map((page) => (
              <section key={page.id}>
                <h2>{[...page.path, page.title].join(" / ")}</h2>
                <Preview
                  value={page.paragraphs.map((p) => p.markdown).join("\n\n")}
                />
              </section>
            ))}
            {!task.output?.pages?.length &&
              task.output?.claims?.map((claim) => (
                <Card key={claim.id}>
                  <p>{claim.statement}</p>
                  <p>{claim.reason}</p>
                </Card>
              ))}
            {task.status === "pending" ? (
              <>
                <Form layout="vertical">
                  <Form.Item label={bt("reviewNote")}>
                    <Input.TextArea
                      rows={4}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </Form.Item>
                </Form>
                <Space>
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={
                      task.stale || !task.readable || task.kind === "repair"
                    }
                    onClick={() => void resolve("approve")}
                  >
                    {bt("approve")}
                  </Button>
                  <Button
                    danger
                    disabled={busy}
                    onClick={() => void resolve("reject")}
                  >
                    {bt("reject")}
                  </Button>
                  <Button disabled={busy} onClick={() => void resolve("retry")}>
                    {bt("retry")}
                  </Button>
                </Space>
              </>
            ) : (
              task.resolution && (
                <>
                  <Tag>{bt(task.resolution.decision)}</Tag>
                  <p>{task.resolution.note}</p>
                </>
              )
            )}
          </>
        )}
      </Drawer>
    </section>
  );
}
function ProvenanceView({ artifact }: { artifact: BookArtifact }) {
  const bt = useBookText();
  const [pageId, setPageId] = useState(
      artifact.pages[0] ? `page:${artifact.pages[0].id}` : "all",
    ),
    [includeExecution, setIncludeExecution] = useState(false),
    [selected, setSelected] = useState<string>();
  const graph = useMemo(() => {
    const nodeKinds = new Map(
      artifact.provenance.nodes.map((node) => [node.id, node.kind]),
    );
    const nodes = artifact.provenance.nodes.filter(
      (node) => includeExecution || node.kind !== "execution",
    );
    const edges = artifact.provenance.edges.filter(
      (edge) =>
        includeExecution ||
        (nodeKinds.get(edge.source) !== "execution" &&
          nodeKinds.get(edge.target) !== "execution"),
    );
    if (pageId === "all") return { nodes, edges };
    const keep = new Set([pageId]);
    if (!nodes.some((node) => node.id === pageId))
      return { nodes: [], edges: [] };
    for (let i = 0; i < nodes.length; i++) {
      let changed = false;
      for (const edge of edges)
        if (keep.has(edge.target) && !keep.has(edge.source)) {
          keep.add(edge.source);
          changed = true;
        }
      if (!changed) break;
    }
    return {
      nodes: nodes.filter((node) => keep.has(node.id)),
      edges: edges.filter(
        (edge) => keep.has(edge.source) && keep.has(edge.target),
      ),
    };
  }, [artifact, pageId, includeExecution]);
  const node = artifact.provenance.nodes.find((n) => n.id === selected);
  return (
    <>
      <Select
        showSearch
        optionFilterProp="label"
        value={pageId}
        style={{ minWidth: 260 }}
        options={[
          { value: "all", label: bt("wholeGraph") },
          ...artifact.pages.map((p) => ({
            value: `page:${p.id}`,
            label: [...p.path, p.title].join(" / "),
          })),
          ...artifact.pages.flatMap((page) =>
            page.paragraphs.map((paragraph, index) => ({
              value: `paragraph:${paragraph.id}`,
              label: `${page.title} / ${bt("provenance.paragraph")} ${index + 1}: ${paragraph.markdown.replace(/[#*`]/g, "").slice(0, 45)}`,
            })),
          ),
        ]}
        onChange={(value) => {
          setPageId(value);
          setSelected(undefined);
        }}
      />
      <Space style={{ marginLeft: 16 }}>
        <Switch checked={includeExecution} onChange={setIncludeExecution} />
        <span>{bt("includeExecution")}</span>
      </Space>
      <BookGraph provenance={graph} selected={setSelected} />
      <Drawer
        title={
          node?.kind === "paragraph"
            ? bt("provenance.paragraph")
            : node?.label.slice(0, 100)
        }
        open={!!node}
        onClose={() => setSelected(undefined)}
        width={520}
      >
        {node && (
          <>
            <Tag>{bt(`provenance.${node.kind}`)}</Tag>
            {node.kind === "paragraph" && <Preview value={node.label} />}
            {Object.entries(node.detail).map(([key, value]) => (
              <section key={key}>
                <strong>{key}</strong>
                {["markdown", "text", "quote"].includes(key) &&
                typeof value === "string" ? (
                  <Preview value={value} />
                ) : (
                  <p className="book-prewrap">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </p>
                )}
              </section>
            ))}
          </>
        )}
      </Drawer>
    </>
  );
}
function ProviderConfiguration({
  source,
  value,
  disabled,
  changed,
}: {
  source?: ContentSourceDescriptor;
  value: Record<string, any>;
  disabled: boolean;
  changed: (value: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  if (!source) return null;
  const fields = Object.entries(source.configSchema.properties ?? {}) as Array<
    [
      string,
      {
        type?: string;
        title?: string;
        description?: string;
        enum?: string[];
        items?: { type?: string };
        minimum?: number;
        maximum?: number;
      },
    ]
  >;
  const supported = fields.every(
    ([, f]) =>
      ["string", "number", "integer", "boolean"].includes(f.type ?? "") ||
      (f.type === "array" && f.items?.type === "string"),
  );
  if (!supported)
    return <Alert type="warning" message={t("content.configUnsupported")} />;
  const set = (key: string, next: unknown) =>
    changed({ ...value, [key]: next });
  return (
    <>
      {fields.map(([key, field]) => (
        <Form.Item
          key={key}
          label={field.title || key}
          help={field.description}
          required={
            Array.isArray(source.configSchema.required) &&
            source.configSchema.required.includes(key)
          }
        >
          {field.enum ? (
            <Select
              aria-label={field.title || key}
              disabled={disabled}
              value={value[key]}
              options={field.enum.map((v) => ({ value: v, label: v }))}
              onChange={(v) => set(key, v)}
            />
          ) : field.type === "boolean" ? (
            <Select
              aria-label={field.title || key}
              disabled={disabled}
              value={value[key] === undefined ? undefined : String(value[key])}
              options={[
                { value: "true", label: t("content.enabled") },
                { value: "false", label: t("content.disabled") },
              ]}
              onChange={(v) => set(key, v === "true")}
            />
          ) : field.type === "array" ? (
            <Select
              aria-label={field.title || key}
              mode="tags"
              disabled={disabled}
              value={value[key] ?? []}
              onChange={(v) => set(key, v)}
              tokenSeparators={[",", "\n"]}
            />
          ) : field.type === "string" ? (
            <Input
              aria-label={field.title || key}
              disabled={disabled}
              value={value[key] ?? ""}
              onChange={(e) => set(key, e.target.value)}
            />
          ) : (
            <InputNumber
              aria-label={field.title || key}
              disabled={disabled}
              min={field.minimum}
              max={field.maximum}
              precision={field.type === "integer" ? 0 : undefined}
              value={value[key]}
              onChange={(v) => set(key, v)}
            />
          )}
        </Form.Item>
      ))}
    </>
  );
}
function FileSourcePicker({
  kind,
  value,
  disabled,
  changed,
}: {
  kind: "file" | "folder";
  value: string[];
  disabled: boolean;
  changed: (id: string, name: string) => void;
}) {
  const bt = useBookText(),
    [trail, setTrail] = useState<
      Array<{ type: "system" | "folder"; id: string; name: string }>
    >([{ type: "system", id: "root", name: bt("source.folder") }]);
  const current = trail[trail.length - 1]!,
    [items, setItems] = useState<{
      folders: Array<{
        id: string;
        name: string;
        type: "system" | "folder";
        virtual: boolean;
      }>;
      files: Array<{ id: string; name: string }>;
    }>({ folders: [], files: [] }),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof items>(
      `/files?parentType=${current.type}&parentId=${encodeURIComponent(current.id)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setItems)
      .catch((e) => {
        if (!controller.signal.aborted) setError(failure(e));
      });
    return () => controller.abort();
  }, [current.type, current.id]);
  return (
    <>
      <Space>
        {trail.map((node, index) => (
          <Button
            key={node.id}
            size="small"
            onClick={() => setTrail(trail.slice(0, index + 1))}
          >
            {node.name}
          </Button>
        ))}
      </Space>
      {error && <Alert type="error" message={error} />}
      <div className="book-cards">
        {items.folders
          .filter((f) => f.type === "folder" || f.id === "shared")
          .map((folder) => (
            <Card key={folder.id} size="small" title={folder.name}>
              <Space>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    setTrail([
                      ...trail,
                      { type: folder.type, id: folder.id, name: folder.name },
                    ])
                  }
                >
                  {bt("inspect")}
                </Button>
                {kind === "folder" && !folder.virtual && (
                  <Button
                    type={value.includes(folder.id) ? "primary" : "default"}
                    disabled={disabled}
                    onClick={() => changed(folder.id, folder.name)}
                  >
                    {bt("chooseResource")}
                  </Button>
                )}
              </Space>
            </Card>
          ))}
        {kind === "file" &&
          items.files.map((file) => (
            <Card key={file.id} size="small" title={file.name}>
              <Button
                type={value.includes(file.id) ? "primary" : "default"}
                disabled={disabled}
                onClick={() => changed(file.id, file.name)}
              >
                {bt("chooseResource")}
              </Button>
            </Card>
          ))}
      </div>
    </>
  );
}
