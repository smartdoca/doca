import { useEffect, useRef } from "react";
import { api } from "@web/shared/api.js";
import {
  PENDING_QUEUE_EVENT,
  loadPendingQueue,
  loadPendingQueues,
  pendingSessionIds,
  sessionHasActiveJob,
  writePendingQueue,
  type PendingSendItem,
} from "@web/features/ai/ai-session-ux.js";

type SessionSnapshot = {
  session: { model_id: string | null };
  jobs: { status: string }[];
};

export async function sendPendingItem(
  sessionId: string,
  item: PendingSendItem,
  fallbackModel?: string | null,
) {
  const modelId = item.modelId || fallbackModel;
  if (!modelId) throw new Error("没有可用的模型");
  const id = crypto.randomUUID();
  await api(`/ai/sessions/${sessionId}/messages`, "POST", {
    id,
    text: item.text,
    attachments: item.attachments.map((file) => file.id),
    ...(item.files?.length ? { files: item.files } : {}),
    modelId,
    scope: item.scope === "all" ? "all" : "document",
    currentResourceId: item.currentResourceId,
    currentFolder: item.currentFolder,
    references: item.references,
    skillIds: item.skillIds ?? [],
    webSearch: item.webSearch !== false,
    skipApprovals: item.skipApprovals,
  });
  return id;
}

export function usePendingSendRunner(
  userId: string | undefined,
  flush?: () => Promise<void>,
) {
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    const locks = new Set<string>();
    const cooldown = new Map<string, number>();
    const blocked = new Map<string, number>();
    const sources = new Map<string, EventSource>();

    const drain = async (sessionId: string, fromComplete = false) => {
      if (stopped || locks.has(sessionId)) return;
      if (!fromComplete && Date.now() < (cooldown.get(sessionId) ?? 0)) return;
      if (Date.now() < (blocked.get(sessionId) ?? 0)) return;
      const item = loadPendingQueue(userId, sessionId)[0];
      if (!item) return;
      locks.add(sessionId);
      const work = async () => {
        const current = loadPendingQueue(userId, sessionId)[0];
        if (!current || current.id !== item.id) return;
        const conv = await api<SessionSnapshot>(`/ai/sessions/${sessionId}`);
        if (sessionHasActiveJob(conv.jobs)) {
          cooldown.delete(sessionId);
          return;
        }
        await flushRef.current?.();
        const jobId = await sendPendingItem(
          sessionId,
          current,
          conv.session.model_id,
        );
        const stillQueued = loadPendingQueue(userId, sessionId).some(
          (entry) => entry.id === current.id,
        );
        if (!stillQueued) {
          await api(`/ai/jobs/${jobId}/cancel`, "POST");
          return;
        }
        const remaining = loadPendingQueue(userId, sessionId).filter(
          (entry) => entry.id !== current.id,
        );
        writePendingQueue(userId, sessionId, remaining);
        cooldown.set(sessionId, Date.now() + 2000);
        blocked.delete(sessionId);
      };
      try {
        if (typeof navigator !== "undefined" && navigator.locks?.request) {
          await navigator.locks.request(
            `doca-ai-pending:${userId}:${sessionId}`,
            work,
          );
        } else {
          await work();
        }
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        blocked.set(
          sessionId,
          Date.now() + (status === 404 || status === 403 ? 60_000 : 8_000),
        );
      } finally {
        locks.delete(sessionId);
      }
    };

    const watch = (sessionId: string) => {
      if (sources.has(sessionId)) return;
      const source = new EventSource(`/api/v1/ai/sessions/${sessionId}/stream`);
      source.addEventListener("job", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as {
          status?: string;
        };
        if (
          data.status &&
          ["queued", "running", "awaiting_approval"].includes(data.status)
        ) {
          cooldown.delete(sessionId);
          return;
        }
        void drain(sessionId, true);
      });
      source.addEventListener("revoked", () => {
        source.close();
        sources.delete(sessionId);
      });
      sources.set(sessionId, source);
    };

    const sync = () => {
      const ids = new Set(pendingSessionIds(loadPendingQueues(userId)));
      for (const [sessionId, source] of sources) {
        if (ids.has(sessionId)) continue;
        source.close();
        sources.delete(sessionId);
      }
      for (const sessionId of ids) {
        watch(sessionId);
        void drain(sessionId);
      }
    };

    sync();
    const timer = setInterval(sync, 2000);
    window.addEventListener(PENDING_QUEUE_EVENT, sync);
    window.addEventListener("storage", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(PENDING_QUEUE_EVENT, sync);
      window.removeEventListener("storage", sync);
      document.removeEventListener("visibilitychange", sync);
      for (const source of sources.values()) source.close();
    };
  }, [userId]);
}
