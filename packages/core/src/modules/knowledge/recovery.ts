import type { DB } from "@db/index.js";

export async function retryKnowledgeTask(
  db: DB,
  taskId: string,
  error: unknown,
  interrupted = false,
) {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as any)?.statusCode;
  const message = String(error);
  // Authentication, quota, and configuration failures stay failed. Retrying them
  // only queues the same answer again.
  if (
    /模型认证失败|账户余额不足|厂商拒绝访问|模型或接口不存在|厂商拒绝请求|请先配置 AI 模型|模型配置已变化|所选模型未启用|请检查模型配置|单次输出上限|非 JSON 响应|模型输出中断|知识模型输出中断/.test(
      message,
    )
  )
    return false;
  const transient =
    interrupted ||
    [429, 502, 503, 504].includes(status ?? 0) ||
    /timeout|timed out|abort|network|fetch failed|ECONN|连接提前关闭|连接中断|超时/i.test(
      message,
    );
  if (!transient) return false;
  const current = await db
    .selectFrom("knowledge_checkpoints")
    .selectAll()
    .where("task_id", "=", taskId)
    .executeTakeFirst();
  const attempts = (current?.attempts ?? 0) + 1;
  if (attempts > 3) return false;
  const available_at = new Date(
    Date.now() + Math.min(60000, 2000 * 2 ** attempts),
  ).toISOString();
  await db
    .insertInto("knowledge_checkpoints")
    .values({
      task_id: taskId,
      detail: current?.detail ?? "{}",
      attempts,
      available_at,
    })
    .onConflict((oc) =>
      oc.column("task_id").doUpdateSet({ attempts, available_at }),
    )
    .execute();
  await db
    .updateTable("knowledge_tasks")
    .set({
      status: "queued",
      error: String(error).slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", taskId)
    .execute();
  return true;
}
