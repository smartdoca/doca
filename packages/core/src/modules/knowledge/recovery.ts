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
  const transient =
    interrupted ||
    [429, 502, 503, 504].includes(status ?? 0) ||
    /timeout|timed out|abort|network|fetch failed|ECONN|连接提前关闭|输出中断|连接中断|超时/i.test(
      String(error),
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
