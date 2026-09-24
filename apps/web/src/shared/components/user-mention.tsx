import { useSyncExternalStore } from "react";
import { UserBadge } from "@web/shared/components/user-badge.js";

let currentUserId: string | null = null;
const listeners = new Set<() => void>();

export function setCurrentUserId(id: string | null) {
  if (currentUserId === id) return;
  currentUserId = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function UserMention({
  id,
  name,
  className = "",
}: {
  id: string;
  name: string;
  className?: string;
}) {
  const self = useSyncExternalStore(
    subscribe,
    () => currentUserId,
    () => null,
  );
  const label = name.replace(/^@/, "");
  return (
    <span
      className={`user-mention${self && self === id ? " is-self" : ""}${className ? ` ${className}` : ""}`}
    >
      <UserBadge id={id} name={label} noAvatar>
        @{label}
      </UserBadge>
    </span>
  );
}
