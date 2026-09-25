import "@web/features/documents/permissions.css";
import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";
export const accessLabelKeys: Record<string, MessageKey> = {
  reader: "role.reader",
  commenter: "role.commenter",
  editor: "role.editor",
  manager: "role.manager",
  owner: "role.owner",
  pending: "role.pending",
  accepted: "role.accepted",
  rejected: "role.rejected",
  cancelled: "role.cancelled",
  expired: "role.expired",
};
export function accessText(
  t: (key: MessageKey) => string,
  key: string,
) {
  const message = accessLabelKeys[key];
  return message ? t(message) : key;
}
export const accessLabels: Record<string, string> = {
  reader: "可阅读",
  commenter: "可评论",
  editor: "可编辑",
  manager: "可管理",
  owner: "所有者",
  pending: "待接受",
  accepted: "已接受",
  rejected: "已拒绝",
  cancelled: "已撤销",
  expired: "已过期",
};
export type Manager = {
  id: string;
  display_name: string;
  public_id?: string;
  role?: string;
};
export function Administrators({ items = [] }: { items?: Manager[] }) {
  return items.length > 0 ? (
    <div className="access-administrators">
      <span>可联系的管理人员：</span>
      {items.map((u) => (
        <span key={u.id}>
          <UserBadge id={u.id} name={u.display_name} />
          {u.role === "owner" ? "（所有者）" : ""}
        </span>
      ))}
    </div>
  ) : null;
}
export type Invitation = {
  id: string;
  key: string;
  resource_id: string;
  user_id: string;
  title: string;
  role: string;
  state: string;
  version: number;
  incoming: boolean;
  outgoing: boolean;
  canCancel: boolean;
  canResend: boolean;
  created_at: string;
  expires_at: string | null;
  user?: Manager;
  inviter?: Manager;
  decider?: Manager;
  administrators?: Manager[];
};
export function InvitationRows({
  items,
  refresh,
  isOwner = false,
}: {
  items: Invitation[];
  refresh: () => Promise<void>;
  isOwner?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<Invitation | null>(null),
    [role, setRole] = useState("reader"),
    [expires, setExpires] = useState("");
  async function act(i: Invitation, action: "cancel" | "resend") {
    setBusy(true);
    setError("");
    try {
      await api(
        `/resources/${i.resource_id}/invitations/${i.user_id}`,
        "POST",
        {
          version: i.version,
          action,
          ...(action === "resend"
            ? {
                role,
                expiresAt: expires ? new Date(expires).toISOString() : null,
              }
            : {}),
        },
      );
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {items.map((i) => (
        <article key={i.key} className="access-record">
          <strong>{i.title}</strong>
          <p>
            {i.user && <UserBadge id={i.user.id} name={i.user.display_name} />}{" "}
            · {accessText(t, i.role)} · {accessText(t, i.state)}
          </p>
          {i.inviter && (
            <p>
              发起人：
              <UserBadge id={i.inviter.id} name={i.inviter.display_name} />
            </p>
          )}
          <p>
            发起于 {new Date(i.created_at).toLocaleString()} ·{" "}
            {i.expires_at
              ? `有效至 ${new Date(i.expires_at).toLocaleString()}`
              : "不过期"}
          </p>
          {i.decider && (
            <p>
              处理人：
              <UserBadge id={i.decider.id} name={i.decider.display_name} />
            </p>
          )}
          {i.canCancel && (
            <button disabled={busy} onClick={() => void act(i, "cancel")}>
              撤销邀请
            </button>
          )}
          {i.canResend && (
            <button
              disabled={busy}
              onClick={() => {
                setEditing(i);
                setRole(i.role);
                setExpires("");
              }}
            >
              调整并重发
            </button>
          )}
          {editing?.key === i.key && (
            <div>
              <Select
                aria-label="邀请角色"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {[
                  "reader",
                  "commenter",
                  "editor",
                  ...(isOwner || i.role === "manager" ? ["manager"] : []),
                ].map((x) => (
                  <option key={x} value={x}>
                    {accessText(t, x)}
                  </option>
                ))}
              </Select>
              <label>
                邀请有效期（留空不过期）
                <input
                  type="datetime-local"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void act(i, "resend")}>
                确认重发
              </button>
              <button onClick={() => setEditing(null)}>取消</button>
            </div>
          )}
        </article>
      ))}
      {error && <Feedback tone="error" message={error} />}
    </>
  );
}
export function DocumentInvitations({
  id,
  isOwner,
  changed,
}: {
  id: string;
  isOwner: boolean;
  changed: () => Promise<void>;
}) {
  const [items, setItems] = useState<Invitation[]>([]),
    [error, setError] = useState(""),
    [all, setAll] = useState(false);
  async function load() {
    const r = await api<{ items: Invitation[] }>(
      `/resources/${id}/invitations`,
    );
    setItems(r.items);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [id]);
  return (
    <section>
      <p className="subtle">
        管理员可以查看全部邀请，并撤销自己发出的邀请；所有者可以撤销任意邀请。
      </p>
      <label className="permissions-filter">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        包含已结束邀请
      </label>
      <InvitationRows
        items={items.filter((i) => all || i.state === "pending")}
        isOwner={isOwner}
        refresh={async () => {
          await load();
          await changed();
        }}
      />
      {!items.some((i) => all || i.state === "pending") && (
        <p className="permissions-empty">
          {all ? "暂无邀请记录" : "暂无待接受的邀请"}
        </p>
      )}
      {error && <Feedback tone="error" message={error} />}
    </section>
  );
}
