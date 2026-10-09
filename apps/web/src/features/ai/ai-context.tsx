import { useI18n } from "@web/shared/i18n.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { AtSign } from "lucide-react";
import { api, type FileItem, type Resource } from "@web/shared/api.js";
import type { AIReference } from "@core/workflows/ai-documents.js";
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
export type AIFileContext = {
  type: "system" | "folder" | "document";
  id: string;
  name: string;
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
  add: (anchor?: unknown) => void;
  addDocument: (resource: Resource) => void;
  fileContext: AIFileContext | null;
  setFileContext: Dispatch<SetStateAction<AIFileContext | null>>;
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
    [fileContext, setFileContext] = useState<AIFileContext | null>(null),
    [composerDraft, setComposerDraftState] = useState<string | null>(null),
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
    if (
      next &&
      !open &&
      !sessionFromHash(hash) &&
      (resource?.id ||
        (sidePanelSurface(hash) &&
          fileContext?.type !== "system" &&
          fileContext?.id))
    ) {
      setSessionId(null);
      resumeAttempt.current = null;
    }
    setOpenState(next);
    const surface = sidePanelSurface(hash);
    if (userId && surface)
      writeSidePanel(userId, surface, { open: next, sessionId });
  };
  useEffect(() => {
    if (!userId) return;
    const surface = sidePanelSurface(hash);
    if (surface) writeSidePanel(userId, surface, { open, sessionId });
  }, [userId, hash, open, sessionId]);
  const seenOperations = useRef(new Set<string>());
  const activeResourceId =
    resource?.id ??
    (sidePanelSurface(hash) && fileContext?.type !== "system"
      ? fileContext?.id
      : undefined);
  const previous = useRef<string | undefined>(undefined);
  const sessionSeen = useRef<string | null>(null);
  const setComposerDraft = (value: string | null) => {
    // An explicit handoff must not be erased by restoring a different chat.
    if (value !== null && userId && activeResourceId)
      resumeAttempt.current = `${userId}:${activeResourceId}`;
    setComposerDraftState(value);
  };
  useEffect(() => {
    setReferences([]);
    setComposerDraftState(null);
    setPendingReference(null);
    setPendingStoredFiles([]);
    seenOperations.current.clear();
    resumeAttempt.current = null;
  }, [userId]);
  useEffect(() => {
    const carried = sessionFromHash(hash);
    if (carried) {
      if (sessionSeen.current !== carried && !sidePanelSurface(hash))
        setOpen(true);
      sessionSeen.current = carried;
      setSessionId(carried);
    } else if (activeResourceId && activeResourceId !== previous.current) {
      setSessionId(null);
      setReferences([]);
      resumeAttempt.current = null;
    }
    previous.current = activeResourceId;
  }, [hash, activeResourceId]);
  useEffect(() => {
    if (!open || !userId || !activeResourceId || sessionId || composerDraft !== null) return;
    const key = `${userId}:${activeResourceId}`;
    if (resumeAttempt.current === key) return;
    resumeAttempt.current = key;
    let active = true;
    setRestoring(true);
    void api<{ id: string; restricted?: boolean }[]>(
      `/ai/sessions?resourceId=${encodeURIComponent(activeResourceId)}`,
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
  }, [open, userId, activeResourceId, sessionId, composerDraft]);
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
        add,
        addDocument: (document) => {
          if (!userId || (document.kind !== "document" && !document.knowledgeBook)) return;
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
            !route.startsWith("/knowledge-books/") &&
            route !== "/files" &&
            !route.startsWith("/shared-files/")
          )
            location.hash = `/ai${sessionId ? `?session=${sessionId}` : ""}`;
        },
        fileContext,
        setFileContext,
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
