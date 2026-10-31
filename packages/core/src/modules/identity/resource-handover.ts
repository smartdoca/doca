import { createHash } from "node:crypto";
import type { DB, Resource, Schema } from "@db/index.js";
import { databaseDriver, readSnapshot, transact } from "@db/transactions.js";
import { fail } from "../../shared/errors.js";
import { archiveInvitation } from "../access/invitations.js";
import { effectiveGrants } from "../access/grants.js";
import { groupChanged, touchGroup } from "../groups/service.js";
import { cancelFolderInvitation } from "../access/folder-sharing.js";
import { namedPermission, type Grant } from "../access/policy.js";
import { ranks } from "../access/roles.js";
import {
  checkMemberAdmission,
  checkStorage,
  checkTransfer,
} from "../access/operation-policy.js";
import { emitIntegrationEvent } from "../automation/events.js";
import { enqueueProjection } from "../automation/jobs.js";
import { enqueueKnowledge } from "../knowledge/service.js";
import { securityAudit } from "./accounts.js";
import type { Actor } from "./passwords.js";

export type HandoverKind =
  "resource" | "folder" | "file" | "resource_access" | "folder_access" | "group";
export type HandoverEntry = {
  key: string;
  id: string;
  kind: HandoverKind;
  name: string;
  parentId: string | null;
  path: string[];
  role: string;
  deleted: boolean;
  size: number;
  selectable: boolean;
  reason: "with_document" | "system_file" | "invalid_metadata" | null;
};
export type HandoverInput = { targetUserId: string; keys: string[] };
export type HandoverChange = {
  id: string;
  kind: "resource" | "folder" | "file" | "group";
  name: string;
  action: "ownership" | "access" | "attachment";
  path: string[];
  role: string;
  includeDescendants: boolean;
  deleted: boolean;
  destination: "unchanged" | "personal_root";
};
export type HandoverConflict = {
  id: string;
  name: string;
  code:
    | "permission_scope"
    | "permission_restricted"
    | "grant_shape"
    | "protected_file"
    | "group_membership";
};
export type HandoverPreview = {
  fingerprint: string;
  source: { id: string; display_name: string };
  target: { id: string; display_name: string };
  changes: HandoverChange[];
  conflicts: HandoverConflict[];
  affectedResources: number;
  retained: {
    id: string;
    kind: "resource" | "folder" | "file";
    name: string;
  }[];
  cancelledInvitations: number;
  bytes: number;
};

const reject = (status: number, code: string): never =>
  fail(status, code, { code });
type File = Schema["file_items"];
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function assertAdministrator(db: DB, actor: Actor) {
  const current = await db
    .selectFrom("users")
    .select(["admin", "status"])
    .where("id", "=", actor.id)
    .executeTakeFirst();
  if (!actor.admin || !current?.admin || current.status !== "active")
    reject(403, "handover_forbidden");
}

