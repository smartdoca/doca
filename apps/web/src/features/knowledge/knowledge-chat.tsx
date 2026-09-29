import { htmlLang } from "@doca/i18n";
import {
  Actions,
  Attachments,
  Bubble,
  Conversations,
  Sender,
} from "@ant-design/x";
import type { BubbleItemType } from "@ant-design/x/es/bubble/interface";
import type { Attachment, AttachmentsRef } from "@ant-design/x/es/attachments";
import { Button, Checkbox, ConfigProvider, Empty, Modal, Spin } from "antd";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  MessageSquare,
  Paperclip,
  Pause,
  SquareCheck,
  ThumbsUp,
  ThumbsDown,
  Plus,
  Trash2,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { KnowledgeModelPicker } from "./knowledge-model-picker.js";
import { HumanTasks } from "./knowledge-human-tasks.js";
import { CurationInputs } from "./knowledge-curation-inputs.js";
import {
  ASSISTANT_PROFILES,
  AssistantIdentity,
  AssistantWelcome,
  assistantProfileClass,
  type AssistantProfileId,
} from "@web/features/ai/assistant-profile.js";
import { antdLocale } from "@web/shared/antd-locale.js";
import { api, uploadFile } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import Preview from "@web/features/documents/markdown-preview.js";
import "@web/features/ai/ai.css";
import "./knowledge-chat.css";

const AIAnswer = lazy(() => import("@web/features/ai/ai-markdown.js"));

type Conversation = {
  archived: number;
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
    attachments?: Array<{
      id: string;
      filename: string;
      mime?: string;
      size?: number;
    }>;
    error?: string;
    citations?: {
      id: string;
      documentId: string;
      title: string;
      heading: string;
      text: string;
      publication: number;
      canOpen?: boolean;
    }[];
  };
};

type ConversationView = {
  conversation: Conversation;
  messages: Message[];
};

type ComposerAttachment = {
  id: string;
  filename: string;
};

