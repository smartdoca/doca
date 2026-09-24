import { SecurityVerification } from "@web/features/auth/security-verification.js";
import { AccountContacts } from "@web/features/account/account-settings.js";
import { MyMembership } from "@web/features/settings/membership-settings.js";
import { Feedback, type FeedbackTone } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { useRef, useState } from "react";
import { Pencil, Camera } from "lucide-react";
import { api, assetUrl, fileUrl, uploadFile, type FileItem, type Me } from "@web/shared/api.js";
import { LinkedIdentities } from "@web/features/auth/authentication.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import { ActivityCalendar } from "@web/features/workspace/activity-calendar.js";
export const avatars: Record<string, string> = {
  fox: "🦊",
  panda: "🐼",
  cat: "🐱",
  whale: "🐳",
  leaf: "🌿",
  sun: "☀️",
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
  return (
    <span className={"user-avatar " + (avatar ?? "initials")}>
      {sourceUrl && /^https:\/\//.test(sourceUrl) ? (
        <img
          src={sourceUrl}
          referrerPolicy="no-referrer"
          alt={name + "的头像"}
        />
      ) : assetId ? (
        <img src={assetUrl(assetId)} alt={name + "的头像"} />
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
  const fallbackName = me.user.display_name || me.user.public_id || me.user.id,
    [name, setName] = useState(me.profileName || fallbackName),
    [avatar, setAvatar] = useState(me.preferences.avatar),
    [assetId, setAssetId] = useState(me.preferences.avatar_asset_id ?? null),
    [tone, setTone] = useState<FeedbackTone>("success"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editingName, setEditingName] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [folderPicker, setFolderPicker] = useState(false),
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
      setName(latest.profileName || latest.user.display_name || latest.user.public_id || latest.user.id);
      setAvatar(latest.preferences.avatar);
      setAssetId(latest.preferences.avatar_asset_id ?? null);
      setEditingName(false);
      await saved();
      window.dispatchEvent(new Event("profile-updated"));
      setTone("success");
      setMessage("已自动保存");
    } catch (e) {
      setTone("error");
      setMessage((e as Error).message);
      try {
        const latest = await api<Me>("/me");
        version.current = latest.preferences.version;
        setName(latest.profileName || latest.user.display_name || latest.user.public_id || latest.user.id);
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
      <h1>个人信息</h1>
      <p className="subtle">管理对协作者展示的资料与账号安全。</p>
      <section className="settings-card">
        <h2>个人资料</h2>
        <div className="profile-preview">
          <button
            hidden={me.fields?.avatar.enabled === false}
            className="profile-avatar-upload"
            aria-label="上传头像"
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
                  aria-label="昵称"
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
                  aria-label="编辑昵称"
                >
                  <strong>{name || "添加昵称"}</strong>
                  <Pencil size={15} />
                </button>
              ))}
            {me.fields?.avatar.enabled !== false && (
              <small>上传自己的头像，或选择下方预设图案</small>
            )}
            <small className="profile-public-id">
              用户标识：@{me.user.public_id ?? me.user.id}
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
        {sourceOpen && <FileSourceDialog title="选择头像" close={() => setSourceOpen(false)} chooseDoca={() => setFolderPicker(true)} chooseLocal={() => upload.current?.click()} />}
        {folderPicker && <FolderFilePicker accept={(item) => item.mime.startsWith("image/")} close={() => setFolderPicker(false)} select={async (item: FileItem) => { const response = await fetch(fileUrl(item.id)); if (!response.ok) throw new Error("图片读取失败"); const asset = await uploadFile(new File([await response.blob()], item.name, { type: item.mime }), "avatar"); await update({ avatarAssetId: asset.id }); }} />}
        <small className="subtle" hidden={me.fields?.avatar.enabled === false}>
          PNG、JPEG、WebP、GIF，最大 5MB；自动裁切为正方形。
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
              aria-label={"头像：" + (avatars[key] ?? "昵称首字")}
              aria-pressed={!assetId && avatar === key}
              disabled={busy || me.editable?.avatar === false}
              onClick={() => void update({ avatar: key, avatarAssetId: null })}
            >
              <Avatar name={name || "我"} avatar={key} />
            </button>
          ))}
        </div>
        <Feedback message={message} tone={tone} />
      </section>
      <ActivityCalendar />
      <MyMembership me={me} />
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
      setMessage("已自动保存");
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
      <h1>系统设置</h1>
      <p className="subtle">只影响你的使用偏好，不改变本站其他用户的设置。</p>
      <section className="settings-card">
        <h2>外观与浏览</h2>
        <div className="theme-choices" role="group" aria-label="页面色调">
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
              <strong>{theme === "light" ? "清爽浅色" : "柔和灰色"}</strong>
              <small>
                {theme === "light"
                  ? "清晰简洁，专注内容"
                  : "柔和底色，减轻视觉负担"}
              </small>
            </button>
          ))}
        </div>
        <label>
          列表密度
          <Select
            value={p.density}
            disabled={busy}
            onChange={(e) =>
              void update({ ...p, density: e.target.value as typeof p.density })
            }
          >
            <option value="comfortable">舒适</option>
            <option value="compact">紧凑</option>
          </Select>
        </label>
        <label>
          默认排序
          <Select
            value={p.default_sort}
            disabled={busy}
            onChange={(e) =>
              void update({ ...p, default_sort: e.target.value })
            }
          >
            <option value="updated_at">修改时间</option>
            <option value="created_at">创建时间</option>
            <option value="visited_at">访问时间</option>
          </Select>
        </label>
        <label>
          顺序
          <Select
            value={p.sort_order}
            disabled={busy}
            onChange={(e) => void update({ ...p, sort_order: e.target.value })}
          >
            <option value="desc">最新在前</option>
            <option value="asc">最早在前</option>
          </Select>
        </label>
        <Feedback message={message} tone={tone} />
      </section>
    </section>
  );
}
