import type { DB, Schema } from "../../../../db/src/index.js";
import type { Actor } from "../identity/passwords.js";
import { fail } from "../../shared/errors.js";
import { accessContext } from "./queries.js";
import { isResourceOwnerLike, label, permission, ranks } from "./policy.js";
import { canChangeMemberRole } from "./roles.js";
import { requestedRoles } from "./presentation.js";
import { requireCapability } from "../access/operation-policy.js";
import { checkMemberAdmission } from "../access/operation-policy.js";
import { touchAccess } from "./invitations.js";
import { setEntry } from "../discovery/entries.js";
export type GrantOperation = {
  type: "resource.grant";
  resourceId: string;
  userId: string;
  role: Schema["grants"]["role"];
  includeDescendants: boolean;
};
export type ApprovalGrant = {
  role?: GrantOperation["role"];
  includeDescendants?: boolean;
};
/** Run inside the ticket transaction: authority, ACL, result and ticket state commit together. */
export async function executeApprovalGrant(
  tx: DB,
  actor: Actor,
  operation: GrantOperation,
) {
  const { resources, grants } = await accessContext(tx, actor, [
    operation.resourceId,
  ]);
  const r = resources.find((r) => r.id === operation.resourceId);
  if (
    !r ||
    r.deleted_at ||
    resources.find((x) => x.id === r.library_id)?.deleted_at
  )
    fail(404, "资源不存在");
  if (
    permission(r, actor, resources, grants) < 4 ||
    operation.userId === actor.id ||
    operation.userId === r.owner_id
  )
    fail(403, "没有审批权限");
  if (!["reader", "commenter", "editor", "manager"].includes(operation.role))
    fail(400, "授权角色无效");
  const user = await tx
    .selectFrom("users")
    .selectAll()
    .where("id", "=", operation.userId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!user) fail(409, "申请人已停用");
  const current = permission(r, user, resources, grants);
  if (!canChangeMemberRole(
    isResourceOwnerLike(r, actor, resources) ? "owner" : label(permission(r, actor, resources, grants)),
    label(current),
    operation.role,
  ))
    fail(403, "只有所有者可以调整管理权限");
  if (current > ranks[operation.role])
    fail(409, "申请人当前权限已高于本次授权，请刷新后重新选择");
  if (!requestedRoles(r, resources).includes(operation.role))
    fail(409, "该资源已停止接受权限申请");
  await requireCapability(tx, actor.id, "sharing.invite");
  await requireCapability(tx, r.owner_id, "sharing.invite");
  await checkMemberAdmission(tx, r.id, user.id);
  const row = {
    resource_id: r.id,
    user_id: user.id,
    source_type: "direct" as const,
    source_id: "",
    source_resource_id: null,
    role: operation.role,
    include_descendants: Number(operation.includeDescendants),
    status: "active" as const,
    created_by: actor.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await tx
    .insertInto("grants")
    .values(row)
    .onConflict((oc) =>
      oc
        .columns(["resource_id", "user_id", "source_type", "source_id"])
        .doUpdateSet(row),
    )
    .execute();
  await setEntry(tx, user, r.id, "joined", "request");
  await touchAccess(tx, r.id);
  return operation;
}
