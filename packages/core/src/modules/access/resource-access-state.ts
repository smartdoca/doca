import type { DB, Resource, Schema } from "../../../../db/src/index.js";
import type { Transaction } from "kysely";
import { effectiveResource } from "./inheritance.js";
import { namedPermission, type Grant } from "./policy.js";

export type ResourceAccessState = "private" | "collaborative" | "public";

/** Account status is checked once per scoped response, without exposing the audience. */
export async function activeResourceAudience(
  db: DB | Transaction<Schema>,
  resources: Resource[],
  grants: Grant[],
) {
  const candidates = [
    ...new Set([
      ...resources.map((r) => r.owner_id),
      ...grants.flatMap((g) => g.memberIds ?? [g.user_id]),
    ]),
  ];
  const active = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += 300) {
    const users = await db
      .selectFrom("users")
      .select("id")
      .where("id", "in", candidates.slice(offset, offset + 300))
      .where("status", "=", "active")
      .execute();
    users.forEach((user) => active.add(user.id));
  }
  return active;
}

/** Describe the actual audience, including inherited/library floors and explicit blocks. */
export function resourceAccessState(
  resource: Resource,
  resources: Resource[],
  grants: Grant[],
  activeUserIds: ReadonlySet<string>,
): ResourceAccessState {
  if (
    ["public", "authenticated"].includes(
      effectiveResource(resource, resources).visibility,
    )
  )
    return "public";
  const scope = resources.some((r) => r.id === resource.id)
    ? resources
    : [...resources, resource];
  for (const id of activeUserIds) {
    if (
      id !== resource.owner_id &&
      namedPermission(
        resource,
        { id, display_name: "", admin: 0 },
        scope,
        grants,
      ) > 0
    )
      return "collaborative";
  }
  return "private";
}
