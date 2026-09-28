/** Deduplicate the header, never the individual sessions/cursors in an editor. */
export function uniqueOnlineUsers<T extends { id: string }>(
  users: readonly T[],
): T[] {
  return [...new Map(users.map((user) => [user.id, user])).values()];
}
