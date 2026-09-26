import { useEffect, useRef, useState } from "react";
import {
  BookOpenCheck,
  Bot,
  Send,
  Plus,
  Pause,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ArrowUpRight,
  CheckCircle2,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import Preview from "@web/features/documents/markdown-preview.js";
import "./knowledge-chat.css";

type Conversation = {
  id: string;
  title: string;
  state: string;
  updated_at: string;
};
type Message = {
  id: string;
  role: string;
  content: string;
  authorName?: string;
  trigger: string;
  created_at: string;
  detail: {
    name?: string;
    status?: string;
    args?: unknown;
    result?: unknown;
    citations?: {
      id: string;
      documentId: string;
      title: string;
      heading: string;
      text: string;
      publication: number;
    }[];
  };
};
export function KnowledgeChat({
  scopeId,
  kind,
}: {
  scopeId: string;
  kind: "curation" | "answer";
}) {
  const { t, locale } = useI18n(),
    curating = kind === "curation";
  const [threads, setThreads] = useState<Conversation[]>([]),
    [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<Message[]>([]),
    [state, setState] = useState("idle"),
    [text, setText] = useState("");
  const [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [feedback, setFeedback] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<any[]>([]),
    [actions, setActions] = useState<any[]>([]),
    [cases, setCases] = useState<any[]>([]),
    [sources, setSources] = useState<any[]>([]),
    [excluded, setExcluded] = useState<string[]>([]);
  const [panel, setPanel] = useState<"documents" | "sources" | "feedback">(
    "documents",
  );
  const tail = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    viewport = useRef<HTMLDivElement>(null);
  const Icon = curating ? BookOpenCheck : Bot;
  const active = state === "queued" || state === "running";
  async function reloadThreads() {
    const value = await api<{ items: Conversation[] }>(
      `/knowledge/conversations?scopeId=${scopeId}&kind=${kind}`,
    );
    setThreads(value.items);
    return value.items;
  }
  async function reloadAssets() {
    if (!curating) return;
    const root = `/knowledge/libraries/${scopeId}`;
    const [system, sourceActions, feedbackCases, subscriptions] =
      await Promise.all([
        api<any>(`${root}/system`),
        api<any>(`${root}/source-actions`),
        api<any>(`${root}/cases`),
        api<any>(`${root}/subscriptions`),
      ]);
    setEntries(system.entries);
    setActions(sourceActions.items);
    setCases(feedbackCases.items);
    setSources([
      ...(subscriptions.groups ?? []).map((group: any) => ({
        ...group,
        title: group.title,
        sourceKind: group.source_kind,
        members: subscriptions.items.filter(
          (item: any) =>
            item.groupId === group.id && item.status !== "detached",
        ),
      })),
      ...subscriptions.items.filter((item: any) => !item.groupId),
    ]);
    setExcluded(system.settings.excludedSourceIds);
  }
  useEffect(() => {
    let live = true;
    setSelected("");
    setMessages([]);
    void reloadThreads()
      .then((items) => {
        if (live && items[0]) setSelected(items[0].id);
      })
      .catch((e) => setError(e.message));
    void reloadAssets().catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [scopeId, kind]);
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    let live = true;
    const load = () =>
      api<{ conversation: Conversation; messages: Message[] }>(
        `/knowledge/conversations/${selected}`,
      )
        .then((value) => {
          if (!live) return;
          setMessages(value.messages);
          setState(value.conversation.state);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected]);
  useEffect(() => {
    if (nearBottom.current) tail.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  useEffect(() => {
    if (!active) {
      void reloadAssets().catch((e) => setError(e.message));
      void reloadThreads().catch(() => {});
    }
  }, [state]);
  async function send(content = text) {
    if (!content.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      let id = selected;
      if (!id) {
        const thread = await api<Conversation>(
          "/knowledge/conversations",
          "POST",
          { scopeId, kind, title: content.slice(0, 80) },
        );
        id = thread.id;
        setSelected(id);
      }
      await api(`/knowledge/conversations/${id}/messages`, "POST", {
        content,
        requestId: crypto.randomUUID(),
      });
      setText("");
      setState("queued");
      nearBottom.current = true;
      await reloadThreads();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function work(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      await reloadAssets();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function vote(id: string, judgment: string) {
    await work(async () => {
      await api(`/knowledge/messages/${id}/feedback`, "POST", { judgment });
      setFeedback((x) => ({ ...x, [id]: judgment }));
    });
  }
  const toolLabel = (name: string) => t(`studio.tool.${name}` as any);
  return (
    <section
      className={`knowledge-chat ${curating ? "curation-chat" : "answer-chat"}`}
    >
      <header className="kc-header">
        <span className={`kc-emblem ${kind}`}>
          <Icon size={23} />
        </span>
        <div>
          <h2>{t(curating ? "studio.curator" : "studio.answer")}</h2>
          <p>{t(curating ? "studio.sharedHint" : "studio.answerHint")}</p>
        </div>
        {curating && (
          <a href={`#/knowledge-assistants?library=${scopeId}`}>
            <Bot size={16} />
            {t("studio.bots")}
          </a>
        )}
      </header>
      {error && (
        <div className="kc-error" role="alert">
          {error}
          <button onClick={() => setError("")}>{t("knowledge.close")}</button>
        </div>
      )}
      <div className="kc-layout">
        <aside className="kc-threads">
          <button
            className="kc-new"
            onClick={() => {
              setSelected("");
              setMessages([]);
              setState("idle");
              setText("");
            }}
          >
            <Plus size={16} />
            {t("studio.new")}
          </button>
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={selected === thread.id ? "selected" : ""}
              onClick={() => setSelected(thread.id)}
            >
              <span>{thread.title}</span>
              <small>
                {new Date(thread.updated_at).toLocaleDateString(locale)}
              </small>
            </button>
          ))}
        </aside>
        <div className="kc-conversation">
          <div
            className="kc-messages"
            ref={viewport}
            onScroll={() => {
              const el = viewport.current;
              if (el)
                nearBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
          >
            {!messages.length && (
              <div className="kc-welcome">
                <Icon size={38} />
                <h3>
                  {t(
                    curating ? "studio.welcomeCurate" : "studio.welcomeAnswer",
                  )}
                </h3>
                <p>{t(curating ? "studio.sharedSources" : "studio.askHint")}</p>
                <div className="kc-suggestions">
                  {(curating
                    ? [
                        "studio.suggestOrganize",
                        "studio.suggestSources",
                        "studio.suggestFeedback",
                      ]
                    : ["studio.suggestOverview", "studio.suggestTroubleshoot"]
                  ).map((key) => (
                    <button key={key} onClick={() => void send(t(key as any))}>
                      {t(key as any)}
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) =>
              message.role === "tool" ? (
                <ToolEvent
                  key={message.id}
                  message={message}
                  label={toolLabel(message.detail.name || message.content)}
                />
              ) : (
                <article
                  key={message.id}
                  className={`kc-message ${message.role}`}
                >
                  <div className="kc-author">
                    {message.role === "user"
                      ? message.trigger === "schedule"
                        ? t("studio.schedule")
                        : message.trigger === "system"
                          ? t("studio.system")
                          : message.authorName || t("studio.admin")
                      : t(curating ? "studio.curator" : "studio.answer")}
                    <time>
                      {new Date(message.created_at).toLocaleTimeString(locale, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <Preview
                    value={
                      message.content ||
                      (message.detail.status === "withdrawn"
                        ? t("studio.withdrawn")
                        : t(
                            message.detail.status === "failed"
                              ? "studio.failedAnswer"
                              : "studio.thinking",
                          ))
                    }
                  />
                  {!!message.detail.citations?.length && (
                    <details className="kc-citations">
                      <summary>
                        {t("studio.citations", {
                          count: message.detail.citations.length,
                        })}
                      </summary>
                      {message.detail.citations.map((citation, i) => (
                        <details key={citation.id}>
                          <summary>
                            [{i + 1}] {citation.title} · {citation.heading}{" "}
                            <small>v{citation.publication}</small>
                          </summary>
                          <Preview value={citation.text} />
                        </details>
                      ))}
                    </details>
                  )}
                  {!curating &&
                    message.role === "assistant" &&
                    message.detail.status === "completed" && (
                      <div className="kc-votes">
                        <button
                          aria-label={t("studio.useful")}
                          aria-pressed={feedback[message.id] === "useful"}
                          onClick={() => void vote(message.id, "useful")}
                        >
                          <ThumbsUp size={14} />
                          {t("studio.useful")}
                        </button>
                        <button
                          aria-label={t("studio.unhelpful")}
                          aria-pressed={feedback[message.id] === "unhelpful"}
                          onClick={() => void vote(message.id, "unhelpful")}
                        >
                          <ThumbsDown size={14} />
                          {t("studio.unhelpful")}
                        </button>
                        {feedback[message.id] && (
                          <small>{t("studio.feedbackSaved")}</small>
                        )}
                      </div>
                    )}
                </article>
              ),
            )}
            <div ref={tail} />
          </div>
          <form
            className="kc-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {active && (
              <div className="kc-activity">
                <span className="kc-dot" />
                {t("studio.running")}
                {curating && (
                  <button
                    type="button"
                    onClick={() =>
                      void work(() =>
                        api(
                          `/knowledge/conversations/${selected}/pause`,
                          "POST",
                        ),
                      )
                    }
                  >
                    <Pause size={13} />
                    {t("studio.pause")}
                  </button>
                )}
              </div>
            )}
            <div className="kc-input">
              <textarea
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t(
                  active && curating
                    ? "studio.addInstruction"
                    : curating
                      ? "studio.curatePlaceholder"
                      : "studio.answerPlaceholder",
                )}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                className="primary"
                disabled={sending || !text.trim() || (!curating && active)}
                aria-label={t("studio.send")}
              >
                <Send size={18} />
              </button>
            </div>
            <small>
              {t(curating ? "studio.auditHint" : "studio.feedbackHint")}
            </small>
          </form>
        </div>
        {curating && (
          <aside className="kc-assets">
            <nav>
              {(["documents", "sources", "feedback"] as const).map((id) => (
                <button
                  key={id}
                  aria-pressed={panel === id}
                  onClick={() => setPanel(id)}
                >
                  {t(`studio.${id}`)}
                </button>
              ))}
            </nav>
            {panel === "documents" && (
              <div className="kc-results">
                {entries
                  .filter((e) => !["deleted", "superseded"].includes(e.status))
                  .map((entry) => (
                    <div className="kc-entry" key={entry.id}>
                      <strong>{entry.title}</strong>
                      <small>{entry.path.join(" / ")}</small>
                      {entry.reviewState.nodeId && (
                        <a href={`#/r/${entry.reviewState.nodeId}`}>
                          <ArrowUpRight size={13} />
                          {t("studio.editDocument")}
                        </a>
                      )}
                      {entry.status === "draft" && (
                        <>
                          <details>
                            <summary>{t("studio.reviewDraft")}</summary>
                            <Preview value={entry.markdown} />
                          </details>
                          <button
                            onClick={() =>
                              void work(() =>
                                api(
                                  `/knowledge/libraries/${scopeId}/entries/${entry.id}/review`,
                                  "POST",
                                  {
                                    expectedRevision: entry.revision,
                                    action: "publish",
                                  },
                                ),
                              )
                            }
                          >
                            {t("studio.adopt")}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                {!entries.length && <p>{t("studio.noDocuments")}</p>}
              </div>
            )}
            {panel === "sources" && (
              <div className="kc-results">
                <p>{t("studio.sourceHint")}</p>
                {sources
                  .filter((source) => source.status !== "detached")
                  .map((source) => (
                    <div className="kc-entry" key={source.id}>
                      <strong>
                        {source.title ||
                          source.sourceTitle ||
                          source.nodeTitle ||
                          source.url ||
                          source.sourceKind}
                      </strong>
                      {source.members && (
                        <details>
                          <summary>
                            {t("sourceGroup.members", {
                              count: source.members.length,
                            })}
                          </summary>
                          {source.members.map((m: any) => (
                            <p key={m.id}>
                              {m.sourceTitle || m.url || m.sourceId} ·{" "}
                              {m.status}
                            </p>
                          ))}
                        </details>
                      )}
                      <div className="kc-source-controls">
                        <button
                          onClick={() =>
                            void work(() =>
                              api(
                                `/knowledge/libraries/${scopeId}/source-actions`,
                                "POST",
                                {
                                  sourceKey: source.id,
                                  action: (
                                    source.members
                                      ? source.members.every((m: any) =>
                                          excluded.includes(m.id),
                                        )
                                      : excluded.includes(source.id)
                                  )
                                    ? "resume"
                                    : "pause",
                                  reason: t("studio.manualSourceChange"),
                                },
                              ),
                            )
                          }
                        >
                          {t(
                            (
                              source.members
                                ? source.members.every((m: any) =>
                                    excluded.includes(m.id),
                                  )
                                : excluded.includes(source.id)
                            )
                              ? "studio.resumeSource"
                              : "studio.pauseSource",
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setText(
                              `${t("studio.prioritizeSource")} ${source.title || source.url || source.id}`,
                            );
                          }}
                        >
                          {t("studio.setPriority")}
                        </button>
                        <button
                          onClick={() => {
                            setText(
                              `${t("studio.editSourceGuide")} ${source.title || source.url || source.id}`,
                            );
                          }}
                        >
                          {t("studio.editGuide")}
                        </button>
                      </div>
                    </div>
                  ))}
                {actions
                  .filter(
                    (action) =>
                      action.action !== "recommend" ||
                      !actions.some(
                        (other) =>
                          other.source_key === action.source_key &&
                          other.action === "ignore" &&
                          other.created_at > action.created_at,
                      ),
                  )
                  .map((action) => {
                    const detail = JSON.parse(action.detail);
                    return (
                      <div className="kc-entry" key={action.id}>
                        <strong>
                          {t(`studio.action.${action.action}` as any)}
                        </strong>
                        <small>
                          {sources.find(
                            (source) => source.id === action.source_key,
                          )?.title ||
                            sources.find(
                              (source) => source.id === action.source_key,
                            )?.url ||
                            action.source_key}
                        </small>
                        <p>{detail.reason}</p>
                        {detail.scores && (
                          <dl>
                            {Object.entries(detail.scores).map(
                              ([key, value]) => (
                                <div key={key}>
                                  <dt>{t(`studio.score.${key}` as any)}</dt>
                                  <dd>{String(value)}</dd>
                                </div>
                              ),
                            )}
                          </dl>
                        )}
                        {action.action === "recommend" && (
                          <div>
                            <button
                              onClick={() =>
                                void send(
                                  `${t("studio.acceptSource")} ${action.source_key}`,
                                )
                              }
                            >
                              {t("studio.accept")}
                            </button>
                            <button
                              onClick={() =>
                                void work(() =>
                                  api(
                                    `/knowledge/libraries/${scopeId}/source-actions`,
                                    "POST",
                                    {
                                      sourceKey: action.source_key,
                                      action: "ignore",
                                      reason: t("studio.ignoredManually"),
                                    },
                                  ),
                                )
                              }
                            >
                              {t("studio.ignore")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
            {panel === "feedback" && (
              <div className="kc-results">
                <button onClick={() => void send(t("studio.suggestFeedback"))}>
                  {t("studio.analyzeFeedback")}
                </button>
                {cases.map((item) => (
                  <div className="kc-entry" key={item.id}>
                    <strong>
                      {t(
                        item.judgment === "useful"
                          ? "studio.useful"
                          : "studio.unhelpful",
                      )}
                    </strong>
                    <p>
                      {
                        JSON.parse(item.snapshot)
                          .messages?.filter((x: any) => x.role === "user")
                          .at(-1)?.content
                      }
                    </p>
                    <small>{item.reason}</small>
                    {JSON.parse(item.snapshot).classification && (
                      <p>{JSON.parse(item.snapshot).classification.reason}</p>
                    )}
                    {JSON.parse(item.snapshot).validation && (
                      <details>
                        <summary>
                          {t(
                            JSON.parse(item.snapshot).validation.passed
                              ? "studio.regressionPassed"
                              : "studio.regressionFailed",
                          )}
                        </summary>
                        <p>{JSON.parse(item.snapshot).validation.reason}</p>
                        <Preview
                          value={JSON.parse(item.snapshot).validation.answer}
                        />
                      </details>
                    )}
                  </div>
                ))}
                {!cases.length && <p>{t("studio.noFeedback")}</p>}
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}

function ToolEvent({ message, label }: { message: Message; label: string }) {
  const { t } = useI18n(),
    args = (message.detail.args ?? {}) as any,
    result = (message.detail.result ?? {}) as any;
  const failed = !!result.error;
  return (
    <details className="kc-tool">
      <summary>
        <CheckCircle2 size={14} />
        {label}
        <span>
          {t(
            failed
              ? "studio.toolFailed"
              : message.detail.status === "running"
                ? "studio.running"
                : "studio.done",
          )}
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="kc-tool-body">
        {(result.title || args.title) && (
          <strong>{result.title || args.title}</strong>
        )}
        {(result.error || result.notes || result.reason || args.reason) && (
          <p>{result.error || result.notes || result.reason || args.reason}</p>
        )}
        {message.content === "work_plan" && Array.isArray(result.items) && (
          <ul>
            {result.items.map((item: any) => (
              <li key={item.id}>
                {item.status === "completed"
                  ? "✓"
                  : item.status === "blocked"
                    ? "!"
                    : "○"}{" "}
                {item.title}
                {item.reason && ` — ${item.reason}`}
              </li>
            ))}
          </ul>
        )}
        {result.characters && (
          <p>{t("studio.writtenCharacters", { count: result.characters })}</p>
        )}
        {result.documents && (
          <p>
            {t("studio.inspectedDocuments", { count: result.documents.length })}
          </p>
        )}
        {result.findings && (
          <ul>
            {result.findings.map((text: string, i: number) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        )}
        {(args.url || args.query) && <p>{args.url || args.query}</p>}
        {result.text && <Preview value={result.text} />}
        {(args.markdown || result.markdown) && (
          <Preview value={args.markdown || result.markdown} />
        )}
        {result.answer && <Preview value={result.answer} />}
        {Array.isArray(result.sources) &&
          result.sources.map((source: any, i: number) => (
            <p key={i}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title || source.url}
              </a>
            </p>
          ))}
        <details>
          <summary>{t("studio.auditDetails")}</summary>
          <pre>{JSON.stringify({ input: args, result }, null, 2)}</pre>
        </details>
      </div>
    </details>
  );
}
