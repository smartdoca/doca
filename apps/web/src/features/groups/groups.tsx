import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Copy,
  Link2,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import { writeClipboardText } from "@web/shared/clipboard.js";
import { realtime } from "@web/features/documents/realtime.js";
import { accessText } from "@web/features/documents/access-management.js";
import { GroupAvatar } from "./group-avatar.js";
import "./groups.css";

type Person = {
  id: string;
  display_name: string;
  public_id: string;
  avatar?: string;
  avatar_asset_id?: string | null;
};
export type Group = {
  id: string;
  name: string;
  avatar: string | null;
  revision: number;
  role: "owner" | "admin" | "member";
  owner: Person;
  memberCount: number;
};
type Invitation = {
  id: string;
  name: string;
  avatar: string | null;
  inviter_name: string;
  group_id: string;
};
type ResourceInvitation = { id: string; title: string; role: string };
type GroupDetail = Group & {
  members: (Person & { role: Group["role"] })[];
  invitations: (Person & { invitation_id: string })[];
  resourceInvitations: ResourceInvitation[];
  inviteLink: { expiresAt: string } | null;
};

export function GroupsPage({ userId, hash }: { userId: string; hash: string }) {
  const { t } = useI18n();
  const id = /^#\/groups\/([a-f0-9-]{36})(?:\?|$)/.exec(hash)?.[1];
  const token = hash.startsWith("#/groups/join?")
    ? new URLSearchParams(hash.split("?")[1]).get("token")
    : null;
  const [list, setList] = useState<{
    items: Group[];
    invitations: Invitation[];
  }>();
  const [detail, setDetail] = useState<GroupDetail>();
  const [join, setJoin] = useState<{
    id: string;
    name: string;
    avatar: string | null;
    memberCount: number;
  }>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"create" | "edit" | "invite" | null>(null);
  const [name, setName] = useState(""),
    [avatar, setAvatar] = useState<string | null>(null);
  const [tab, setTab] = useState<"name" | "link">("name");
  const [person, setPerson] = useState<Pick<
    Person,
    "id" | "display_name"
  > | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  async function load(signal?: AbortSignal) {
    if (token)
      setJoin(
        await api(
          `/groups/join/${encodeURIComponent(token)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    else if (id)
      setDetail(await api(`/groups/${id}`, "GET", undefined, signal));
    else setList(await api("/groups", "GET", undefined, signal));
  }
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setList(undefined);
    setJoin(undefined);
    setError("");
    setNotice("");
    setModal(null);
    setLink(null);
    setQuery("");
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    const stop = realtime.subscribe((message) => {
      if (message.type === "notifications.changed")
        void load(controller.signal).catch(() => {});
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [hash, userId]);
  async function act(
    path: string,
    method: "POST" | "PUT" | "DELETE",
    body: unknown = {},
    after?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, method, body);
      if (after) after();
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(create: boolean) {
    setName(create ? "" : detail!.name);
    setAvatar(create ? null : detail!.avatar);
    setModal(create ? "create" : "edit");
    setError("");
  }
  async function upload(file?: File) {
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw Error(t("groups.error.invalid"));
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const context = canvas.getContext("2d")!;
      const edge = Math.min(bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        (bitmap.width - edge) / 2,
        (bitmap.height - edge) / 2,
        edge,
        edge,
        0,
        0,
        128,
        128,
      );
      bitmap.close();
      setAvatar(canvas.toDataURL("image/png"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("groups.error.invalid"));
    }
  }
  const roleLabel = (role: Group["role"]) =>
    t(
      role === "owner"
        ? "groups.owner"
        : role === "admin"
          ? "groups.admin"
          : "groups.member",
    );
  const manager = detail && detail.role !== "member";
  const shown = list?.items.filter((group) =>
    group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="groups-page">
      {error && <Feedback message={error} tone="error" />}
      {notice && <Feedback message={notice} tone="success" />}
      {token && join ? (
        <div className="group-join">
          <GroupAvatar name={join.name} avatar={join.avatar} />
          <h1>{t("groups.joinTitle", { name: join.name })}</h1>
          <p>{t("groups.memberCount", { count: join.memberCount })}</p>
          <p>{t("groups.joinHelp")}</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(
                `/groups/join/${encodeURIComponent(token)}`,
                "POST",
                {},
                () => {
                  location.hash = `/groups/${join.id}`;
                },
              )
            }
          >
            {t("groups.join")}
          </button>
        </div>
      ) : detail ? (
        <>
          <a className="groups-back" href="#/groups">
            <ArrowLeft size={16} />
            {t("groups.back")}
          </a>
          <header className="groups-header group-detail-header">
            <GroupAvatar name={detail.name} avatar={detail.avatar} />
            <div className="group-heading">
              <h1>{detail.name}</h1>
              <p>
                {t("groups.memberCount", { count: detail.memberCount })}
                <span>·</span>
                {roleLabel(detail.role)}
              </p>
            </div>
            <div className="group-actions">
              {manager && (
                <>
                  <button disabled={busy} onClick={() => edit(false)}>
                    <Settings size={16} />
                    {t("groups.edit")}
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setModal("invite");
                      setTab("name");
                      setPerson(null);
                    }}
                  >
                    <Plus size={16} />
                    {t("groups.invite")}
                  </button>
                </>
              )}
            </div>
          </header>
          {!!detail.resourceInvitations.length && (
            <section className="group-invitations">
              <h2>{t("groups.resourceInvitations")}</h2>
              {detail.resourceInvitations.map((i) => (
                <div className="group-invitation-row" key={i.id}>
                  <div>
                    <strong>
                      {t("groups.resourceInvite", { name: i.title })}
                    </strong>
                    <small>
                      {i.role === "admin"
                        ? t("groups.admin")
                        : accessText(t, i.role)}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/groups/${id}/resource-invitations/${i.id}`,
                        "POST",
                        { accept: false },
                      )
                    }
                  >
                    {t("groups.reject")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/groups/${id}/resource-invitations/${i.id}`,
                        "POST",
                        { accept: true },
                      )
                    }
                  >
                    {t("groups.accept")}
                  </button>
                </div>
              ))}
            </section>
          )}
          <div className="group-members-title">
            <h2>{t("groups.members")}</h2>
          </div>
          <div className="group-members">
            {detail.members.map((member) => (
              <div className="group-member-row" key={member.id}>
                <UserBadge passive id={member.id} name={member.display_name} />
                <span className="group-member-public">@{member.public_id}</span>
                {member.id === userId && <small>{t("groups.you")}</small>}
                <span className={`group-role group-role-${member.role}`}>
                  {member.role !== "member" && <ShieldCheck size={13} />}
                  {roleLabel(member.role)}
                </span>
                <div className="group-member-actions">
                  {detail.role === "owner" && member.id !== userId && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            `/groups/${id}/members/${member.id}`,
                            "PUT",
                            {
                              revision: detail.revision,
                              role:
                                member.role === "admin" ? "member" : "admin",
                            },
                          )
                        }
                      >
                        {t(
                          member.role === "admin"
                            ? "groups.removeAdmin"
                            : "groups.makeAdmin",
                        )}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              t("groups.transferConfirm", {
                                name: member.display_name,
                              }),
                            )
                          )
                            void act(`/groups/${id}/transfer`, "POST", {
                              revision: detail.revision,
                              userId: member.id,
                            });
                        }}
                      >
                        {t("groups.transfer")}
                      </button>
                    </>
                  )}
                  {manager &&
                    member.id !== userId &&
                    (detail.role === "owner" || member.role === "member") && (
                      <button
                        className="group-danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              t("groups.removeConfirm", {
                                name: member.display_name,
                              }),
                            )
                          )
                            void act(
                              `/groups/${id}/members/${member.id}`,
                              "DELETE",
                              { revision: detail.revision },
                            );
                        }}
                      >
                        {t("groups.remove")}
                      </button>
                    )}
                </div>
              </div>
            ))}
          </div>
          {!!detail.invitations.length && (
            <section className="group-invitations">
              <h2>{t("groups.pending")}</h2>
              {detail.invitations.map((i) => (
                <div className="group-invitation-row" key={i.invitation_id}>
                  <UserBadge passive id={i.id} name={i.display_name} />
                  <small>{t("groups.pending")}</small>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/groups/${id}/invitations/${i.invitation_id}`,
                        "DELETE",
                        { revision: detail.revision },
                      )
                    }
                  >
                    {t("groups.cancel")}
                  </button>
                </div>
              ))}
            </section>
          )}
          <footer className="group-footer">
            {detail.role === "owner" ? (
              <>
                <p>{t("groups.ownerLeave")}</p>
                <button
                  className="group-danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        t("groups.dissolveConfirm", { name: detail.name }),
                      )
                    )
                      void act(
                        `/groups/${id}`,
                        "DELETE",
                        { revision: detail.revision },
                        () => {
                          location.hash = "/groups";
                        },
                      );
                  }}
                >
                  {t("groups.dissolve")}
                </button>
              </>
            ) : (
              <button
                className="group-danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(t("groups.leaveConfirm", { name: detail.name })))
                    void act(
                      `/groups/${id}/leave`,
                      "POST",
                      { revision: detail.revision },
                      () => {
                        location.hash = "/groups";
                      },
                    );
                }}
              >
                {t("groups.leave")}
              </button>
            )}
          </footer>
        </>
      ) : list ? (
        <>
          <header className="groups-header">
            <div>
              <h1>{t("groups.title")}</h1>
            </div>
            <button className="primary" onClick={() => edit(true)}>
              <Plus size={17} />
              {t("groups.create")}
            </button>
          </header>
          {!!list.invitations.length && (
            <section className="group-invitations">
              <h2>{t("groups.invitations")}</h2>
              {list.invitations.map((i) => (
                <div className="group-invitation-row" key={i.id}>
                  <GroupAvatar name={i.name} avatar={i.avatar} />
                  <div>
                    <strong>{i.name}</strong>
                    <small>
                      {t("groups.invitedBy", { name: i.inviter_name })}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(`/groups/invitations/${i.id}`, "POST", {
                        accept: false,
                      })
                    }
                  >
                    {t("groups.reject")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(`/groups/invitations/${i.id}`, "POST", {
                        accept: true,
                      })
                    }
                  >
                    {t("groups.accept")}
                  </button>
                </div>
              ))}
            </section>
          )}
          {!!list.items.length && (
            <div className="group-search">
              <Search size={16} />
              <input
                aria-label={t("common.search")}
                placeholder={t("common.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          {!list.items.length ? (
            <div className="groups-empty">
              <Users size={42} />
              <h2>{t("groups.empty")}</h2>
              <p>{t("groups.emptyHelp")}</p>
              <button onClick={() => edit(true)}>{t("groups.create")}</button>
            </div>
          ) : (
            <div className="groups-grid">
              {shown?.map((group) => (
                <a
                  className="group-card"
                  href={`#/groups/${group.id}`}
                  key={group.id}
                >
                  <GroupAvatar name={group.name} avatar={group.avatar} />
                  <div className="group-card-title">
                    <strong>{group.name}</strong>
                    <span>{roleLabel(group.role)}</span>
                  </div>
                  <p>{t("groups.memberCount", { count: group.memberCount })}</p>
                  <div className="group-card-owner">
                    <span>{t("groups.owner")}</span>
                    <span>{group.owner.display_name}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        !error && <p className="empty">{t("groups.loading")}</p>
      )}
      {(modal === "create" || modal === "edit") && (
        <Dialog
          className="modal-compact"
          title={t(modal === "create" ? "groups.create" : "groups.edit")}
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="group-avatar-editor">
            <GroupAvatar name={name} avatar={avatar} />
            <label className="group-upload">
              {t("groups.changeAvatar")}
              <input
                aria-label={t("groups.avatar")}
                type="file"
                accept="image/*"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
            </label>
          </div>
          <label className="group-name-field">
            {t("groups.name")}
            <input
              autoFocus
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <footer>
            <button disabled={busy} onClick={() => setModal(null)}>
              {t("groups.cancel")}
            </button>
            <button
              className="primary"
              disabled={busy || !name.trim()}
              onClick={() =>
                void act(
                  modal === "create" ? "/groups" : `/groups/${id}`,
                  modal === "create" ? "POST" : "PUT",
                  {
                    name: name.trim(),
                    avatar,
                    ...(detail && modal === "edit"
                      ? { revision: detail.revision }
                      : {}),
                  },
                  () => {
                    setModal(null);
                    void load().catch((e) => setError(e.message));
                  },
                )
              }
            >
              {t("groups.save")}
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "invite" && detail && (
        <Dialog
          className="modal-compact"
          title={t("groups.invite")}
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <p>{t("groups.inviteHelp")}</p>
          <div className="group-invite-tabs">
            <button
              className={tab === "name" ? "active" : ""}
              onClick={() => setTab("name")}
            >
              <Search size={16} />
              {t("groups.byName")}
            </button>
            <button
              className={tab === "link" ? "active" : ""}
              onClick={() => setTab("link")}
            >
              <Link2 size={16} />
              {t("groups.byLink")}
            </button>
          </div>
          {tab === "name" ? (
            <PersonPicker
              selected={person}
              select={setPerson}
              clear={() => setPerson(null)}
            />
          ) : (
            <div className="group-link">
              <p>{t("groups.linkHelp")}</p>
              {!link && detail.inviteLink && <p>{t("groups.activeLink")}</p>}
              {link && (
                <>
                  <input
                    readOnly
                    aria-label={t("groups.byLink")}
                    value={new URL(link.url, location.href).href}
                  />
                  <small>{t("groups.linkExpires")}</small>
                </>
              )}
            </div>
          )}
          <footer>
            {tab === "name" ? (
              <button
                className="primary"
                disabled={busy || !person}
                onClick={() =>
                  void act(
                    `/groups/${id}/invitations`,
                    "POST",
                    { userId: person!.id, revision: detail.revision },
                    () => {
                      setNotice(t("groups.sent"));
                      setPerson(null);
                      void load().catch((e) => setError(e.message));
                    },
                  )
                }
              >
                {t("groups.send")}
              </button>
            ) : (
              <>
                {(link || detail.inviteLink) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        `/groups/${id}/invite-link`,
                        "DELETE",
                        { revision: detail.revision },
                        () => {
                          setLink(null);
                          void load().catch((e) => setError(e.message));
                        },
                      )
                    }
                  >
                    {t("groups.disableLink")}
                  </button>
                )}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      if (link) {
                        await writeClipboardText(
                          new URL(link.url, location.href).href,
                        );
                        setNotice(t("groups.copied"));
                      } else {
                        setLink(
                          await api(`/groups/${id}/invite-link`, "POST", {
                            revision: detail.revision,
                          }),
                        );
                        await load();
                      }
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {link ? <Copy size={16} /> : <Link2 size={16} />}
                  {t(
                    link
                      ? "groups.copy"
                      : detail.inviteLink
                        ? "groups.replaceLink"
                        : "groups.newLink",
                  )}
                </button>
              </>
            )}
          </footer>
        </Dialog>
      )}
    </section>
  );
}
