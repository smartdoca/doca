import { UserBadge } from "@web/shared/components/user-badge.js";

/** Self labels use stable IDs, never a display-name comparison. */
export function DocumentAuthor({
  id,
  name,
  currentUserId,
}: {
  id: string;
  name?: string;
  currentUserId?: string;
}) {
  return id === currentUserId ? (
    <span className="document-author-self">我</span>
  ) : (
    <UserBadge id={id} name={name} />
  );
}
