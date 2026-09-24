import { createHash, randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  blockDocument,
  moderationConfig,
  moderationSnapshot,
} from "@core/modules/moderation/service.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import {
  createModerationProvider,
  type ModerationRuntime,
  type Verdict,
} from "../adapters/moderation.js";
import {
  createStorage,
  storageDefaults,
  type StorageConfig,
  type StorageRuntime,
} from "../adapters/storage.js";
export function createModerationWorker(
  db: DB,
  storageRuntime: StorageRuntime,
  runtime: ModerationRuntime = {},
  changed: (id: string) => Promise<void> = async () => {},
) {
  const provider = createModerationProvider(runtime),
    storage = createStorage(storageRuntime);
  async function review(kind: "text" | "image", id: string, bytes?: Buffer) {
    const config = await moderationConfig(db);
    if (!config.enabled) return;
    let resourceId: string | null = null,
      userId: string,
      title: string,
      evidence = "",
      fingerprint: string;
    if (kind === "text") {
      const r = await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!r || r.kind !== "document" || r.moderation_status === "blocked")
        return;
      const snap = await moderationSnapshot(db, id);
      resourceId = id;
      userId = r.last_editor_id ?? r.owner_id;
      title = r.title;
      evidence = snap.text;
      fingerprint = snap.fingerprint;
    } else {
      const asset = await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!asset || asset.deleted_at || asset.moderation_status !== "pending")
        return;
      resourceId = asset.resource_id;
      userId = asset.uploaded_by ?? asset.owner_id;
      title = asset.filename;
      if (!bytes) {
        const p = await db
          .selectFrom("storage_profiles")
          .selectAll()
          .where("id", "=", asset.profile_id)
          .executeTakeFirstOrThrow();
        bytes = await storage.read(
          {
            ...storageDefaults,
            ...JSON.parse(p.config),
            provider: p.provider,
          } as StorageConfig,
          asset.object_key,
        );
      }
      fingerprint = createHash("sha256").update(bytes).digest("hex");
    }
    let results: Verdict[] = [],
      error = false;
    try {
      results =
        kind === "text"
          ? await provider.text(config, evidence, id)
          : await provider.image(config, bytes!, id);
    } catch {
      error = true;
    }
    const suggestion = results.some((r) => r.suggestion === "Block")
      ? "Block"
      : results.some((r) => r.suggestion === "Review")
        ? "Review"
        : "Pass";
    let didBlock = false;
    await transact(db, async (tx) => {
      // An in-flight response cannot overwrite a newer edit or administrator decision.
      if (kind === "text") {
        const current = await moderationSnapshot(tx, id);
        if (
          current.fingerprint !== fingerprint ||
          current.resource.moderation_status === "blocked"
        )
          return;
      } else {
        const asset = await tx
          .selectFrom("assets")
          .select("moderation_status")
          .where("id", "=", id)
          .executeTakeFirst();
        if (asset?.moderation_status !== "pending") return;
      }
      if (!(await moderationConfig(tx)).enabled) return;
      const now = new Date().toISOString(),
        caseId = randomUUID();
      const previousErrors = tx
        .selectFrom("moderation_cases")
        .select("id")
        .where("kind", "=", kind)
        .where("fingerprint", "=", fingerprint)
        .where("status", "=", "error");
      const previous = await (
        kind === "image"
          ? previousErrors.where("asset_id", "=", id)
          : previousErrors.where("resource_id", "=", id)
      ).execute();
      if (previous.length) {
        await tx
          .updateTable("moderation_cases")
          .set({ updated_at: now, ...(error ? {} : { status: "resolved" }) })
          .where(
            "id",
            "in",
            previous.map((r) => r.id),
          )
          .execute();
        if (error) return;
      }

      await tx
        .insertInto("moderation_cases")
        .values({
          id: caseId,
          resource_id: resourceId,
          asset_id: kind === "image" ? id : null,
          reporter_id: null,
          subject_user_id: userId,
          kind,
          status: error
            ? "error"
            : suggestion === "Block"
              ? "blocked"
              : suggestion === "Review"
                ? "pending"
                : "passed",
          reason: error
            ? "云审核暂不可用，任务会自动重试"
            : results
                .map((r) => r.label)
                .filter(Boolean)
                .join("、"),
          title,
          evidence,
          fingerprint,
          result: JSON.stringify(results),
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (kind === "image" && !error)
        await tx
          .updateTable("assets")
          .set({
            moderation_status:
              suggestion === "Pass"
                ? "pass"
                : suggestion === "Review"
                  ? "review"
                  : "blocked",
          })
          .where("id", "=", id)
          .execute();
      if (kind === "text" && suggestion === "Block" && !error && resourceId) {
        await blockDocument(
          tx,
          resourceId,
          true,
          null,
          "云审核判定违规",
          caseId,
        );
        didBlock = true;
      }
    });
    if (didBlock && resourceId) await changed(resourceId);
    if (error) throw Error("云审核暂不可用");
  }
  return {
    review,
    async tick() {
      if (!(await moderationConfig(db)).enabled) return;
      await processProjections(
        db,
        "moderation-image",
        (p) => review("image", String(p.assetId)),
        2,
        900000,
      );
      await processProjections(
        db,
        "moderation-text",
        (p) => review("text", String(p.resourceId)),
        2,
        900000,
      );
    },
  };
}
