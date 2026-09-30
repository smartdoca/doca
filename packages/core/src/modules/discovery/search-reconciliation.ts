import { createHash, randomUUID } from "node:crypto";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { projectionErrorMessage } from "../automation/jobs.js";

export type SearchConfig = Schema["search_settings"];
export type IndexedDocument = {
  id: string;
  title: string;
  text: string;
  content_hash: string;
};
export function searchDocument(row: {
  id: string;
  title: string;
  text: string | null;
}): IndexedDocument {
  const text = row.text ?? "";
  return {
    id: row.id,
    title: row.title,
    text,
    content_hash: createHash("sha256")
      .update(JSON.stringify([row.title, text]))
      .digest("hex"),
  };
}

/** The caller includes this reset in the settings transaction. */
export async function resetSearchReconciliation(
  db: DB,
  generation: number,
  now = new Date().toISOString(),
) {
  await db.deleteFrom("search_reconcile_entries").execute();
  await db
    .updateTable("search_reconciliation")
    .set({
      generation,
      round_id: "",
      phase: "idle",
      cursor: "",
      remote_offset: 0,
      scanned: 0,
      differences: 0,
      started_at: null,
      checked_at: null,
      completed_at: null,
      next_at: now,
      lease_token: null,
      lease_until: null,
      last_error: null,
    })
    .where("id", "=", "system")
    .execute();
}

