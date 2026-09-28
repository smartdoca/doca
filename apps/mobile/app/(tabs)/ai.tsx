import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Conversation } from "../ai/[id]";
import { api } from "../../src/api";
import { getAiSession, setAiSession, subscribeAiSession } from "../../src/ai-session";
import { useAuth } from "../../src/auth";
import { EmptyState, LoadingState } from "../../src/chrome";

type SessionRow = { id: string; title: string };
type Options = {
  defaultModel: string;
  models: { id: string }[];
  preferences?: { default_model?: string | null };
};

export default function AI() {
  const client = useQueryClient();
  const { session } = useAuth();
  const [picked, setPicked] = useState(getAiSession());
  const [error, setError] = useState("");
  const origin = session?.origin ?? "";
  const seenOrigin = useRef(origin);

  useEffect(() => subscribeAiSession(setPicked), []);

  useEffect(() => {
    if (seenOrigin.current === origin) return;
    seenOrigin.current = origin;
    setAiSession(null);
    setError("");
  }, [origin]);

  useEffect(() => {
    if (!session || picked) return;
    let cancel = false;
    void (async () => {
      try {
        const data = await api<SessionRow[] | { items: SessionRow[] }>("/ai/sessions?archived=false");
        const rows = Array.isArray(data) ? data : data.items;
        if (cancel) return;
        if (rows[0]) {
          setAiSession(rows[0].id);
          return;
        }
        const options = await api<Options>("/ai/options");
        const modelId = options.preferences?.default_model || options.defaultModel || options.models[0]?.id;
        if (!modelId) throw new Error("还没有可用的模型");
        const created = await api<{ id: string }>("/ai/sessions", { body: { title: "新对话", modelId } });
        if (cancel) return;
        await client.invalidateQueries({ queryKey: ["ai-sessions", session.origin] });
        setAiSession(created.id);
      } catch (reason) {
        if (!cancel) setError(reason instanceof Error ? reason.message : "无法打开对话");
      }
    })();
    return () => {
      cancel = true;
    };
  }, [client, picked, session]);

  if (error) return <EmptyState title={error} />;
  if (!picked) return <LoadingState label="正在打开对话…" />;
  return <Conversation key={picked} sessionId={picked} />;
}
