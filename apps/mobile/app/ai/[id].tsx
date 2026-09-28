import { useQuery } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import { ArrowUp, Paperclip } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Composer, GiftedChat, InputToolbar, type IMessage } from "react-native-gifted-chat";
import { IconButton } from "react-native-paper";
import EventSource from "react-native-sse";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, uuid } from "../../src/api";
import { AnswerBody, ApprovalCards, type ApprovalItem } from "../../src/ai-answer";
import { AiTrace, type TraceEvent, type TraceOperation } from "../../src/ai-trace";
import { useAuth } from "../../src/auth";
import { colors } from "../../src/chrome";
import { fileSize } from "../../src/format";

type ChatAttachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  uri?: string;
};
type ApiMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  attachments?: ChatAttachment[];
};
type ChatMessage = IMessage & { attachments?: ChatAttachment[]; revision?: number };
type PendingFile = {
  localId: string;
  name: string;
  mime: string;
  size: number;
  uri: string;
  status: "uploading" | "done" | "error";
  id?: string;
};
type Job = {
  id: string;
  status: string;
  error?: string | null;
  progress?: {
    text?: string;
    reasoning?: string;
    events?: TraceEvent[];
    approvals?: ApprovalItem[];
  };
};
type Detail = {
  session: { id: string; title: string; model_id: string | null };
  messages: ApiMessage[];
  jobs: Job[];
  operations?: TraceOperation[];
};
type Options = {
  defaultModel: string;
  webSearchAvailable: boolean;
  models: { id: string }[];
  preferences?: { default_model?: string | null };
};
type JobEvent = {
  id: string;
  status: string;
  error?: string | null;
  progress?: {
    text?: string;
    appendText?: boolean;
    reasoning?: string;
    appendReasoning?: boolean;
    events?: TraceEvent[];
    eventOffset?: number;
    approvals?: ApprovalItem[];
  };
};

const activeStatus = new Set(["queued", "running", "awaiting_approval"]);
const doneStatus = new Set(["completed", "failed", "cancelled", "interrupted"]);

const maxFiles = 8;
const maxFileBytes = 20 * 1024 * 1024;
const maxTotalBytes = 25 * 1024 * 1024;

function toMessages(rows: ApiMessage[]): ChatMessage[] {
  return [...rows]
    .filter((row) => row.text || row.attachments?.length)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((row) => ({
      _id: row.id,
      text: row.text,
      createdAt: new Date(row.createdAt),
      user: row.role === "user" ? { _id: "me", name: "我" } : { _id: "ai", name: "Doca" },
      attachments: row.attachments?.filter((file) => file.id && file.filename),
    }));
}

function merge(server: ChatMessage[], live: Map<string, string>, traced: Set<string>): ChatMessage[] {
  const extras: ChatMessage[] = [];
  const ids = new Set([...live.keys(), ...traced]);
  for (const jobId of ids) {
    const text = live.get(jobId) ?? "";
    const sample = text.slice(0, Math.min(24, text.length));
    const present = !!sample && server.some((item) => item.user._id === "ai" && item.text.includes(sample));
    const saved = server.some((item) => linkedJob(item._id) === jobId);
    if (!present && !saved && (text || traced.has(jobId))) {
      extras.push({
        _id: `live:${jobId}`,
        text,
        createdAt: new Date(),
        user: { _id: "ai", name: "Doca" },
      });
    }
  }
  return [...extras, ...server];
}

function tracesFrom(jobs: Job[]) {
  const next: Record<string, TraceEvent[]> = {};
  for (const job of jobs) {
    if (job.progress?.events?.length) next[job.id] = job.progress.events;
  }
  return next;
}

function linkedJob(id: string | number) {
  const value = String(id);
  if (value.startsWith("live:")) return value.slice(5);
  if (value.endsWith("-answer")) return value.slice(0, -"-answer".length);
  return "";
}

const prompts = ["帮我列一个提纲", "把这段话写得更清楚", "总结今天要做的事"];
const screenWidth = Dimensions.get("window").width;

