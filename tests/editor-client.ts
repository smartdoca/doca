import { DEFAULT_SPREADSHEET_SCHEMA } from "@core/modules/documents/codecs/surfaces.js";
import { createDocuments as createService } from "@core/modules/collaboration/documents.js";
import type { DB } from "@db/index.js";
export * from "@core/modules/collaboration/documents.js";
/** Test client negotiates the current wire contract; rejection tests use the service directly. */
export function createDocuments(db: DB) {
  const service = createService(db);
  return {
    async exchange(...[actor, id, input]: Parameters<typeof service.exchange>) {
      const resource = await db
        .selectFrom("resources")
        .select("format")
        .where("id", "=", id)
        .executeTakeFirst();
      const epoch = await db
        .selectFrom(
          resource?.format === "markdown" ? "markdown_epochs" : "editor_epochs",
        )
        .select("epoch_id")
        .where("resource_id", "=", id)
        .executeTakeFirst();
      const sheetEpoch =
        resource?.format === "spreadsheet"
          ? await db
              .selectFrom("editor_epochs")
              .select("baseline")
              .where("resource_id", "=", id)
              .executeTakeFirst()
          : undefined;
      const sheetSchema = sheetEpoch?.baseline
        ? JSON.parse(sheetEpoch.baseline).schemaVersion
        : DEFAULT_SPREADSHEET_SCHEMA;
      const codec =
        resource?.format === "spreadsheet"
          ? "exlsx-cell-registers"
          : resource?.format === "canvas"
            ? "aidcanvas-yjs"
            : resource?.format === "markdown"
              ? "markdown-ytext"
              : "slate-kit";
      return service.exchange(actor, id, {
        protocolVersion: 1,
        schemaVersion:
          codec === "exlsx-cell-registers"
            ? sheetSchema
            : codec === "slate-kit"
              ? 3
              : 1,
        codec,
        epochId: epoch?.epoch_id,
        ...(input.update !== undefined
          ? { messageId: crypto.randomUUID() }
          : {}),
        ...input,
      });
    },
  };
}
