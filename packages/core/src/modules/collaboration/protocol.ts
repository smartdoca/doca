import type { Transaction } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import type { Schema } from "../../../../db/src/index.js";
import { fail } from "../../shared/errors.js";
export type EditorInput = {
  vector?: string;
  update?: string;
  epochId?: string;
  codec?: string;
  schemaVersion?: number;
  protocolVersion?: number;
  messageId?: string;
  restoreVersion?: string;
  expectedSeq?: number;
};
export async function editorEpoch(
  tx: Transaction<Schema>,
  id: string,
  baseline: string | null = null,
) {
  let row = await tx
    .selectFrom("editor_epochs")
    .selectAll()
    .where("resource_id", "=", id)
    .executeTakeFirst();
  if (!row) {
    row = { resource_id: id, epoch_id: randomUUID(), baseline };
    await tx.insertInto("editor_epochs").values(row).execute();
  }
  return row;
}
export function checkProtocol(
  input: EditorInput,
  codec: string,
  schemaVersion: number,
  epochId?: string,
) {
  if (input.restoreVersion) return;
  if (
    input.protocolVersion !== 1 ||
    input.codec !== codec ||
    input.schemaVersion !== schemaVersion
  )
    fail(409, "编辑器协议不匹配，请更新客户端；原始数据未修改");
  if (
    (input.epochId && input.epochId !== epochId) ||
    (input.update !== undefined && (!epochId || input.epochId !== epochId))
  )
    fail(409, "文档谱系不匹配，未同步内容保留在本地，请导出恢复副本");
}
export async function checkReceipt(
  tx: Transaction<Schema>,
  id: string,
  epochId: string,
  input: EditorInput,
) {
  if (input.update === undefined || input.restoreVersion) return undefined;
  if (!input.messageId || input.messageId.length > 80)
    fail(400, "缺少提交标识");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.update,
    )
  )
    fail(400, "协同数据格式无效");
  const digest = createHash("sha256")
    .update(Buffer.from(input.update, "base64"))
    .digest("hex");
  const old = await tx
    .selectFrom("editor_receipts")
    .selectAll()
    .where("resource_id", "=", id)
    .where("epoch_id", "=", epochId)
    .where("message_id", "=", input.messageId)
    .executeTakeFirst();
  if (old && old.digest !== digest) fail(409, "同一提交标识不能对应不同内容");
  return { digest, old };
}
export async function saveReceipt(
  tx: Transaction<Schema>,
  id: string,
  epochId: string,
  input: EditorInput,
  receipt: Awaited<ReturnType<typeof checkReceipt>>,
  seq: number,
) {
  if (receipt && !receipt.old)
    await tx
      .insertInto("editor_receipts")
      .values({
        resource_id: id,
        epoch_id: epochId,
        message_id: input.messageId!,
        digest: receipt.digest,
        seq,
      })
      .execute();
}
