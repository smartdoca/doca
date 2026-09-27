import { HumanTasks } from "./knowledge-human-tasks.js";
import { CurationInputs } from "./knowledge-curation-inputs.js";
import { useEffect, useRef, useState } from "react";
import {
  BookOpenCheck,
  Paperclip,
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
import { api, uploadFile } from "@web/shared/api.js";
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
  feedback?: "useful" | "unhelpful" | null;
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
    attachments?: Array<{ id: string; filename: string }>;
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
  initialConversationId,
  kind,
  compactHeader = false,
  attachmentsEnabled = false,
  guestToken,
  channel = "web",
}: {
  scopeId: string;
  initialConversationId?: string;
  kind: "curation" | "answer";
  compactHeader?: boolean;
  attachmentsEnabled?: boolean;
  guestToken?: string;
  channel?: "web" | "embed";
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
    [feedback, setFeedback] = useState<Record<string, string | null>>({});
  const voting = useRef(new Set<string>());
  const feedbackVersion = useRef(0);
  const [feedbackPending, setFeedbackPending] = useState<
    Record<string, boolean>
  >({});
  const [attachments, setAttachments] = useState<
      Array<{ id: string; filename: string }>
    >([]),
    [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tail = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    viewport = useRef<HTMLDivElement>(null);
  const Icon = curating ? BookOpenCheck : Bot;
  const active = state === "queued" || state === "running";
  async function guestRequest<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `/api/v1/knowledge/assistants/${scopeId}/api${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${guestToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw Error(data.message || data.error || String(response.status));
    return data;
  }
  async function reloadThreads() {
    const value = guestToken
      ? await guestRequest<{ items: Conversation[] }>("/conversations")
      : await api<{ items: Conversation[] }>(
          `/knowledge/conversations?scopeId=${scopeId}&kind=${kind}`,
        );
    setThreads(value.items);
    return value.items;
  }
  useEffect(() => {
    let live = true;
    setSelected("");
    setMessages([]);
    void reloadThreads()
      .then((items) => {
        if (live) setSelected(initialConversationId || items[0]?.id || "");
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [scopeId, kind, initialConversationId]);
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    let live = true;
    const load = () => {
      const version = feedbackVersion.current;
      return (
        guestToken
          ? guestRequest<{ conversation: Conversation; messages: Message[] }>(
              `/conversations/${selected}`,
            )
          : api<{ conversation: Conversation; messages: Message[] }>(
              `/knowledge/conversations/${selected}`,
            )
      )
        .then((value) => {
          if (!live) return;
          setMessages(value.messages);
          if (version === feedbackVersion.current && voting.current.size === 0)
            setFeedback(
              Object.fromEntries(
                value.messages.map((message) => [
                  message.id,
                  message.feedback ?? null,
                ]),
              ),
            );
          setState(value.conversation.state);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    };
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
        void reloadThreads().catch(() => {});
    }
  }, [state]);
  async function send(content = text) {
    if (!content.trim() || sending || uploading) return;
    setSending(true);
    setError("");
    try {
      if (guestToken) {
        const result = await guestRequest<{ conversationId: string }>("/ask", {
          query: content,
          conversationId: selected || undefined,
        });
        setSelected(result.conversationId);
        setText("");
        setState("queued");
        nearBottom.current = true;
        await reloadThreads();
        return;
      }
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
        attachments: attachments.map((x) => x.id),
        channel,
      });
      setText("");
      setAttachments([]);
      setState("queued");
      nearBottom.current = true;
      await reloadThreads();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function work(fn:()=>Promise<unknown>){setError("");try{await fn();}catch(e){setError((e as Error).message);}}
  async function vote(id: string, choice: "useful" | "unhelpful") {
    if (voting.current.has(id)) return;
    const judgment = feedback[id] === choice ? null : choice;
    voting.current.add(id);
    feedbackVersion.current++;
    setFeedbackPending((x) => ({ ...x, [id]: true }));
    try {
      if (guestToken)
        await guestRequest(
          `/conversations/${selected}/messages/${id}/feedback`,
          { judgment },
        );
      else
        await api(`/knowledge/messages/${id}/feedback`, "POST", { judgment });
      setFeedback((x) => ({ ...x, [id]: judgment }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      voting.current.delete(id);
      feedbackVersion.current++;
      setFeedbackPending((x) => ({ ...x, [id]: false }));
    }
  }
  const toolLabel = (name: string) => t(`studio.tool.${name}` as any);
  return (
    <section
      className={`knowledge-chat ${curating ? "curation-chat" : "answer-chat"}`}
    >
      {!compactHeader && (
        <header className="kc-header">
          <span className={`kc-emblem ${kind}`}>
            <Icon size={23} />
          </span>
          <div>
            <h2>{t(curating ? "studio.curator" : "studio.answer")}</h2>
            <p>{t(curating ? "studio.sharedHint" : "studio.answerHint")}</p>
          </div>
          {curating && (
            <a href={`#/r/${scopeId}?view=qa`}>
              <Bot size={16} />
              {t("studio.bots")}
            </a>
          )}
        </header>
      )}
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
              title={thread.title}
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
                      ? message.trigger === "schedule" ||
                        message.trigger === "feedback_schedule"
                        ? t("studio.schedule")
                        : message.trigger === "system"
                          ? t("studio.system")
                          : message.trigger === "public"
                            ? t("bot.guest")
                            : message.trigger === "api"
                              ? "API"
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
                  {message.detail.attachments?.map((file) => (
                    <div className="kc-attachment-history" key={file.id}>
                      <Paperclip size={13} /> {file.filename}
                    </div>
                  ))}
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
                          disabled={feedbackPending[message.id]}
                          aria-label={t("studio.useful")}
                          aria-pressed={feedback[message.id] === "useful"}
                          onClick={() => void vote(message.id, "useful")}
                        >
                          <ThumbsUp size={14} />
                          {t("studio.useful")}
                        </button>
                        <button
                          disabled={feedbackPending[message.id]}
                          aria-label={t("studio.unhelpful")}
                          aria-pressed={feedback[message.id] === "unhelpful"}
                          onClick={() => void vote(message.id, "unhelpful")}
                        >
                          <ThumbsDown size={14} />
                          {t("studio.unhelpful")}
                        </button>
                        {feedback[message.id] && (
                          <small role="status">
                            {t("studio.feedbackSaved")}
                          </small>
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
            {!!attachments.length && (
              <div className="kc-attachments">
                {attachments.map((file) => (
                  <span key={file.id}>
                    <Paperclip size={13} />
                    {file.filename}
                    <button
                      type="button"
                      aria-label={t("knowledge.removeMember")}
                      onClick={() =>
                        setAttachments(
                          attachments.filter((x) => x.id !== file.id),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachmentsEnabled && !curating && !guestToken && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length + attachments.length > 8) {
                      setError(t("chat.attachmentLimit"));
                      return;
                    }
                    setUploading(true);
                    try {
                      for (const file of files) {
                        const asset = await uploadFile(file, "ai_attachment");
                        setAttachments((current) => [
                          ...current,
                          { id: asset.id, filename: file.name },
                        ]);
                      }
                    } catch (error) {
                      setError((error as Error).message);
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={uploading || active}
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip size={15} />
                  {t(uploading ? "bot.uploading" : "bot.upload")}
                </button>
              </>
            )}
            {curating && (
              <CurationInputs
                libraryId={scopeId}
                added={(label) =>
                  setText((old) =>
                    [old, t("curator.addedSource", { name: label })]
                      .filter(Boolean)
                      .join("\n"),
                  )
                }
              />
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
                disabled={
                  sending || uploading || !text.trim() || (!curating && active)
                }
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
          <HumanTasks libraryId={scopeId} conversationId={selected} />
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