async function snapshot(
  db: DB,
  actor: Actor,
  sourceId: string,
  targetId?: string,
) {
  await assertAdministrator(db, actor);
  const source = await db
    .selectFrom("users")
    .select(["id", "display_name", "status"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!source || source.status !== "disabled")
    reject(409, "handover_source_disabled");
  const target = targetId
    ? await db
        .selectFrom("users")
        .select(["id", "display_name", "status"])
        .where("id", "=", targetId)
        .executeTakeFirst()
    : undefined;
  if (
    targetId &&
    (!target || target.status !== "active" || target.id === sourceId)
  )
    reject(409, "handover_target_active");
  // Only metadata is read: document bodies, histories and private credentials never enter the inventory.
  const resources = await db
    .selectFrom("resources")
    .selectAll()
    .orderBy("id")
    .execute();
  const folders = await db
    .selectFrom("file_folders")
    .selectAll()
    .orderBy("id")
    .execute();
  const sourceFolderTree = subtree(
    folders,
    new Set(folders.filter((f) => f.owner_id === sourceId).map((f) => f.id)),
  );
  const files = await db
    .selectFrom("file_items")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("owner_id", "=", sourceId),
        eb.and([
          eb("parent_type", "=", "document"),
          eb(
            "parent_id",
            "in",
            db
              .selectFrom("resources")
              .select("id")
              .where("owner_id", "=", sourceId),
          ),
        ]),
        ...(sourceFolderTree.length
          ? [
              eb.and([
                eb("parent_type", "=", "folder"),
                eb(
                  "parent_id",
                  "in",
                  sourceFolderTree.map((f) => f.id),
                ),
              ]),
            ]
          : []),
      ]),
    )
    .orderBy("id")
    .execute();
  const grants = await db
    .selectFrom("grants")
    .selectAll()
    .where("user_id", "in", targetId ? [sourceId, targetId] : [sourceId])
    .orderBy("resource_id")
    .orderBy("user_id")
    .orderBy("source_type")
    .orderBy("source_id")
    .execute();
  const shares = await db
    .selectFrom("file_folder_shares")
    .selectAll()
    .where("user_id", "in", targetId ? [sourceId, targetId] : [sourceId])
    .orderBy("folder_id")
    .orderBy("user_id")
    .execute();
  const groups = await db.selectFrom("user_groups").selectAll().where("owner_id", "=", sourceId).where("dissolved_at", "is", null).orderBy("id").execute();
  const groupMembers = groups.length ? await db.selectFrom("user_group_members").selectAll().where("group_id", "in", groups.map(g => g.id)).orderBy("group_id").orderBy("user_id").execute() : [];
  const groupGrants = (await effectiveGrants(db, resources.map(r => r.id))).filter(g => g.groupId);
  return { source: source!, target, resources, folders, files, grants, shares, groups, groupMembers, groupGrants };
}

function fileReason(file: File): HandoverEntry["reason"] {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(file.metadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      return "invalid_metadata";
  } catch {
    return "invalid_metadata";
  }
  // Retired knowledge bindings and personal AI files keep their existing restrictions and attribution.
  if (
    Object.hasOwn(metadata, "knowledgeSessionFolder") ||
    Object.hasOwn(metadata, "aiSessionFolder")
  )
    return "system_file";
  if (file.parent_type === "document") return "with_document";
  if (file.locked) return "system_file";
  if (file.parent_type === "system" && file.parent_id !== "root")
    return "system_file";
  return null;
}

function itemPath(
  s: Snapshot,
  kind: "resource" | "folder" | "file" | "group",
  id: string,
): string[] {
  if (kind === "group") return [];
  let type: "resource" | "folder" = kind === "resource" ? "resource" : "folder";
  let parent: string | null;
  if (kind === "file") {
    const file = s.files.find((f) => f.id === id);
    if (!file || file.parent_type === "system") return [];
    type = file.parent_type === "document" ? "resource" : "folder";
    parent = file.parent_id;
  } else if (kind === "resource") {
    const resource = s.resources.find((r) => r.id === id);
    parent = resource?.parent_id ?? resource?.library_id ?? null;
  } else parent = s.folders.find((f) => f.id === id)?.parent_id ?? null;
  const path: string[] = [],
    visited = new Set([id]);
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    if (type === "resource") {
      const row = s.resources.find((r) => r.id === parent);
      if (!row) break;
      path.unshift(row.title);
      parent = row.parent_id ?? row.library_id;
    } else {
      const row = s.folders.find((f) => f.id === parent);
      if (!row) break;
      path.unshift(row.name);
      parent = row.parent_id;
    }
  }
  return path;
}