export function Conversation({ sessionId, heading }: { sessionId?: string; heading?: string }) {
  const params = useLocalSearchParams<{ id: string; title?: string }>();
  const id = sessionId || (typeof params.id === "string" ? params.id : "");
  const title = heading ?? (typeof params.title === "string" ? params.title : undefined);
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [traces, setTraces] = useState<Record<string, TraceEvent[]>>({});
  const [reasoning, setReasoning] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [deciding, setDeciding] = useState(false);
  const buffers = useRef(new Map<string, string>());
  const reasons = useRef(new Map<string, string>());
  const tracesRef = useRef<Record<string, TraceEvent[]>>({});
  const watch = useRef(new Set<string>());
  const source = useRef<EventSource<"job" | "revoked"> | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const seeded = useRef(false);

  const detail = useQuery({
    queryKey: ["ai-session", session?.origin, id],
    enabled: !!session && !!id,
    staleTime: 0,
    queryFn: () => api<Detail>(`/ai/sessions/${id}`),
  });
  const options = useQuery({
    queryKey: ["ai-options", session?.origin],
    enabled: !!session,
    queryFn: () => api<Options>("/ai/options"),
  });
  const refetch = detail.refetch;
  useEffect(() => {
    if (detail.data?.jobs) setJobs(detail.data.jobs);
  }, [detail.data]);
  const rememberTraces = useCallback((next: Record<string, TraceEvent[]>) => {
    tracesRef.current = next;
    setTraces(next);
  }, []);
  const modelId =
    detail.data?.session.model_id ||
    options.data?.preferences?.default_model ||
    options.data?.defaultModel ||
    options.data?.models[0]?.id ||
    "";

  useLayoutEffect(() => {
    navigation.setOptions({
      title: detail.data?.session.title || title || "对话",
      headerRight: () => <IconButton icon="cog-outline" onPress={() => router.push("/ai/settings")} />,
    });
  }, [detail.data?.session.title, navigation, router, title]);

  const stopStream = useCallback(() => {
    running.current = false;
    const current = source.current;
    source.current = null;
    current?.close();
  }, []);

  const settle = useCallback(async () => {
    const result = await refetch();
    const next = toMessages(result.data?.messages ?? []);
    const stillLive = [...buffers.current.keys()].some((jobId) =>
      result.data?.jobs.some((job) => job.id === jobId && activeStatus.has(job.status)),
    );
    if (stillLive) {
      rememberTraces(tracesFrom(result.data?.jobs ?? []));
      setMessages(merge(next, buffers.current, new Set(Object.keys(tracesRef.current))));
      return;
    }
    const kept = new Map<string, string>();
    for (const [jobId, text] of buffers.current) {
      const sample = text.slice(0, Math.min(24, text.length));
      const present = !!sample && next.some((item) => item.user._id === "ai" && item.text.includes(sample));
      if (text && !present) kept.set(jobId, text);
    }
    buffers.current.clear();
    for (const [jobId, text] of kept) buffers.current.set(jobId, text);
    const nextTraces = tracesFrom(result.data?.jobs ?? []);
    rememberTraces(nextTraces);
    setMessages(merge(next, buffers.current, new Set(Object.keys(nextTraces))));
    setTyping(false);
    stopStream();
  }, [refetch, rememberTraces, stopStream]);

  const startStream = useCallback(() => {
    if (!session || !id) return;
    const previous = source.current;
    source.current = null;
    previous?.close();
    const stream = new EventSource<"job" | "revoked">(
      `${session.origin}/api/v1/ai/sessions/${id}/stream`,
      {
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: "text/event-stream",
        },
        pollingInterval: 0,
      },
    );
    source.current = stream;
    stream.addEventListener("job", (event) => {
      if (!event.data) return;
      const data = JSON.parse(event.data) as JobEvent;
      if (!watch.current.has(data.id)) {
        if (!activeStatus.has(data.status)) return;
        watch.current.add(data.id);
      }
      const patch = data.progress;
      if (patch && typeof patch.reasoning === "string" && patch.reasoning) {
        const previousReason = reasons.current.get(data.id) ?? "";
        reasons.current.set(data.id, patch.appendReasoning ? previousReason + patch.reasoning : patch.reasoning);
        setReasoning(Object.fromEntries(reasons.current));
      }
      if (patch?.events) {
        const previous = tracesRef.current[data.id] ?? [];
        rememberTraces({
          ...tracesRef.current,
          [data.id]: [...previous.slice(0, patch.eventOffset ?? 0), ...patch.events],
        });
      }
      const traced = new Set(Object.keys(tracesRef.current));
      if (patch && typeof patch.text === "string") {
        const previousText = buffers.current.get(data.id) ?? "";
        buffers.current.set(data.id, patch.appendText ? previousText + patch.text : patch.text);
        setMessages((current) =>
          merge(
            current.filter((item) => !String(item._id).startsWith("live:")),
            buffers.current,
            traced,
          ),
        );
        setTyping(!buffers.current.get(data.id));
      } else if (patch?.events || patch?.approvals) {
        setMessages((current) =>
          merge(
            current.filter((item) => !String(item._id).startsWith("live:")),
            buffers.current,
            traced,
          ),
        );
      }
      setJobs((current) => {
        const previous = current.find((job) => job.id === data.id);
        const next: Job = {
          id: data.id,
          status: data.status,
          error: data.error,
          progress: {
            ...previous?.progress,
            approvals: patch && "approvals" in patch ? patch.approvals : previous?.progress?.approvals,
          },
        };
        return [next, ...current.filter((job) => job.id !== data.id)];
      });
      setMessages((current) =>
        current.map((item) => (linkedJob(item._id) === data.id ? { ...item, revision: Date.now() } : item)),
      );
      if (doneStatus.has(data.status)) {
        watch.current.delete(data.id);
        if (data.error) setError(data.error);
        if (watch.current.size === 0) void settle();
      } else if (activeStatus.has(data.status)) {
        running.current = true;
      }
    });
    stream.addEventListener("revoked", () => {
      setError("会话已失效");
      stopStream();
    });
    stream.addEventListener("error", (event) => {
      if (event.type === "error" && (event.xhrStatus === 401 || event.xhrStatus === 403)) {
        setError("无法继续接收回复");
        stopStream();
      }
    });
    stream.addEventListener("close", () => {
      if (source.current !== stream || !alive.current || !running.current) return;
      setTimeout(() => {
        if (alive.current && running.current && source.current === stream) startStream();
      }, 500);
    });
  }, [id, rememberTraces, session, settle, stopStream]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopStream();
    };
  }, [stopStream]);

  useEffect(() => {
    if (!detail.data || seeded.current) return;
    seeded.current = true;
    const liveJobs = detail.data.jobs.filter((job) => activeStatus.has(job.status));
    const nextTraces = tracesFrom(detail.data.jobs);
    for (const job of detail.data.jobs) {
      if (job.progress?.reasoning) reasons.current.set(job.id, job.progress.reasoning);
    }
    for (const job of liveJobs) {
      watch.current.add(job.id);
      if (job.progress?.text) buffers.current.set(job.id, job.progress.text);
    }
    rememberTraces(nextTraces);
    setReasoning(Object.fromEntries(reasons.current));
    setMessages(merge(toMessages(detail.data.messages), buffers.current, new Set(Object.keys(nextTraces))));
    if (liveJobs.length) {
      running.current = true;
      setTyping(liveJobs.some((job) => !buffers.current.get(job.id)));
      startStream();
    }
  }, [detail.data, rememberTraces, startStream]);

  async function fileByteSize(uri: string, reported?: number | null) {
    if (reported && reported > 0) return reported;
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory ? info.size ?? 0 : 0;
  }

  async function addFiles(assets: { uri: string; name: string; mime?: string | null; size?: number | null }[]) {
    if (!session) return;
    const room = maxFiles - pending.length;
    if (room <= 0) {
      setError("每条消息最多 8 个附件");
      return;
    }
    let used = pending.reduce((sum, item) => sum + item.size, 0);
    const accepted: PendingFile[] = [];
    for (const asset of assets.slice(0, room)) {
      const size = await fileByteSize(asset.uri, asset.size);
      if (!size || size > maxFileBytes) {
        setError("请选择非空且不超过 20MB 的文件");
        continue;
      }
      if (used + size > maxTotalBytes) {
        setError("每条消息的附件总大小不能超过 25MB");
        continue;
      }
      used += size;
      accepted.push({
        localId: uuid(),
        name: asset.name.slice(0, 255),
        mime: asset.mime || "application/octet-stream",
        size,
        uri: asset.uri,
        status: "uploading",
      });
    }
    if (assets.length > room) setError("每条消息最多 8 个附件");
    if (!accepted.length) return;
    setPending((current) => [...current, ...accepted]);
    for (const file of accepted) void uploadPending(file);
  }

  async function uploadPending(file: PendingFile) {
    if (!session) return;
    try {
      const result = await FileSystem.uploadAsync(
        `${session.origin}/api/v1/assets?purpose=ai_attachment&filename=${encodeURIComponent(file.name)}`,
        file.uri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${session.token}`,
            "content-type": "application/octet-stream",
          },
        },
      );
      const data = result.body ? JSON.parse(result.body) : {};
      if (result.status >= 400) throw new Error(data.message ?? "上传失败");
      setPending((current) =>
        current.map((item) =>
          item.localId === file.localId
            ? {
                ...item,
                status: "done",
                id: String(data.id),
                name: String(data.filename || item.name),
                mime: String(data.mime || item.mime),
                size: Number(data.size || item.size),
              }
            : item,
        ),
      );
    } catch (reason) {
      setPending((current) =>
        current.map((item) => (item.localId === file.localId ? { ...item, status: "error" } : item)),
      );
      setError(reason instanceof Error ? reason.message : "上传失败");
    }
  }

  async function pickImages() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("需要相册权限才能选择图片");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, maxFiles - pending.length),
    });
    if (picked.canceled) return;
    await addFiles(
      picked.assets.map((asset, index) => ({
        uri: asset.uri,
        name: asset.fileName || `图片-${Date.now()}-${index + 1}.jpg`,
        mime: asset.mimeType,
        size: asset.fileSize,
      })),
    );
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError("需要相机权限才能拍照");
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    await addFiles([
      {
        uri: asset.uri,
        name: asset.fileName || `照片-${Date.now()}.jpg`,
        mime: asset.mimeType || "image/jpeg",
        size: asset.fileSize,
      },
    ]);
  }

  async function pickDocuments() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
    if (picked.canceled) return;
    await addFiles(
      picked.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name || "未命名文件",
        mime: asset.mimeType,
        size: asset.size,
      })),
    );
  }

  function openAttachMenu() {
    Alert.alert("添加附件", undefined, [
      { text: "相册", onPress: () => void pickImages() },
      { text: "拍照", onPress: () => void takePhoto() },
      { text: "文件", onPress: () => void pickDocuments() },
      { text: "取消", style: "cancel" },
    ]);
  }

  async function openAttachment(file: ChatAttachment) {
    if (!session || !FileSystem.cacheDirectory) return;
    try {
      const uri = file.uri
        ? file.uri
        : (
            await FileSystem.downloadAsync(
              `${session.origin}/api/v1/assets/${file.id}/content`,
              FileSystem.cacheDirectory + file.id + "-" + file.filename.replace(/[^\w.\u4e00-\u9fff-]+/g, "_"),
              { headers: { Authorization: `Bearer ${session.token}` } },
            )
          ).uri;
      await Sharing.shareAsync(uri, { mimeType: file.mime, dialogTitle: file.filename });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开附件");
    }
  }

  async function onSend(outgoing: ChatMessage[]) {
    const typed = outgoing[0]?.text.trim() ?? "";
    if (pending.some((item) => item.status === "uploading")) {
      setError("请等待附件上传完成");
      return;
    }
    if (pending.some((item) => item.status === "error")) {
      setError("请移除上传失败的文件");
      return;
    }
    const ready = pending.filter((item) => item.status === "done" && item.id);
    const text = typed || (ready.length ? "请分析这些附件" : "");
    if (!text || !id) return;
    if (!modelId) {
      setError("还没有可用的模型");
      return;
    }
    const attachments: ChatAttachment[] = ready.map((item) => ({
      id: item.id!,
      filename: item.name,
      mime: item.mime,
      size: item.size,
      uri: item.uri,
    }));
    const messageId = uuid();
    watch.current.add(messageId);
    setError("");
    setPending([]);
    setMessages((current) =>
      GiftedChat.append(current, [
        { _id: messageId, text, createdAt: new Date(), user: { _id: "me", name: "我" }, attachments },
      ]),
    );
    setTyping(true);
    running.current = true;
    try {
      await api(`/ai/sessions/${id}/messages`, {
        body: {
          id: messageId,
          text,
          modelId,
          scope: "all",
          references: [],
          attachments: attachments.map((file) => file.id),
          files: [],
          quickNoteIds: [],
          skillIds: [],
          webSearch: !!options.data?.webSearchAvailable,
        },
      });
      startStream();
    } catch (reason) {
      running.current = false;
      setTyping(false);
      setError(reason instanceof Error ? reason.message : "发送失败");
    }
  }

  async function decide(jobId: string, approvalId: string, approved: boolean) {
    if (deciding) return;
    setDeciding(true);
    setError("");
    try {
      await api(`/ai/jobs/${jobId}/approval`, { body: { approvalId, approved } });
      setJobs((current) =>
        current.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: approved ? "queued" : "cancelled",
                progress: {
                  ...job.progress,
                  approvals: job.progress?.approvals?.map((item) =>
                    item.id === approvalId ? { ...item, state: approved ? "approved" : "rejected" } : item,
                  ),
                },
              }
            : job,
        ),
      );
      running.current = approved;
      startStream();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审批失败");
    } finally {
      setDeciding(false);
    }
  }

  if (detail.isLoading) {
    return <Text style={styles.status}>正在加载…</Text>;
  }
  if (detail.isError) {
    return <Text style={styles.status}>{detail.error instanceof Error ? detail.error.message : "加载失败"}</Text>;
  }

  return (
    <View style={styles.page}>
      <GiftedChat
        messages={messages}
        onSend={(items) => void onSend(items)}
        user={{ _id: "me", name: "我" }}
        placeholder="发消息…"
        alwaysShowSend
        isTyping={false}
        bottomOffset={insets.bottom}
        renderAvatar={null}
        renderTime={() => null}
        minComposerHeight={44}
        maxComposerHeight={120}
        messagesContainerStyle={{ backgroundColor: colors.bg }}
        onLongPress={() => undefined}
        textInputProps={{ placeholderTextColor: colors.muted }}
        listViewProps={{ keyboardShouldPersistTaps: "handled", removeClippedSubviews: false }}
        renderBubble={(props) => {
          const text = props.currentMessage?.text ?? "";
          const jobId = linkedJob(props.currentMessage?._id ?? "");
          const events = jobId ? traces[jobId] ?? [] : [];
          const operations = jobId
            ? (detail.data?.operations ?? []).filter((item) => item.job_id === jobId)
            : [];
          if (props.position === "left") {
            return (
              <View style={styles.assistant} collapsable={false}>
                <Text style={styles.assistantName}>Doca</Text>
                <AiTrace
                  router={router}
                  events={events}
                  reasoning={jobId ? reasoning[jobId] : undefined}
                  answer={text}
                />
                <AnswerBody text={text} events={events} operations={operations} router={router} />
              </View>
            );
          }
          return (
            <View style={styles.userBubble}>
              <MessageFiles
                files={(props.currentMessage as ChatMessage | undefined)?.attachments}
                session={session}
                onOpen={(file) => void openAttachment(file)}
              />
              {text ? <Text style={styles.userText}>{text}</Text> : null}
            </View>
          );
        }}
        renderMessageText={() => null}
        renderChatEmpty={() => (
          <View style={styles.empty}>
            <Text style={styles.hello}>你好</Text>
            <Text style={styles.emptyText}>我可以帮你写文档、整理邮件、回答问题。</Text>
          </View>
        )}
        renderFooter={() =>
          typing ? <Text style={styles.thinking}>正在思考…</Text> : null
        }
        renderChatFooter={() => (
          <View>
            <ApprovalCards
              busy={deciding}
              items={jobs.flatMap((job) =>
                job.status === "awaiting_approval"
                  ? (job.progress?.approvals ?? [])
                      .filter((approval) => approval.state === "pending")
                      .map((approval) => ({ jobId: job.id, approval }))
                  : [],
              )}
              onDecide={(jobId, approvalId, approved) => void decide(jobId, approvalId, approved)}
            />
            {pending.length ? (
              <ScrollView
                horizontal
                style={styles.pendingBar}
                contentContainerStyle={styles.pendingRow}
                showsHorizontalScrollIndicator={false}
              >
                {pending.map((file) => (
                  <View key={file.localId} style={styles.pendingChip}>
                    {file.mime.startsWith("image/") ? (
                      <Image source={{ uri: file.uri }} style={styles.pendingThumb} />
                    ) : null}
                    <View style={styles.pendingCopy}>
                      <Text numberOfLines={1} style={styles.pendingName}>{file.name}</Text>
                      <Text style={styles.pendingMeta}>
                        {file.status === "uploading" ? "上传中" : file.status === "error" ? "上传失败" : fileSize(file.size)}
                      </Text>
                    </View>
                    <Pressable hitSlop={8} onPress={() => setPending((current) => current.filter((item) => item.localId !== file.localId))}>
                      <Text style={styles.pendingRemove}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            {messages.length === 0 ? (
              <View style={styles.prompts}>
                {prompts.map((prompt) => (
                  <Pressable
                    key={prompt}
                    style={styles.prompt}
                    onPress={() =>
                      void onSend([
                        { _id: uuid(), text: prompt, createdAt: new Date(), user: { _id: "me", name: "我" } },
                      ])
                    }
                  >
                    <Text style={styles.promptText}>{prompt}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        )}
        renderInputToolbar={(props) => (
          <InputToolbar
            {...props}
            containerStyle={styles.toolbar}
            primaryStyle={styles.toolbarRow}
          />
        )}
        renderComposer={(props) => (
          <Composer
            {...props}
            textInputStyle={styles.composer}
            placeholderTextColor={colors.muted}
          />
        )}
        renderActions={() => (
          <Pressable accessibilityLabel="添加附件" style={styles.attach} onPress={openAttachMenu}>
            <Paperclip color={colors.secondary} size={20} />
          </Pressable>
        )}
        renderSend={(props) => {
          const typed = props.text?.trim() ?? "";
          const ready = pending.some((item) => item.status === "done");
          const uploading = pending.some((item) => item.status === "uploading");
          const failed = pending.some((item) => item.status === "error");
          const enabled = (!!typed || ready) && !uploading && !failed;
          return (
            <Pressable
              accessibilityLabel="发送"
              style={styles.sendWrap}
              disabled={!enabled}
              onPress={() => {
                if (pending.some((item) => item.status === "uploading")) {
                  setError("请等待附件上传完成");
                  return;
                }
                if (pending.some((item) => item.status === "error")) {
                  setError("请移除上传失败的文件");
                  return;
                }
                if (!typed && !pending.some((item) => item.status === "done")) return;
                props.onSend?.({ text: typed || "请分析这些附件" }, true);
              }}
            >
              <View style={[styles.send, !enabled && styles.sendIdle]}>
                <ArrowUp color="#fff" size={18} strokeWidth={2.4} />
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function MessageFiles({
  files,
  session,
  onOpen,
}: {
  files?: ChatAttachment[];
  session: { origin: string; token: string } | null;
  onOpen: (file: ChatAttachment) => void;
}) {
  if (!files?.length) return null;
  return (
    <View style={styles.fileList}>
      {files.map((file) =>
        file.mime.startsWith("image/") ? (
          <Pressable key={file.id} onPress={() => onOpen(file)}>
            <Image
              source={
                file.uri
                  ? { uri: file.uri }
                  : session
                    ? {
                        uri: `${session.origin}/api/v1/assets/${file.id}/content`,
                        headers: { Authorization: `Bearer ${session.token}` },
                      }
                    : { uri: "" }
              }
              style={styles.userImage}
              contentFit="cover"
            />
          </Pressable>
        ) : (
          <Pressable key={file.id} style={styles.fileChip} onPress={() => onOpen(file)}>
            <Text numberOfLines={1} style={styles.fileName}>{file.filename}</Text>
            <Text style={styles.fileMeta}>{fileSize(file.size)}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  status: { margin: 24, color: colors.muted },
  assistant: { width: screenWidth - 32, paddingHorizontal: 4, paddingVertical: 10 },
  assistantName: { color: colors.accent, fontSize: 13, fontWeight: "600", marginBottom: 6 },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: screenWidth * 0.78,
    marginRight: 12,
    marginVertical: 6,
    backgroundColor: colors.selected,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: { color: colors.ink, fontSize: 16, lineHeight: 22 },
  fileList: { gap: 8, marginBottom: 8 },
  userImage: { width: 180, height: 120, borderRadius: 12, backgroundColor: "#fff" },
  fileChip: { maxWidth: 220, backgroundColor: "#fff", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  fileName: { color: colors.ink, fontSize: 14 },
  fileMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  pendingBar: { height: 52, flexGrow: 0, marginBottom: 8 },
  pendingRow: { alignItems: "center", paddingHorizontal: 16, gap: 8 },
  pendingChip: {
    height: 44,
    maxWidth: 220,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingLeft: 8,
    paddingRight: 10,
  },
  pendingThumb: { width: 28, height: 28, borderRadius: 6 },
  pendingCopy: { flexShrink: 1 },
  pendingName: { color: colors.ink, fontSize: 13, maxWidth: 120 },
  pendingMeta: { color: colors.muted, fontSize: 11, marginTop: 1 },
  pendingRemove: { color: colors.secondary, fontSize: 18, lineHeight: 20 },
  attach: { width: 36, height: 36, marginBottom: 4, marginRight: 4, alignItems: "center", justifyContent: "center" },
  empty: { transform: [{ scaleY: -1 }], paddingHorizontal: 28, paddingTop: 72 },
  hello: { fontSize: 32, fontWeight: "600", color: colors.ink },
  emptyText: { marginTop: 8, fontSize: 16, lineHeight: 24, color: colors.secondary },
  thinking: { marginLeft: 16, marginBottom: 8, color: colors.muted, fontSize: 13 },
  prompts: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  prompt: {
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  promptText: { color: colors.ink, fontSize: 14 },
  error: { color: colors.danger, paddingHorizontal: 16, paddingBottom: 8 },
  toolbar: {
    backgroundColor: colors.bg,
    borderTopWidth: 0,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
  },
  toolbarRow: { alignItems: "flex-end" },
  composer: {
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    marginLeft: 0,
    marginRight: 8,
    fontSize: 16,
    lineHeight: 22,
    color: colors.ink,
  },
  sendWrap: { justifyContent: "center", marginBottom: 4, marginRight: 2 },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendIdle: { backgroundColor: "#c9cdd4" },
});

export default function ConversationRoute() {
  return <Conversation />;
}
