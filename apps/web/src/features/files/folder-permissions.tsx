import { useI18n } from "@web/shared/i18n.js";
import { ArrowLeft, ChevronRight, Copy, Link2, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type FileFolder } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Select } from "@web/shared/components/select.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import "@web/features/documents/permissions.css";

type ShareRole = "admin" | "reader";
type Member = { user_id: string; role: ShareRole; version: number; display_name: string; public_id?: string | null };
type Person = { id: string; display_name: string; public_id?: string | null };
type Overview = {
  owner: Person | null;
  currentUser: Person | null;
  members: Member[];
  role: "owner" | ShareRole;
  isOwner: boolean;
  canManage: boolean;
};
type ShareLink = { enabled: boolean; role: ShareRole; token: string | null; url: string | null; isOwner: boolean };
type Page = "main" | "invite" | "members";


export function FolderPermissionPanel({ folder, close }: { folder: FileFolder; close: () => void }) {
const { t } = useI18n();
const labels = { owner: t("search.owner"), admin: t("admin.badge"), reader: t("fileManager.reader") } as const;

  const [page, setPage] = useState<Page>("main");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [person, setPerson] = useState<{ id: string; display_name: string } | null>(null);
  const [role, setRole] = useState<ShareRole>("reader");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-permissions-popup]")) return;
      const popup = target.closest("[role=listbox]");
      if (popup && Array.from(panel.current?.querySelectorAll("[aria-controls]") ?? []).some((trigger) => trigger.getAttribute("aria-controls") === popup.id)) return;
      if (!panel.current?.contains(target) && !target.closest("[data-permissions-trigger]")) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [close]);

  async function load() {
    setError("");
    const [nextOverview, nextLink] = await Promise.all([
      api<Overview>(`/files/folders/${folder.id}/shares`),
      api<ShareLink>(`/files/folders/${folder.id}/share-link`),
    ]);
    setOverview(nextOverview);
    setLink(nextLink);
  }
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [folder.id]);

  async function addMember() {
    if (!person) return;
    setBusy(true); setError("");
    try {
      await api(`/files/folders/${folder.id}/shares`, "PUT", { userId: person.id, role });
      setPerson(null); setNotice(t("sharingUi.added")); setPage("main"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("sharingUi.addFailed")); }
    finally { setBusy(false); }
  }
  async function updateMember(member: Member, nextRole: ShareRole | null) {
    setBusy(true); setError("");
    try {
      if (nextRole) await api(`/files/folders/${folder.id}/shares`, "PUT", { userId: member.user_id, role: nextRole });
      else await api(`/files/folders/${folder.id}/shares/${member.user_id}`, "DELETE");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("sharingUi.updateFailed")); }
    finally { setBusy(false); }
  }
  async function updateLink(change: Partial<Pick<ShareLink, "enabled" | "role">> & { rotate?: boolean }) {
    if (!link) return;
    setBusy(true); setError("");
    try {
      setLink(await api<ShareLink>(`/files/folders/${folder.id}/share-link`, "PUT", { enabled: change.enabled ?? link.enabled, role: change.role ?? link.role, rotate: change.rotate }));
    } catch (e) { setError(e instanceof Error ? e.message : t("sharingUi.settingsFailed")); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!link?.url) return;
    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${link.url}`);
    setNotice(t("sharingUi.linkCopied"));
  }
  const title = page === "main" ? t("share.title") : page === "invite" ? t("share.invite") : t("share.members");
  return <div ref={panel} className="permissions-panel permissions-floating folder-permissions-panel" role="dialog" aria-label={t("share.title")} onKeyDown={(event) => { if (event.key === "Escape") page === "main" ? close() : setPage("main"); }}>
    <header className="permissions-header">
      <div className="permissions-heading">{page !== "main" && <button className="icon" aria-label={t("sharingUi.back")} onClick={() => setPage("main")}><ArrowLeft size={18} /></button>}<h2>{title}</h2></div>
      <div className="permissions-header-actions"><button className="icon" aria-label={t("sharingUi.close")} onClick={close}><X size={18} /></button></div>
    </header>
    <div className="permissions-body" aria-busy={busy}>
      {error && <Feedback tone="error" message={error} />}
      {notice && <Feedback tone="success" message={notice} />}
      {!overview && !error && <p className="permissions-empty">{t("common.loading")}</p>}
      {overview && page === "main" && <>
        <section className="permissions-self"><span className="permissions-self-title">{t("permissionsUi.currentUser")}</span>{overview.currentUser && <UserBadge id={overview.currentUser.id} name={overview.currentUser.display_name} passive />}<span className="permissions-self-role">{labels[overview.role]}</span></section>
        <section className="permissions-collaboration">
          <button type="button" className="permissions-collaborators" disabled={!overview.canManage} aria-label={t("permissionsUi.collaboratorCount", { count: overview.members.length })} onClick={() => setPage("members")}><span>{t("share.invite")}</span><span className="permissions-avatars">{overview.members.slice(0, 5).map((member) => <UserBadge key={member.user_id} id={member.user_id} name={member.display_name} passive avatarOnly />)}{overview.members.length > 5 && <span className="permissions-more">+{overview.members.length - 5}</span>}{overview.canManage && <ChevronRight size={17} />}</span></button>
          {overview.canManage && <button type="button" className="permissions-invite-entry" onClick={() => setPage("invite")}><Search size={16} /><span>{t("permissionsUi.search")}</span></button>}
        </section>
        {overview.canManage && link && <section className="permissions-section share-settings folder-share-link-settings">
          <div className="permissions-section-heading"><h3>{t("sharingUi.linkSharing")}</h3><label className="permissions-switch"><input role="switch" type="checkbox" checked={link.enabled} disabled={busy} onChange={(event) => void updateLink({ enabled: event.target.checked })} /></label></div>
          {link.enabled && <><div className="permissions-link-row"><span className="permissions-link-icon"><Link2 size={21} /></span><span className="permissions-link-label"><strong>{t("sharingUi.linkAudience")}</strong><small>{t("sharingUi.joinAfterLogin")}</small></span><Select aria-label={t("sharingUi.permission")} value={link.role} disabled={busy} onChange={(event) => void updateLink({ role: event.target.value as ShareRole })}><option value="reader">{t("role.reader")}</option>{link.isOwner && <option value="admin">{t("role.manager")}</option>}</Select><button className="primary" onClick={() => void copyLink()}><Copy size={16} />{t("sharingUi.copyLink")}</button></div><button className="permissions-text-button" disabled={busy} onClick={() => void updateLink({ rotate: true })}>{t("sharingUi.changeLink")}</button></>}
        </section>}
      </>}
      {overview?.canManage && page === "invite" && <form className="permissions-invite-form" onSubmit={(event) => { event.preventDefault(); void addMember(); }}><fieldset className="permissions-form" disabled={busy}><div className="permissions-invite-recipient"><h3>{t("dialog.chooseCollaborator")}</h3><PersonPicker autoFocus selected={person} clear={() => setPerson(null)} select={setPerson} /></div><label>{t("permissionsUi.grant")}<Select aria-label={t("permissionsUi.inviteAccess")} value={role} onChange={(event) => setRole(event.target.value as ShareRole)}><option value="reader">{t("fileManager.reader")}</option>{overview.isOwner && <option value="admin">{t("admin.badge")}</option>}</Select></label><footer><button type="button" onClick={() => setPage("main")}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!person || busy}>{busy ? t("sharingUi.adding") : t("sharingUi.addCollaborator")}</button></footer></fieldset></form>}
      {overview?.canManage && page === "members" && <>{overview.members.map((member) => { const canAdjust = overview.isOwner || member.role === "reader"; return <div className="permissions-member" key={member.user_id}><div className="permissions-person"><UserBadge id={member.user_id} name={member.display_name} /><small>@{member.public_id || member.user_id}</small></div>{canAdjust ? <div className="permissions-member-controls"><Select aria-label={t("permissionsUi.accessFor", { name: member.display_name })} value={member.role} disabled={busy} onChange={(event) => void updateMember(member, event.target.value as ShareRole)}><option value="reader">{t("fileManager.reader")}</option>{overview.isOwner && <option value="admin">{t("admin.badge")}</option>}</Select><button className="icon" disabled={busy} onClick={() => void updateMember(member, null)} aria-label={t("permissionsUi.removePerson", { name: member.display_name })}><Trash2 size={15} /></button></div> : <span className="permissions-member-role">{labels[member.role]}</span>}</div>; })}{!overview.members.length && <p className="permissions-empty">{t("permissionsUi.noCollaborators")}</p>}</>}
    </div>
  </div>;
}
