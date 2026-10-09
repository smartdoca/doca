import { htmlLang } from "@doca/i18n";
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
import { accessText } from "@web/features/documents/access-management.js";
import { useI18n } from "@web/shared/i18n.js";
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
  basePath = `/resources/${id}`,
  allowedRoles = ["reader", "commenter", "editor"],
}: {
  id: string;
  basePath?: string;
  allowedRoles?: string[];
  changed?: () => Promise<unknown>;
  inheritanceControl?: ReactNode;
  inheritedEnabled?: boolean;
}) {
  const { t, locale } = useI18n();
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
    const r = await api<ShareState>(`${basePath}/share-link`);
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
    void api<ShareState>(`${basePath}/share-link`)
      .then((r) => {
        if (alive) {
          setItems(r.items);
          setRevokedItems(r.revokedItems);
          setEnabled(r.sharingEnabled);
          setSupportsDescendants(r.supportsDescendants);
          const first = r.items.find(
            (l) => l.enabled && !l.expired && allowedRoles.includes(l.role),
          );
          setRole(first?.role ?? "reader");
          setIncludeDescendants(
            r.supportsDescendants && (first?.includeDescendants ?? true),
          );
          setMaxMembers(first ? first.maxMembers : 1);
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
      await api(`${basePath}/share-links/enabled`, "PUT", {
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
      setError(t("sharingUi.manualCopyHelp"));
    }
  }
  async function share() {
    setBusy(true);
    setError("");
    try {
      const l = await api<ShareLink>(`${basePath}/share-link`, "PUT", {
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
        await api(`${basePath}/share-links/${l.id}/revoke`, "POST", {
          version: l.version,
        });
      else
        await api(`${basePath}/share-link`, "PUT", {
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
        <span>
          {t("sharingUi.linkSharing")}
          {inheritanceControl}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t("sharingUi.linkSharing")}
          checked={enabled}
          disabled={busy || !ready}
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
              <span>{t("sharingUi.linkAudience")}</span>
              <small>{t("sharingUi.joinAfterLogin")}</small>
            </div>
            <div className="permissions-link-limit-wrap">
              <button
                type="button"
                className="permissions-link-limit"
                ref={limitTrigger}
                aria-label={t("sharingUi.memberLimit")}
                aria-haspopup="dialog"
                aria-expanded={limitOpen}
                disabled={busy || !ready}
                onClick={() =>
                  limitOpen ? setLimitOpen(false) : openLimitDialog()
                }
              >
                {maxMembers === null
                  ? t("sharingUi.unlimited")
                  : t("sharingUi.members", { count: maxMembers })}
              </button>
              {limitOpen &&
                createPortal(
                  <div
                    ref={limitMenu}
                    className="permissions-link-limit-menu"
                    data-permissions-popup="true"
                    role="dialog"
                    aria-label={t("sharingUi.setLimit")}
                    style={limitPosition}
                  >
                    <div className="permissions-link-limit-heading">
                      <span>{t("sharingUi.allowedMembers")}</span>
                      <small>{t("sharingUi.perLink")}</small>
                    </div>
                    <div className="permissions-link-limit-presets">
                      {[1, 5, 10, 20].map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={maxMembers === value ? "is-selected" : ""}
                          onClick={() => applyLimit(value)}
                        >
                          {t("sharingUi.members", { count: value })}
                        </button>
                      ))}
                    </div>
                    <label className="permissions-link-limit-custom">
                      <span>{t("sharingUi.custom")}</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        aria-label={t("sharingUi.customLimit")}
                        value={draftMaxMembers}
                        onChange={(e) => {
                          setDraftMaxMembers(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") applyLimit();
                        }}
                      />
                      <span>{t("sharingUi.memberUnit")}</span>
                      <button
                        type="button"
                        className="permissions-link-limit-apply"
                        disabled={
                          !Number.isInteger(Number(draftMaxMembers)) ||
                          Number(draftMaxMembers) < 1
                        }
                        onClick={() => applyLimit()}
                      >
                        {t("common.confirm")}
                      </button>
                    </label>
                    <button
                      type="button"
                      className={`permissions-link-limit-unlimited${
                        maxMembers === null ? " is-selected" : ""
                      }`}
                      onClick={() => applyLimit(null)}
                    >
                      {t("sharingUi.unlimited")}
                    </button>
                  </div>,
                  document.body,
                )}
            </div>
            <Select
              aria-label={t("sharingUi.linkAccess")}
              value={role}
              disabled={busy || !ready}
              onChange={(e) => {
                setRole(e.target.value);
                setCopied("");
              }}
            >
              {allowedRoles.map((r) => (
                <option key={r} value={r}>
                  {accessText(t, r)}
                </option>
              ))}
            </Select>
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => void share()}
            >
              <Copy size={14} />
              {copied ? t("sharingUi.copied") : t("sharingUi.copyLink")}
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
                {t("role.scope.descendants")}
              </label>
            )}
            <button
              className="permissions-text-button"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              {t("sharingUi.linkSettings")}
              <ChevronDown size={13} />
            </button>
          </div>
          {advanced && (
            <div className="permissions-link-settings">
              <label>
                {t("sharingUi.newExpiry")}
                <input
                  type="datetime-local"
                  step="0.001"
                  aria-label={t("sharingUi.expiry")}
                  value={expires}
                  disabled={busy}
                  onChange={(e) => {
                    setExpires(e.target.value);
                    setCopied("");
                  }}
                />
              </label>
              <p className="subtle">{t("sharingUi.expiryHelp")}</p>
              <button
                type="button"
                className="permissions-share-records-toggle"
                aria-expanded={recordsOpen}
                onClick={() => {
                  setRecordsOpen(!recordsOpen);
                  setExpandedMembers(null);
                }}
              >
                <span>{t("sharingUi.history")}</span>
                <small>{t("sharingUi.links", { count: items.length })}</small>
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
                      {t("sharingUi.history")}
                      <small>{items.length}</small>
                    </button>
                    <button
                      type="button"
                      aria-pressed={recordTab === "revoked"}
                      onClick={() => {
                        setRecordTab("revoked");
                        setExpandedMembers(null);
                      }}
                    >
                      {t("sharingUi.revokedHistory")}
                      <small>{revokedItems.length}</small>
                    </button>
                  </div>
                  {!recordItems.length && (
                    <p className="subtle">
                      {recordTab === "active"
                        ? t("sharingUi.historyEmpty")
                        : t("sharingUi.noRevocations")}
                    </p>
                  )}
                  {recordItems.map((l) => (
                    <article className="permissions-share-record" key={l.id}>
                      <header>
                        <div className="permissions-share-record-title">
                          <strong>{t("sharingUi.linkId")}</strong>
                          <code title={l.id}>{l.id}</code>
                        </div>
                        <span
                          className={`permissions-share-record-status ${
                            l.expired || !l.enabled ? "is-muted" : ""
                          }`}
                        >
                          {l.expired
                            ? t("ticket.expired")
                            : l.enabled
                              ? t("sharingUi.valid")
                              : t("users.disabled")}
                        </span>
                      </header>
                      <div className="permissions-share-record-meta">
                        <span>{accessText(t, l.role)}</span>
                        <span>
                          {l.includeDescendants
                            ? t("role.scope.descendants")
                            : t("permissionsUi.currentOnly")}
                        </span>
                        <span>
                          {l.maxMembers === null
                            ? t("sharingUi.unlimited")
                            : t("sharingUi.limit", { count: l.maxMembers })}
                          {t("sharingUi.acceptedCount", {
                            count: l.memberCount,
                          })}
                        </span>
                        <span>
                          {l.expiresAt
                            ? t("sharingUi.expiresAt", {
                                date: new Date(l.expiresAt).toLocaleString(
                                  htmlLang(locale),
                                ),
                              })
                            : t("sharingUi.noExpiry")}
                        </span>
                        {l.revokedAt && (
                          <span>
                            {t("sharingUi.revokedAt", {
                              date: new Date(l.revokedAt).toLocaleString(
                                htmlLang(locale),
                              ),
                            })}
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
                            <span>{t("sharingUi.acceptedUsers")}</span>
                            <ChevronDown size={13} />
                          </button>
                        ) : (
                          <span className="permissions-share-members-empty">
                            {t("sharingUi.noAccepted")}
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
                            {t("sharingUi.copyThis")}
                          </button>
                        )}
                        <button
                          disabled={busy || l.expired || l.revoked || !allowedRoles.includes(l.role)}
                          onClick={() => void change(l)}
                        >
                          {l.revoked
                            ? t("ticket.cancelled")
                            : l.enabled
                              ? t("sharingUi.disable")
                              : t("sharingUi.enable")}
                        </button>
                        <button
                          disabled={busy || l.revoked || !allowedRoles.includes(l.role)}
                          onClick={() => setConfirm(l.id)}
                        >
                          {t("sharingUi.revoke")}
                        </button>
                      </footer>
                      {confirm === l.id && (
                        <div className="permissions-confirm">
                          <p>{t("sharingUi.revokeHelp")}</p>
                          <button
                            disabled={busy}
                            onClick={() => void change(l, true)}
                          >
                            {t("sharingUi.confirmRevoke")}
                          </button>
                          <button onClick={() => setConfirm("")}>
                            {t("common.cancel")}
                          </button>
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
          aria-label={t("sharingUi.manualCopy")}
          readOnly
          value={fallback}
          onFocus={(e) => e.target.select()}
        />
      )}
    </section>
  );
}
