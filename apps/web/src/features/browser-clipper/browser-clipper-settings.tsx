import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Copy,
  Globe,
  Plus,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import { ClipperDestinationTree } from "./clipper-destination-tree.js";
import "./browser-clipper.css";

type Profile = {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  strategy: "create" | "append";
  libraryId: string | null;
  parentId: string | null;
  targetId: string | null;
  titleTemplate: string;
  aiInstruction: string;
  destinationTitle?: string | null;
};
type Connection = {
  id: string;
  name: string;
  assistant_enabled: number;
  signedIn: boolean;
  revision: number;
  token_hint: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
};
type Destination = {
  id: string;
  title: string;
  kind: string;
  format: string;
  libraryId: string | null;
  parentId: string | null;
};
type ExtensionRelease = { version: string; filename: string };
type ProfileForm = Omit<Profile, "id" | "revision" | "destinationTitle"> & {
  id?: string;
  revision?: number;
};
const base = "/me/browser-clipper";
export function BrowserClipperSettings() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState("profiles"),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [connections, setConnections] = useState<Connection[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null),
    [connectionForm, setConnectionForm] = useState(false),
    [name, setName] = useState(""),
    [assistantEnabled, setAssistantEnabled] = useState(true);
  const [destinations, setDestinations] = useState<Destination[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState("");
  const [destinationReady, setDestinationReady] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(
    null,
  );
  const [revoke, setRevoke] = useState<Connection | "all" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [release, setRelease] = useState<ExtensionRelease | null>(null),
    [releaseError, setReleaseError] = useState(false);
  async function loadRelease() {
    setReleaseError(false);
    try {
      const value = await api<ExtensionRelease>("/browser-clipper/release");
      if (
        !/^\d+(?:\.\d+){0,3}$/.test(value.version) ||
        value.filename !== `doca-browser-assistant-${value.version}.zip`
      )
        throw Error("clipper_invalid_package_version");
      setRelease(value);
    } catch {
      setRelease(null);
      setReleaseError(true);
    }
  }
  async function load() {
    const [p, c] = await Promise.all([
      api<{ items: Profile[] }>(base + "/profiles"),
      api<{ items: Connection[] }>(base + "/connections"),
    ]);
    setProfiles(p.items);
    setConnections(c.items);
  }
  useEffect(() => {
    void load().catch((error) => setError(error.message));
    void loadRelease();
  }, []);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
    } catch (error) {
      const message = (error as Error).message;
      const known: Record<string, string> = {
        clipper_connection_revoked: t(
          "clipper.error.clipper_connection_revoked",
        ),
        clipper_invalid_target: t("clipper.error.clipper_invalid_target"),
        clipper_target_unsupported: t(
          "clipper.error.clipper_target_unsupported",
        ),
        clipper_knowledge_book_readonly: t(
          "clipper.error.clipper_knowledge_book_readonly",
        ),
        clipper_profile_changed: t("clipper.error.clipper_profile_changed"),
        clipper_connection_changed: t(
          "clipper.error.clipper_connection_changed",
        ),
        clipper_invalid_input: t("clipper.error.clipper_invalid_input"),
      };
      setError(known[message] ?? message);
    } finally {
      setBusy(false);
    }
  }
  async function search(more = false, text = query) {
    const params = new URLSearchParams({ q: text, kind: "document" });
    if (more && cursor) params.set("cursor", cursor);
    const page = await api<{ items: Destination[]; nextCursor: string | null }>(
      base + "/destinations?" + params,
    );
    setDestinations((previous) => [
      ...new Map(
        [...(more ? previous : []), ...page.items].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ]);
    setCursor(page.nextCursor);
  }
  async function edit(profile?: Profile) {
    const clean = profile
      ? (({ destinationTitle: _label, ...fields }) => fields)(profile)
      : null;
    setQuery("");
    setDestinations([]);
    setCursor(null);
    setDestinationReady(false);
    setForm(
      clean ?? {
        name: "",
        enabled: true,
        isDefault: !profiles.length,
        strategy: "create",
        libraryId: null,
        parentId: null,
        targetId: null,
        titleTemplate: "{title}",
        aiInstruction: "",
      },
    );
    if (profile?.strategy !== "append") return;
    const page = await api<{ items: Destination[]; nextCursor: string | null }>(
      base + "/destinations?kind=document",
    );
    const selected: Destination[] = [];
    for (const id of [profile.targetId])
      if (id && !page.items.some((item) => item.id === id)) {
        const item = await api<{
          resource: {
            id: string;
            title: string;
            kind: string;
            format: string;
            library_id: string | null;
            parent_id: string | null;
          };
        }>(`/resources/${id}`);
        selected.push({
          ...item.resource,
          libraryId: item.resource.library_id,
          parentId: item.resource.parent_id,
        });
      }
    setDestinations([...page.items, ...selected]);
    setCursor(page.nextCursor);
  }
  async function download() {
    const response = await fetch("/api/v1" + base + `/download`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw Error((await response.json()).message);
    const filename =
      /^attachment; filename="(doca-browser-assistant-(\d+(?:\.\d+){0,3})\.zip)"$/.exec(
        response.headers.get("Content-Disposition") || "",
      );
    if (!filename) throw Error(t("clipper.packageUnavailable"));
    setRelease({ version: filename[2]!, filename: filename[1]! });
    const url = URL.createObjectURL(await response.blob()),
      link = document.createElement("a");
    link.href = url;
    link.download = filename[1]!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      dateStyle: "medium",
    }).format(new Date(value));
  const targetLabel = (profile: Profile) =>
    profile.destinationTitle ??
    (profile.libraryId || profile.targetId
      ? t("clipper.unavailable")
      : t("clipper.personal"));
  return (
    <section className="clipper-settings">
      <header className="clipper-page-header">
        <div className="clipper-page-icon">
          <Globe size={25} />
        </div>
        <div>
          <h1>{t("clipper.title")}</h1>
          <p>{t("clipper.description")}</p>
        </div>
      </header>
      <div className="clipper-download">
        <div>
          <strong>
            {release
              ? t("clipper.packageName", { version: release.version })
              : t("clipper.downloadTitle")}
          </strong>
          {release && (
            <span className="clipper-package-filename">{release.filename}</span>
          )}
          <p>{t("clipper.websiteSession")}</p>
          {releaseError && (
            <p role="alert">
              {t("clipper.packageUnavailable")}{" "}
              <button
                className="clipper-rules-link"
                onClick={() => void loadRelease()}
              >
                {t("clipper.retryPackage")}
              </button>
            </p>
          )}
        </div>
        <button
          className="primary"
          disabled={busy || !release}
          onClick={() => void act(download)}
        >
          <ArrowDownToLine size={17} />
          {release
            ? t("clipper.downloadVersion", { version: release.version })
            : t("clipper.download")}
        </button>
        <button
          className="clipper-rules-link"
          onClick={() => setTab("profiles")}
        >
          {t("clipper.rulesLink")}
        </button>
      </div>
      <SettingsTabs
        label={t("clipper.title")}
        value={tab}
        onChange={setTab}
        items={[
          ["profiles", t("clipper.profiles")],
          ["connections", t("clipper.connections")],
          ["ai", t("clipper.ai")],
        ]}
      />
      <Feedback message={error} tone="error" />
      <Feedback message={notice} tone="info" />
      {tab === "profiles" && (
        <div className="clipper-section">
          <div className="clipper-section-head">
            <h2>{t("clipper.profiles")}</h2>
            <button className="primary" onClick={() => void act(() => edit())}>
              <Plus size={15} />
              {t("clipper.addProfile")}
            </button>
          </div>
          {!profiles.length && (
            <p className="clipper-empty">{t("clipper.emptyProfiles")}</p>
          )}
          {profiles.map((profile) => (
            <article className="clipper-row" key={profile.id}>
              <div className="clipper-row-icon">
                <ArrowDownToLine size={19} />
              </div>
              <div className="clipper-row-body">
                <strong>{profile.name}</strong>
                {profile.isDefault && (
                  <span className="clipper-tag">{t("clipper.default")}</span>
                )}
                {!profile.enabled && (
                  <span className="clipper-tag muted">
                    {t("clipper.disabled")}
                  </span>
                )}
                <p>
                  {t(
                    profile.strategy === "create"
                      ? "clipper.create"
                      : "clipper.append",
                  )}{" "}
                  · {targetLabel(profile)}
                </p>
              </div>
              <button
                className="soft"
                onClick={() => void act(() => edit(profile))}
              >
                {t("clipper.edit")}
              </button>
            </article>
          ))}
        </div>
      )}
      {tab === "connections" && (
        <div className="clipper-section">
          <div className="clipper-section-head">
            <h2>{t("clipper.connections")}</h2>
            <div className="clipper-actions">
              <button
                onClick={() =>
                  void act(async () => {
                    const value = await api<{ config: unknown }>(
                      base + "/config",
                    );
                    await navigator.clipboard.writeText(
                      JSON.stringify(value.config),
                    );
                    setNotice(t("clipper.copied"));
                  })
                }
              >
                {t("clipper.copy")}
              </button>
            </div>
          </div>
          <div className="clipper-install">
            <ShieldCheck size={20} />
            <div>
              <p>{t("clipper.downloadHelp")}</p>
              <small>{t("clipper.siteAccess")}</small>
            </div>
          </div>
          {!connections.length && (
            <p className="clipper-empty">{t("clipper.emptyConnections")}</p>
          )}
          {connections.map((connection) => (
            <article
              className={`clipper-row ${connection.revoked_at ? "is-revoked" : ""}`}
              key={connection.id}
            >
              <div className="clipper-row-icon">
                <Globe size={19} />
              </div>
              <div className="clipper-row-body">
                <strong>{connection.name}</strong>
                <span
                  className={`clipper-tag ${connection.revoked_at ? "muted" : ""}`}
                >
                  {t(
                    connection.revoked_at
                      ? "clipper.revoked"
                      : connection.signedIn
                        ? "clipper.active"
                        : "clipper.pending",
                  )}
                </span>
                <p>
                  {t(
                    connection.assistant_enabled
                      ? "clipper.aiEnabled"
                      : "clipper.aiDisabled",
                  )}{" "}
                  ·{" "}
                  {t("clipper.created", { date: date(connection.created_at) })}
                </p>
                <small>{t("clipper.websiteSession")}</small>
                <div className="clipper-actions">
                  <button
                    onClick={() => {
                      setEditingConnection(connection);
                      setName(connection.name);
                      setAssistantEnabled(!!connection.assistant_enabled);
                      setConnectionForm(true);
                    }}
                  >
                    {t("clipper.edit")}
                  </button>
                  {connection.revoked_at && (
                    <button
                      onClick={() =>
                        void act(async () => {
                          await api(
                            base + `/connections/${connection.id}/restore`,
                            "POST",
                            { revision: connection.revision },
                          );
                        })
                      }
                    >
                      {t("clipper.restore")}
                    </button>
                  )}
                </div>
              </div>
              {!connection.revoked_at && (
                <button
                  className="clipper-danger-link"
                  onClick={() => setRevoke(connection)}
                >
                  <Unplug size={14} />
                  {t("clipper.revoke")}
                </button>
              )}
            </article>
          ))}
          {connections.some((connection) => !connection.revoked_at) && (
            <div className="clipper-revoke-all">
              <button
                className="clipper-danger-link"
                onClick={() => setRevoke("all")}
              >
                <Unplug size={15} />
                {t("clipper.revokeAll")}
              </button>
            </div>
          )}
        </div>
      )}
      {tab === "ai" && (
        <div className="clipper-section clipper-ai">
          <Sparkles size={30} />
          <h2>{t("clipper.ai")}</h2>
          <p>{t("clipper.aiHelp")}</p>
          <blockquote>{t("clipper.aiExamples")}</blockquote>
          <p>{t("clipper.aiPrivacy")}</p>
          <button
            className="primary"
            onClick={() => {
              setTab("connections");
            }}
          >
            {t("clipper.connections")}
          </button>
        </div>
      )}
      {form && (
        <Dialog
          title={form.id ? t("clipper.edit") : t("clipper.addProfile")}
          close={() => setForm(null)}
          className="clipper-dialog"
        >
          <form
            className="clipper-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (form.strategy === "create" && !destinationReady) return;
              void act(async () => {
                const { id, ...input } = form;
                await api(
                  base + "/profiles" + (id ? "/" + id : ""),
                  id ? "PUT" : "POST",
                  input,
                );
                setForm(null);
                setNotice(t("clipper.saved"));
              });
            }}
          >
            <label>
              {t("clipper.name")}
              <input
                value={form.name}
                required
                maxLength={80}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </label>
            <label>
              {t("clipper.strategy")}
              <Select
                value={form.strategy}
                onChange={(event) => {
                  const strategy = event.target.value as Profile["strategy"];
                  setDestinationReady(false);
                  setQuery("");
                  setDestinations([]);
                  setCursor(null);
                  setForm({
                    ...form,
                    strategy,
                    libraryId: null,
                    parentId: null,
                    targetId: null,
                  });
                  if (strategy === "append") void act(() => search(false, ""));
                }}
              >
                <option value="create">{t("clipper.create")}</option>
                <option value="append">{t("clipper.append")}</option>
              </Select>
            </label>
            {form.strategy === "create" ? (
              <ClipperDestinationTree
                key={form.id ?? "new"}
                value={form}
                disabled={busy}
                onReadyChange={setDestinationReady}
                onChange={(location) =>
                  setForm((current) =>
                    current ? { ...current, ...location } : null,
                  )
                }
              />
            ) : (
              <>
                <div className="clipper-search">
                  <input
                    aria-label={t("clipper.search")}
                    placeholder={t("clipper.search")}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setCursor(null);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(() => search())}
                  >
                    {t("clipper.search")}
                  </button>
                </div>
                <label>
                  {t("clipper.target")}
                  <Select
                    value={form.targetId ?? ""}
                    required
                    onChange={(event) =>
                      setForm({ ...form, targetId: event.target.value || null })
                    }
                  >
                    <option value="">{t("clipper.chooseDocument")}</option>
                    {destinations
                      .filter(
                        (item) =>
                          item.kind === "document" &&
                          ["rich_text", "markdown"].includes(item.format),
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                  </Select>
                </label>
              </>
            )}
            {form.strategy === "append" && cursor && (
              <button
                type="button"
                className="soft"
                onClick={() => void act(() => search(true))}
              >
                {t("clipper.more")}
              </button>
            )}
            <small>{t("clipper.formatHelp")}</small>
            <label>
              {t("clipper.titleTemplate")}
              <input
                required
                maxLength={160}
                value={form.titleTemplate}
                onChange={(event) =>
                  setForm({ ...form, titleTemplate: event.target.value })
                }
              />
              <small>{t("clipper.titleHelp")}</small>
            </label>
            <label>
              {t("clipper.instruction")}
              <textarea
                rows={3}
                maxLength={4000}
                value={form.aiInstruction}
                onChange={(event) =>
                  setForm({ ...form, aiInstruction: event.target.value })
                }
              />
            </label>
            <label className="clipper-toggle">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) =>
                  setForm({ ...form, isDefault: event.target.checked })
                }
              />
              {t("clipper.default")}
            </label>
            <label className="clipper-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
              {t("clipper.enabled")}
            </label>
            <footer>
              <button
                type="button"
                className="soft"
                onClick={() => setForm(null)}
              >
                {t("clipper.cancel")}
              </button>
              <button
                className="primary"
                disabled={
                  busy || (form.strategy === "create" && !destinationReady)
                }
              >
                {t("clipper.save")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {connectionForm && (
        <Dialog
          title={t("clipper.edit")}
          close={() => setConnectionForm(false)}
        >
          <form
            className="clipper-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                if (!editingConnection) return;
                await api(
                  base + `/connections/${editingConnection.id}`,
                  "PUT",
                  {
                    revision: editingConnection.revision,
                    name,
                    assistantEnabled,
                  },
                );
                setConnectionForm(false);
              });
            }}
          >
            <Feedback message={error} tone="error" />
            <label>
              {t("clipper.connectionName")}
              <input
                autoFocus
                placeholder={t("clipper.connectionPlaceholder")}
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="clipper-toggle">
              <input
                type="checkbox"
                checked={assistantEnabled}
                onChange={(event) => setAssistantEnabled(event.target.checked)}
              />
              {t("clipper.enableAI")}
            </label>
            <footer>
              <button className="primary" disabled={busy}>
                {t("clipper.connections")}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {revoke && (
        <Dialog title={t("clipper.revokeTitle")} close={() => setRevoke(null)}>
          <p>
            {t(
              revoke === "all" ? "clipper.revokeAllHelp" : "clipper.revokeHelp",
            )}
          </p>
          <div className="clipper-dialog-actions">
            <button className="soft" onClick={() => setRevoke(null)}>
              {t("clipper.cancel")}
            </button>
            <button
              className="clipper-danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(
                    base +
                      (revoke === "all"
                        ? "/revoke-all"
                        : `/connections/${revoke.id}/revoke`),
                    "POST",
                    revoke === "all" ? {} : { revision: revoke.revision },
                  );
                  setRevoke(null);
                  setNotice(t("clipper.revokedNotice"));
                })
              }
            >
              {t("clipper.revokeConfirm")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