/** One bounded page per tick. Remote inventory is durable before repairs begin. */
export function createSearchReconciler(
  db: DB,
  options: {
    list: (
      config: SearchConfig,
      offset: number,
      limit: number,
    ) => Promise<unknown>;
    pageSize?: number;
    now?: () => number;
  },
) {
  const pageSize = options.pageSize ?? 100;
  const now = () => new Date((options.now ?? Date.now)()).toISOString();
  const later = (ms: number) =>
    new Date((options.now ?? Date.now)() + ms).toISOString();

  async function status() {
    return transact(db, async (tx) => {
      let state = await tx
        .selectFrom("search_reconciliation")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirst();
      if (!state) {
        const settings = await tx
          .selectFrom("search_settings")
          .select("generation")
          .where("id", "=", "system")
          .executeTakeFirst();
        await tx
          .insertInto("search_reconciliation")
          .values({
            id: "system",
            generation: settings?.generation ?? 1,
            round_id: "",
            phase: "idle",
            cursor: "",
            remote_offset: 0,
            scanned: 0,
            differences: 0,
            next_at: now(),
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        state = await tx
          .selectFrom("search_reconciliation")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
      }
      const count = await tx
        .selectFrom("search_reconcile_entries")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("pending", "=", 1)
        .executeTakeFirstOrThrow();
      const failed = await tx
        .selectFrom("projection_jobs")
        .select(["id", "last_error", "attempts", "available_at"])
        .where("kind", "=", "search")
        .where("last_error", "is not", null)
        .orderBy("available_at", "desc")
        .limit(1)
        .executeTakeFirst();
      const failedError = failed?.last_error ?? null;
      return {
        phase: state.phase,
        scanned: state.scanned,
        differences: state.differences,
        pending: Number(count.count),
        startedAt: state.started_at,
        checkedAt: state.checked_at,
        completedAt: state.completed_at,
        nextAt: state.next_at,
        failedAttempts: Number(failed?.attempts ?? 0),
        retryAt: failed?.available_at ?? null,
        lastError:
          state.last_error ??
          (failedError === "投影任务执行失败，请检查服务连接"
            ? "此前失败记录没有保存具体原因；正在自动重试，新的失败会显示详细原因。"
            : failedError),
      };
    });
  }

  async function schedule() {
    await db
      .updateTable("search_reconciliation")
      .set({ next_at: now() })
      .where("id", "=", "system")
      .execute();
  }

  async function queue(tx: DB, id: string) {
    // Preserve a newer content event, its due time, lease and retry backoff.
    await tx
      .insertInto("projection_jobs")
      .values({
        id:
          id.length <= 153
            ? `search:${id}`
            : `search-orphan:${createHash("sha256").update(id).digest("hex")}`,
        kind: "search",
        payload: JSON.stringify({ resourceId: id }),
        revision: 1,
        attempts: 0,
        available_at: now(),
        last_error: null,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  async function tick(config: SearchConfig) {
    const token = randomUUID();
    const state = await transact(db, async (tx) => {
      const current = await tx
        .selectFrom("search_settings")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
      if (!current.enabled || current.generation !== config.generation)
        return null;
      const claimed = await tx
        .updateTable("search_reconciliation")
        .set({ lease_token: token, lease_until: later(60000) })
        .where("id", "=", "system")
        .where("generation", "=", config.generation)
        .where("next_at", "<=", now())
        .where((eb) =>
          eb.or([
            eb("lease_until", "is", null),
            eb("lease_until", "<=", now()),
          ]),
        )
        .executeTakeFirst();
      if (!claimed.numUpdatedRows) return null;
      let row = await tx
        .selectFrom("search_reconciliation")
        .selectAll()
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
      if (row.phase === "idle") {
        await tx.deleteFrom("search_reconcile_entries").execute();
        await tx
          .updateTable("search_reconciliation")
          .set({
            round_id: randomUUID(),
            phase: "remote",
            cursor: "",
            remote_offset: 0,
            scanned: 0,
            differences: 0,
            started_at: now(),
            checked_at: null,
            last_error: null,
          })
          .where("id", "=", "system")
          .execute();
        row = await tx
          .selectFrom("search_reconciliation")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
      }
      return row;
    });
    if (!state) return;

    try {
      // Keep remote I/O outside transactions. Fence the page commit against expired leases/config changes.
      let remote: { id: string; content_hash: string | null }[] = [];
      if (state.phase === "remote") {
        const data = (await options.list(
          config,
          state.remote_offset,
          pageSize,
        )) as { results?: unknown };
        if (
          !data ||
          !Array.isArray(data.results) ||
          data.results.length > pageSize
        )
          throw new Error("搜索索引清单格式无效");
        remote = data.results.map((value: any) => {
          if (
            !value ||
            !["string", "number"].includes(typeof value.id) ||
            !/^[a-zA-Z0-9_-]{1,512}$/.test(String(value.id))
          )
            throw new Error("搜索索引文档标识无效");
          return {
            id: String(value.id),
            content_hash:
              typeof value.content_hash === "string" &&
              /^[a-f0-9]{64}$/.test(value.content_hash)
                ? value.content_hash
                : null,
          };
        });
      }
      await transact(db, async (tx) => {
        const current = await tx
          .selectFrom("search_settings")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
        const owned = await tx
          .updateTable("search_reconciliation")
          .set({ lease_until: later(60000) })
          .where("id", "=", "system")
          .where("lease_token", "=", token)
          .where("generation", "=", config.generation)
          .where("lease_until", ">", now())
          .executeTakeFirst();
        if (
          !owned.numUpdatedRows ||
          !current.enabled ||
          current.generation !== config.generation
        )
          return;
        const patch: Partial<Schema["search_reconciliation"]> = {
          last_error: null,
        };
        if (state.phase === "remote") {
          // File records share the Meilisearch index, but have their own
          // projection lifecycle. Keep them out of the document reconciler so
          // a document-only inventory pass never treats files as orphans.
          for (const row of remote.filter((item) => !item.id.startsWith("file_")))
            await tx
              .insertInto("search_reconcile_entries")
              .values({ ...row, round_id: state.round_id, pending: 0 })
              .onConflict((oc) =>
                oc.column("id").doUpdateSet({ content_hash: row.content_hash }),
              )
              .execute();
          patch.remote_offset = state.remote_offset + remote.length;
          if (remote.length < pageSize) patch.phase = "source";
        } else if (state.phase === "source") {
          const rows = await tx
            .selectFrom("resources as r")
            .leftJoin("document_states as s", "s.resource_id", "r.id")
            .select(["r.id", "r.title", "s.text"])
            .where("r.kind", "=", "document")
            .where("r.deleted_at", "is", null)
            .where("r.id", ">", state.cursor)
            .orderBy("r.id")
            .limit(pageSize)
            .execute();
          // Reconcile the page as a lightweight ID/fingerprint inventory.
          // One batch lookup avoids a database round trip for every resource.
          const indexedRows = rows.length
            ? await tx
                .selectFrom("search_reconcile_entries")
                .select(["id", "content_hash"])
                .where("id", "in", rows.map(row => row.id))
                .execute()
            : [];
          const indexed = new Map(indexedRows.map(row => [row.id, row.content_hash]));
          const unchanged: string[] = [];
          const missing: string[] = [];
          for (const row of rows) {
            if (!indexed.has(row.id)) missing.push(row.id);
            else if (indexed.get(row.id) === searchDocument(row).content_hash)
              unchanged.push(row.id);
          }
          if (unchanged.length)
            await tx.deleteFrom("search_reconcile_entries")
              .where("id", "in", unchanged).execute();
          if (missing.length)
            await tx.insertInto("search_reconcile_entries").values(
              missing.map(id => ({ id, content_hash: null, round_id: state.round_id, pending: 0 })),
            ).execute();
          patch.scanned = state.scanned + rows.length;
          patch.cursor = rows.at(-1)?.id ?? state.cursor;
          if (rows.length < pageSize) {
            patch.phase = "enqueue";
            patch.cursor = "";
          }
        } else if (state.phase === "enqueue") {
          const rows = await tx
            .selectFrom("search_reconcile_entries")
            .select("id")
            .where("id", ">", state.cursor)
            .orderBy("id")
            .limit(pageSize)
            .execute();
          for (const { id } of rows) {
            await queue(tx, id);
            await tx
              .updateTable("search_reconcile_entries")
              .set({ pending: 1 })
              .where("id", "=", id)
              .execute();
          }
          patch.differences = state.differences + rows.length;
          patch.cursor = rows.at(-1)?.id ?? state.cursor;
          if (rows.length < pageSize) {
            patch.phase = "waiting";
            patch.checked_at = now();
            patch.cursor = "";
          }
        } else if (state.phase === "waiting") {
          const rows = await tx
            .selectFrom("search_reconcile_entries")
            .select("id")
            .where("id", ">", state.cursor)
            .orderBy("id")
            .limit(pageSize)
            .execute();
          for (const { id } of rows) await queue(tx, id);
          patch.cursor = rows.length < pageSize ? "" : rows.at(-1)!.id;
          const remaining = await tx
            .selectFrom("search_reconcile_entries")
            .select("id")
            .limit(1)
            .executeTakeFirst();
          if (!remaining) {
            patch.phase = "idle";
            patch.completed_at = now();
            patch.next_at = later(current.reconcile_interval_hours * 3600000);
          }
        }
        await tx
          .updateTable("search_reconciliation")
          .set({
            ...patch,
            lease_token: null,
            lease_until: null,
          })
          .where("id", "=", "system")
          .where("lease_token", "=", token)
          .execute();
      });
    } catch (error) {
      await db
        .updateTable("search_reconciliation")
        .set({
          last_error: `对账失败：${projectionErrorMessage(error)}`,
          next_at: later(60000),
          lease_token: null,
          lease_until: null,
        })
        .where("id", "=", "system")
        .where("lease_token", "=", token)
        .execute();
    } finally {
      await db
        .updateTable("search_reconciliation")
        .set({ lease_token: null, lease_until: null })
        .where("id", "=", "system")
        .where("lease_token", "=", token)
        .execute();
    }
  }

  async function repairToken(id: string) {
    return (
      await db
        .selectFrom("search_reconcile_entries")
        .select("round_id")
        .where("id", "=", id)
        .where("pending", "=", 1)
        .executeTakeFirst()
    )?.round_id;
  }
  async function completeRepair(
    config: SearchConfig,
    id: string,
    round: string | undefined,
  ) {
    if (!round) return;
    await transact(db, async (tx) => {
      const state = await tx
        .selectFrom("search_reconciliation")
        .select("generation")
        .where("id", "=", "system")
        .executeTakeFirstOrThrow();
      if (state.generation !== config.generation) return;
      await tx
        .deleteFrom("search_reconcile_entries")
        .where("id", "=", id)
        .where("round_id", "=", round)
        .where("pending", "=", 1)
        .execute();
    });
  }
  return { tick, status, schedule, repairToken, completeRepair };
}