export function KnowledgeChat({
  scopeId,
  initialConversationId,
  kind,
  compactHeader = false,
  attachmentsEnabled = false,
  guestToken,
  channel = "web",
  assistantName,
  headerStart,
  headerActions,
}: {
  scopeId: string;
  initialConversationId?: string;
  kind: "curation" | "answer";
  compactHeader?: boolean;
  attachmentsEnabled?: boolean;
  guestToken?: string;
  channel?: "web" | "embed";
  assistantName?: string;
  headerStart?: ReactNode;
  headerActions?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const curating = kind === "curation";
  const profile: AssistantProfileId = curating
    ? "knowledge-curation"
    : "knowledge-answer";
  const profileConfig = ASSISTANT_PROFILES[profile];
  const accent = profileConfig.accent;
  const title =
    assistantName || t(curating ? "studio.curator" : "studio.answer");
  const description = t(curating ? "studio.sharedHint" : "studio.answerHint");
  const memoryLabel = t(
    curating ? "assistant.memory.library" : "assistant.memory.thread",
  );
  const [threads, setThreads] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [list, setList] = useState(true);
  const [feedback, setFeedback] = useState<Record<string, string | null>>({});
  const [feedbackPending, setFeedbackPending] = useState<
    Record<string, boolean>
  >({});
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [archivedView, setArchivedView] = useState(false);
  const attachmentRef = useRef<AttachmentsRef>(null);
  const startingFresh = useRef(false);
  const active = state === "queued" || state === "running";
  const voting = useRef(new Set<string>());

  const guestRequest = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
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
    },
    [guestToken, scopeId],
  );

  const reloadThreads = useCallback(async () => {
    const value = guestToken
      ? await guestRequest<{ items: Conversation[] }>("/conversations")
      : await api<{ items: Conversation[] }>(
          `/knowledge/conversations?scopeId=${scopeId}&kind=${kind}&archived=${archivedView}`,
        );
    setThreads(value.items);
    return value.items;
  }, [archivedView, guestRequest, guestToken, kind, scopeId]);

  const applyView = useCallback((value: ConversationView) => {
    setMessages(value.messages);
    setFeedback((current) => {
      const next = { ...current };
      for (const message of value.messages)
        if (!voting.current.has(message.id))
          next[message.id] = message.feedback ?? null;
      return next;
    });
    setState(value.conversation.state);
  }, []);

  const loadConversation = useCallback(async () => {
    if (!selected) return;
    const value = guestToken
      ? await guestRequest<ConversationView>(`/conversations/${selected}`)
      : await api<ConversationView>(`/knowledge/conversations/${selected}`);
    applyView(value);
  }, [applyView, guestRequest, guestToken, selected]);

  useEffect(() => {
    let live = true;
    setSelected("");
    setMessages([]);
    setState("idle");
    void reloadThreads()
      .then((items) => {
        if (!live) return;
        setSelected(
          startingFresh.current
            ? ""
            : initialConversationId || items[0]?.id || "",
        );
        startingFresh.current = false;
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [initialConversationId, reloadThreads]);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    let live = true;
    const refresh = () =>
      loadConversation().catch((e) => {
        if (live) setError(e.message);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), active ? 1400 : 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, loadConversation, selected]);

  useEffect(() => {
    if (!selected || !active || guestToken) return;
    const source = new EventSource(
      `/api/v1/knowledge/conversations/${selected}/stream`,
    );
    source.addEventListener("update", (event) => {
      try {
        applyView(JSON.parse((event as MessageEvent).data));
      } catch {}
    });
    source.addEventListener("done", () => source.close());
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [active, applyView, guestToken, selected]);

  useEffect(() => {
    if (!active) void reloadThreads().catch(() => undefined);
  }, [active, reloadThreads]);

  function newConversation() {
    startingFresh.current = true;
    if (archivedView) setArchivedView(false);
    setSelected("");
    setMessages([]);
    setState("idle");
    setText("");
    setAttachments([]);
    setError("");
    if (matchMedia("(max-width: 720px)").matches) setList(false);
  }

  async function send(content = text) {
    const value = content.trim();
    if (
      !value ||
      archivedView ||
      sending ||
      uploading ||
      (!curating && active)
    )
      return;
    setSending(true);
    setError("");
    try {
      if (guestToken) {
        setMessages((current) => [
          ...current,
          optimisticMessage(value, attachments),
        ]);
        const result = await guestRequest<{ conversationId: string }>("/ask", {
          query: value,
          conversationId: selected || undefined,
        });
        setSelected(result.conversationId);
        setText("");
        setState("queued");
        await reloadThreads();
        return;
      }
      let id = selected;
      let created = false;
      if (!id) {
        const thread = await api<Conversation>(
          "/knowledge/conversations",
          "POST",
          { scopeId, kind, title: value.slice(0, 80) },
        );
        id = thread.id;
        created = true;
      }
      const requestId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        {
          ...optimisticMessage(value, attachments),
          id: requestId,
        },
      ]);
      await api(`/knowledge/conversations/${id}/messages`, "POST", {
        content: value,
        requestId,
        attachments: attachments.map((item) => item.id),
        channel,
      });
      if (created) setSelected(id);
      setText("");
      setAttachments([]);
      setState("queued");
      await reloadThreads();
    } catch (e) {
      setError((e as Error).message);
      await loadConversation().catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  async function work(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pause() {
    if (!selected) return;
    await work(async () => {
      await api(`/knowledge/conversations/${selected}/pause`, "POST");
      setState("paused");
      await loadConversation();
    });
  }

  const toggleSelectedSession = (id: string) =>
    setSelectedSessions((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );

  async function manageSessions(
    ids: string[],
    action: "archive" | "restore" | "delete",
  ) {
    if (!ids.length || guestToken) return;
    await work(async () => {
      await api("/knowledge/conversations/batch", "POST", { ids, action });
      if (ids.includes(selected)) {
        setSelected("");
        setMessages([]);
        setState("idle");
      }
      setSelectedSessions([]);
      await reloadThreads();
    });
  }

  function confirmDelete(ids: string[]) {
    Modal.confirm({
      title: t(
        ids.length > 1
          ? "chat.deleteSelectedConfirm"
          : "chat.deleteConfirm",
      ),
      content: t(
        ids.length > 1
          ? "chat.deleteSelectedHelp"
          : "chat.deleteKnowledgeHelp",
      ),
      okText: t("chat.delete"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: () => manageSessions(ids, "delete"),
    });
  }

  async function vote(id: string, choice: "useful" | "unhelpful") {
    if (voting.current.has(id)) return;
    const judgment = feedback[id] === choice ? null : choice;
    voting.current.add(id);
    setFeedbackPending((current) => ({ ...current, [id]: true }));
    try {
      if (guestToken)
        await guestRequest(
          `/conversations/${selected}/messages/${id}/feedback`,
          { judgment },
        );
      else
        await api(`/knowledge/messages/${id}/feedback`, "POST", { judgment });
      setFeedback((current) => ({ ...current, [id]: judgment }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      voting.current.delete(id);
      setFeedbackPending((current) => ({ ...current, [id]: false }));
    }
  }

  async function upload(file: File) {
    if (attachments.length >= 8) {
      setError(t("chat.attachmentLimit"));
      return;
    }
    setUploading(true);
    setError("");
    try {
      const asset = await uploadFile(file, "ai_attachment");
      setAttachments((current) => [
        ...current,
        { id: asset.id, filename: file.name },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const attachmentItems: Attachment[] = attachments.map((file) => ({
    uid: file.id,
    name: file.filename,
    status: "done",
  }));

  const prompts = useMemo(
    () =>
      (curating
        ? [
            "studio.suggestOrganize",
            "studio.suggestSources",
            "studio.suggestFeedback",
          ]
        : ["studio.suggestOverview", "studio.suggestTroubleshoot"]
      ).map((key) => ({
        key,
        icon: <ArrowUpRight size={15} />,
        label: t(key as any),
        description: t(key as any),
      })),
    [curating, t],
  );

  const bubbleItems = useMemo<BubbleItemType[]>(() => {
    if (!messages.length)
      return [
        {
          key: "welcome",
          role: "welcome",
          variant: "borderless",
          styles: {
            content: { padding: 0, width: "100%" },
            body: { width: "100%" },
          },
          content: (
            <AssistantWelcome
              profile={profile}
              title={t(
                curating ? "studio.welcomeCurate" : "studio.welcomeAnswer",
              )}
              description={t(
                curating ? "studio.sharedSources" : "studio.askHint",
              )}
              items={prompts}
              onSelect={(item) => setText(String(item.description))}
            />
          ),
        },
      ];
    return messages.map((message): BubbleItemType => {
      if (message.role === "tool")
        return {
          key: message.id,
          role: "progress",
          variant: "borderless",
          className: "ai-step-bubble assistant-tool-bubble",
          content: (
            <ToolEvent
              message={message}
              label={t(
                `studio.tool.${message.detail.name || message.content}` as any,
              )}
            />
          ),
        };
      const user = message.role === "user";
      const status = message.detail.status;
      const answer =
        message.content ||
        (status === "withdrawn"
          ? t("studio.withdrawn")
          : status === "failed"
            ? message.detail.error || t("studio.failedAnswer")
            : t("studio.thinking"));
      return {
        key: message.id,
        role: user ? "user" : "ai",
        placement: user ? "end" : "start",
        variant: user ? "filled" : "borderless",
        className: user ? "ai-user-bubble" : "ai-response-bubble",
        header: user ? (
          <time className="ai-message-time" dateTime={message.created_at}>
            {messageAuthor(message, t)} ·{" "}
            {new Date(message.created_at).toLocaleString(htmlLang(locale), {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        ) : (
          title
        ),
        streaming: !user && ["streaming", "running"].includes(status || ""),
        content: (
          <>
            {!!message.detail.attachments?.length && (
              <div className="assistant-message-attachments">
                {message.detail.attachments.map((file) => (
                  <span key={file.id}>
                    <Paperclip size={13} />
                    {file.filename}
                  </span>
                ))}
              </div>
            )}
            {user ? (
              <span className="ai-user-message-text">{message.content}</span>
            ) : (
              <Suspense fallback={<span>{answer}</span>}>
                <AIAnswer
                  text={answer}
                  streaming={["streaming", "running"].includes(status || "")}
                  onDocument={(id) => {
                    location.hash = `/r/${id}`;
                  }}
                />
              </Suspense>
            )}
            {!!message.detail.citations?.length && (
              <details className="assistant-citations">
                <summary>
                  {t("studio.citations", {
                    count: message.detail.citations.length,
                  })}
                </summary>
                {message.detail.citations.map((citation, index) => (
                  <details key={citation.id}>
                    <summary>
                      <span>[{index + 1}] </span>
                      {citation.canOpen && !guestToken ? (
                        <a
                          className="assistant-citation-link"
                          href={`#/r/${citation.documentId}`}
                          title={t("common.open")}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {citation.title} · {citation.heading}
                          <ExternalLink size={12} aria-hidden />
                        </a>
                      ) : (
                        <span>
                          {citation.title} · {citation.heading}
                        </span>
                      )}{" "}
                      <small>v{citation.publication}</small>
                    </summary>
                    <Preview value={citation.text} />
                  </details>
                ))}
              </details>
            )}
          </>
        ),
        footer:
          !user && message.content && status !== "streaming" ? (
            <div className="assistant-answer-actions">
              <Actions
                items={[
                  {
                    key: "copy",
                    label: t("chat.copyAnswer"),
                    actionRender: <Actions.Copy text={message.content} />,
                  },
                ]}
              />
              {profileConfig.capabilities.feedback &&
                status === "completed" && (
                  <div className="kc-votes">
                    <button type="button" aria-label={t("studio.useful")}
                      aria-pressed={feedback[message.id] === "useful"}
                      disabled={feedbackPending[message.id]}
                      onClick={() => void vote(message.id, "useful")}>
                      <ThumbsUp size={15} />
                    </button>
                    <button type="button" aria-label={t("studio.unhelpful")}
                      aria-pressed={feedback[message.id] === "unhelpful"}
                      disabled={feedbackPending[message.id]}
                      onClick={() => void vote(message.id, "unhelpful")}>
                      <ThumbsDown size={15} />
                    </button>
                    {feedback[message.id] && <small role="status">{t("studio.feedbackSaved")}</small>}
                  </div>
                )}
            </div>
          ) : undefined,
      };
    });
  }, [
    curating,
    feedback,
    feedbackPending,
    guestToken,
    locale,
    messages,
    profile,
    profileConfig.capabilities.feedback,
    prompts,
    t,
    title,
  ]);

  return (
    <ConfigProvider
      locale={antdLocale(locale)}
      theme={{
        token: {
          colorPrimary: accent,
          borderRadius: 10,
          fontFamily: "inherit",
        },
      }}
    >
      <section
        className={`knowledge-chat ai-chat ai-chat-full assistant-surface ${assistantProfileClass(profile)} ${list ? "ai-history-open" : ""} ${curating ? "assistant-curation curation-chat" : "assistant-answer answer-chat"}`}
        aria-label={title}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <header className="ai-chat-header assistant-chat-header">
          {headerStart}
          <AssistantIdentity
            profile={profile}
            title={title}
            description={description}
            memoryLabel={memoryLabel}
            compact={compactHeader}
          />
          <span className="ai-flex" />
          {headerActions}
          <button
            title={t("chat.sessionList")}
            aria-label={t("chat.sessionList")}
            aria-expanded={list}
            className={list ? "active" : ""}
            onClick={() => setList((value) => !value)}
          >
            <MessageSquare size={17} />
          </button>
          <button title={t("chat.newSession")} onClick={newConversation}>
            <Plus size={18} />
          </button>
        </header>
        {error && (
          <div className="assistant-chat-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              {t("knowledge.close")}
            </button>
          </div>
        )}
        <div className="ai-chat-body">
          {list && (
            <nav className="ai-session-list" aria-label={t("chat.history")}>
              {!guestToken && (
                <div className="ai-session-tools knowledge-session-tools">
                  <div className="ai-session-batch-row">
                    <button
                      className="ai-batch-toggle"
                      aria-pressed={batch}
                      disabled={!threads.length}
                      onClick={() => {
                        setBatch((value) => !value);
                        setSelectedSessions([]);
                      }}
                    >
                      <SquareCheck size={13} />
                      {batch ? t("chat.exitBulk") : t("chat.bulk")}
                    </button>
                    <button
                      className="knowledge-archive-toggle"
                      aria-pressed={archivedView}
                      onClick={() => {
                        startingFresh.current = false;
                        setArchivedView((value) => !value);
                        setBatch(false);
                        setSelectedSessions([]);
                      }}
                    >
                      {archivedView ? (
                        <MessageSquare size={13} />
                      ) : (
                        <Archive size={13} />
                      )}
                      {t(archivedView ? "chat.showActive" : "chat.archived")}
                    </button>
                  </div>
                  {batch && (
                    <div className="ai-selection-bar">
                      <span>
                        {selectedSessions.length
                          ? t("chat.selectedCount", {
                              count: selectedSessions.length,
                            })
                          : t("chat.chooseSessions")}
                      </span>
                      <button
                        disabled={!threads.length}
                        onClick={() =>
                          setSelectedSessions(threads.map((thread) => thread.id))
                        }
                      >
                        {t("notes.selectAll")}
                      </button>
                      <button
                        disabled={!selectedSessions.length}
                        onClick={() => setSelectedSessions([])}
                      >
                        {t("notes.clear")}
                      </button>
                      <button
                        className="primary"
                        disabled={!selectedSessions.length}
                        onClick={() =>
                          void manageSessions(
                            selectedSessions,
                            archivedView ? "restore" : "archive",
                          )
                        }
                      >
                        {archivedView ? (
                          <ArchiveRestore size={13} />
                        ) : (
                          <Archive size={13} />
                        )}
                        {t(
                          archivedView
                            ? "chat.restoreSelected"
                            : "chat.archiveSelected",
                        )}
                      </button>
                      <button
                        className="danger"
                        disabled={!selectedSessions.length}
                        onClick={() => confirmDelete(selectedSessions)}
                      >
                        <Trash2 size={13} />
                        {t("chat.deleteSelected")}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <Conversations
                creation={
                  archivedView
                    ? undefined
                    : {
                        label: t("chat.newChat"),
                        onClick: newConversation,
                      }
                }
                activeKey={selected || undefined}
                items={threads.map((thread) => ({
                  key: thread.id,
                  label: batch ? (
                    <span className="ai-session-check">
                      <Checkbox
                        aria-label={t("chat.selectSession", {
                          name: thread.title,
                        })}
                        checked={selectedSessions.includes(thread.id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggleSelectedSession(thread.id)}
                      />
                      <span className="ai-session-label" title={thread.title}>
                        <span className="ai-session-check-title">
                          {thread.title}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <span className="ai-session-label" title={thread.title}>
                      <span className="ai-session-title">{thread.title}</span>
                    </span>
                  ),
                  className:
                    batch && selectedSessions.includes(thread.id)
                      ? "ai-session-picked"
                      : undefined,
                  icon: ["queued", "running"].includes(thread.state) ? (
                    <Spin size="small" aria-label={t(thread.state === "queued" ? "studio.queued" : "studio.running")} />
                  ) : undefined,
                  group:
                    new Date(thread.updated_at).toDateString() ===
                    new Date().toDateString()
                      ? t("common.today")
                      : t("chat.earlier"),
                }))}
                groupable
                onActiveChange={(id) => {
                  if (batch) {
                    toggleSelectedSession(id);
                    return;
                  }
                  setSelected(id);
                  setMessages([]);
                  setText("");
                  setAttachments([]);
                  setError("");
                  if (matchMedia("(max-width: 720px)").matches) setList(false);
                }}
                menu={(item) =>
                  batch || guestToken
                    ? undefined
                    : {
                        items: [
                          {
                            key: archivedView ? "restore" : "archive",
                            label: t(
                              archivedView ? "chat.restore" : "chat.archive",
                            ),
                            icon: archivedView ? (
                              <ArchiveRestore size={14} />
                            ) : (
                              <Archive size={14} />
                            ),
                          },
                          {
                            key: "delete",
                            label: t("chat.delete"),
                            danger: true,
                            icon: <Trash2 size={14} />,
                          },
                        ],
                        onClick: ({ key }) => {
                          if (key === "delete") confirmDelete([item.key]);
                          else
                            void manageSessions(
                              [item.key],
                              key as "archive" | "restore",
                            );
                        },
                      }
                }
              />
              {!threads.length && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t("chat.historyEmpty")}
                />
              )}
            </nav>
          )}
          <div className="ai-conversation">
            <div className="ai-messages" aria-live="polite">
              <Bubble.List
                className="ai-bubble-list"
                classNames={{ scroll: "ai-bubble-scroll" }}
                items={bubbleItems}
                autoScroll
                styles={{ scroll: { padding: 0 } }}
              />
            </div>
            <div className="ai-composer assistant-composer">
              {active && (
                <div className="assistant-running">
                  <Spin size="small" />
                  <span>{t(state === "queued" ? "studio.queued" : "studio.running")}</span>
                  {curating && !guestToken && (
                    <Button
                      type="text"
                      size="small"
                      icon={<Pause size={13} />}
                      onClick={() => void pause()}
                    >
                      {t("studio.pause")}
                    </Button>
                  )}
                </div>
              )}
              <Sender
                className="assistant-sender"
                suffix={false}
                value={text}
                onChange={setText}
                onSubmit={() => void send()}
                submitType="enter"
                autoSize={{ minRows: 2, maxRows: 8 }}
                placeholder={t(
                  archivedView
                    ? "chat.archivedReadOnly"
                    : curating
                      ? active
                        ? "studio.addInstruction"
                        : "studio.curatePlaceholder"
                      : "studio.answerPlaceholder",
                )}
                disabled={sending || archivedView}
                header={
                  attachmentsEnabled &&
                  !curating &&
                  !guestToken &&
                  !archivedView ? (
                    <Attachments
                      ref={attachmentRef}
                      style={{
                        display: attachments.length ? undefined : "none",
                      }}
                      overflow="scrollX"
                      maxCount={8}
                      className="ai-upload-list"
                      items={attachmentItems}
                      multiple
                      disabled={uploading || active}
                      beforeUpload={(file) => {
                        void upload(file);
                        return false;
                      }}
                      onRemove={(file) => {
                        setAttachments((current) =>
                          current.filter((item) => item.id !== file.uid),
                        );
                        return true;
                      }}
                      getDropContainer={() => null}
                    />
                  ) : undefined
                }
                footer={(_, { components: { SendButton } }) => (
                  <div className="ai-composer-tools assistant-composer-tools">
                    {curating && !archivedView ? (
                      <CurationInputs
                        libraryId={scopeId}
                        added={(label) =>
                          setText((current) =>
                            [current, t("curator.addedSource", { name: label })]
                              .filter(Boolean)
                              .join("\n"),
                          )
                        }
                      />
                    ) : attachmentsEnabled && !guestToken && !archivedView ? (
                      <Button
                        type="text"
                        className="ai-upload-trigger"
                        disabled={uploading || active}
                        title={t("chat.upload")}
                        aria-label={t("chat.upload")}
                        icon={<Plus size={20} />}
                        onClick={() =>
                          attachmentRef.current?.select({ multiple: true })
                        }
                      />
                    ) : null}
                    <span className="ai-flex" />
                    {!archivedView &&
                      profileConfig.capabilities.modelPicker && (
                        <KnowledgeModelPicker libraryId={scopeId} />
                      )}
                    <SendButton
                      aria-label={t("studio.send")}
                      disabled={
                        sending ||
                        uploading ||
                        archivedView ||
                        !text.trim() ||
                        (!curating && active)
                      }
                    />
                  </div>
                )}
                onPasteFile={(items) => {
                  if (!attachmentsEnabled || curating || guestToken) return;
                  for (const file of Array.from(items)) void upload(file);
                }}
              />
              <small className="assistant-composer-note">
                {t(curating ? "studio.auditHint" : "studio.feedbackHint")}
              </small>
            </div>
          </div>
          {profileConfig.capabilities.humanTasks && (
            <HumanTasks libraryId={scopeId} conversationId={selected} />
          )}
        </div>
      </section>
    </ConfigProvider>
  );
}

function optimisticMessage(
  content: string,
  attachments: ComposerAttachment[],
): Message {
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    role: "user",
    content,
    trigger: "manual",
    created_at: new Date().toISOString(),
    detail: { attachments },
  };
}

function messageAuthor(message: Message, t: (key: any) => string) {
  if (message.trigger === "schedule" || message.trigger === "feedback_schedule")
    return t("studio.schedule");
  if (message.trigger === "system") return t("studio.system");
  if (message.trigger === "public") return t("bot.guest");
  if (message.trigger === "api") return "API";
  return message.authorName || t("studio.admin");
}

function ToolEvent({ message, label }: { message: Message; label: string }) {
  const { t } = useI18n();
  const args = (message.detail.args ?? {}) as any;
  const result = (message.detail.result ?? {}) as any;
  const failed = !!result.error;
  return (
    <details className="kc-tool assistant-tool-event">
      <summary>
        <CheckCircle2 size={14} />
        <span className="assistant-tool-title">{label}</span>
        <span className="assistant-tool-status">
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
            {result.findings.map((text: string, index: number) => (
              <li key={index}>{text}</li>
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
          result.sources.map((source: any, index: number) => (
            <p key={index}>
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
