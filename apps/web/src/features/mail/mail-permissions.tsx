import { ArrowLeft, ChevronRight, Copy, Link2, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Select } from "@web/shared/components/select.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
import "@web/features/documents/permissions.css";

type ShareRole = "admin" | "sender" | "reader";
type Member = { user_id: string; role: ShareRole; version: number; display_name: string; public_id?: string | null };
type Person = { id: string; display_name: string; public_id?: string | null };
type Overview = {
  owner: Person | null;
  currentUser: Person | null;
  members: Member[];
  role: "owner" | ShareRole;
  isOwner: boolean;
  canManage: boolean;
  shareable: boolean;
};
type ShareLink = { enabled: boolean; role: ShareRole; token: string | null; url: string | null; isOwner: boolean; shareable: boolean };
type Page = "main" | "invite" | "members";
const labels = { owner: "所有者", admin: "管理员", sender: "可发邮件", reader: "只读用户" } as const;

export function MailPermissionPanel({
  mailboxId,
  close,
}: {
  mailboxId: string;
  close: () => void;
}) {
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
      api<Overview>(`/mail/mailboxes/${mailboxId}/shares`),
      api<ShareLink>(`/mail/mailboxes/${mailboxId}/share-link`),
    ]);
    setOverview(nextOverview);
    setLink(nextLink);
  }
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [mailboxId]);

  async function addMember() {
    if (!person) return;
    setBusy(true); setError("");
    try {
      await api(`/mail/mailboxes/${mailboxId}/shares`, "PUT", { userId: person.id, role });
      setPerson(null); setNotice("协作者已添加"); setPage("main"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "添加协作者失败"); }
    finally { setBusy(false); }
  }
  async function updateMember(member: Member, nextRole: ShareRole | null) {
    setBusy(true); setError("");
    try {
      if (nextRole) await api(`/mail/mailboxes/${mailboxId}/shares`, "PUT", { userId: member.user_id, role: nextRole });
      else await api(`/mail/mailboxes/${mailboxId}/shares/${member.user_id}`, "DELETE");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "权限更新失败"); }
    finally { setBusy(false); }
  }
  async function updateLink(change: Partial<Pick<ShareLink, "enabled" | "role">> & { rotate?: boolean }) {
    if (!link) return;
    setBusy(true); setError("");
    try {
      setLink(await api<ShareLink>(`/mail/mailboxes/${mailboxId}/share-link`, "PUT", { enabled: change.enabled ?? link.enabled, role: change.role ?? link.role, rotate: change.rotate }));
    } catch (e) { setError(e instanceof Error ? e.message : "分享链接设置失败"); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!link?.url) return;
    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${link.url}`);
    setNotice("分享链接已复制");
  }
  const title = page === "main" ? "分享与权限" : page === "invite" ? "邀请协作者" : "协作者";
  return <div ref={panel} className="permissions-panel permissions-floating folder-permissions-panel" role="dialog" aria-label="分享与权限" onKeyDown={(event) => { if (event.key === "Escape") page === "main" ? close() : setPage("main"); }}>
    <header className="permissions-header">
      <div className="permissions-heading">{page !== "main" && <button className="icon" aria-label="返回分享" onClick={() => setPage("main")}><ArrowLeft size={18} /></button>}<h2>{title}</h2></div>
      <div className="permissions-header-actions"><button className="icon" aria-label="关闭分享与权限" onClick={close}><X size={18} /></button></div>
    </header>
    <div className="permissions-body" aria-busy={busy}>
      {error && <Feedback tone="error" message={error} />}
      {notice && <Feedback tone="success" message={notice} />}
      {!overview && !error && <p className="permissions-empty">正在加载…</p>}
      {overview && !overview.shareable && <p className="permissions-empty">独立邮箱不能分享，也不能删除。</p>}
      {overview && page === "main" && <>
        <section className="permissions-self"><span className="permissions-self-title">当前用户</span>{overview.currentUser && <UserBadge id={overview.currentUser.id} name={overview.currentUser.display_name} passive />}<span className="permissions-self-role">{labels[overview.role]}</span></section>
        <section className="permissions-collaboration">
          <button type="button" className="permissions-collaborators" disabled={!overview.canManage} aria-label={`协作者，${overview.members.length}人`} onClick={() => setPage("members")}><span>邀请协作者</span><span className="permissions-avatars">{overview.members.slice(0, 5).map((member) => <UserBadge key={member.user_id} id={member.user_id} name={member.display_name} passive avatarOnly />)}{overview.members.length > 5 && <span className="permissions-more">+{overview.members.length - 5}</span>}{overview.canManage && <ChevronRight size={17} />}</span></button>
          {overview.canManage && <button type="button" className="permissions-invite-entry" onClick={() => setPage("invite")}><Search size={16} /><span>搜索用户名或昵称，邀请协作者</span></button>}
        </section>
        {overview.canManage && link && <section className="permissions-section share-settings folder-share-link-settings">
          <div className="permissions-section-heading"><h3>链接分享</h3><label className="permissions-switch"><input role="switch" type="checkbox" checked={link.enabled} disabled={busy} onChange={(event) => void updateLink({ enabled: event.target.checked })} /></label></div>
          {link.enabled && <><div className="permissions-link-row"><span className="permissions-link-icon"><Link2 size={21} /></span><span className="permissions-link-label"><strong>获得链接并加入的人</strong><small>登录后加入协作</small></span><Select aria-label="链接权限" value={link.role} disabled={busy} onChange={(event) => void updateLink({ role: event.target.value as ShareRole })}><option value="reader">只读</option><option value="sender">可发邮件</option>{link.isOwner && <option value="admin">可管理</option>}</Select><button className="primary" onClick={() => void copyLink()}><Copy size={16} />复制链接</button></div><button className="permissions-text-button" disabled={busy} onClick={() => void updateLink({ rotate: true })}>链接设置 · 更换链接</button></>}
        </section>}
      </>}
      {overview?.canManage && page === "invite" && <form className="permissions-invite-form" onSubmit={(event) => { event.preventDefault(); void addMember(); }}><fieldset className="permissions-form" disabled={busy}><div className="permissions-invite-recipient"><h3>选择协作者</h3><PersonPicker autoFocus selected={person} clear={() => setPerson(null)} select={setPerson} /></div><label>授予权限<Select aria-label="邀请权限" value={role} onChange={(event) => setRole(event.target.value as ShareRole)}><option value="reader">只读用户</option><option value="sender">可发邮件</option>{overview.isOwner && <option value="admin">管理员</option>}</Select></label><footer><button type="button" onClick={() => setPage("main")}>取消</button><button className="primary" type="submit" disabled={!person || busy}>{busy ? "正在添加…" : "添加协作者"}</button></footer></fieldset></form>}
      {overview?.canManage && page === "members" && <>{overview.members.map((member) => { const canAdjust = overview.isOwner || member.role !== "admin"; return <div className="permissions-member" key={member.user_id}><div className="permissions-person"><UserBadge id={member.user_id} name={member.display_name} /><small>@{member.public_id || member.user_id}</small></div>{canAdjust ? <div className="permissions-member-controls"><Select aria-label={`${member.display_name}的权限`} value={member.role} disabled={busy} onChange={(event) => void updateMember(member, event.target.value as ShareRole)}><option value="reader">只读用户</option><option value="sender">可发邮件</option>{overview.isOwner && <option value="admin">管理员</option>}</Select><button className="icon" disabled={busy} onClick={() => void updateMember(member, null)} aria-label={`移除${member.display_name}`}><Trash2 size={15} /></button></div> : <span className="permissions-member-role">{labels[member.role]}</span>}</div>; })}{!overview.members.length && <p className="permissions-empty">暂无协作者</p>}</>}
    </div>
  </div>;
}
