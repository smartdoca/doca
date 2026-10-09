import type { DB } from "@db/index.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import {
  bindHistoryFileStore,
  cleanupHistoryGarbage,
  retainDocumentHistory,
} from "@core/modules/history/archive.js";
import { createHostFileStore } from "../services/host-file-store.js";
import type { StorageRuntime } from "../adapters/storage.js";

export function createHistoryWorker(db: DB, runtime: StorageRuntime) {
  const unbind = bindHistoryFileStore(db, createHostFileStore(runtime));
  let lastCleanup = 0;
  return {
    dispose: unbind,
    async pump() {
      const completed = await processProjections(
        db,
        "history-retention",
        async (payload) => {
          if (
            typeof payload.resourceId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(payload.resourceId)
          )
            throw new Error("Invalid history retention job");
          await retainDocumentHistory(db, payload.resourceId);
        },
        2,
        5 * 60_000,
      );
      if (Date.now() - lastCleanup > 60_000) {
        await cleanupHistoryGarbage(db);
        lastCleanup = Date.now();
      }
      return completed;
    },
  };
}
