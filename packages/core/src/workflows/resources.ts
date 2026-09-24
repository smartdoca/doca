import type { DB } from "../../../db/src/index.js";
import { createAccessManagement } from "../modules/access/management.js";
import { createInteractions } from "../modules/interactions/commands.js";
import { createResourceCommands } from "../modules/resources/commands.js";
import { createResourceRunner } from "../modules/resources/context.js";
import { createResourceReads } from "../modules/resources/reads.js";
export function createContent(db: DB) {
  const run = createResourceRunner(db);
  return {
    ...createResourceReads(db, run),
    ...createResourceCommands(db, run),
    ...createAccessManagement(db, run),
    ...createInteractions(db, run),
  };
}
