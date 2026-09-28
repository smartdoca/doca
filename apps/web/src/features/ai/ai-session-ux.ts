import type { AIReference } from "@core/workflows/ai-documents.js";
import type { QuickNoteReference } from "@web/features/ai/ai-context.js";

export const INITIAL_RENDER_QUESTIONS = 8;
export const RENDER_EXPAND_QUESTIONS = 8;
export const DRAFT_QUEUE_KEY = "draft";
const QUEUE_PREFIX = "doca.ai.pending-send";
const memoryStore = new Map<string, string>();

function readStore(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

function writeStore(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (value == null) memoryStore.delete(key);
    else memoryStore.set(key, value);
  }
}

export type ChatFileSnapshot = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sourceFileId?: string;
  sourceName?: string;
};

export type ExplorerTarget = {
  kind: "file" | "folder";
  id: string;
  name?: string;
};

export type FileContextSnapshot = {
  type: "system" | "folder" | "document";
  id: string;
};

export const PENDING_QUEUE_EVENT = "doca-ai-pending-queue";
export const ACTIVE_JOB_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
] as const;

export type PendingSendItem = {
  id: string;
  text: string;
  attachments: ChatFileSnapshot[];
  files?: ExplorerTarget[];
  references: AIReference[];
  notes: QuickNoteReference[];
  createdAt: string;
  modelId?: string;
  scope?: "document" | "all";
  currentResourceId?: string;
  currentFolder?: FileContextSnapshot;
  skillIds?: string[];
  webSearch?: boolean;
  skipApprovals?: {
    create?: boolean;
    delete?: boolean;
    modify?: boolean;
  };
};

export type UserQuestion = {
  id: string;
  text: string;
  createdAt?: string;
};

export function previewQuestion(text: string, max = 48) {
  const cleaned = text.replace(/@【[^】]*】/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned || "（无文字）";
  return `${cleaned.slice(0, max)}...`;
}

export function userQuestions(
  messages: { id: string; role: string; text: string; createdAt?: string }[],
): UserQuestion[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => ({
      id: m.id,
      text: previewQuestion(m.text),
      createdAt: m.createdAt,
    }));
}

export function windowedMessages<M extends { id: string; role: string }>(
  messages: M[],
  latestQuestionCount: number,
  includeId?: string | null,
): { messages: M[]; startIndex: number } {
  const userIndexes = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (!userIndexes.length || latestQuestionCount >= userIndexes.length)
    return { messages, startIndex: 0 };
  let firstUser = Math.max(0, userIndexes.length - Math.max(1, latestQuestionCount));
  if (includeId) {
    const pos = userIndexes.findIndex((i) => messages[i]!.id === includeId);
    if (pos !== -1 && pos < firstUser) firstUser = pos;
  }
  const startIndex = userIndexes[firstUser]!;
  return { messages: messages.slice(startIndex), startIndex };
}

export function questionsToReveal(
  questions: UserQuestion[],
  targetId: string,
  current: number,
) {
  const pos = questions.findIndex((q) => q.id === targetId);
  if (pos === -1) return current;
  return Math.max(current, questions.length - pos);
}

export function activeQuestionFromPositions(
  items: { id: string; top: number }[],
  markerY: number,
  atLatest: boolean,
) {
  if (!items.length) return null;
  if (atLatest) return items[items.length - 1]!.id;
  let current: string | null = null;
  for (const item of items) {
    if (item.top <= markerY) current = item.id;
  }
  return current ?? items[0]!.id;
}

export function formatContextTokens(
  tokens?: number | null,
  format?: (count: string) => string,
  locale = "en",
) {
  if (!Number.isFinite(tokens) || !tokens || tokens <= 0) return null;
  const count = Math.round(tokens).toLocaleString(
    locale === "zh" ? "zh-CN" : "en",
  );
  return format ? format(count) : count;
}

function isFile(value: unknown): value is ChatFileSnapshot {
  if (!value || typeof value !== "object") return false;
  const file = value as ChatFileSnapshot;
  return (
    typeof file.id === "string" &&
    typeof file.filename === "string" &&
    typeof file.mime === "string" &&
    typeof file.size === "number"
  );
}

function isReference(value: unknown): value is AIReference {
  return !!value && typeof value === "object" && typeof (value as AIReference).resourceId === "string";
}

function isNote(value: unknown): value is QuickNoteReference {
  if (!value || typeof value !== "object") return false;
  const note = value as QuickNoteReference;
  return (
    typeof note.id === "string" &&
    typeof note.label === "string" &&
    !!note.content &&
    typeof note.content === "object" &&
    Array.isArray(note.attachments) &&
    typeof note.createdAt === "string"
  );
}

function isPendingItem(value: unknown): value is PendingSendItem {
  if (!value || typeof value !== "object") return false;
  const item = value as PendingSendItem;
  return (
    typeof item.id === "string" &&
    typeof item.text === "string" &&
    typeof item.createdAt === "string" &&
    Array.isArray(item.attachments) &&
    item.attachments.every(isFile) &&
    (!item.files ||
      (Array.isArray(item.files) &&
        item.files.every(
          (file) =>
            !!file &&
            (file.kind === "file" || file.kind === "folder") &&
            typeof file.id === "string",
        ))) &&
    Array.isArray(item.references) &&
    item.references.every(isReference) &&
    Array.isArray(item.notes) &&
    item.notes.every(isNote)
  );
}

export function queueStorageKey(userId: string) {
  return `${QUEUE_PREFIX}.${userId}`;
}

export function loadPendingQueues(userId: string): Record<string, PendingSendItem[]> {
  try {
    const raw = JSON.parse(readStore(queueStorageKey(userId)) ?? "null");
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).flatMap(([key, items]) =>
        Array.isArray(items) ? [[key, items.filter(isPendingItem)]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function loadPendingQueue(userId: string, sessionKey: string) {
  return loadPendingQueues(userId)[sessionKey] ?? [];
}

export function savePendingQueue(
  userId: string,
  sessionKey: string,
  items: PendingSendItem[],
) {
  try {
    const all = loadPendingQueues(userId);
    if (items.length) all[sessionKey] = items;
    else delete all[sessionKey];
    const key = queueStorageKey(userId);
    if (Object.keys(all).length) writeStore(key, JSON.stringify(all));
    else writeStore(key, null);
  } catch {
    /* Private browsing or quota. */
  }
}

export function notifyPendingQueue() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PENDING_QUEUE_EVENT));
}

export function writePendingQueue(
  userId: string,
  sessionKey: string,
  items: PendingSendItem[],
) {
  savePendingQueue(userId, sessionKey, items);
  notifyPendingQueue();
}

export function adoptDraftQueue(userId: string, sessionId: string) {
  const all = loadPendingQueues(userId);
  const draft = all[DRAFT_QUEUE_KEY] ?? [];
  if (!draft.length) return loadPendingQueue(userId, sessionId);
  const merged = [...draft, ...(all[sessionId] ?? [])];
  savePendingQueue(userId, sessionId, merged);
  savePendingQueue(userId, DRAFT_QUEUE_KEY, []);
  notifyPendingQueue();
  return merged;
}

export function sessionHasActiveJob(jobs: { status: string }[]) {
  return jobs.some((job) =>
    (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status),
  );
}

export function pendingSessionIds(queues: Record<string, PendingSendItem[]>) {
  return Object.entries(queues)
    .filter(([key, items]) => key !== DRAFT_QUEUE_KEY && items.length > 0)
    .map(([key]) => key);
}

export function promotePendingItem(items: PendingSendItem[], id: string) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return items;
  return [item, ...items.filter((entry) => entry.id !== id)];
}
