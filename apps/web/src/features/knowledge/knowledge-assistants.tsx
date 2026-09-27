import { PublicResourceLink } from "@web/features/discovery/discovery.js";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Plus,
  Settings,
  ShieldCheck,
  ArrowLeft,
  Copy,
  KeyRound,
  Trash2,
} from "lucide-react";
import { Select as MultiSelect } from "antd";
import { KnowledgeChat } from "./knowledge-chat.js";
import { api, roleRank } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Dialog, PersonPicker } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import "@web/features/documents/permissions.css";
import "./knowledge-bots.css";

type BotInfo = {
  id: string;
  title: string;
  revision: number;
  enabled: boolean;
  canManage: boolean;
  accessible: boolean;
  invitationPending?: boolean;
  visibility: string;
  libraryIds?: string[];
  libraryCount: number;
  activeLibraryIds?: string[];
  activeLibraryCount?: number;
  memberIds?: string[];
  managerIds?: string[];
  memberNames?: Record<string, string>;
  creator: { id: string; displayName: string };
  config: { attachmentsEnabled: boolean; channels: string[] };
};
type Library = { id: string; title: string; role: string };
export function KnowledgeAssistants({ libraryId }: { libraryId?: string }) {
  const { t } = useI18n();
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const update = () => setRoute(location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const params = new URLSearchParams(route.split("?")[1]),
    selected = libraryId ? null : params.get("bot");
  const [items, setItems] = useState<BotInfo[]>([]),
    [bot, setBot] = useState<BotInfo>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"" | "manage" | "share">(""),
    [draft, setDraft] = useState<BotInfo>(),
    [libraries, setLibraries] = useState<Library[]>([]);
  const [keys, setKeys] = useState<
      Array<{ id: string; name: string; channel: string; expires_at: string }>
    >([]),
    [secret, setSecret] = useState(""),
    [copied, setCopied] = useState(false);
  const [keyName, setKeyName] = useState(""),
    [keyChannel, setKeyChannel] = useState("api");
  async function reload() {
    if (selected) {
      const value = await api<BotInfo>(`/knowledge/assistants/${selected}`);
      setBot(value);
      return value;
    }
    setItems(
      (
        await api<{ items: BotInfo[] }>(
          `/knowledge/assistants${libraryId ? `?libraryId=${libraryId}` : ""}`,
        )
      ).items,
    );
  }
  useEffect(() => {
    setError("");
    setLoading(true);
    setBot(undefined);
    setDialog("");
    void reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected, libraryId]);
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(mode: "manage" | "share") {
    if (!bot) return;
    setDraft(structuredClone(bot));
    setDialog(mode);
    setSecret("");
    setCopied(false);
    if (mode === "manage")
      await work(async () => {
        const all: Library[] = [];
        let cursor: string | undefined;
        do {
          const page: { items: Library[]; nextCursor?: string | null } =
            await api(`/resources?scope=all&kind=library${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          all.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        setLibraries(all.filter((x) => roleRank(x.role) >= 4));
        setKeys(
          (
            await api<{ items: typeof keys }>(
              `/knowledge/assistants/${bot.id}/keys`,
            )
          ).items,
        );
      });
  }
  async function create() {
    await work(async () => {
      const result = await api<{ id: string }>(
        "/knowledge/assistants",
        "POST",
        {
          expectedRevision: 0,
          title: t("bot.newName"),
          libraryIds: libraryId ? [libraryId] : [],
          memberIds: [],
          managerIds: [],
          enabled: true,
          visibility: "invited",
          attachmentsEnabled: false,
          channels: ["web", "embed", "api", "mcp"],
        },
      );
      location.hash = `/knowledge-assistants?bot=${result.id}&manage=1`;
    });
  }
  useEffect(() => {
    if (bot?.canManage && params.get("manage") === "1") void open("manage");
  }, [bot?.id]);
  async function save() {
    if (!draft) return;
    await work(async () => {
      await api("/knowledge/assistants", "POST", {
        id: draft.id,
        expectedRevision: draft.revision,
        title: draft.title,
        libraryIds: draft.libraryIds ?? [],
        memberIds: draft.memberIds ?? [],
        managerIds: draft.managerIds ?? [],
        visibility: draft.visibility,
        enabled: draft.enabled,
        ...draft.config,
      });
      await reload();
      setDialog("");
    });
  }
  const shareSlot = document.getElementById("knowledge-share-slot");
  const shareLink = bot
    ? `${location.origin}/#/knowledge-assistants?bot=${bot.id}`
    : "";
  const members = [
    ...new Set([...(draft?.memberIds ?? []), ...(draft?.managerIds ?? [])]),
  ];
  return (
    <section
      className={`library-system knowledge-full-width knowledge-bots-page ${selected ? "is-bot-detail" : ""}`}
    >
      {error && <Feedback tone="error" message={error} />}
      {loading ? (
        <p role="status">{t("knowledge.loading")}</p>
      ) : !selected ? (
        <>
          <div className="kb-list-toolbar"><PublicResourceLink kind="assistant" />
            <p>{t("bot.listHint")}</p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              {t("bot.create")}
            </button>
          </div>
          <div className="kb-bot-grid">
            {items.map((item) => (
              <article className="kb-bot-card" key={item.id}>
                <Bot size={26} />
                <h2>{item.title}</h2>
                <p>{t("bot.creator", { name: item.creator.displayName })}</p>
                <small>
                  {t("bot.libraryCount", { count: item.libraryCount })}
                </small>
                {item.canManage || item.accessible || item.invitationPending ? (
                  <a href={`#/knowledge-assistants?bot=${item.id}`}>
                    {t(item.canManage ? "bot.openManage" : "bot.open")}
                  </a>
                ) : (
                  <small>{t("bot.noAccess")}</small>
                )}
              </article>
            ))}
          </div>
          {!items.length && (
            <div className="kb-empty">
              <Bot size={36} />
              <p>{t("bot.emptyList")}</p>
            </div>
          )}
        </>
      ) : bot ? (
        <>
          {shareSlot &&
            createPortal(
              <button
                className="share-trigger"
                onClick={() => void open("share")}
              >
                <ShieldCheck size={16} />
                {t("shell.share")}
              </button>,
              shareSlot,
            )}
          <div className="kb-detail-toolbar">
            <a href="#/knowledge-assistants" aria-label={t("bot.back")}>
              <ArrowLeft size={18} />
            </a>
            <Bot size={23} />
            <h2>{bot.title}</h2>
            {bot.canManage && (
              <button onClick={() => void open("manage")}>
                <Settings size={16} />
                {t("bot.manage")}
              </button>
            )}
          </div>
          {bot.invitationPending ? (
            <div className="kb-empty">
              <p>{t("bot.invited")}</p>
              <button
                className="primary"
                onClick={() =>
                  void work(async () => {
                    await api(`/knowledge/assistants/${bot.id}/visit`, "POST", {
                      accept: true,
                    });
                    await reload();
                  })
                }
              >
                {t("bot.accept")}
              </button>
            </div>
          ) : !bot.activeLibraryCount ? (
            <div className="kb-empty">
              <Bot size={40} />
              <h3>
                {t(
                  bot.libraryCount
                    ? "bot.noActiveLibraries"
                    : "bot.noLibraries",
                )}
              </h3>
              <p>{t(bot.libraryCount ? "bot.revokedHint" : "bot.bindHint")}</p>
              {bot.canManage && (
                <button className="primary" onClick={() => void open("manage")}>
                  {t("bot.manage")}
                </button>
              )}
            </div>
          ) : !bot.enabled || !bot.config.channels.includes("web") ? (
            <div className="kb-empty">{t("bot.webDisabled")}</div>
          ) : (
            <KnowledgeChat
              key={bot.id}
              scopeId={bot.id}
              kind="answer"
              compactHeader
              attachmentsEnabled={bot.config.attachmentsEnabled}
            />
          )}
        </>
      ) : null}
      {dialog && draft && (
        <Dialog
          title={t(dialog === "share" ? "share.title" : "bot.manage")}
          close={() => {
            setDialog("");
            setSecret("");
          }}
          className={`knowledge-bot-dialog ${dialog === "share" ? "knowledge-bot-permissions" : ""}`}
        >
          {error && <Feedback tone="error" message={error} />}
          {dialog === "manage" ? (
            <>
              <label>
                {t("knowledge.botName")}
                <input
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </label>
              <label>
                {t("knowledge.botLibraries")}
                <MultiSelect
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  value={draft.libraryIds ?? []}
                  placeholder={t("bot.chooseLibraries")}
                  onChange={(libraryIds) => setDraft({ ...draft, libraryIds })}
                  options={[
                    ...libraries.map((x) => ({ value: x.id, label: x.title })),
                    ...(draft.libraryIds ?? [])
                      .filter((id) => !libraries.some((x) => x.id === id))
                      .map((id) => ({
                        value: id,
                        label: t("bot.unavailableLibrary", {
                          id: id.slice(0, 8),
                        }),
                      })),
                  ]}
                />
              </label>
              {!!bot?.libraryCount &&
                bot.activeLibraryCount !== bot.libraryCount && (
                  <p role="status">{t("bot.revokedHint")}</p>
                )}
              <label className="kb-check">
                <input
                  type="checkbox"
                  checked={draft.config.attachmentsEnabled}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      config: {
                        ...draft.config,
                        attachmentsEnabled: e.target.checked,
                      },
                    })
                  }
                />
                {t("bot.attachments")}
              </label>
              <small>{t("bot.attachmentsHint")}</small>
              <fieldset>
                <legend>{t("bot.channels")}</legend>
                <div className="kb-channel-options">
                  {["web", "embed", "api", "mcp"].map((channel) => (
                    <label className="kb-check" key={channel}>
                      <input
                        type="checkbox"
                        checked={draft.config.channels.includes(channel)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            config: {
                              ...draft.config,
                              channels: e.target.checked
                                ? [...draft.config.channels, channel]
                                : draft.config.channels.filter(
                                    (x) => x !== channel,
                                  ),
                            },
                          })
                        }
                      />
                      {t(`bot.channel.${channel}` as any)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="kb-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) =>
                    setDraft({ ...draft, enabled: e.target.checked })
                  }
                />
                {t("knowledge.botEnabled")}
              </label>
              <details className="kb-keys">
                <summary>
                  <KeyRound size={15} />
                  {t("bot.keys")}
                </summary>
                <p>{t("bot.keyHint")}</p>
                <div className="kb-key-create">
                  <input
                    aria-label={t("bot.keyName")}
                    placeholder={t("bot.keyName")}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                  <select
                    value={keyChannel}
                    onChange={(e) => setKeyChannel(e.target.value)}
                  >
                    <option value="api">API</option>
                    <option value="mcp">MCP</option>
                  </select>
                  <button
                    disabled={busy || !keyName.trim()}
                    onClick={() =>
                      void work(async () => {
                        const value = await api<{ token: string }>(
                          `/knowledge/assistants/${draft.id}/keys`,
                          "POST",
                          { name: keyName, channel: keyChannel },
                        );
                        setSecret(value.token);
                        setKeys(
                          (
                            await api<{ items: typeof keys }>(
                              `/knowledge/assistants/${draft.id}/keys`,
                            )
                          ).items,
                        );
                        setKeyName("");
                      })
                    }
                  >
                    {t("bot.createKey")}
                  </button>
                </div>
                {secret && (
                  <label>
                    {t("bot.keyOnce")}
                    <input readOnly value={secret} />
                    <button
                      onClick={() =>
                        void work(async () => {
                          await navigator.clipboard.writeText(secret);
                          setCopied(true);
                        })
                      }
                    >
                      <Copy size={14} />
                      {t(copied ? "bot.copied" : "bot.copy")}
                    </button>
                  </label>
                )}
                <ul>
                  {keys.map((key) => (
                    <li key={key.id}>
                      <span>
                        {key.name} · {key.channel.toUpperCase()} ·{" "}
                        {new Date(key.expires_at).toLocaleDateString()}
                      </span>
                      <button
                        aria-label={t("bot.revokeKey")}
                        onClick={() =>
                          void work(async () => {
                            await api(
                              `/knowledge/assistants/${draft.id}/keys/${key.id}`,
                              "DELETE",
                            );
                            setKeys(keys.filter((x) => x.id !== key.id));
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <p>
                  API{" "}
                  <code>{`${location.origin}/api/v1/knowledge/assistants/${draft.id}/api/ask`}</code>
                </p>
                <p>
                  MCP{" "}
                  <code>{`${location.origin}/api/v1/knowledge/assistants/${draft.id}/mcp`}</code>
                </p>
                <p>
                  iframe{" "}
                  <code>{`${location.origin}/knowledge/embed/${draft.id}`}</code>
                </p>
              </details>
            </>
          ) : (
            <>
              <section className="permissions-section">
                <label>
                  {t("bot.visibility")}
                  <select
                    disabled={!draft.canManage}
                    value={draft.visibility}
                    onChange={(e) =>
                      setDraft({ ...draft, visibility: e.target.value })
                    }
                  >
                    <option value="invited">{t("bot.private")}</option>
                    <option value="authenticated">
                      {t("bot.authenticated")}
                    </option>
                    <option value="public">{t("bot.public")}</option>
                  </select>
                </label>
                <p>{t("bot.shareHint")}</p>
                <div className="kb-share-link">
                  <input readOnly value={shareLink} />
                  <button
                    onClick={() =>
                      void work(async () => {
                        await navigator.clipboard.writeText(shareLink);
                        setCopied(true);
                      })
                    }
                  >
                    <Copy size={15} />
                    {t(copied ? "bot.copied" : "bot.copyLink")}
                  </button>
                </div>
              </section>
              {draft.canManage && (
                <section className="permissions-section">
                  <h3>{t("share.members")}</h3>
                  <p>{t("bot.creator", { name: draft.creator.displayName })}</p>
                  <PersonPicker
                    select={(person) => {
                      if (person.id === draft.creator.id) return;
                      setDraft({
                        ...draft,
                        memberIds: [
                          ...new Set([...(draft.memberIds ?? []), person.id]),
                        ],
                        memberNames: {
                          ...draft.memberNames,
                          [person.id]: person.display_name,
                        },
                      });
                    }}
                  />
                  <ul className="kb-members">
                    {members.map((id) => (
                      <li key={id}>
                        <span>{draft.memberNames?.[id] ?? id}</span>
                        <select
                          value={
                            draft.managerIds?.includes(id)
                              ? "manager"
                              : "reader"
                          }
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              memberIds: [
                                ...new Set([...(draft.memberIds ?? []), id]),
                              ],
                              managerIds:
                                e.target.value === "manager"
                                  ? [
                                      ...new Set([
                                        ...(draft.managerIds ?? []),
                                        id,
                                      ]),
                                    ]
                                  : (draft.managerIds ?? []).filter(
                                      (x) => x !== id,
                                    ),
                            })
                          }
                        >
                          <option value="reader">{t("bot.roleReader")}</option>
                          <option value="manager">
                            {t("bot.roleManager")}
                          </option>
                        </select>
                        <button
                          onClick={() =>
                            setDraft({
                              ...draft,
                              memberIds: draft.memberIds?.filter(
                                (x) => x !== id,
                              ),
                              managerIds: draft.managerIds?.filter(
                                (x) => x !== id,
                              ),
                            })
                          }
                          aria-label={t("knowledge.removeMember")}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          <footer>
            <button onClick={() => setDialog("")}>
              {t("knowledge.close")}
            </button>
            {draft.canManage && (
              <button
                className="primary"
                disabled={busy || !draft.title.trim()}
                onClick={() => void save()}
              >
                {t("knowledge.save")}
              </button>
            )}
          </footer>
        </Dialog>
      )}
    </section>
  );
}
