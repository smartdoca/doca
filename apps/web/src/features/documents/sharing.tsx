import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, Link as LinkIcon } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { accessLabels } from "@web/features/documents/access-management.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
type ShareLink = {
  id: string;
  enabled: boolean;
  role: string;
  includeDescendants: boolean;
  maxMembers: number | null;
  memberCount: number;
  members: {
    id: string;
    display_name: string;
    public_id?: string;
  }[];
  revoked: boolean;
  revokedAt: string | null;
  version: string;
  token: string | null;
  expiresAt: string | null;
  expired: boolean;
};
type ShareState = {
  items: ShareLink[];
  revokedItems: ShareLink[];
  sharingEnabled: boolean;
  supportsDescendants: boolean;
};
const linkUrl = (l: ShareLink) =>
  `${location.origin}${location.pathname}#/s/${l.token}`;
export function ShareLinkSettings({
  id,
  changed,
  inheritanceControl,
  inheritedEnabled,
}: {
  id: string;
  changed?: () => Promise<unknown>;
  inheritanceControl?: ReactNode;
  inheritedEnabled?: boolean;
}) {
  const allowed = useEntitlements();
  const [items, setItems] = useState<ShareLink[]>([]),
    [revokedItems, setRevokedItems] = useState<ShareLink[]>([]),
    [role, setRole] = useState("reader"),
    [includeDescendants, setIncludeDescendants] = useState(true),
    [supportsDescendants, setSupportsDescendants] = useState(true),
    [maxMembers, setMaxMembers] = useState<number | null>(1),
    [limitOpen, setLimitOpen] = useState(false),
    [draftMaxMembers, setDraftMaxMembers] = useState("1"),
    [expires, setExpires] = useState(""),
    [recordsOpen, setRecordsOpen] = useState(false),
    [recordTab, setRecordTab] = useState<"active" | "revoked">("active"),
    [expandedMembers, setExpandedMembers] = useState<string | null>(null),
    [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [advanced, setAdvanced] = useState(false),
    [confirm, setConfirm] = useState(""),
    [copied, setCopied] = useState(""),
    [fallback, setFallback] = useState("");
  const limitMenu = useRef<HTMLDivElement>(null);
  const limitTrigger = useRef<HTMLButtonElement>(null);
  const [limitPosition, setLimitPosition] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (inheritedEnabled !== undefined) setEnabled(inheritedEnabled);
  }, [inheritedEnabled]);
  useEffect(() => {
    if (!limitOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        !limitTrigger.current?.contains(event.target as Node) &&
        !limitMenu.current?.contains(event.target as Node)
      )
        setLimitOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLimitOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    const closeOnViewportChange = () => setLimitOpen(false);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [limitOpen]);
  useLayoutEffect(() => {
    if (!limitOpen || !limitTrigger.current) return;
    const rect = limitTrigger.current.getBoundingClientRect();
    const width = 238;
    const gap = 8;
    const left = Math.max(
      12,
      Math.min(rect.right - width, window.innerWidth - width - 12),
    );
    const top =
      rect.bottom + gap + 250 <= window.innerHeight
        ? rect.bottom + gap
        : Math.max(12, rect.top - gap - 250);
    setLimitPosition({ top, left });
  }, [limitOpen]);
  async function load() {
    const r = await api<ShareState>(`/resources/${id}/share-link`);
    setItems(r.items);
    setRevokedItems(r.revokedItems);
    setEnabled(r.sharingEnabled);
    setSupportsDescendants(r.supportsDescendants);
    return r.items;
  }
  useEffect(() => {
    let alive = true;
    setReady(false);
    setItems([]);
    setRevokedItems([]);
    setError("");
    setAdvanced(false);
    setRecordsOpen(false);
    setRecordTab("active");
    setExpandedMembers(null);
    void api<ShareState>(`/resources/${id}/share-link`)
      .then((r) => {
        if (alive) {
          setItems(r.items);
          setRevokedItems(r.revokedItems);
          setEnabled(r.sharingEnabled);
          setSupportsDescendants(r.supportsDescendants);
          const first = r.items.find((l) => l.enabled && !l.expired);
          setRole(first?.role ?? "reader");
          setIncludeDescendants(
            r.supportsDescendants && (first?.includeDescendants ?? true),
          );
          setMaxMembers(first?.maxMembers ?? 1);
          const end = first?.expiresAt ? new Date(first.expiresAt) : null;
          setExpires(
            end
              ? new Date(end.getTime() - end.getTimezoneOffset() * 60000)
                  .toISOString()
                  .slice(0, -1)
              : "",
          );
          setReady(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/resources/${id}/share-links/enabled`, "PUT", {
        enabled: next,
      });
      setAdvanced(false);
      setCopied("");
      setFallback("");
      setConfirm("");
      await load();
      await changed?.();
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function copy(l: ShareLink) {
    try {
      await navigator.clipboard.writeText(linkUrl(l));
      setCopied(l.id);
      setFallback("");
    } catch {
      setFallback(linkUrl(l));
      setError("请选中下方链接手动复制");
    }
  }
  async function share() {
    setBusy(true);
    setError("");
    try {
      const l = await api<ShareLink>(`/resources/${id}/share-link`, "PUT", {
        version: null,
        enabled: true,
        role,
        includeDescendants: supportsDescendants && includeDescendants,
        maxMembers,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      });
      await load();
      await changed?.();
      await copy(l);
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function change(l: ShareLink, revoke = false) {
    setBusy(true);
    setError("");
    try {
      if (revoke)
        await api(`/resources/${id}/share-links/${l.id}/revoke`, "POST", {
          version: l.version,
        });
      else
        await api(`/resources/${id}/share-link`, "PUT", {
          version: l.version,
          enabled: !l.enabled,
          role: l.role,
          includeDescendants: l.includeDescendants,
          maxMembers: l.maxMembers,
        });
      setConfirm("");
      setCopied("");
      await load();
      await changed?.();
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  function openLimitDialog() {
    setDraftMaxMembers(maxMembers === null ? "1" : String(maxMembers));
    setLimitOpen(true);
  }
  function applyLimit(selected?: number | null) {
    if (selected !== undefined) {
      setMaxMembers(selected);
      setCopied("");
      setLimitOpen(false);
      return;
    }
    const value = Number.parseInt(draftMaxMembers, 10);
    if (!Number.isInteger(value) || value < 1) return;
    setMaxMembers(value);
    setCopied("");
    setLimitOpen(false);
  }
  const recordItems = recordTab === "active" ? items : revokedItems;
  return (
    <section className="share-settings permissions-section">
      <label className="permissions-switch">
        <span>链接分享 {inheritanceControl}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="链接分享"
          checked={enabled}
          disabled={busy || !ready || (!enabled && !allowed("sharing.links"))}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </label>
      {enabled && (
        <>
          <div className="permissions-link-row">
            <span className="permissions-link-icon">
              <LinkIcon size={19} />
            </span>
            <div className="permissions-link-label">
              <span>获得链接并加入的人</span>
              <small>登录后加入协作</small>
            </div>
            <div className="permissions-link-limit-wrap">
              <button
                type="button"
                className="permissions-link-limit"
                ref={limitTrigger}
                aria-label="分享链接人数限制"
                aria-haspopup="dialog"
                aria-expanded={limitOpen}
                disabled={busy || !ready}
                onClick={() =>
                  limitOpen ? setLimitOpen(false) : openLimitDialog()
                }
              >
                {maxMembers === null ? "不限人数" : `${maxMembers}人`}
              </button>
              {limitOpen &&
                createPortal(
                  <div
                    ref={limitMenu}
                    className="permissions-link-limit-menu"
                    data-permissions-popup="true"
                    role="dialog"
                    aria-label="设置分享人数"
                    style={limitPosition}
                  >
                  <div className="permissions-link-limit-heading">
                    <span>允许加入人数</span>
                    <small>每条链接独立计算</small>
                  </div>
                  <div className="permissions-link-limit-presets">
                    {[1, 5, 10, 20].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={
                          maxMembers === value ? "is-selected" : ""
                        }
                        onClick={() => applyLimit(value)}
                      >
                        {value}人
                      </button>
                    ))}
                  </div>
                  <label className="permissions-link-limit-custom">
                    <span>自定义</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      aria-label="自定义分享人数"
                      value={draftMaxMembers}
                      onChange={(e) => {
                        setDraftMaxMembers(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyLimit();
                      }}
                    />
                    <span>人</span>
                    <button
                      type="button"
                      className="permissions-link-limit-apply"
                      disabled={
                        !Number.isInteger(Number(draftMaxMembers)) ||
                        Number(draftMaxMembers) < 1
                      }
                      onClick={() => applyLimit()}
                    >
                      确定
                    </button>
                  </label>
                  <button
                    type="button"
                    className={`permissions-link-limit-unlimited${
                      maxMembers === null ? " is-selected" : ""
                    }`}
                    onClick={() => applyLimit(null)}
                  >
                    不限人数
                  </button>
                  </div>,
                  document.body,
                )}
            </div>
            <Select
              aria-label="链接访问权限"
              value={role}
              disabled={busy || !ready}
              onChange={(e) => {
                setRole(e.target.value);
                setCopied("");
              }}
            >
              {["reader", "commenter", "editor"].map((r) => (
                <option key={r} value={r}>
                  {accessLabels[r]}
                </option>
              ))}
            </Select>
            <button
              className="primary"
              disabled={
                busy || !ready || !allowed("sharing.links")
              }
              onClick={() => void share()}
            >
              <Copy size={14} />
              {copied ? "已复制" : "复制链接"}
            </button>
          </div>
          <div className="permissions-link-footer">
            {supportsDescendants && (
              <label className="permissions-check permissions-link-scope">
                <input
                  type="checkbox"
                  checked={includeDescendants}
                  disabled={busy}
                  onChange={(e) => {
                    setIncludeDescendants(e.target.checked);
                    setCopied("");
                  }}
                />
                包含子文档
              </label>
            )}
            <button
              className="permissions-text-button"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              链接设置
              <ChevronDown size={13} />
            </button>
          </div>
          {advanced && (
            <div className="permissions-link-settings">
              <label>
                新链接有效期（留空不过期）
                <input
                  type="datetime-local"
                  step="0.001"
                  aria-label="链接有效期"
                  value={expires}
                  disabled={busy}
                  onChange={(e) => {
                    setExpires(e.target.value);
                    setCopied("");
                  }}
                />
              </label>
              <p className="subtle">
                到期或停用只停止新用户加入；已加入的人保留权限。
              </p>
              <button
                type="button"
                className="permissions-share-records-toggle"
                aria-expanded={recordsOpen}
                onClick={() => {
                  setRecordsOpen(!recordsOpen);
                  setExpandedMembers(null);
                }}
              >
                <span>分享记录</span>
                <small>{items.length} 条链接</small>
                <ChevronDown size={14} />
              </button>
              {recordsOpen && (
                <div className="permissions-share-records">
                  <div className="permissions-record-tabs" role="tablist">
                    <button
                      type="button"
                      aria-pressed={recordTab === "active"}
                      onClick={() => {
                        setRecordTab("active");
                        setExpandedMembers(null);
                      }}
                    >
                      分享记录 <small>{items.length}</small>
                    </button>
                    <button
                      type="button"
                      aria-pressed={recordTab === "revoked"}
                      onClick={() => {
                        setRecordTab("revoked");
                        setExpandedMembers(null);
                      }}
                    >
                      撤销记录 <small>{revokedItems.length}</small>
                    </button>
                  </div>
                  {!recordItems.length && (
                    <p className="subtle">
                      {recordTab === "active"
                        ? "复制链接后会显示在这里。"
                        : "暂无撤销记录。"}
                    </p>
                  )}
                  {recordItems.map((l) => (
                    <article className="permissions-share-record" key={l.id}>
                      <header>
                        <div className="permissions-share-record-title">
                          <strong>链接 ID</strong>
                          <code title={l.id}>{l.id}</code>
                        </div>
                        <span
                          className={`permissions-share-record-status ${
                            l.expired || !l.enabled ? "is-muted" : ""
                          }`}
                        >
                          {l.expired
                            ? "已过期"
                            : l.enabled
                              ? "有效"
                              : "已停用"}
                        </span>
                      </header>
                      <div className="permissions-share-record-meta">
                        <span>{accessLabels[l.role]}</span>
                        <span>
                          {l.includeDescendants ? "包含子文档" : "仅当前文档"}
                        </span>
                        <span>
                          {l.maxMembers === null
                            ? "不限人数"
                            : `${l.maxMembers}人上限`}
                          · 已接受 {l.memberCount} 人
                        </span>
                        <span>
                          {l.expiresAt
                            ? `有效至 ${new Date(l.expiresAt).toLocaleString()}`
                            : "不过期"}
                        </span>
                        {l.revokedAt && (
                          <span>
                            撤销于 {new Date(l.revokedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="permissions-share-record-members">
                        {l.members.length ? (
                          <button
                            type="button"
                            className="permissions-share-members-toggle"
                            aria-expanded={expandedMembers === l.id}
                            onClick={() =>
                              setExpandedMembers(
                                expandedMembers === l.id ? null : l.id,
                              )
                            }
                          >
                            <span className="permissions-avatars">
                              {l.members.slice(0, 5).map((member) => (
                                <UserBadge
                                  key={member.id}
                                  id={member.id}
                                  name={member.display_name}
                                  passive
                                  avatarOnly
                                />
                              ))}
                              {l.members.length > 5 && (
                                <span className="permissions-more">
                                  +{l.members.length - 5}
                                </span>
                              )}
                            </span>
                            <span>查看已接受用户</span>
                            <ChevronDown size={13} />
                          </button>
                        ) : (
                          <span className="permissions-share-members-empty">
                            暂无用户接受
                          </span>
                        )}
                        {expandedMembers === l.id && (
                          <div className="permissions-share-members-list">
                            {l.members.map((member) => (
                              <div key={member.id}>
                                <UserBadge
                                  id={member.id}
                                  name={member.display_name}
                                  passive
                                />
                                {member.public_id && (
                                  <small>@{member.public_id}</small>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <footer className="permissions-share-record-actions">
                        {l.token && (
                          <button
                            disabled={busy || l.expired}
                            onClick={() => void copy(l)}
                          >
                            复制此链接
                          </button>
                        )}
                        <button
                          disabled={
                            busy ||
                            l.expired ||
                            l.revoked ||
                            (!l.enabled && !allowed("sharing.links"))
                          }
                          onClick={() => void change(l)}
                        >
                          {l.revoked ? "已撤销" : l.enabled ? "停用链接" : "启用链接"}
                        </button>
                        <button
                          disabled={busy || l.revoked}
                          onClick={() => setConfirm(l.id)}
                        >
                          撤销链接权限
                        </button>
                      </footer>
                      {confirm === l.id && (
                        <div className="permissions-confirm">
                          <p>
                            停用此链接，并移除通过此链接加入的权限。其他授权会保留。
                          </p>
                          <button
                            disabled={busy}
                            onClick={() => void change(l, true)}
                          >
                            确认撤销权限
                          </button>
                          <button onClick={() => setConfirm("")}>取消</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error && <Feedback tone="error" message={error} />}
      {enabled && fallback && (
        <input
          aria-label="手动复制邀请链接"
          readOnly
          value={fallback}
          onFocus={(e) => e.target.select()}
        />
      )}
    </section>
  );
}
