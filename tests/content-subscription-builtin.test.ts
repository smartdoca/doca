import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { builtinContentSource } from "@core/modules/content/builtin.js";
import { createContentService } from "@core/modules/content/service.js";
import { createContentSubscription } from "@core/modules/knowledge/content-subscriptions.js";
import {
  executeKnowledgeCuration,
  queueKnowledgeCuration,
  type CurationGenerator,
} from "@core/modules/knowledge/system.js";

it("consumes real SQLite document blocks without holding a transaction across provider calls", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const stamp = new Date().toISOString();
    const actor = { id: randomUUID(), display_name: "Owner", admin: 0 };
    await db
      .insertInto("users")
      .values({
        ...actor,
        login: actor.id,
        password_hash: "unused",
        status: "active",
        created_at: stamp,
      })
      .execute();
    const libraryId = randomUUID(),
      documentId = randomUUID();
    await db
      .insertInto("resources")
      .values(
        [
          { id: libraryId, kind: "library" as const, title: "Knowledge" },
          { id: documentId, kind: "document" as const, title: "Plan" },
        ].map((row) => ({
          ...row,
          format: "markdown",
          owner_id: actor.id,
          library_id: null,
          parent_id: null,
          access_mode: "custom",
          visibility: "invited",
          version: 1,
          deleted_at: null,
          delete_batch: null,
          created_at: stamp,
          updated_at: stamp,
          ai_curated: 1,
        })),
      )
      .execute();
    // Readable projection in an isolated test database; no editor/user document is modified.
    await db
      .insertInto("document_states")
      .values({
        resource_id: documentId,
        codec: "test",
        checkpoint: "",
        checkpoint_seq: 1,
        seq: 1,
        text: "Submit budget\n\nSend invoice",
        updated_at: stamp,
      })
      .execute();
    const source = builtinContentSource(db, "documents");
    const read = vi.fn(source.read);
    createContentService(db).register({ ...source, read });
    const subscription = await createContentSubscription(db, actor, libraryId, {
      sourceId: source.id,
      config: { resourceIds: [documentId] },
      title: "Plan",
    });
    const generator = vi.fn<CurationGenerator>(async ({ materials }) => ({
      entries: [
        {
          title: "Plan knowledge",
          markdown: materials.map((m) => m.text).join("\n\n"),
          sourceIds: [subscription.id],
          reason: "Extract current plan",
        },
      ],
      notes: "",
    }));
    const execute = async () => {
      const run = await queueKnowledgeCuration(db, actor, libraryId);
      await executeKnowledgeCuration(db, run.id, generator);
      const saved = await db
        .selectFrom("knowledge_runs")
        .selectAll()
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(saved.status, saved.detail).not.toBe("failed");
    };
    await execute();
    expect(read).toHaveBeenCalledTimes(2);
    expect(generator).toHaveBeenCalledTimes(2);
    await execute();
    expect(read).toHaveBeenCalledTimes(2);
    expect(generator).toHaveBeenCalledTimes(2);
    await db
      .updateTable("document_states")
      .set({ text: "Submit revised budget\n\nSend invoice", seq: 2 })
      .where("resource_id", "=", documentId)
      .execute();
    await execute();
    expect(read).toHaveBeenCalledTimes(3);
    expect(generator).toHaveBeenCalledTimes(3);
    expect(generator.mock.calls[2]![0].materials.map((m) => m.text)).toEqual([
      "Plan\n\nSubmit revised budget",
    ]);
  } finally {
    await db.destroy();
  }
}, 15_000);
