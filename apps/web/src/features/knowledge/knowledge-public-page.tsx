import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { KnowledgeChat } from "./knowledge-chat.js";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import "./knowledge-bots.css";
export function KnowledgePublicPage({
  botId,
  channel = "web",
  authenticated = false,
}: {
  botId: string;
  channel?: "web" | "embed";
  authenticated?: boolean;
}) {
  const { t } = useI18n(),
    [value, setValue] = useState<{
      token?: string;
      title: string;
      activeLibraryCount: number;
      attachmentsEnabled: boolean;
    }>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (authenticated) {
        const bot = await api<any>(`/knowledge/assistants/${botId}`);
        if (!bot.enabled || !bot.config.channels.includes(channel))
          throw Error(t("bot.webDisabled"));
        return {
          title: bot.title,
          activeLibraryCount: bot.activeLibraryCount,
          attachmentsEnabled: bot.config.attachmentsEnabled,
        };
      }
      const storageKey = `doca.knowledge.public.${botId}.${channel}`,
        saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const cache = JSON.parse(saved);
        if (cache.expires > Date.now()) return cache.value;
      }
      const response = await fetch(
          `/api/v1/knowledge/assistants/${botId}/public-session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel }),
          },
        ),
        data = await response.json();
      if (!response.ok)
        throw Error(data.message || data.error || String(response.status));
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ expires: Date.now() + 23 * 3600000, value: data }),
      );
      return data;
    };
    void load()
      .then((x) => {
        if (live) setValue(x);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [botId, channel, authenticated]);
  return (
    <main className="knowledge-public-page">
      <header>
        <Bot size={24} />
        <h1>{value?.title || t("knowledge.assistants")}</h1>
        {!authenticated && <a href={`/#/home`}>{t("shell.signIn")}</a>}
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : !value ? (
        <p>{t("knowledge.loading")}</p>
      ) : !value.activeLibraryCount ? (
        <div className="kb-empty">{t("bot.noActiveLibraries")}</div>
      ) : (
        <>
          <KnowledgeChat
            scopeId={botId}
            kind="answer"
            compactHeader
            channel={channel}
            guestToken={value.token}
            attachmentsEnabled={value.attachmentsEnabled && authenticated}
          />
          {value.attachmentsEnabled && !authenticated && (
            <small>{t("bot.loginAttachments")}</small>
          )}
        </>
      )}
    </main>
  );
}
