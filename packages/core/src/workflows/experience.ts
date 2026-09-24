import type { DB } from "../../../db/src/index.js";
import { createShareLinks } from "../modules/access/links.js";
import { createHistory } from "../modules/history/service.js";
import { createInteractionReads } from "../modules/interactions/reads.js";
export function createExperience(db: DB) {
  return {
    ...createShareLinks(db),
    ...createHistory(db),
    ...createInteractionReads(db),
  };
}