function entries(s: Snapshot): HandoverEntry[] {
  const result: Omit<HandoverEntry, "path">[] = [];
  for (const group of s.groups) result.push({ key: `group:${group.id}`, id: group.id, kind: "group", name: group.name, parentId: null, role: "owner", deleted: false, size: 0, selectable: true, reason: null });
  for (const r of s.resources) {
    if (r.owner_id === s.source.id)
      result.push({
        key: `resource:${r.id}`,
        id: r.id,
        kind: "resource",
        name: r.title,
        parentId: r.parent_id ?? r.library_id,
        role: "owner",
        deleted: !!r.deleted_at,
        size: Number(r.content_bytes),
        selectable: true,
        reason: null,
      });
    else if (
      s.grants.some(
        (g) =>
          g.resource_id === r.id &&
          g.user_id === s.source.id &&
          g.status === "active",
      )
    )
      result.push({
        key: `resource_access:${r.id}`,
        id: r.id,
        kind: "resource_access",
        name: r.title,
        parentId: r.parent_id ?? r.library_id,
        role: "member",
        deleted: !!r.deleted_at,
        size: 0,
        selectable: true,
        reason: null,
      });
  }
  for (const f of s.folders) {
    if (f.owner_id === s.source.id)
      result.push({
        key: `folder:${f.id}`,
        id: f.id,
        kind: "folder",
        name: f.name,
        parentId: f.parent_id,
        role: "owner",
        deleted: !!f.deleted_at,
        size: 0,
        selectable: true,
        reason: null,
      });
    else {
      const share = s.shares.find(
        (g) => g.folder_id === f.id && g.user_id === s.source.id,
      );
      if (share)
        result.push({
          key: `folder_access:${f.id}`,
          id: f.id,
          kind: "folder_access",
          name: f.name,
          parentId: f.parent_id,
          role: share.role,
          deleted: !!f.deleted_at,
          size: 0,
          selectable: true,
          reason: null,
        });
    }
  }
  for (const f of s.files.filter((f) => f.owner_id === s.source.id)) {
    const reason = fileReason(f);
    result.push({
      key: `file:${f.id}`,
      id: f.id,
      kind: "file",
      name: f.name,
      parentId: f.parent_id,
      role: "owner",
      deleted: !!f.deleted_at,
      size: Number(f.size),
      selectable: !reason,
      reason,
    });
  }
  return result.map((entry) => ({
    ...entry,
    path: itemPath(
      s,
      entry.kind === "resource_access"
        ? "resource"
        : entry.kind === "folder_access"
          ? "folder"
          : entry.kind,
      entry.id,
    ),
  }));
}

export async function userHandoverInventory(
  db: DB,
  actor: Actor,
  sourceId: string,
) {
  return readSnapshot(db, async (tx) => {
    const s = await snapshot(tx, actor, sourceId);
    return {
      source: { id: s.source.id, display_name: s.source.display_name },
      items: entries(s),
    };
  });
}

function subtree<T extends { id: string; parent_id: string | null }>(
  rows: T[],
  roots: Set<string>,
  library = false,
) {
  const ids = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (
        !ids.has(row.id) &&
        ((row.parent_id && ids.has(row.parent_id)) ||
          (library &&
            "library_id" in row &&
            typeof row.library_id === "string" &&
            ids.has(row.library_id)))
      ) {
        ids.add(row.id);
        changed = true;
      }
  }
  return rows.filter((row) => ids.has(row.id));
}

