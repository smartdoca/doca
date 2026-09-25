import Preview from "@web/features/documents/markdown-preview.js";
import { useEffect, useState } from "react";
import { api, roleRank } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import "@web/features/documents/library-system.css";
import "./knowledge-workspace.css";
type Bot = {
  visibility: "invited" | "authenticated" | "public";
  invitationPending?: boolean;
  id: string;
  title: string;
  revision: number;
  enabled: boolean;
  canManage: boolean;
  libraryIds?: string[];
  memberIds?: string[];
  memberNames?: Record<string, string>;
};
type Library = { id: string; title: string; role: string };
export function KnowledgeAssistants({ libraryId }: { libraryId?: string }) {
  const { t } = useI18n();
  const [bots, setBots] = useState<Bot[]>([]),
    [libraries, setLibraries] = useState<Library[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    id?: string;
    expectedRevision: number;
    visibility: Bot["visibility"];
    title: string;
    libraryIds: string[];
    memberIds: string[];
    enabled: boolean;
  }>({
    expectedRevision: 0,
    visibility: "invited",
    title: "",
    libraryIds: libraryId ? [libraryId] : [],
    memberIds: [],
    enabled: true,
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{
    answer?: string;
    items: {
      id: string;
      title: string;
      excerpt: string;
      documentUrl?: string;
      sources?: { id: string; title: string; href?: string }[];
    }[];
  }>();
  const [fullText, setFullText] = useState<{
    title: string;
    markdown: string;
  }>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  async function reload() {
    const data = await api<{ items: Bot[] }>("/knowledge/assistants");
    setBots(data.items);
    return data.items;
  }
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      api<{ items: Bot[] }>(
        "/knowledge/assistants",
        "GET",
        undefined,
        c.signal,
      ),
      api<{ items: Library[] }>(
        "/resources?scope=all&kind=library",
        "GET",
        undefined,
        c.signal,
      ),
    ])
      .then(async ([bs, ls]) => {
        const target = new URLSearchParams(location.hash.split("?")[1]).get(
          "bot",
        );
        if (target && /^[0-9a-f-]{36}$/.test(target)) {
          await api(`/knowledge/assistants/${target}/visit`, "POST", {});
          bs = await api<{ items: Bot[] }>("/knowledge/assistants");
        }
        if (c.signal.aborted) return;
        setBots(bs.items);
        setSelected(
          (target && bs.items.some((b) => b.id === target) ? target : "") ||
            bs.items.find(
              (b) => !libraryId || b.libraryIds?.includes(libraryId),
            )?.id ||
            bs.items[0]?.id ||
            "",
        );
        setLibraries(ls.items.filter((l) => roleRank(l.role) >= 4));
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [libraryId]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const bot = bots.find((b) => b.id === selected);
  return (
    <section className="library-system knowledge-assistants">
      <header>
        <h2>{t("knowledge.assistants")}</h2>
        <p>{t("knowledge.assistantsHint")}</p>
      </header>
      {error && <Feedback tone="error" message={error} />}
      {saved && <Feedback tone="success" message={t("knowledge.saved")} />}
      <div className="library-system-actions">
        {!!bots.length && (
          <Select
            aria-label={t("knowledge.assistants")}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setAnswer(undefined);
              setFullText(undefined);
              setEditing(false);
            }}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
                {b.enabled ? "" : ` · ${t("knowledge.disabled")}`}
              </option>
            ))}
          </Select>
        )}
        {!!libraries.length && (
          <button
            onClick={() => {
              setForm({
                expectedRevision: 0,
                visibility: "invited",
                title: "",
                libraryIds: libraryId ? [libraryId] : [],
                memberIds: [],
                enabled: true,
              });
              setEditing(true);
            }}
          >
            {t("knowledge.createBot")}
          </button>
        )}
        {bot?.canManage && (
          <button
            onClick={() => {
              setNames(bot.memberNames || {});
              setForm({
                id: bot.id,
                expectedRevision: bot.revision,
                visibility: bot.visibility,
                title: bot.title,
                libraryIds: bot.libraryIds!,
                memberIds: bot.memberIds!,
                enabled: bot.enabled,
              });
              setEditing(true);
            }}
          >
            {t("knowledge.configureBot")}
          </button>
        )}
      </div>
      {bot && (
        <p>
          <a href={`#/knowledge-assistants?bot=${bot.id}`}>
            {t("knowledge.botPermalink")}
          </a>
        </p>
      )}
      {!bots.length && !editing && (
        <p className="knowledge-empty">{t("knowledge.botsEmpty")}</p>
      )}
      {editing && (
        <section className="knowledge-bot-config">
          <h3>{t("knowledge.configureBot")}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void work(async () => {
                const result = await api<{ id: string }>(
                  "/knowledge/assistants",
                  "POST",
                  form,
                );
                await reload();
                setSelected(result.id);
                setEditing(false);
                setSaved(true);
              });
            }}
          >
            <label>
              {t("knowledge.title")}
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <fieldset>
              <legend>{t("knowledge.boundLibraries")}</legend>
              {libraries.map((l) => (
                <label key={l.id}>
                  <input
                    type="checkbox"
                    checked={form.libraryIds.includes(l.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        libraryIds: e.target.checked
                          ? [...form.libraryIds, l.id]
                          : form.libraryIds.filter((id) => id !== l.id),
                      })
                    }
                  />
                  {l.title}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>{t("knowledge.botMembers")}</legend>
              <p>{t("knowledge.botMembersHint")}</p>
              <PersonPicker
                select={(person) => {
                  setNames({ ...names, [person.id]: person.display_name });
                  setForm({
                    ...form,
                    memberIds: [...new Set([...form.memberIds, person.id])],
                  });
                }}
              />
              <ul>
                {form.memberIds.map((id, index) => (
                  <li key={id}>
                    {names[id] ||
                      t("knowledge.memberNumber", { index: index + 1 })}
                    <button
                      type="button"
                      aria-label={t("knowledge.removeMember")}
                      onClick={() =>
                        setForm({
                          ...form,
                          memberIds: form.memberIds.filter((x) => x !== id),
                        })
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
            <label>
              {t("knowledge.botVisibility")}
              <Select
                value={form.visibility}
                onChange={(e) =>
                  setForm({
                    ...form,
                    visibility: e.target.value as Bot["visibility"],
                  })
                }
              >
                <option value="invited">{t("knowledge.botPrivate")}</option>
                <option value="authenticated">
                  {t("knowledge.botAuthenticated")}
                </option>
                <option value="public">{t("knowledge.botPublic")}</option>
              </Select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              {t("knowledge.enableBot")}
            </label>
            <div className="library-system-actions">
              <button
                className="primary"
                disabled={busy || !form.libraryIds.length}
              >
                {t("knowledge.save")}
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                {t("knowledge.cancel")}
              </button>
            </div>
          </form>
        </section>
      )}
      {bot?.invitationPending && (
        <button
          disabled={busy}
          onClick={() =>
            void work(async () => {
              await api(`/knowledge/assistants/${bot.id}/visit`, "POST", {
                accept: true,
              });
              await reload();
            })
          }
        >
          {t("knowledge.acceptInvitation")}
        </button>
      )}
      {bot?.enabled && !bot.invitationPending && (
        <form
          className="knowledge-question"
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              setFullText(undefined);
              await api(`/knowledge/assistants/${selected}/visit`, "POST", {});
              setAnswer(
                await api(
                  "/knowledge/assistants/" + selected + "/ask",
                  "POST",
                  { query },
                ),
              );
            });
          }}
        >
          <input
            required
            maxLength={500}
            value={query}
            placeholder={t("knowledge.questionPlaceholder")}
            aria-label={t("library.qa.question")}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="primary" disabled={busy || !query.trim()}>
            {t(busy ? "knowledge.answering" : "library.qa.ask")}
          </button>
        </form>
      )}
      {answer?.answer && (
        <article className="knowledge-answer">
          <Preview value={answer.answer} />
        </article>
      )}
      {answer && !answer.items.length && (
        <p className="knowledge-empty">{t("knowledge.noEvidence")}</p>
      )}
      {!!answer?.items.length && (
        <>
          <h3>{t("knowledge.evidence")}</h3>
          <ul className="library-system-links">
            {answer.items.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <div className="knowledge-evidence">
                  <Preview value={item.excerpt} />
                </div>
                {!!item.sources?.length && (
                  <ul>
                    {item.sources.map((source) => (
                      <li key={source.id}>
                        {source.href ? (
                          <a
                            href={source.href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {source.title}
                          </a>
                        ) : (
                          <span>{source.title}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {item.documentUrl && (
                  <button
                    onClick={() =>
                      void work(async () =>
                        setFullText(
                          await api(
                            item.documentUrl!.replace(/^\/api\/v1/, ""),
                          ),
                        ),
                      )
                    }
                  >
                    {t("knowledge.read")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {fullText && (
        <section className="knowledge-answer">
          <h3>{fullText.title}</h3>
          <Preview value={fullText.markdown} />
          <button onClick={() => setFullText(undefined)}>
            {t("knowledge.close")}
          </button>
        </section>
      )}
    </section>
  );
}
