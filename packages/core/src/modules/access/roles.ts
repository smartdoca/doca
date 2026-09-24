/** Shared role semantics for documents, knowledge bases and ACL adapters. */
export const ranks = {
  none: 0,
  reader: 1,
  commenter: 2,
  editor: 3,
  manager: 4,
  owner: 5,
} as const;

export type Role = keyof typeof ranks;

/** Managers can maintain ordinary members; only owners can change management roles. */
export function canChangeMemberRole(
  actorRole: Role,
  currentRole: Role | null,
  nextRole: Role | null,
) {
  if (ranks[actorRole] < ranks.manager) return false;
  const changesManagement = [currentRole, nextRole].some(
    (role) => role === "manager" || role === "owner",
  );
  return !changesManagement || actorRole === "owner";
}
