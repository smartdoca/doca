import { z } from "zod";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { fail } from "../../shared/errors.js";

const bound = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uploadLimitsSchema = z
  .object({ maxFiles: bound, maxFileBytes: bound, maxTotalBytes: bound })
  .strict();
export type AIUploadLimits = z.infer<typeof uploadLimitsSchema>;
export const uploadPolicySchema = z
  .object({
    version: z.literal(1),
    global: uploadLimitsSchema,
    users: z.record(z.string().uuid(), uploadLimitsSchema),
  })
  .strict();
export type AIUploadPolicy = z.infer<typeof uploadPolicySchema>;
export const defaultUploadPolicy: AIUploadPolicy = {
  version: 1,
  global: {
    maxFiles: 100,
    maxFileBytes: 100 * 1024 ** 2,
    maxTotalBytes: 500 * 1024 ** 2,
  },
  users: {},
};
const key = "ai-upload-policy";
export async function readUploadPolicy(db: DB) {
  const row = await db
    .selectFrom("account_settings")
    .selectAll()
    .where("id", "=", key)
    .executeTakeFirst();
  return {
    policy: row
      ? uploadPolicySchema.parse(JSON.parse(row.config))
      : structuredClone(defaultUploadPolicy),
    revision: row?.revision ?? 0,
  };
}
export async function userUploadLimits(db: DB, userId: string) {
  const { policy } = await readUploadPolicy(db);
  return policy.users[userId] ?? policy.global;
}
export function checkUploadLimits(limits: AIUploadLimits, sizes: number[]) {
  if (limits.maxFiles && sizes.length > limits.maxFiles)
    fail(400, "upload_count_exceeded");
  if (limits.maxFileBytes && sizes.some((size) => size > limits.maxFileBytes))
    fail(413, "upload_file_size_exceeded");
  if (
    limits.maxTotalBytes &&
    sizes.reduce((sum, size) => sum + size, 0) > limits.maxTotalBytes
  )
    fail(413, "upload_total_size_exceeded");
}
export async function saveUploadPolicy(
  db: DB,
  input: AIUploadPolicy,
  revision: number,
) {
  const policy = uploadPolicySchema.parse(input);
  return transact(db, async (tx) => {
    if ((await readUploadPolicy(tx)).revision !== revision)
      fail(409, "upload_policy_changed");
    for (const id of Object.keys(policy.users)) {
      if (
        !(await tx
          .selectFrom("users")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst())
      )
        fail(404, "upload_policy_user_missing");
    }
    if (revision === 0)
      await tx
        .insertInto("account_settings")
        .values({ id: key, config: JSON.stringify(policy), revision: 1 })
        .execute();
    else {
      const result = await tx
        .updateTable("account_settings")
        .set({ config: JSON.stringify(policy), revision: revision + 1 })
        .where("id", "=", key)
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!result.numUpdatedRows) fail(409, "upload_policy_changed");
    }
    return { policy, revision: revision + 1 };
  });
}
