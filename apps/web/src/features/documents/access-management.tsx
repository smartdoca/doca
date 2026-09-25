import { htmlLang } from "@doca/i18n";
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
export type Manager = {
  id: string;
  display_name: string;
  public_id?: string;
  role?: string;
};
export function Administrators({ items = [] }: { items?: Manager[] }) {
const { t, locale } = useI18n();

  return items.length > 0 ? (
    <div className="access-administrators">
      <span>{t("accessUi.managers")}</span>
      {items.map((u) => (
        <span key={u.id}>
          <UserBadge id={u.id} name={u.display_name} />
          {u.role === "owner" ? t("accessUi.ownerSuffix") : ""}
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
  const { t, locale } = useI18n();
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
            <p>{t("accessUi.sender")}<UserBadge id={i.inviter.id} name={i.inviter.display_name} />
            </p>
          )}
          <p>
            {t("sharingUi.createdAt", { date: new Date(i.created_at).toLocaleString(htmlLang(locale)) })} ·{" "}
            {i.expires_at
              ? t("sharingUi.expiresAt", { date: new Date(i.expires_at).toLocaleString(htmlLang(locale)) })
              : t("sharingUi.noExpiry")}
          </p>
          {i.decider && (
            <p>{t("accessUi.handler")}<UserBadge id={i.decider.id} name={i.decider.display_name} />
            </p>
          )}
          {i.canCancel && (
            <button disabled={busy} onClick={() => void act(i, "cancel")}>{t("accessUi.revokeInvite")}</button>
          )}
          {i.canResend && (
            <button
              disabled={busy}
              onClick={() => {
                setEditing(i);
                setRole(i.role);
                setExpires("");
              }}
            >{t("accessUi.resend")}</button>
          )}
          {editing?.key === i.key && (
            <div>
              <Select
                aria-label={t("accessUi.invitationRole")}
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
              <label>{t("accessUi.invitationExpiry")}<input
                  type="datetime-local"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void act(i, "resend")}>{t("accessUi.confirmResend")}</button>
              <button onClick={() => setEditing(null)}>{t("common.cancel")}</button>
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
const { t, locale } = useI18n();

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
      <p className="subtle">{t("accessUi.manageHelp")}</p>
      <label className="permissions-filter">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />{t("accessUi.includeEnded")}</label>
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
          {all ? t("accessUi.noInvitations") : t("accessUi.noPending")}
        </p>
      )}
      {error && <Feedback tone="error" message={error} />}
    </section>
  );
}