async function plan(
  db: DB,
  actor: Actor,
  sourceId: string,
  input: HandoverInput,
) {
  const s = await snapshot(db, actor, sourceId, input.targetUserId);
  const keys = [...new Set(input.keys)].sort();
  if (!keys.length || keys.length > 500) reject(400, "handover_selection");
  const inventory = new Map(entries(s).map((entry) => [entry.key, entry]));
  if (keys.some((key) => !inventory.get(key)?.selectable))
    reject(409, "handover_changed");
  const selected = keys.map((key) => inventory.get(key)!);
  const ownResources = subtree(
    s.resources,
    new Set(selected.filter((e) => e.kind === "resource").map((e) => e.id)),
    true,
  ).filter((r) => r.owner_id === sourceId);
  const resourceIds = new Set(ownResources.map((r) => r.id));
  const folderTree = subtree(
    s.folders,
    new Set(
      selected
        .filter((e) => e.kind === "folder" || e.kind === "folder_access")
        .map((e) => e.id),
    ),
  );
  const ownedFolderTree = subtree(
    s.folders,
    new Set(selected.filter((e) => e.kind === "folder").map((e) => e.id)),
  );
  const ownedFolderTreeIds = new Set(ownedFolderTree.map((f) => f.id));
  const ownFolders = ownedFolderTree.filter((f) => f.owner_id === sourceId);
  const folderIds = new Set(ownFolders.map((f) => f.id));
  const explicitFileIds = new Set(
    selected.filter((e) => e.kind === "file").map((e) => e.id),
  );
  const ownFiles = s.files.filter(
    (f) =>
      explicitFileIds.has(f.id) ||
      (f.parent_type === "folder" &&
        ownedFolderTreeIds.has(f.parent_id) &&
        f.owner_id === sourceId) ||
      (f.parent_type === "document" && resourceIds.has(f.parent_id)),
  );
  const assets = resourceIds.size
    ? await db
        .selectFrom("assets")
        .selectAll()
        .where("resource_id", "in", [...resourceIds])
        .orderBy("id")
        .execute()
    : [];
  const changes: Omit<HandoverChange, "path">[] = [];
  const conflicts: HandoverConflict[] = [];
  const addConflict = (
    id: string,
    name: string,
    code: HandoverConflict["code"],
  ) => {
    if (!conflicts.some((c) => c.id === id && c.code === code))
      conflicts.push({ id, name, code });
  };
  const ownGroups = s.groups.filter(group => selected.some(entry => entry.kind === "group" && entry.id === group.id));
  for (const group of ownGroups) {
    if (!s.groupMembers.some(member => member.group_id === group.id && member.user_id === input.targetUserId)) addConflict(group.id, group.name, "group_membership");
    changes.push({ id: group.id, kind: "group", name: group.name, action: "ownership", role: "owner", includeDescendants: false, deleted: false, destination: "unchanged" });
  }
  const movedFolders = new Set<string>(),
    movedFiles = new Set<string>();
  for (const r of ownResources)
    changes.push({
      id: r.id,
      kind: "resource",
      name: r.title,
      action: "ownership",
      role: "owner",
      includeDescendants: true,
      deleted: !!r.deleted_at,
      destination: "unchanged",
    });
  for (const f of ownFolders) {
    if (
      f.parent_id &&
      f.parent_id !== "shared" &&
      !folderIds.has(f.parent_id) &&
      s.folders.find((p) => p.id === f.parent_id)?.owner_id !==
        input.targetUserId
    )
      movedFolders.add(f.id);
    changes.push({
      id: f.id,
      kind: "folder",
      name: f.name,
      action: "ownership",
      role: "owner",
      includeDescendants: true,
      deleted: !!f.deleted_at,
      destination: movedFolders.has(f.id) ? "personal_root" : "unchanged",
    });
  }
  for (const f of ownFiles) {
    const reason = fileReason(f);
    if (reason && reason !== "with_document")
      addConflict(f.id, f.name, "protected_file");
    if (
      f.parent_type === "folder" &&
      !folderIds.has(f.parent_id) &&
      s.folders.find((p) => p.id === f.parent_id)?.owner_id !==
        input.targetUserId
    )
      movedFiles.add(f.id);
    changes.push({
      id: f.id,
      kind: "file",
      name: f.name,
      action: f.parent_type === "document" ? "attachment" : "ownership",
      role: "owner",
      includeDescendants: false,
      deleted: !!f.deleted_at,
      destination: movedFiles.has(f.id) ? "personal_root" : "unchanged",
    });
  }
  const sourceGrants = s.grants.filter((g) => g.user_id === sourceId);
  const targetActor: Actor = {
    id: input.targetUserId,
    admin: 0,
    display_name: "",
  };
  const sourceActor: Actor = { id: sourceId, admin: 0, display_name: "" };
  const effective = (
    r: Resource,
    person: Actor,
    resources: Resource[],
    grants: Schema["grants"][],
  ) =>
    namedPermission(
      r,
      person,
      resources,
      [...grants, ...s.groupGrants].map((g) => ({
        ...g,
        blocked: g.status === "disabled",
      })) as Grant[],
    );
  const newGrants: Schema["grants"][] = [];
  const accessResources = selected.filter(
    (e) => e.kind === "resource_access" && !resourceIds.has(e.id),
  );
  for (const entry of accessResources) {
    const local = sourceGrants.filter(
      (g) => g.resource_id === entry.id && g.status === "active",
    );
    const direct = s.grants.find(
      (g) =>
        g.resource_id === entry.id &&
        g.user_id === input.targetUserId &&
        g.source_type === "direct",
    );
    const override = s.grants.find(
      (g) =>
        g.resource_id === entry.id &&
        g.user_id === input.targetUserId &&
        g.source_type === "parent_override",
    );
    if (direct?.status === "disabled" || override?.status === "disabled")
      addConflict(entry.id, entry.name, "permission_restricted");
    const active = [...local, ...(direct?.status === "active" ? [direct] : [])];
    const selfRank = Math.max(0, ...active.map((g) => ranks[g.role]));
    const descendantRank = Math.max(
      0,
      ...active
        .filter((g) => g.include_descendants === 1)
        .map((g) => ranks[g.role]),
    );
    // A high node-only grant and a lower subtree grant cannot be collapsed into a stronger subtree grant.
    if (descendantRank !== 0 && descendantRank !== selfRank)
      addConflict(entry.id, entry.name, "grant_shape");
    const role =
      local.find((g) => ranks[g.role] === selfRank)?.role ?? direct!.role;
    const grant: Schema["grants"] = {
      resource_id: entry.id,
      user_id: input.targetUserId,
      source_type: "direct",
      source_id: "",
      source_resource_id: null,
      role,
      include_descendants: descendantRank ? 1 : 0,
      status: "active",
      created_by: actor.id,
    };
    newGrants.push(grant);
    changes.push({
      id: entry.id,
      kind: "resource",
      name: entry.name,
      action: "access",
      role,
      includeDescendants: descendantRank > 0,
      deleted: entry.deleted,
      destination: "unchanged",
    });
  }
  const afterResources = s.resources.map((r) =>
    resourceIds.has(r.id) ? { ...r, owner_id: input.targetUserId } : r,
  );
  const afterGrants = [
    ...s.grants.filter(
      (g) =>
        !newGrants.some(
          (n) =>
            n.resource_id === g.resource_id &&
            g.user_id === n.user_id &&
            g.source_type === "direct",
        ),
    ),
    ...newGrants,
  ];
  const affected = subtree(
    s.resources,
    new Set([...resourceIds, ...accessResources.map((e) => e.id)]),
    true,
  );
  const accessAffected = subtree(
    s.resources,
    new Set(accessResources.map((e) => e.id)),
    true,
  );
  for (const r of accessAffected) {
    const sourceRank = effective(r, sourceActor, s.resources, s.grants);
    const targetRank = effective(r, targetActor, s.resources, s.grants);
    const after = effective(
      afterResources.find((next) => next.id === r.id)!,
      targetActor,
      afterResources,
      afterGrants,
    );
    const offered = effective(
      r,
      targetActor,
      s.resources.map((row) => ({ ...row, owner_id: "" })),
      newGrants,
    );
    if (after > Math.max(sourceRank, targetRank) && !resourceIds.has(r.id))
      addConflict(r.id, r.title, "permission_scope");
    if (after < Math.max(Math.min(offered, sourceRank), targetRank))
      addConflict(r.id, r.title, "permission_restricted");
  }
  const folderShares: Schema["file_folder_shares"][] = [];
  for (const entry of selected.filter(
    (e) => e.kind === "folder_access" && !folderIds.has(e.id),
  )) {
    const source = s.shares.find(
      (g) => g.folder_id === entry.id && g.user_id === sourceId,
    )!;
    const target = s.shares.find(
      (g) => g.folder_id === entry.id && g.user_id === input.targetUserId,
    );
    const role =
      source.role === "admin" || target?.role === "admin"
        ? ("admin" as const)
        : ("reader" as const);
    folderShares.push({
      ...source,
      user_id: input.targetUserId,
      role,
      version: target ? target.version + 1 : 1,
    });
    changes.push({
      id: entry.id,
      kind: "folder",
      name: entry.name,
      action: "access",
      role,
      includeDescendants: true,
      deleted: entry.deleted,
      destination: "unchanged",
    });
  }
  // Include ancestors in the fingerprint: changing inherited permissions invalidates confirmation too.
  const relevantIds = new Set(affected.map((r) => r.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of s.resources)
      if (relevantIds.has(r.id))
        for (const id of [r.parent_id, r.library_id])
          if (id && !relevantIds.has(id)) {
            relevantIds.add(id);
            changed = true;
          }
  }
  const folderTreeIds = new Set(folderTree.map((f) => f.id));
  // Read every affected file, including files owned by other people in shared directories.
  const affectedFiles = folderTreeIds.size
    ? await db
        .selectFrom("file_items")
        .selectAll()
        .where("parent_type", "=", "folder")
        .where("parent_id", "in", [...folderTreeIds])
        .orderBy("id")
        .execute()
    : [];
  const retained = [
    ...affected
      .filter((r) => !resourceIds.has(r.id))
      .map((r) => ({ id: r.id, kind: "resource" as const, name: r.title })),
    ...folderTree
      .filter((f) => !folderIds.has(f.id))
      .map((f) => ({ id: f.id, kind: "folder" as const, name: f.name })),
    ...affectedFiles
      .filter((f) => !ownFiles.some((own) => own.id === f.id))
      .map((f) => ({ id: f.id, kind: "file" as const, name: f.name })),
  ];
  const changedResourceIds = new Set(
    changes.filter((c) => c.kind === "resource").map((c) => c.id),
  );
  const changedFolderIds = new Set(
    changes.filter((c) => c.kind === "folder").map((c) => c.id),
  );
  const invitations = changedResourceIds.size
    ? await db
        .selectFrom("access_invitations")
        .selectAll()
        .where("resource_id", "in", [...changedResourceIds])
        .where("user_id", "in", [sourceId, input.targetUserId])
        .where("state", "=", "pending")
        .orderBy("resource_id")
        .orderBy("user_id")
        .execute()
    : [];
  const folderInvitations = changedFolderIds.size
    ? await db
        .selectFrom("file_folder_invitations")
        .selectAll()
        .where("folder_id", "in", [...changedFolderIds])
        .where("user_id", "in", [sourceId, input.targetUserId])
        .where("state", "=", "pending")
        .orderBy("id")
        .execute()
    : [];
  const locatedChanges = changes.map((change) => ({
    ...change,
    path: itemPath(s, change.kind, change.id),
  }));
  const facts = {
    groups: ownGroups,
    groupMembers: s.groupMembers.filter(member => ownGroups.some(group => group.id === member.group_id)),
    groupGrants: s.groupGrants.filter(grant => relevantIds.has(grant.resource_id)),
    affectedFiles,
    invitations,
    folderInvitations,
    retained,
    source: s.source,
    target: s.target,
    keys,
    resources: s.resources.filter((r) => relevantIds.has(r.id)),
    folders: s.folders,
    files: ownFiles,
    assets,
    grants: s.grants.filter((g) => relevantIds.has(g.resource_id)),
    shares: s.shares,
    changes: locatedChanges,
    conflicts,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ actorId: actor.id, ...facts }))
    .digest("hex");
  const bytesByObject = new Map<string, number>();
  for (const f of ownFiles)
    bytesByObject.set(`file:${f.storage_object_id}`, Number(f.size));
  // Assets and directory items can reference the same bytes. Resolve through the registered object identity.
  const objects = assets.length
    ? await db
        .selectFrom("file_storage_objects")
        .select(["id", "profile_id", "object_key"])
        .where(
          "object_key",
          "in",
          assets.map((a) => a.object_key),
        )
        .execute()
    : [];
  for (const a of assets) {
    const object = objects.find(
      (o) => o.profile_id === a.profile_id && o.object_key === a.object_key,
    );
    bytesByObject.set(
      object ? `file:${object.id}` : `asset:${a.id}`,
      Number(a.size),
    );
  }
  const preview: HandoverPreview = {
    fingerprint,
    source: { id: s.source.id, display_name: s.source.display_name },
    target: { id: s.target!.id, display_name: s.target!.display_name },
    changes: locatedChanges,
    conflicts,
    retained,
    cancelledInvitations: invitations.length + folderInvitations.length,
    affectedResources: affected.length,
    bytes: [...bytesByObject.values()].reduce((sum, bytes) => sum + bytes, 0),
  };
  return {
    s,
    preview,
    ownResources,
    ownGroups,
    ownFolders,
    ownFiles,
    assets,
    newGrants,
    folderShares,
    movedFolders,
    movedFiles,
    invitations,
    folderInvitations,
  };
}

