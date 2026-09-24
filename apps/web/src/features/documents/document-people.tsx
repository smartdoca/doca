import { useEffect, useState } from "react";
import { realtime } from "@web/features/documents/realtime.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { uniqueOnlineUsers } from "@web/features/documents/online-users.js";
export function DocumentPeople({ id }: { id: string }) {
  const [users, setUsers] = useState<{ id: string; display_name: string }[]>(
    [],
  );
  useEffect(() => {
    setUsers([]);
    return realtime.subscribe((m) => {
      if (m.type === "disconnected") setUsers([]);
      if (m.type === "presence" && m.room === id)
        setUsers(uniqueOnlineUsers(m.users));
    });
  }, [id]);
  if (!users.length) return null;
  return (
    <details className="menu document-people">
      <summary aria-label={`${users.length} 人在线`} title="查看在线用户">
        <span className="online-avatar-stack">
          {users.slice(0, 4).map((u) => (
            <span key={u.id}>
              <UserBadge id={u.id} name={u.display_name} avatarOnly passive />
            </span>
          ))}
        </span>
        <small className="online-user-count">{users.length}人在线</small>
      </summary>
      <div>
        {users.map((u) => (
          <UserBadge key={u.id} id={u.id} name={u.display_name} />
        ))}
      </div>
    </details>
  );
}
