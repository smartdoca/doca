import { useEffect, useRef, useState } from "react";
import {
  UserRound,
  Settings,
  ShieldCheck,
  House,
  LogOut,
} from "lucide-react";
import { api, type Me, type User } from "@web/shared/api.js";
import { Avatar } from "@web/features/account/profile.js";
import { MembershipIcon } from "@web/features/settings/membership-icon.js";
export function AccountMenu({
  user,
  me,
  logout,
  onError,
  refresh,
  showWorkspaceLink = false,
}: {
  user: User;
  me: Me | null;
  logout: () => void;
  onError: (message: string) => void;
  refresh: () => Promise<void>;
  showWorkspaceLink?: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null),
    [busy, setBusy] = useState(false);
  const close = () => {
    if (root.current) root.current.open = false;
  };
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target))
        close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && root.current?.open) {
        close();
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("hashchange", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("hashchange", close);
    };
  }, []);
  const membership = me?.entitlements;
  const displayName = user.display_name || user.public_id || user.id;
  const label = membership?.level && (
    <>
      <span className="membership-label">
        <MembershipIcon icon={membership.level.icon} />
        <strong style={{ color: membership.level.color }}>
          {membership.level.name}
        </strong>
      </span>
      {membership.expiresAt && (
        <small>
          到期时间：{new Date(membership.expiresAt).toLocaleDateString("zh-CN")}
        </small>
      )}
    </>
  );
  return (
    <details
      className="account-menu"
      ref={root}
      onToggle={(e) => {
        if (e.currentTarget.open)
          void refresh().catch((e) => onError(e.message));
      }}
    >
      <summary aria-label="用户菜单" title="用户菜单">
        <Avatar
          name={displayName}
          avatar={me?.preferences.avatar}
          assetId={me?.preferences.avatar_asset_id}
          sourceUrl={me?.avatarUrl}
        />
      </summary>
      <div className="account-menu-panel">
        <div className="account-menu-profile">
          <Avatar
            name={displayName}
            avatar={me?.preferences.avatar}
            assetId={me?.preferences.avatar_asset_id}
            sourceUrl={me?.avatarUrl}
          />
          <strong className="account-menu-nickname">{displayName}</strong>
          {label && (
            <div className="account-menu-membership">
              {membership?.vip?.enabled ? (
                <button
                  className="membership-link"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api<{ url: string }>(
                        "/me/membership-link",
                        "POST",
                      );
                      location.assign(r.url);
                    } catch (e) {
                      onError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {label}
                </button>
              ) : (
                <div className="membership-info">{label}</div>
              )}
            </div>
          )}
        </div>
        <nav aria-label="账号菜单">
          <a href="#/account" onClick={close}>
            <UserRound size={16} />
            个人信息
          </a>
          <a href="#/preferences" onClick={close}>
            <Settings size={16} />
            系统设置
          </a>
          {user.admin && (
            <a href="#/admin" onClick={close}>
              <ShieldCheck size={16} />
              管理员后台
            </a>
          )}
          {showWorkspaceLink && <a href="#/home" onClick={close}>
            <House size={16} />
            返回工作台
          </a>}
          <button
            type="button"
            onClick={() => {
              close();
              logout();
            }}
          >
            <LogOut size={16} />
            退出登录
          </button>
        </nav>
      </div>
    </details>
  );
}