export async function previewUserHandover(
  db: DB,
  actor: Actor,
  sourceId: string,
  input: HandoverInput,
) {
  return readSnapshot(
    db,
    async (tx) => (await plan(tx, actor, sourceId, input)).preview,
  );
}

export async function executeUserHandover(
  db: DB,
  actor: Actor,
  sourceId: string,
  input: HandoverInput & { fingerprint: string },
) {
  return transact(db, async (tx) => {
    // Account state changes serialize with the handover; no impersonation of the disabled owner.
    if (databaseDriver(tx) === "postgres")
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "in", [actor.id, sourceId, input.targetUserId])
        .orderBy("id")
        .forUpdate()
        .execute();
    const p = await plan(tx, actor, sourceId, input);
    if (p.preview.fingerprint !== input.fingerprint)
      reject(409, "handover_changed");
    if (p.preview.conflicts.length) reject(409, "handover_conflict");
    const now = new Date().toISOString();
    for (const group of p.ownGroups) {
      await touchGroup(tx, group.id, group.revision);
      await tx.updateTable("user_group_members").set({ role: "member" }).where("group_id", "=", group.id).where("user_id", "=", sourceId).execute();
      await tx.updateTable("user_group_members").set({ role: "owner" }).where("group_id", "=", group.id).where("user_id", "=", input.targetUserId).execute();
      await tx.updateTable("user_groups").set({ owner_id: input.targetUserId }).where("id", "=", group.id).execute();
      await groupChanged(tx, group.id, actor, "admin_transferred");
    }
    await checkStorage(tx, input.targetUserId, p.preview.bytes);
    for (const r of p.ownResources) {
      await checkTransfer(tx, r, input.targetUserId);
      await tx
        .updateTable("resources")
        .set((eb) => ({
          owner_id: input.targetUserId,
          version: eb("version", "+", 1),
          authz_revision: eb("authz_revision", "+", 1),
          updated_at: now,
        }))
        .where("id", "=", r.id)
        .execute();
      await tx
        .deleteFrom("grants")
        .where("resource_id", "=", r.id)
        .where("user_id", "=", sourceId)
        .execute();
      await tx
        .updateTable("assets")
        .set({ owner_id: input.targetUserId })
        .where("resource_id", "=", r.id)
        .execute();
      await emitIntegrationEvent(tx, "resource.transferred", {
        resourceId: r.id,
        actorId: actor.id,
        previousOwnerId: sourceId,
        ownerId: input.targetUserId,
        kind: r.kind,
      });
    }
    for (const folder of p.ownFolders) {
      await tx
        .updateTable("file_folders")
        .set((eb) => ({
          owner_id: input.targetUserId,
          parent_id: p.movedFolders.has(folder.id) ? null : folder.parent_id,
          version: eb("version", "+", 1),
          updated_at: now,
        }))
        .where("id", "=", folder.id)
        .execute();
      await tx
        .deleteFrom("file_folder_shares")
        .where("folder_id", "=", folder.id)
        .where("user_id", "=", sourceId)
        .execute();
    }
    for (const file of p.ownFiles) {
      await tx
        .updateTable("file_items")
        .set((eb) => ({
          owner_id: input.targetUserId,
          ...(p.movedFiles.has(file.id)
            ? { parent_type: "system" as const, parent_id: "root" }
            : {}),
          version: eb("version", "+", 1),
          updated_at: now,
        }))
        .where("id", "=", file.id)
        .execute();
      await enqueueProjection(tx, "search-file", file.id, { fileId: file.id });
      await enqueueKnowledge(tx, "file", file.id);
    }
    for (const grant of p.newGrants) {
      await checkMemberAdmission(tx, grant.resource_id, input.targetUserId);
      await tx
        .insertInto("grants")
        .values({ ...grant, created_at: now, updated_at: now })
        .onConflict((c) =>
          c
            .columns(["resource_id", "user_id", "source_type", "source_id"])
            .doUpdateSet({
              role: grant.role,
              include_descendants: grant.include_descendants,
              updated_at: now,
            }),
        )
        .execute();
      await tx
        .deleteFrom("grants")
        .where("resource_id", "=", grant.resource_id)
        .where("user_id", "=", sourceId)
        .where("status", "=", "active")
        .execute();
      await tx
        .updateTable("resources")
        .set((eb) => ({
          version: eb("version", "+", 1),
          authz_revision: eb("authz_revision", "+", 1),
          updated_at: now,
        }))
        .where("id", "=", grant.resource_id)
        .execute();
      await emitIntegrationEvent(tx, "resource.permissions_changed", {
        resourceId: grant.resource_id,
        actorId: actor.id,
        userIds: [sourceId, input.targetUserId],
      });
    }
    for (const share of p.folderShares) {
      await tx
        .insertInto("file_folder_shares")
        .values({ ...share, created_at: now, updated_at: now })
        .onConflict((c) =>
          c.columns(["folder_id", "user_id"]).doUpdateSet({
            role: share.role,
            version: share.version,
            updated_at: now,
          }),
        )
        .execute();
      await tx
        .deleteFrom("file_folder_shares")
        .where("folder_id", "=", share.folder_id)
        .where("user_id", "=", sourceId)
        .execute();
    }
    for (const invitation of p.invitations) {
      await archiveInvitation(tx, {
        ...invitation,
        state: "cancelled",
        decided_by: actor.id,
        updated_at: now,
      });
      await tx
        .deleteFrom("access_invitations")
        .where("resource_id", "=", invitation.resource_id)
        .where("user_id", "=", invitation.user_id)
        .execute();
    }
    for (const invitation of p.folderInvitations)
      await cancelFolderInvitation(tx, invitation, actor.id, now);
    const changedResources = new Set(
      p.preview.changes.filter((c) => c.kind === "resource").map((c) => c.id),
    );
    const changedFolders = new Set(
      p.preview.changes.filter((c) => c.kind === "folder").map((c) => c.id),
    );
    await securityAudit(tx, actor.id, sourceId, "user.resources_handed_over", {
      targetUserId: input.targetUserId,
      fingerprint: input.fingerprint,
      changes: p.preview.changes,
      cancelledInvitations: p.preview.cancelledInvitations,
      previous: {
        resources: p.ownResources,
        folders: p.ownFolders,
        files: p.ownFiles,
        assets: p.assets.map((a) => ({ id: a.id, owner_id: a.owner_id })),
        grants: p.s.grants.filter((g) => changedResources.has(g.resource_id)),
        shares: p.s.shares.filter((g) => changedFolders.has(g.folder_id)),
      },
    });
    return { ok: true, changes: p.preview.changes.length };
  });
}
