import { SecurityVerification } from "@web/features/auth/security-verification.js";
import { AccountContacts } from "@web/features/account/account-settings.js";
import {
  Feedback,
  type FeedbackTone,
} from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { useRef, useState } from "react";
import { Pencil, Camera } from "lucide-react";
import {
  api,
  assetUrl,
  fileUrl,
  uploadFile,
  type FileItem,
  type Me,
} from "@web/shared/api.js";
import { LinkedIdentities } from "@web/features/auth/authentication.js";
import {
  FileSourceDialog,
  FolderFilePicker,
} from "@web/features/files/files.js";
import { localeLabel, locales } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
export const avatars: Record<string, string> = {
  fox: "🦊",
  panda: "🐼",
  cat: "🐱",
  dog: "🐶",
  rabbit: "🐰",
  lion: "🦁",
  tiger: "🐯",
  bear: "🐻",
  koala: "🐨",
  monkey: "🐵",
  penguin: "🐧",
  owl: "🦉",
  dragon: "🐲",
  whale: "🐳",
  butterfly: "🦋",
  leaf: "🌿",
  cactus: "🌵",
  sun: "☀️",
  moon: "🌙",
  rocket: "🚀",
};
export function Avatar({
  name,
  avatar,
  assetId,
  sourceUrl,
}: {
  name: string;
  avatar?: string;
  assetId?: string | null;
  sourceUrl?: string;
}) {
  const { t } = useI18n();
  return (
    <span className={"user-avatar " + (avatar ?? "initials")}>
      {sourceUrl && /^https?:\/\//.test(sourceUrl) ? (
        <img
          src={sourceUrl}
          referrerPolicy="no-referrer"
          alt={t("profile.avatarAlt", { name })}
        />
      ) : assetId ? (
        <img src={assetUrl(assetId)} alt={t("profile.avatarAlt", { name })} />
      ) : (
        (avatars[avatar ?? ""] ?? name[0])
      )}
    </span>
  );
}
export function Profile({
  me,
  saved,
  passwordForm,
}: {
  me: Me;
  saved: () => Promise<void>;
  passwordForm: React.ReactNode;
}) {
  const { t } = useI18n();

  const fallbackName = me.user.display_name || me.user.public_id || me.user.id,
    [name, setName] = useState(me.profileName || fallbackName),
    [avatar, setAvatar] = useState(me.preferences.avatar),
    [assetId, setAssetId] = useState(me.preferences.avatar_asset_id ?? null),
    [tone, setTone] = useState<FeedbackTone>("success"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editingName, setEditingName] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [folderPicker, setFolderPicker] = useState<boolean | "materials">(false),
    [passwordEnabled, setPasswordEnabled] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const version = useRef(me.preferences.version);
  async function update(next: {
    displayName?: string;
    avatar?: string;
    avatarAssetId?: string | null;
  }) {
    if (saving.current) return;
    const displayName = next.displayName ?? name;
    if (me.fields?.displayName.required && !displayName.trim()) {
      setName(me.profileName || fallbackName);
      setEditingName(false);
      return;
    }
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api("/me/profile", "PUT", {
        displayName,
        clearSourceAvatar:
          next.avatar !== undefined || next.avatarAssetId !== undefined,
        avatar: next.avatar ?? avatar,
        avatarAssetId:
          next.avatarAssetId === undefined ? assetId : next.avatarAssetId,
        version: version.current,
      });
      const latest = await api<Me>("/me");
      version.current = latest.preferences.version;
      setName(
        latest.profileName ||
          latest.user.display_name ||
          latest.user.public_id ||
          latest.user.id,
      );
      setAvatar(latest.preferences.avatar);
      setAssetId(latest.preferences.avatar_asset_id ?? null);
      setEditingName(false);
      await saved();
      window.dispatchEvent(new Event("profile-updated"));
      setTone("success");
      setMessage(t("profile.autoSaved"));
    } catch (e) {
      setTone("error");
      setMessage((e as Error).message);
      try {
        const latest = await api<Me>("/me");
        version.current = latest.preferences.version;
        setName(
          latest.profileName ||
            latest.user.display_name ||
            latest.user.public_id ||
            latest.user.id,
        );
        setAvatar(latest.preferences.avatar);
        setAssetId(latest.preferences.avatar_asset_id ?? null);
      } catch {
        /* Keep the current draft on network failure. */
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="account-page">
      <h1>{t("mobile.screen.account")}</h1>
      <p className="subtle">{t("profile.intro")}</p>
      <section className="settings-card">
        <h2>{t("profile.details")}</h2>
        <div className="profile-preview">
          <button
            hidden={me.fields?.avatar.enabled === false}
            className="profile-avatar-upload"
            aria-label={t("profile.uploadAvatar")}
            disabled={busy || me.editable?.avatar === false}
            onClick={() => setSourceOpen(true)}
          >
            <Avatar
              name={name}
              avatar={avatar}
              assetId={assetId}
              sourceUrl={me.avatarUrl}
            />
            <Camera size={18} />
          </button>
          <div>
            {me.fields?.displayName.enabled !== false &&
              (editingName ? (
                <input
                  autoFocus
                  aria-label={t("login.nickname")}
                  value={name}
                  maxLength={160}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    if (!saving.current) void update({ displayName: name });
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void update({ displayName: name });
                    }
                    if (e.key === "Escape") {
                      setName(me.profileName || fallbackName);
                      setEditingName(false);
                    }
                  }}
                />
              ) : (
                <button
                  className="profile-name"
                  disabled={busy || me.editable?.displayName === false}
                  onClick={() => setEditingName(true)}
                  aria-label={t("profile.editName")}
                >
                  <strong>{name || t("profile.addName")}</strong>
                  <Pencil size={15} />
                </button>
              ))}
            {me.fields?.avatar.enabled !== false && (
              <small>{t("profile.avatarHint")}</small>
            )}
            <small className="profile-public-id">
              {t("profile.publicId", { id: me.user.public_id ?? me.user.id })}
            </small>
          </div>
        </div>
        <input
          ref={upload}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            setMessage("");
            try {
              const asset = await uploadFile(file, "avatar");
              await update({ avatarAssetId: asset.id });
            } catch (err) {
              setTone("error");
              setMessage((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {sourceOpen && (
          <FileSourceDialog
            title={t("profile.chooseAvatar")}
            close={() => setSourceOpen(false)}
            chooseDoca={source => setFolderPicker(source ?? true)}
            chooseLocal={() => upload.current?.click()}
          />
        )}
        {folderPicker && (
          <FolderFilePicker
            initialSource={folderPicker === "materials" ? "materials" : "folders"}
            accept={(item) => item.mime.startsWith("image/")}
            close={() => setFolderPicker(false)}
            select={async (item: FileItem) => {
              const response = await fetch(fileUrl(item.id));
              if (!response.ok) throw new Error(t("profile.imageReadFailed"));
              const asset = await uploadFile(
                new File([await response.blob()], item.name, {
                  type: item.mime,
                }),
                "avatar",
              );
              await update({ avatarAssetId: asset.id });
            }}
          />
        )}
        <small className="subtle" hidden={me.fields?.avatar.enabled === false}>
          {t("profile.avatarFormats")}
        </small>
        <div
          className="avatar-options"
          hidden={me.fields?.avatar.enabled === false}
        >
          {["initials", ...Object.keys(avatars)].map((key) => (
            <button
              type="button"
              key={key}
              className={!assetId && avatar === key ? "selected" : ""}
              aria-label={t("profile.avatarOption", {
                name: avatars[key] ?? t("profile.initials"),
              })}
              aria-pressed={!assetId && avatar === key}
              disabled={busy || me.editable?.avatar === false}
              onClick={() => void update({ avatar: key, avatarAssetId: null })}
            >
              <Avatar name={name || t("time.me")} avatar={key} />
            </button>
          ))}
        </div>
        <Feedback message={message} tone={tone} />
      </section>
      <section className="settings-card" id="account-security">
        <SecurityVerification />
      </section>
      <LinkedIdentities passwordStatus={setPasswordEnabled} />
      <AccountContacts />
      {passwordEnabled && passwordForm}
    </section>
  );
}
export function PersonalSettings({
  me,
  saved,
}: {
  me: Me;
  saved: () => Promise<void>;
}) {
  const { locale, setLocale, t } = useI18n();
  const [p, setP] = useState(me.preferences),
    [tone, setTone] = useState<FeedbackTone>("success"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function update(next: typeof p) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setP(next);
    setMessage("");
    try {
      await api("/me/preferences", "PUT", {
        version: p.version,
        theme: next.theme,
        density: next.density,
        defaultSort: next.default_sort,
        sortOrder: next.sort_order,
      });
      setP((await api<Me>("/me")).preferences);
      await saved();
      setTone("success");
      setMessage(t("settings.saved"));
    } catch (e) {
      setP(p);
      setTone("error");
      setMessage((e as Error).message);
      try {
        setP((await api<Me>("/me")).preferences);
      } catch {}
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="account-page">
      <h1>{t("account.settings")}</h1>
      <p className="subtle">{t("settings.intro")}</p>
      <section className="settings-card">
        <h2>{t("settings.language")}</h2>
        <p className="subtle">{t("settings.language.hint")}</p>
        <label>
          {t("settings.language")}
          <Select
            value={locale}
            onChange={(event) =>
              void setLocale(event.target.value as typeof locale)
            }
          >
            {locales.map((code) => (
              <option key={code} value={code}>
                {t(localeLabel[code])}
              </option>
            ))}
          </Select>
        </label>
      </section>
      <section className="settings-card">
        <h2>{t("settings.appearance")}</h2>
        <div
          className="theme-choices"
          role="group"
          aria-label={t("settings.themeGroup")}
        >
          {(["light", "soft"] as const).map((theme) => (
            <button
              type="button"
              key={theme}
              className="theme-choice"
              aria-pressed={p.theme === theme}
              disabled={busy}
              onClick={() => void update({ ...p, theme })}
            >
              <span className={`theme-preview ${theme}`}>
                <i />
                <span />
              </span>
              <strong>
                {t(
                  theme === "light"
                    ? "settings.theme.light"
                    : "settings.theme.soft",
                )}
              </strong>
              <small>
                {t(
                  theme === "light"
                    ? "settings.theme.lightHint"
                    : "settings.theme.softHint",
                )}
              </small>
            </button>
          ))}
        </div>
        <label>
          {t("settings.density")}
          <Select
            value={p.density}
            disabled={busy}
            onChange={(e) =>
              void update({ ...p, density: e.target.value as typeof p.density })
            }
          >
            <option value="comfortable">
              {t("settings.density.comfortable")}
            </option>
            <option value="compact">{t("settings.density.compact")}</option>
          </Select>
        </label>
        <label>
          {t("settings.sort")}
          <Select
            value={p.default_sort}
            disabled={busy}
            onChange={(e) =>
              void update({ ...p, default_sort: e.target.value })
            }
          >
            <option value="updated_at">{t("settings.sort.updated")}</option>
            <option value="created_at">{t("settings.sort.created")}</option>
            <option value="visited_at">{t("settings.sort.visited")}</option>
          </Select>
        </label>
        <label>
          {t("settings.order")}
          <Select
            value={p.sort_order}
            disabled={busy}
            onChange={(e) => void update({ ...p, sort_order: e.target.value })}
          >
            <option value="desc">{t("settings.order.newest")}</option>
            <option value="asc">{t("settings.order.oldest")}</option>
          </Select>
        </label>
        <Feedback message={message} tone={tone} />
      </section>
    </section>
  );
}
