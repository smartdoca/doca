import { createHash, randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { authorize } from "../access/queries.js";
import type { Actor } from "../identity/passwords.js";
import { fail } from "../../shared/errors.js";
import { emitIntegrationEvent } from "../automation/events.js";
export type ModerationConfig = {
  enabled: boolean;
  provider: "tencent";
  region: string;
  secretId: string;
  secretKey: string;
  textBizType: string;
  imageBizType: string;
  delaySeconds: number;
};
export async function moderationConfig(db: DB): Promise<ModerationConfig> {
  return JSON.parse(
    (
      await db
        .selectFrom("moderation_settings")
        .select("config")
        .where("id", "=", "system")
        .executeTakeFirstOrThrow()
    ).config,
  );
}
export async function moderationSnapshot(db: DB, id: string) {
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!r) fail(404, "文档不存在");
  const state = await db
    .selectFrom("document_states")
    .select(["text", "seq", "updated_at"])
    .where("resource_id", "=", id)
    .executeTakeFirst();
  const text = `${r.title}\n${state?.text ?? ""}`;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        text,
        state?.seq,
        state?.updated_at,
        r.moderation_revision ?? 0,
      ]),
    )
    .digest("hex");
  return { resource: r, text, fingerprint };
}
export async function moderationAction(
  db: DB,
  input: Partial<Schema["moderation_actions"]> & {
    action: string;
    reason: string;
  },
) {
  await db
    .insertInto("moderation_actions")
    .values({
      id: randomUUID(),
      case_id: null,
      actor_id: null,
      resource_id: null,
      user_id: null,
      created_at: new Date().toISOString(),
      ...input,
    })
    .execute();
}
/** Retention is sticky: lifting a block never erases the audit hold. */
export async function blockDocument(
  db: DB,
  id: string,
  blocked: boolean,
  actorId: string | null,
  reason: string,
  caseId: string | null = null,
) {
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!r || r.kind !== "document") fail(404, "文档不存在");
  if (blocked) {
    const snapshot = await moderationSnapshot(db, id),
      now = new Date().toISOString();
    const state = await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", id)
      .executeTakeFirst();
    const epoch = await db
      .selectFrom("editor_epochs")
      .selectAll()
      .where("resource_id", "=", id)
      .executeTakeFirst();
    const updates = state
      ? await db
          .selectFrom("document_updates")
          .selectAll()
          .where("resource_id", "=", id)
          .where("seq", ">", state.checkpoint_seq)
          .orderBy("seq")
          .execute()
      : [];
    const assets = await db
      .selectFrom("assets")
      .select(["id", "object_key", "profile_id", "filename", "mime"])
      .where("resource_id", "=", id)
      .execute();
    // Immutable evidence survives an eventual unblock and later edits, preserving CRDT identities.
    await db
      .insertInto("moderation_cases")
      .values({
        id: randomUUID(),
        resource_id: id,
        asset_id: null,
        reporter_id: null,
        subject_user_id: r.owner_id,
        kind: "archive",
        status: "archived",
        reason,
        title: r.title,
        evidence: snapshot.text,
        result: JSON.stringify({ resource: r, state, epoch, updates, assets }),
        fingerprint: snapshot.fingerprint,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  await db
    .updateTable("resources")
    .set((eb) => ({
      moderation_status: blocked ? "blocked" : "active",
      ...(blocked ? { moderation_hold: 1 } : {}),
      moderation_revision: eb("moderation_revision", "+", 1),
      authz_revision: eb("authz_revision", "+", 1),
      version: eb("version", "+", 1),
    }))
    .where("id", "=", id)
    .execute();
  await moderationAction(db, {
    actor_id: actorId,
    resource_id: id,
    case_id: caseId,
    action: blocked ? "document.blocked" : "document.unblocked",
    reason,
  });
  await emitIntegrationEvent(db, "resource.moderation", { resourceId: id });
}
export async function reportDocument(
  db: DB,
  actor: Actor,
  id: string,
  reason: string,
) {
  return transact(db, async (tx) => {
    const { resource } = await authorize(tx, actor, id);
    if (resource.kind !== "document") fail(400, "仅支持举报文档");
    if (resource.owner_id === actor.id) fail(400, "不能举报自己的文档");
    if (!reason.trim() || reason.length > 2000)
      fail(400, "请填写举报原因（最多 2000 字）");
    const existing = await tx
      .selectFrom("moderation_cases")
      .select("id")
      .where("reporter_id", "=", actor.id)
      .where("resource_id", "=", id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (existing) return existing;
    const snapshot = await moderationSnapshot(tx, id),
      now = new Date().toISOString(),
      caseId = randomUUID();
    await tx
      .insertInto("moderation_cases")
      .values({
        id: caseId,
        resource_id: id,
        asset_id: null,
        reporter_id: actor.id,
        subject_user_id: resource.owner_id,
        kind: "report",
        status: "pending",
        reason: reason.trim(),
        title: resource.title,
        evidence: snapshot.text,
        fingerprint: snapshot.fingerprint,
        result: "{}",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await moderationAction(tx, {
      case_id: caseId,
      actor_id: actor.id,
      resource_id: id,
      action: "report.created",
      reason: reason.trim(),
    });
    return { id: caseId };
  });
}
export async function decideCase(
  db: DB,
  actor: Actor,
  id: string,
  decision: "dismiss" | "block_document" | "block_user" | "approve_image",
  reason: string,
) {
  if (!actor.admin) fail(403, "需要系统管理员权限");
  if (!reason.trim()) fail(400, "请填写处理说明");
  return transact(db, async (tx) => {
    const row = await tx
      .selectFrom("moderation_cases")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) fail(404, "审核记录不存在");
    const claimed = await tx
      .updateTable("moderation_cases")
      .set({ status: "resolved", updated_at: new Date().toISOString() })
      .where("id", "=", id)
      .where("status", "in", ["pending", "blocked", "error"])
      .executeTakeFirst();
    if (!claimed.numUpdatedRows) fail(409, "此记录已处理，请刷新");
    if (decision === "block_document") {
      if (!row.resource_id) fail(400, "此记录未关联文档");
      await blockDocument(tx, row.resource_id, true, actor.id, reason, id);
    }
    if (decision === "block_user") {
      const user = await tx
        .selectFrom("users")
        .selectAll()
        .where("id", "=", row.subject_user_id)
        .executeTakeFirst();
      if (!user || user.admin || user.id === actor.id)
        fail(403, "不能在内容审核中封禁管理员");
      await tx
        .updateTable("users")
        .set({ status: "disabled" })
        .where("id", "=", user.id)
        .execute();
      await tx.deleteFrom("sessions").where("user_id", "=", user.id).execute();
    }
    if (decision === "approve_image") {
      if (!row.asset_id) fail(400, "此记录不是图片");
      await tx
        .updateTable("assets")
        .set({ moderation_status: "pass" })
        .where("id", "=", row.asset_id)
        .execute();
      await tx
        .deleteFrom("projection_jobs")
        .where("id", "=", `moderation-image:${row.asset_id}`)
        .execute();
    }
    await moderationAction(tx, {
      case_id: id,
      actor_id: actor.id,
      resource_id: row.resource_id,
      user_id: row.subject_user_id,
      action: decision,
      reason,
    });
    return row;
  });
}
