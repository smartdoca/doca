import { createHash } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import type { FilesRequestContext } from "@smartdoca/files-capability";
import { fail } from "@core/shared/errors.js";
import { fileOperationScope } from "./file-operation-scope.js";
export type Receipt = Schema["file_operation_receipts"];
export function operationIdentity(
  context: FilesRequestContext,
  operation: string,
  key: string,
) {
  const pluginId = (
    context as FilesRequestContext & { [fileOperationScope]?: string }
  )[fileOperationScope];
  if (!pluginId || !context.principalId)
    fail(400, "Idempotency requires an installed plugin context");
  if (
    typeof key !== "string" ||
    !key.length ||
    key.length > 200 ||
    /[\x00-\x1f\x7f]/.test(key)
  )
    fail(400, "Invalid idempotency key");
  return {
    plugin_id: pluginId,
    user_id: context.principalId,
    operation,
    operation_key: key,
  };
}
export function requestHash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export async function findReceipt(
  db: DB,
  identity: ReturnType<typeof operationIdentity>,
  hash?: string,
) {
  const row = await db
    .selectFrom("file_operation_receipts")
    .selectAll()
    .where("plugin_id", "=", identity.plugin_id)
    .where("user_id", "=", identity.user_id)
    .where("operation", "=", identity.operation)
    .where("operation_key", "=", identity.operation_key)
    .executeTakeFirst();
  if (row && hash !== undefined && row.request_hash !== hash)
    fail(409, "Idempotency key was already used with different parameters");
  return row;
}
/** Locks a host identity row, independently of AI bookkeeping, before checking receipts. */
export async function lockFileActor(db: DB, id: string) {
  await db.updateTable("users").set({ id }).where("id", "=", id).execute();
}
export async function completeReceipt(
  db: DB,
  identity: ReturnType<typeof operationIdentity>,
  hash: string,
  result: unknown,
) {
  await db
    .insertInto("file_operation_receipts")
    .values({
      ...identity,
      request_hash: hash,
      status: "completed",
      result: JSON.stringify(result),
      object_id: null,
      profile_id: null,
      object_key: null,
      cleanup_at: null,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc
        .columns(["plugin_id", "user_id", "operation", "operation_key"])
        .doUpdateSet({ status: "completed", result: JSON.stringify(result) }),
    )
    .execute();
}
