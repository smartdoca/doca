import {
  directorySourceRegistry,
  withDirectoryDatabase,
} from "./directory-registry.js";
import type { DirectoryMode } from "@smartdoca/plugin-contracts";
import type { DB } from "../../../../db/src/index.js";
import { activeActor } from "../access/queries.js";
import type { Actor } from "../identity/passwords.js";
import { fail } from "../../shared/errors.js";
export type { DirectoryMode } from "@smartdoca/plugin-contracts";
async function directoryMode(db: DB, actor: Actor): Promise<DirectoryMode> {
  await activeActor(db, actor);
  const user = await db
    .selectFrom("users")
    .select("directory_mode")
    .where("id", "=", actor.id)
    .executeTakeFirstOrThrow();
  const settings = await db
    .selectFrom("settings")
    .select("directory_mode")
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  // Per-user overrides are administrator policy, never a self-service privacy bypass.
  const mode = user.directory_mode ?? settings.directory_mode ?? "all";
  if (mode !== "none" && mode !== "all" && mode !== "related")
    fail(409, "Invalid directory policy");
  return mode;
}
export async function assertDirectoryMode(
  db: DB,
  actor: Actor,
  mode: DirectoryMode,
) {
  if ((await directoryMode(db, actor)) !== mode)
    fail(409, "Directory policy changed; restart the search");
}
export async function directoryAccess(
  db: DB,
  actor: Actor,
  signal?: AbortSignal,
): Promise<{
  mode: DirectoryMode;
  ids: Set<string> | null;
  complete: boolean;
}> {
  signal?.throwIfAborted();
  const mode = await directoryMode(db, actor);
  if (mode === "all") return { mode, ids: null, complete: true };
  if (mode === "none") return { mode, ids: new Set(), complete: true };
  const related = new Set<string>();
  const registry = directorySourceRegistry(db);
  const sources = [...registry.values()];
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = () => {};
      try {
        const collect = async () => {
          if (source.schemaVersion !== 1)
            throw new Error("Unsupported directory source version");
          const ids = new Set<string>();
          let cursor: string | null = null;
          const seen = new Set<string>();
          for (let page = 0; page < 40; page++) {
            controller.signal.throwIfAborted();
            const batch = await source.related(actor.id, {
              cursor,
              limit: 250,
              signal: controller.signal,
            });
            if (
              !Array.isArray(batch.items) ||
              batch.items.length > 250 ||
              batch.items.some(
                (item) => !item.userId || !item.relationId || !item.revision,
              )
            )
              throw new Error("Invalid directory page");
            const candidates = new Set(batch.items.map((item) => item.userId));
            for (const id of await source.verify(
              actor.id,
              batch.items,
              controller.signal,
            ))
              if (candidates.has(id)) ids.add(id);
            if (batch.cursor === null) return { source, ids };
            if (
              typeof batch.cursor !== "string" ||
              !batch.cursor ||
              !batch.items.length ||
              seen.has(batch.cursor)
            )
              throw new Error("Repeated directory cursor");
            seen.add(batch.cursor);
            cursor = batch.cursor;
          }
          throw new Error("Directory source exceeded page budget");
        };
        return await Promise.race([
          withDirectoryDatabase(db, collect),
          new Promise<never>((_, reject) => {
            cancelled = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", cancelled, {
              once: true,
            });
            if (controller.signal.aborted) cancelled();
            timer = setTimeout(() => {
              controller.abort(new Error("Directory source timed out"));
            }, 2000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancelled);
        signal?.removeEventListener("abort", abort);
      }
    }),
  );
  signal?.throwIfAborted();
  let complete = true;
  for (const result of results) {
    if (
      result.status !== "fulfilled" ||
      registry.get(result.value.source.id) !== result.value.source
    ) {
      complete = false;
      continue;
    }
    for (const id of result.value.ids) related.add(id);
  }
  await assertDirectoryMode(db, actor, mode);
  return { mode: "related", ids: related, complete };
}

export async function directoryIds(
  db: DB,
  actor: Actor,
): Promise<Set<string> | null> {
  return (await directoryAccess(db, actor)).ids;
}
