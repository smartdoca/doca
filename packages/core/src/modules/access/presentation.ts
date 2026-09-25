import {
  effectiveResource,
  policySource,
  policyFields,
  type PolicyField,
} from "./inheritance.js";
import type { DB, Resource } from "../../../../db/src/index.js";
import type { Actor } from "../identity/passwords.js";
import { distributionPolicy } from "../deployment/policies.js";
import { accessContext } from "./queries.js";
import {
  permission,
  namedPermission,
  ranks,
  label,
  isResourceOwnerLike,
  type Grant,
} from "./policy.js";
import { fail } from "../../shared/errors.js";
export function openness(r: Resource, resources: Resource[]): Resource {
  const current = effectiveResource(r, resources);
  return current.visibility === "invited" && current.requests_enabled
    ? { ...current, visibility: "requestable" }
    : current;
}
export function requestedRoles(
  r: Resource,
  resources: Resource[],
): Grant["role"][] {
  return openness(r, resources).requests_enabled
    ? ["reader", "commenter", "editor", "manager"]
    : [];
}
export async function managers(
  db: DB,
  resource: Resource,
  resources: Resource[],
  grants: Grant[],
) {
  const ids = [
    ...new Set([
      ...resources.map((r) => r.owner_id),
      ...grants.filter((g) => g.role === "manager").map((g) => g.user_id),
    ]),
  ];
  if (!ids.length) return [];
  const users = await db
    .selectFrom("users")
    .select(["id", "display_name", "public_id", "admin"])
    .where("id", "in", ids)
    .where("status", "=", "active")
    .execute();
  return users
    .filter((u) => permission(resource, u, resources, grants) >= 4)
    .map(({ admin, ...u }) => ({
      ...u,
      role: u.id === resource.owner_id ? "owner" : "manager",
    }));
}
export async function managementVisible(
  db: DB,
  actor: Actor | null,
  r: Resource,
  resources: Resource[],
  grants: Grant[],
) {
  return (
    permission(r, actor, resources, grants) >= 4 ||
    (await distributionPolicy(db, r.kind)).managerInfoVisible
  );
}
export async function requestContext(db: DB, actor: Actor | null, id: string) {
  const ctx = await accessContext(db, actor, [id]);
  const r = ctx.resources.find((r) => r.id === id);
  if (
    !r ||
    r.deleted_at ||
    ctx.resources.find((x) => x.id === r.library_id)?.deleted_at
  )
    fail(404, "文档不存在");
  const rank = permission(r, actor, ctx.resources, ctx.grants),
    open = openness(r, ctx.resources);
  if (
    !rank &&
    open.visibility !== "requestable" &&
    !(open.visibility === "authenticated" && !actor)
  )
    fail(404, "文档不存在");
  return { r, rank, open, ...ctx };
}
export async function permissionOverview(
  db: DB,
  actor: Actor | null,
  id: string,
) {
  const ctx = await requestContext(db, actor, id),
    { r, rank, resources, grants, open } = ctx;
  const isOwner = isResourceOwnerLike(r, actor, resources);
  const show = await managementVisible(db, actor, r, resources, grants);
  const administrators = show ? await managers(db, r, resources, grants) : [];
  // Only ancestors reached through inheritance contribute grants or member identities.
  const chain = new Set<string>();
  let current: Resource | undefined = r;
  while (current && !chain.has(current.id)) {
    chain.add(current.id);
    current =
      current.access_mode === "inherit"
        ? resources.find(
            (x) => x.id === (current!.parent_id ?? current!.library_id),
          )
        : undefined;
  }
  const effectiveGrants = grants.filter((g) => chain.has(g.resource_id));
  const candidates = new Set([
    ...grants.filter((grant) => grant.resource_id === r.library_id && grant.role === "manager" && !grant.blocked).map((grant) => grant.user_id),
    ...resources.filter((resource) => resource.id === r.library_id).map((resource) => resource.owner_id),
    ...effectiveGrants.map((g) => g.user_id),
    ...resources.filter((x) => chain.has(x.id)).map((x) => x.owner_id),
  ]);
  const users =
    rank >= 3 && candidates.size
      ? await db
          .selectFrom("users")
          .select(["id", "display_name", "public_id", "admin"])
          .where("id", "in", [...candidates])
          .where("status", "=", "active")
          .execute()
      : [];
  const members = users.flatMap((u) => {
    const effective = namedPermission(r, u, resources, grants);
    if (!effective || (effective >= 4 && !show)) return [];
    const direct = grants.find(
      (g) =>
        g.resource_id === id &&
        g.user_id === u.id &&
        g.source_type === "direct" &&
        g.status === "active",
    );
    const local = grants.filter(
      (g) => g.resource_id === id && g.user_id === u.id,
    );
    const parent = resources.find(
      (resource) => resource.id === (r.parent_id ?? r.library_id),
    );
    const parentOverride = local.find(
      (g) => g.source_type === "parent_override",
    );
    const inherited =
      u.id !== r.owner_id &&
      !!parent &&
      !parentOverride &&
      namedPermission(parent, u, resources, grants, true) > 0;
    const includeDescendants =
      namedPermission(r, u, resources, grants, true) > 0;
    const sourceDetails = [
      ...local.map((g) => ({
        type: g.source_type ?? "direct",
        sourceType: g.source_type ?? "direct",
        id: g.source_id ?? null,
        sourceResourceId: g.source_resource_id ?? null,
        role: label(g.status === "disabled" ? 0 : ranks[g.role]),
        includeDescendants: g.include_descendants !== 0,
        status: g.status ?? "active",
      })),
      ...effectiveGrants
        .filter(
          (g) =>
            g.user_id === u.id &&
            g.resource_id !== id &&
            chain.has(g.resource_id),
        )
        .map((g) => ({
          type: "parent_inherited",
          sourceType: g.source_type ?? "direct",
          id: g.source_id ?? null,
          sourceResourceId: g.resource_id,
          role: label(g.status === "disabled" ? 0 : ranks[g.role]),
          includeDescendants: g.include_descendants !== 0,
          status: g.status ?? "active",
        })),
      ...(inherited &&
      !effectiveGrants.some(
        (g) =>
          g.user_id === u.id &&
          g.resource_id !== id &&
          chain.has(g.resource_id),
      )
        ? [
            {
              type: "parent_inherited",
              sourceType: "parent_inherited",
              id: parent!.id,
              sourceResourceId: parent!.id,
              role: label(namedPermission(parent!, u, resources, grants, true)),
              includeDescendants: true,
              status: "active",
            },
          ]
        : []),
    ];
    return [
      {
        id: u.id,
        display_name: u.display_name,
        public_id: u.public_id,
        role: label(effective),
        directRole: direct?.role ?? null,
        includeDescendants,
        sourceDetails,
        sources: [
          ...(u.id === r.owner_id ? ["owner"] : []),
          ...(direct ? ["direct"] : []),
          ...(inherited ? ["inherit"] : []),
          ...(effectiveGrants.some((g) =>
            g.user_id === u.id && g.source_type === "link" && g.status === "active",
          )
            ? ["link"]
            : []),
          ...(parentOverride ? ["parent_override"] : []),
        ],
        canAdjust:
          rank >= 4 &&
          u.id !== r.owner_id &&
          (effective < 4 || actor?.id === r.owner_id),
      },
    ];
  });
  return {
    rank,
    currentUser: actor
      ? {
          id: actor.id,
          display_name: actor.display_name,
          public_id: actor.public_id,
        }
      : null,
    role: label(rank),
    version: r.version,
    authzRevision: r.authz_revision ?? 1,
    accessMode: r.access_mode,
    hasParent: !!(r.parent_id ?? r.library_id),
    supportsDescendants: r.kind === "library" || !!r.library_id,
    inheritedFields: (Object.keys(policyFields) as PolicyField[]).filter(
      (field) => policySource(r, resources, field).id !== r.id,
    ),
    visibility:
      r.visibility === "invited" && r.requests_enabled
        ? "requestable"
        : r.visibility,
    effectiveVisibility: open.visibility,
    publicRole: open.public_role ?? "reader",
    requestRoles: requestedRoles(r, resources).filter(
      (role) => ranks[role] > rank,
    ),
    requestsEnabled: !!r.requests_enabled,
    effectiveRequestsEnabled: !!open.requests_enabled,
    historyReaders: !!open.history_readers,
    sharingEnabled: !!open.share_links_enabled,
    discoverable: !!open.discoverable,
    canManage: rank >= 4,
    isOwner,
    administrators,
    members,
    loginRequired: !actor && open.visibility === "authenticated",
    sources: [
      ...(isOwner ? ["owner"] : []),
      ...effectiveGrants
        .filter((g) => g.user_id === actor?.id)
        .map((g) =>
          g.resource_id === id
            ? g.source === "link"
              ? "link"
              : "direct"
            : "inherit",
        ),
      ...(["authenticated", "public"].includes(open.visibility)
        ? ["public"]
        : []),
    ],
  };
}
