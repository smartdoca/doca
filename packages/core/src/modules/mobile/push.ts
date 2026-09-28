import type { DB } from "@db/index.js";
import { enqueueProjectionOnce } from "../automation/jobs.js";

export type MobilePush = {
  id: string;
  userId: string;
  title: string;
  body: string;
  path: string;
};

/** Persist with the business transaction; any healthy instance may deliver it. */
export async function queueMobilePush(db: DB, event: MobilePush) {
  await enqueueProjectionOnce(db, "mobile-push", event.id, event);
}
