import { useI18n } from "@web/shared/i18n.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AtSign } from "lucide-react";
import { api, type FileItem, type Resource } from "@web/shared/api.js";
import type { AIReference } from "@core/workflows/ai-documents.js";
import type { NoteContent } from "@core/shared/quick-notes.js";
import { usePendingSendRunner } from "@web/features/ai/ai-pending-runner.js";
import {
  keepsAssistantSession,
  withSessionHash,
} from "@web/features/ai/ai-folder-mentions.js";
import {
  readSidePanel,
  sessionFromHash,
  sidePanelSurface,
  writeSidePanel,
} from "@web/features/ai/ai-side-open.js";

type Bridge = {
  capture: () => unknown;
  describe?: (anchor: any) => string;
  reveal?: (anchor: any) => void;
  ready: () => boolean;
  flush?: () => void | Promise<void>;
};
export type QuickNoteReference = {
  id: string;
  label: string;
  content: NoteContent;
  attachments: { id: string; filename: string; mime: string; size: number }[];
  createdAt: string;
};
type AIContextValue = {
  userId?: string;
  resource?: Resource;
  open: boolean;
  restoring: boolean;
  setOpen: (v: boolean) => void;
  sessionId: string | null;
  setSessionId: (v: string | null) => void;
  composerDraft: string | null;
  setComposerDraft: (v: string | null) => void;
  references: AIReference[];
  setReferences: (v: AIReference[]) => void;
  noteReferences: QuickNoteReference[];
  setNoteReferences: (v: QuickNoteReference[]) => void;
  addNotes: (notes: QuickNoteReference[]) => void;
  add: (anchor?: unknown) => void;
  addDocument: (resource: Resource) => void;
  pendingStoredFiles: FileItem[];
  queueStoredFiles: (files: FileItem[]) => void;
  clearPendingStoredFiles: () => void;
  beforeSend: () => Promise<void>;
  reveal: (ref: AIReference) => void;
  bridges: Map<string, Bridge>;
  error: string;
  setError: (v: string) => void;
  resourcesChanged: (operationIds: string[]) => void;
};
const AIContext = createContext<AIContextValue | null>(null);
export const useAI = () => useContext(AIContext);
export function AIProvider({
  userId,
  resource,
  hash,
  onResourcesChanged,
  children,
}: {
  userId?: string;
  resource?: Resource;
  hash: string;
  onResourcesChanged?: () => void;
  children: ReactNode;
}) {
  const [open, setOpenState] = useState(() => {
    const surface = sidePanelSurface(hash);
    return !!(userId && surface && readSidePanel(userId, surface).open);
  }),
    [openUserId, setOpenUserId] = useState(userId),
    [sessionId, setSessionId] = useState<string | null>(() => {
      const carried = sessionFromHash(hash);
      const surface = sidePanelSurface(hash);
      if (carried) return carried;
      if (userId && surface) return readSidePanel(userId, surface).sessionId;
      return null;
    }),
    [references, setReferences] = useState<AIReference[]>([]),
    [noteReferences, setNoteReferences] = useState<QuickNoteReference[]>([]),
    [composerDraft, setComposerDraft] = useState<string | null>(null),
    [error, setError] = useState("");
  const [pendingStoredFiles, setPendingStoredFiles] = useState<FileItem[]>([]);
  const [restoring, setRestoring] = useState(false);
  const resumeAttempt = useRef<string | null>(null);
  const bridges = useRef(new Map<string, Bridge>()).current;
  const [pendingReference, setPendingReference] = useState<AIReference | null>(
    null,
  );
  useEffect(() => {
    if (!pendingReference) return;
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      const bridge = bridges.get(pendingReference.resourceId);
      if (bridge?.ready()) {
        try {
          bridge.reveal?.(pendingReference.anchor);
        } catch (e) {
          setError((e as Error).message);
        }
        setPendingReference(null);
      } else if (Date.now() > deadline) {
        setError("暂时无法定位引用，请等待文档加载完成后重试");
        setPendingReference(null);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [pendingReference, bridges]);
  if (userId !== openUserId) {
    setOpenUserId(userId);
    const surface = sidePanelSurface(hash);
    const carried = sessionFromHash(hash);
    if (!userId) {
      setOpenState(false);
      setSessionId(null);
    } else if (surface) {
      const memory = readSidePanel(userId, surface);
      setOpenState(memory.open);
      setSessionId(carried ?? memory.sessionId);
    } else if (carried) {
      setSessionId(carried);
    }
  }
  const setOpen = (next: boolean) => {
    setOpenState(next);
    const surface = sidePanelSurface(hash);
    if (userId && surface) writeSidePanel(userId, surface, { open: next, sessionId });
  };
  useEffect(() => {
    if (!userId) return;
    const surface = sidePanelSurface(hash);
    if (surface) writeSidePanel(userId, surface, { open, sessionId });
  }, [userId, hash, open, sessionId]);
  const seenOperations = useRef(new Set<string>());
  const previous = useRef<string | undefined>(undefined);
  const sessionSeen = useRef<string | null>(null);
  useEffect(() => {
    setReferences([]);
    setNoteReferences([]);
    setPendingReference(null);
    setPendingStoredFiles([]);
    seenOperations.current.clear();
    resumeAttempt.current = null;
  }, [userId]);
  useEffect(() => {
    const carried = sessionFromHash(hash);
    if (carried) {
      if (sessionSeen.current !== carried && !sidePanelSurface(hash)) setOpen(true);
      sessionSeen.current = carried;
      setSessionId(carried);
    } else if (resource?.id && resource.id !== previous.current) {
      setSessionId(null);
      setReferences([]);
      setNoteReferences([]);
      resumeAttempt.current = null;
    }
    previous.current = resource?.id;
  }, [hash, resource?.id]);
  useEffect(() => {
    if (!open || !userId || !resource?.id || sessionId) return;
    const key = `${userId}:${resource.id}`;
    if (resumeAttempt.current === key) return;
    resumeAttempt.current = key;
    let active = true;
    setRestoring(true);
    void api<{ id: string; restricted?: boolean }[]>(
      `/ai/sessions?resourceId=${encodeURIComponent(resource.id)}`,
    )
      .then((rows) => {
        const last = rows.find((row) => !row.restricted);
        if (active && last) selectSession(last.id);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
      setRestoring(false);
    };
  }, [open, userId, resource?.id, sessionId]);
  const add = (provided?: unknown) => {
    if (!userId || !resource) return;
    try {
      const anchor = provided ?? bridges.get(resource.id)?.capture();
      if (!anchor) throw Error("请先选择要引用的内容");
      setReferences((prev) =>
        [
          ...prev,
          {
            resourceId: resource.id,
            label: resource.title,
            format: resource.format,
            description: String(
              (anchor as any).quote ||
                bridges.get(resource.id)?.describe?.(anchor) ||
                "选中内容",
            ).slice(0, 300),
            anchor,
          },
        ].slice(-20),
      );
      setOpen(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    }
  };
  const beforeSend = async () => {
    const relevant = [
      ...new Set(
        [resource?.id, ...references.map((r) => r.resourceId)].filter(Boolean),
      ),
    ];
    for (const id of relevant) {
      const bridge = bridges.get(id!);
      if (!bridge) continue;
      await bridge.flush?.();
      const deadline = Date.now() + 10000;
      while (!bridge.ready()) {
        if (Date.now() > deadline)
          throw Error("文档尚未完成同步，请连接后再发送");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  usePendingSendRunner(userId, async () => {
    await Promise.all(
      [...bridges.values()].map(async (bridge) => {
        try {
          await bridge.flush?.();
        } catch {
          /* Snapshotted queue items can still send. */
        }
      }),
    );
  });
  const reveal = (ref: AIReference) => {
    const b = bridges.get(ref.resourceId);
    if (b?.ready() && ref.anchor) {
      try {
        b.reveal?.(ref.anchor);
      } catch (e) {
        setError((e as Error).message);
      }
    } else {
      if (ref.anchor) setPendingReference(ref);
      location.hash = `/r/${ref.resourceId}${sessionId ? `?session=${sessionId}` : ""}`;
    }
  };
  const selectSession = (id: string | null) => {
    if (userId && resource) resumeAttempt.current = `${userId}:${resource.id}`;
    setSessionId(id);
    sessionSeen.current = id;
    const route = location.hash.replace(/^#/, "");
    if (!keepsAssistantSession(route)) return;
    const next = withSessionHash(location.hash, id);
    if (location.hash !== `#${next}`) location.hash = next;
  };
  return (
    <AIContext.Provider
      value={{
        userId,
        resource,
        open,
        restoring,
        setOpen,
        sessionId,
        setSessionId: selectSession,
        composerDraft,
        setComposerDraft,
        references,
        setReferences,
        noteReferences,
        setNoteReferences,
        addNotes: (notes) => {
          if (!userId || !notes.length) return;
          setNoteReferences(notes.slice(-20));
          // 整理必须开启全新会话：在 /notes 路由上 selectSession 只清空 sessionId，不动 hash。
          selectSession(null);
          setComposerDraft(
            "请阅读我引用的随手记，调用文档工具创建一份结构清晰的在线文档（标题自拟，必须是富文本格式，不是 Markdown）：合并重复内容，按主题组织，保留事实、时间和待办；缺失或矛盾处标为待确认，不要编造。不要在对话里直接输出文档正文或 Markdown，创建完成后告诉我文档标题即可。",
          );
          location.hash = "/ai";
        },
        add,
        addDocument: (document) => {
          if (!userId || document.kind !== "document") return;
          setReferences((prev) =>
            [
              ...prev.filter((r) => r.resourceId !== document.id || !!r.anchor),
              {
                resourceId: document.id,
                label: document.title,
                format: document.format,
              },
            ].slice(-20),
          );
          setOpen(true);
          const route = hash.replace(/^#/, "").split("?")[0] ?? "";
          if (
            !resource &&
            route !== "/files" &&
            !route.startsWith("/shared-files/")
          )
            location.hash = `/ai${sessionId ? `?session=${sessionId}` : ""}`;
        },
        pendingStoredFiles,
        queueStoredFiles: (files) => {
          if (!userId || !files.length) return;
          setPendingStoredFiles((prev) => {
            const seen = new Set(prev.map((file) => file.id));
            const next = [...prev];
            for (const file of files) {
              if (seen.has(file.id)) continue;
              next.push(file);
              seen.add(file.id);
            }
            return next.slice(0, 8);
          });
          setOpen(true);
        },
        clearPendingStoredFiles: () => setPendingStoredFiles([]),
        beforeSend,
        reveal,
        bridges,
        error,
        setError,
        resourcesChanged: (ids) => {
          const fresh = ids.filter((id) => !seenOperations.current.has(id));
          if (!fresh.length) return;
          fresh.forEach((id) => seenOperations.current.add(id));
          onResourcesChanged?.();
        },
      }}
    >
      {children}
    </AIContext.Provider>
  );
}
export function useAIBridge(id: string, bridge: Bridge) {
  const ai = useAI(),
    current = useRef(bridge);
  current.current = bridge;
  useEffect(() => {
    if (!ai) return;
    const stable: Bridge = {
      capture: () => current.current.capture(),
      describe: (a) => current.current.describe?.(a) ?? "选中内容",
      reveal: (a) => current.current.reveal?.(a),
      ready: () => current.current.ready(),
      flush: () => current.current.flush?.(),
    };
    ai.bridges.set(id, stable);
    return () => {
      if (ai.bridges.get(id) === stable) ai.bridges.delete(id);
    };
  }, [ai?.bridges, id]);
  return ai;
}
export function AIReferenceButton({ anchor }: { anchor?: unknown }) {
const { t } = useI18n();

  const ai = useAI();
  if (!ai?.userId) return null;
  return (
    <button
      type="button"
      className="ai-reference-button"
      title={t("doc.cite")}
      aria-label={t("doc.cite")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => ai.add(anchor)}
    >
      <AtSign size={17} />
    </button>
  );
}
