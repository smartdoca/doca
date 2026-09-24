import { effectiveResource } from "./inheritance.js";
import type { Resource, Schema } from "../../../../db/src/index.js";
import type { Actor } from "../identity/passwords.js";
import { ranks, type Role } from "./roles.js";
export { ranks, type Role } from "./roles.js";
export type Grant = Schema["grants"] & { source?: string; blocked?: boolean };
/** A knowledge-base owner has owner-level control over every document in it. */
export function isResourceOwnerLike(
  resource: Resource,
  actor: Pick<Actor, "id"> | null | undefined,
  resources: Resource[],
) {
  if (!actor) return false;
  if (resource.owner_id === actor.id) return true;
  return !!resource.library_id && resources.some(
    (candidate) =>
      candidate.id === resource.library_id &&
      candidate.kind === "library" &&
      candidate.owner_id === actor.id,
  );
}
/** Direct/link records combine with inheritance; parent_override controls fallback. */
export function namedPermission(
  resource: Resource,
  actor: Actor | null,
  resources: Resource[],
  grants: Grant[],
  descendants = false,
  visited = new Set<string>(),
): number {
  if (!actor || visited.has(resource.id)) return 0;
  visited.add(resource.id);
  if (isResourceOwnerLike(resource, actor, resources)) return 5;
  const local = grants.filter(
    (g) => g.resource_id === resource.id && g.user_id === actor.id,
  );
  const localRows = local.filter((g) => g.source_type !== "parent_override");
  const overrides = local.filter((g) => g.source_type === "parent_override");
  const localRank = Math.max(
    0,
    ...localRows.map((g) =>
      g.blocked || (descendants && g.include_descendants === 0)
        ? 0
        : ranks[g.role],
    ),
  );
  const override = overrides[0];
  const overrideRank = override
    ? override.blocked || (descendants && override.include_descendants === 0)
      ? 0
      : ranks[override.role]
    : 0;
  if (override) return Math.max(localRank, overrideRank);
  if (resource.access_mode !== "inherit") return localRank;
  const parent = resources.find(
    (r) => r.id === (resource.parent_id ?? resource.library_id),
  );
  return Math.max(
    localRank,
    parent
      ? namedPermission(parent, actor, resources, grants, true, visited)
      : 0,
  );
}
export function permission(
  resource: Resource,
  actor: Actor | null,
  resources: Resource[],
  grants: Grant[],
  visited = new Set<string>(),
): number {
  if (resource.moderation_status === "blocked") return 0;
  const named = namedPermission(
    resource,
    actor,
    resources,
    grants,
    false,
    visited,
  );
  const open = effectiveResource(resource, resources);
  const publicRank =
    open.visibility === "public" ||
    (actor && open.visibility === "authenticated")
      ? actor
        ? ranks[open.public_role ?? "reader"]
        : 1
      : 0;
  return Math.max(named, publicRank);
}
export const label = (rank: number) =>
  (Object.keys(ranks) as Role[]).find((k) => ranks[k] === rank) ?? "none";

export type Action =
  | "read_content"
  | "read_assets"
  | "comment"
  | "edit_content"
  | "create_child"
  | "create_history"
  | "read_history"
  | "restore_history"
  | "manage_sharing"
  | "manage_structure"
  | "trash"
  | "purge"
  | "transfer_ownership";
export function actionMinimum(resource: Resource, action: Action): number {
  switch (action) {
    case "read_content":
    case "read_assets":
      return ranks.reader;
    case "comment":
      return ranks.commenter;
    case "edit_content":
    case "create_child":
    case "create_history":
      return ranks.editor;
    case "read_history":
      return resource.history_readers ? ranks.reader : ranks.editor;
    case "trash":
    case "purge":
    case "transfer_ownership":
      return ranks.owner;
    default:
      return ranks.manager;
  }
}
