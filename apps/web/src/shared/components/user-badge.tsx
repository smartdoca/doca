import { useEffect, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import {
  defaultUserCard,
  userCardUrl,
  type UserCardSettings,
} from "@core/modules/deployment/user-card.js";
import { api } from "@web/shared/api.js";
import { Avatar } from "@web/features/account/profile.js";
type Identity = {
  display_name: string;
  public_id?: string;
  avatar?: string;
  avatar_asset_id?: string | null;
  avatarUrl?: string;
};
export const USER_CARD_SUPPRESSION_EVENT = "doca-user-card-suppression";
export function setUserCardsSuppressed(suppressed: boolean) {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(USER_CARD_SUPPRESSION_EVENT, { detail: suppressed }),
    );
}
const cache = new Map<string, Promise<Identity>>();
export function UserBadge({
  id,
  name,
  avatarOnly = false,
  children,
  noAvatar = false,
  passive = false,
  initialOpen = false,
  hideTrigger = false,
  anchorRect,
  onDismiss,
}: {
  id: string;
  name?: string;
  avatarOnly?: boolean;
  children?: ReactNode;
  noAvatar?: boolean;
  passive?: boolean;
  initialOpen?: boolean;
  hideTrigger?: boolean;
  anchorRect?: Pick<DOMRect, "left" | "top" | "bottom">;
  onDismiss?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cardsSuppressed, setCardsSuppressed] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [config, setConfig] = useState<UserCardSettings>(defaultUserCard);
  const card = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const wasOpen = useRef(false);
  useEffect(() => {
    if (initialOpen && !passive) open();
  }, [id, initialOpen, passive]);
  useEffect(() => {
    const suppress = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail === true;
      setCardsSuppressed(next);
      if (next) {
        setExpanded(false);
        setPosition(null);
      }
    };
    window.addEventListener(USER_CARD_SUPPRESSION_EVENT, suppress);
    return () =>
      window.removeEventListener(USER_CARD_SUPPRESSION_EVENT, suppress);
  }, []);
  useEffect(() => {
    if (expanded) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      onDismiss?.();
    }
  }, [expanded, onDismiss]);
  const keepOpen = () => clearTimeout(hoverTimer.current);
  const close = () => {
    setExpanded(false);
    setPosition(null);
  };
  const scheduleClose = () => {
    keepOpen();
    hoverTimer.current = setTimeout(close, 220);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!expanded) return;
    void api<UserCardSettings>("/user-card-settings")
      .then(setConfig)
      .catch(() => {});
    const dismiss = (e: PointerEvent) => {
      if (
        !card.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
    };
  }, [expanded]);
  const [user, setUser] = useState<Identity | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => {
      cache.delete(id);
      setRevision((n) => n + 1);
    };
    window.addEventListener("profile-updated", refresh);
    return () => window.removeEventListener("profile-updated", refresh);
  }, [id]);
  useEffect(() => {
    let active = true;
    let p = cache.get(id);
    if (!p) {
      p = api<Identity>(`/users/${id}/profile`);
      cache.set(id, p);
      p.catch(() => cache.delete(id));
    }
    void p
      .then((u) => {
        if (active) setUser(u);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, revision]);
  const display =
    user?.display_name?.trim() ||
    name?.trim() ||
    user?.public_id?.trim() ||
    id ||
    "用户";
  const href =
    config.enabled && user?.public_id
      ? userCardUrl(config.url, user?.public_id ?? id, id)
      : null;
  const place = () => {
    const r = anchorRect ?? trigger.current?.getBoundingClientRect();
    if (!r) return null;
    const height = card.current?.offsetHeight || 230,
      below = r.bottom + 8,
      above = r.top - 8 - height;
    return {
      left: Math.max(12, Math.min(r.left, window.innerWidth - 292)),
      top:
        below + height <= window.innerHeight - 8
          ? below
          : above >= 8
            ? above
            : Math.max(8, window.innerHeight - height - 8),
    };
  };
  const open = () => {
    keepOpen();
    if (anchorRect || trigger.current?.getBoundingClientRect())
      setExpanded(true);
  };
  useLayoutEffect(() => {
    if (!expanded || position) return;
    const next = place();
    if (next) setPosition(next);
  });
  return (
    <>
      {!hideTrigger && (
        <span
          ref={trigger}
          className="user-badge"
          role={passive ? undefined : "button"}
          tabIndex={passive ? undefined : 0}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          onMouseEnter={() => {
            if (!passive) open();
          }}
          onMouseLeave={scheduleClose}
          onClick={(e) => {
            if (passive) return;
            e.preventDefault();
            e.stopPropagation();
            open();
          }}
          onKeyDown={(e) => {
            if (passive) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              open();
            }
          }}
          title={display + (user?.public_id ? " @" + user.public_id : "")}
        >
          {!noAvatar && (
            <Avatar
              name={display}
              avatar={user?.avatar}
              sourceUrl={user?.avatarUrl}
              assetId={user?.avatar_asset_id}
            />
          )}
          {children ?? (!avatarOnly && <span>{display}</span>)}
        </span>
      )}
      {expanded && !cardsSuppressed &&
        createPortal(
          <div
            ref={card}
            className="user-profile-card"
            role="dialog"
            aria-label="用户资料"
            style={
              position
                ? { left: position.left, top: position.top }
                : { visibility: "hidden" }
            }
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={keepOpen}
            onMouseLeave={scheduleClose}
          >
            <button
              className="icon user-card-close"
              aria-label="关闭用户资料"
              onClick={close}
            >
              <X size={16} />
            </button>
            <Avatar
              name={display}
              avatar={user?.avatar}
              sourceUrl={user?.avatarUrl}
              assetId={user?.avatar_asset_id}
            />
            <strong>{display}</strong>
            <small>@{user?.public_id ?? id}</small>
            {href && (
              <a
                className={"user-card-link " + config.style}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {config.text}
                <ExternalLink size={14} />
              </a>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
