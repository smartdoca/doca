import { entitlements } from "../entitlements/service.js";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
export type RecoveryMetadata = {
  origin?: "ai";
  version: 1;
  format: string;
  codec: string;
  epochId: string | null;
  baseline: unknown;
  assetIds: string[];
};
/** Every business version carries its own decoding dependencies, never the current baseline. */
export async function recordVersion(
  db: DB,
  row: Schema["document_versions"],
  origin?: "ai",
) {
  return transact(db, async (db) => {
    const resource = await db
      .selectFrom("resources")
      .select(["format", "owner_id"])
      .where("id", "=", row.resource_id)
      .executeTakeFirstOrThrow();
    const e = await entitlements(db, resource.owner_id),
      limit = e.level.limits["history.versions"];
    if (limit === 0) {
      await db
        .deleteFrom("document_versions")
        .where("resource_id", "=", row.resource_id)
        .execute();
      return;
    }
    const state = await db
      .selectFrom("document_states")
      .select("codec")
      .where("resource_id", "=", row.resource_id)
      .executeTakeFirstOrThrow();
    const epoch = await db
      .selectFrom("editor_epochs")
      .selectAll()
      .where("resource_id", "=", row.resource_id)
      .executeTakeFirst();
    const markdown =
      resource.format === "markdown"
        ? await db
            .selectFrom("markdown_epochs")
            .select("epoch_id")
            .where("resource_id", "=", row.resource_id)
            .executeTakeFirst()
        : null;
    const assets = await db
      .selectFrom("assets")
      .select("id")
      .where("resource_id", "=", row.resource_id)
      .where("deleted_at", "is", null)
      .execute();
    const metadata: RecoveryMetadata = {
      ...(origin ? { origin } : {}),
      version: 1,
      format: resource.format,
      codec: state.codec,
      epochId: epoch?.epoch_id ?? markdown?.epoch_id ?? null,
      baseline: epoch?.baseline ? JSON.parse(epoch.baseline) : null,
      assetIds: assets.map((a) => a.id),
    };
    await db
      .insertInto("document_versions")
      .values({ ...row, recovery_json: JSON.stringify(metadata) })
      .execute();
    if (limit !== null) {
      // Always retain the snapshot just written, including equal timestamps/seqs.
      // Prune in the same transaction so a failed save cannot remove old history.
      const retained = db
        .selectFrom("document_versions")
        .select("id")
        .where("resource_id", "=", row.resource_id)
        .where("id", "!=", row.id)
        .orderBy("created_at", "desc")
        .orderBy("seq", "desc")
        .orderBy("id", "desc")
        .limit(limit - 1);
      await db
        .deleteFrom("document_versions")
        .where("resource_id", "=", row.resource_id)
        .where("id", "!=", row.id)
        .where("id", "not in", retained)
        .execute();
    }
  });
}
export function recoveryMetadata(
  row: Schema["document_versions"],
): RecoveryMetadata {
  if (!row.recovery_json) fail(409, "此版本缺少独立恢复信息，无法安全预览");
  const metadata = JSON.parse(row.recovery_json) as RecoveryMetadata;
  if (metadata.version !== 1) fail(409, "不支持的历史版本格式");
  return metadata;
}
