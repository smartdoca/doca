import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { Doc, YjsDocument, applyUpdate } from "@smartdoca/slate/yjs";
import { createEditorDocument } from "@smartdoca/slate/headless";
import type { Actor } from "@core/modules/identity/passwords.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createHistory } from "@core/modules/history/service.js";
import { recordVersion } from "@core/modules/history/repository.js";
import {
  bindHistoryFileStore,
  cleanupHistoryGarbage,
  retainDocumentHistory,
  type HistoryFileStore,
} from "@core/modules/history/archive.js";
import {
  createDocuments as nativeDocuments,
  b64,
  unb64,
} from "@core/modules/collaboration/documents.js";
import { createDocuments } from "./editor-client.js";
import { openTestDatabase } from "./database.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { createHostFileStore } from "@server/services/host-file-store.js";
import { rollbackHistoryStorage } from "@server/services/history-maintenance.js";
import {
  historyTables,
  HISTORY_SCHEMA_BASELINE,
  PRE_HISTORY_SCHEMA_BASELINE,
  upgradeHistorySchema,
} from "@db/history-schema.js";
import { validateSchema } from "@db/create-schema.js";
import { systemErrorText } from "@core/shared/errors.js";
import { createTranslator } from "@doca/i18n";
import { systemErrorMessage } from "@web/shared/system-errors.js";
import { createHistoryWorker } from "@server/jobs/history-worker.js";
import type { DB, Schema } from "@db/index.js";

let db: DB, owner: Actor, directory: string, store: HistoryFileStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "doca-history-storage-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "history-owner",
        displayName: "Owner",
        password: "isolated-history-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  store = createHostFileStore({ ...storageRuntime(), root: directory });
  bindHistoryFileStore(db, store);
});
afterEach(async () => {
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
});

async function setup(
  format:
    | "rich_text"
    | "markdown"
    | "spreadsheet"
    | "canvas"
    | "presentation" = "markdown",
) {
  const resource = await createContent(db).create(owner, {
    kind: "document",
    format,
    title: "History fixture",
    ...(format === "markdown"
      ? { markdown: "# Before\nOriginal content" }
      : format === "rich_text"
        ? {
            initialContent: createEditorDocument([
              {
                type: "paragraph",
                id: randomUUID(),
                children: [{ text: "Original content" }],
              },
            ]),
          }
        : {}),
  });
  const initial =
    format === "presentation"
      ? await nativeDocuments(db).exchange(owner, resource.id, {
          protocolVersion: 1,
          codec: "eppt-yjs-v5",
          schemaVersion: 2,
        })
      : await createDocuments(db).exchange(owner, resource.id, {});
  return { resource, initial, history: createHistory(db) };
}
async function populate(id: string, count = 35) {
  const history = createHistory(db);
  const first = await history.snapshot(owner, id);
  const row = await db
    .selectFrom("document_versions")
    .selectAll()
    .where("id", "=", first.id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("document_versions")
    .set({ created_at: "2020-01-01T00:00:00.000Z" })
    .where("id", "=", row.id)
    .execute();
  for (let i = 1; i < count; i++)
    await recordVersion(
      db,
      {
        ...row,
        id: randomUUID(),
        seq: i,
        created_at: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
      },
      i === 9 ? "ai" : undefined,
    );
  return db
    .selectFrom("document_versions")
    .selectAll()
    .where("resource_id", "=", id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}
const recent = (id: string) =>
  db
    .selectFrom("document_versions")
    .selectAll()
    .where("resource_id", "=", id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
const archives = (id: string) =>
  db
    .selectFrom("document_version_archives")
    .selectAll()
    .where("resource_id", "=", id)
    .execute();

it.each([
  "rich_text",
  "markdown",
  "spreadsheet",
  "canvas",
  "presentation",
] as const)(
  "%s keeps one complete cloud rollback point per ten old snapshots and a transparent list",
  async (format) => {
    const { resource, history } = await setup(format);
    const rows = await populate(resource.id, 40);
    const before = await history.version(owner, resource.id, rows[9]!.id);
    expect(await retainDocumentHistory(db, resource.id)).toBe(2);
    expect((await recent(resource.id)).map((r) => r.id).sort()).toEqual(
      rows
        .slice(20)
        .map((r) => r.id)
        .sort(),
    );
    expect((await archives(resource.id)).map((r) => r.id).sort()).toEqual(
      [rows[9]!.id, rows[19]!.id].sort(),
    );
    expect(await history.version(owner, resource.id, rows[9]!.id)).toEqual(
      before,
    );
    const page = await history.versions(owner, resource.id);
    expect(page.items).toHaveLength(22);
    expect(page.items.find((r) => r.id === rows[9]!.id)?.is_ai).toBe(true);
    expect(Object.keys(page.items.at(-1)!).sort()).toEqual([
      "author_id",
      "created_at",
      "display_name",
      "id",
      "is_ai",
      "seq",
      "title",
    ]);
    await expect(
      history.version(owner, resource.id, rows[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await retainDocumentHistory(db, resource.id)).toBe(0);
    expect(
      await db
        .selectFrom("document_history_archive_operations")
        .selectAll()
        .execute(),
    ).toHaveLength(0);
  },
);

it("waits for a complete group and retries an interrupted upload without deleting database originals or duplicating files", async () => {
  const { resource } = await setup();
  const rows = await populate(resource.id, 29);
  expect(await retainDocumentHistory(db, resource.id)).toBe(0);
  await recordVersion(db, {
    ...rows.at(-1)!,
    id: randomUUID(),
    created_at: "2020-01-02T00:00:00.000Z",
  });
  bindHistoryFileStore(db, {
    ...store,
    putImmutable: async (...args) => {
      await store.putImmutable(...args);
      throw new Error("interrupted after upload");
    },
  });
  await expect(retainDocumentHistory(db, resource.id)).rejects.toThrow(
    "interrupted",
  );
  expect(await recent(resource.id)).toHaveLength(30);
  expect(await archives(resource.id)).toHaveLength(0);
  bindHistoryFileStore(db, store);
  expect(await retainDocumentHistory(db, resource.id)).toBe(1);
  expect(await recent(resource.id)).toHaveLength(20);
  expect(
    (await readdir(directory, { recursive: true })).filter((p) =>
      p.endsWith(".json.gz"),
    ),
  ).toHaveLength(1);
});

it("does not sample when a concurrent edit changes a candidate, and overlapping workers converge to one archive", async () => {
  const { resource } = await setup();
  const rows = await populate(resource.id, 30);
  let changed = false;
  bindHistoryFileStore(db, {
    ...store,
    putImmutable: async (...args) => {
      const result = await store.putImmutable(...args);
      if (!changed) {
        changed = true;
        await db
          .updateTable("document_versions")
          .set({ title: "Concurrent correction" })
          .where("id", "=", rows[9]!.id)
          .execute();
      }
      return result;
    },
  });
  expect(await retainDocumentHistory(db, resource.id)).toBe(0);
  expect(await recent(resource.id)).toHaveLength(30);
  bindHistoryFileStore(db, store);
  await Promise.all([
    retainDocumentHistory(db, resource.id),
    retainDocumentHistory(db, resource.id),
  ]);
  expect(await recent(resource.id)).toHaveLength(20);
  expect(await archives(resource.id)).toHaveLength(1);
  await cleanupHistoryGarbage(db, Date.now() + 7200_000);
  expect(
    (await readdir(directory, { recursive: true })).filter((p) =>
      p.endsWith(".json.gz"),
    ),
  ).toHaveLength(1);
});

it("keeps listing available during storage failure, refuses corrupt bytes and checks current permissions first", async () => {
  const { resource, history } = await setup();
  const rows = await populate(resource.id, 30);
  bindHistoryFileStore(db, {
    ...store,
    read: async () => {
      throw new Error("storage unavailable");
    },
  });
  await expect(retainDocumentHistory(db, resource.id)).rejects.toThrow(
    "unavailable",
  );
  expect(await recent(resource.id)).toHaveLength(30);
  bindHistoryFileStore(db, store);
  await retainDocumentHistory(db, resource.id);
  const index = (await archives(resource.id))[0]!;
  const bytes = await readFile(join(directory, index.object_key));
  await writeFile(join(directory, index.object_key), Buffer.from("corrupt"));
  expect((await history.versions(owner, resource.id)).items).toHaveLength(21);
  const failure = await history
    .version(owner, resource.id, rows[9]!.id)
    .catch((error) => error);
  expect(failure).toMatchObject({ status: 503 });
  const presentation = systemErrorText(failure);
  expect(systemErrorMessage(presentation, createTranslator("en"))).toBe(
    "This snapshot is temporarily unavailable. Try again later.",
  );
  expect(systemErrorMessage(presentation, createTranslator("zh"))).toBe(
    "这条快照暂时无法读取，请稍后重试。",
  );
  expect(presentation).not.toContain(index.object_key);
  await expect(
    history.version(null, resource.id, rows[9]!.id),
  ).rejects.toMatchObject({ status: 404 });
  await writeFile(join(directory, index.object_key), bytes);
  await expect(
    history.version(owner, resource.id, rows[9]!.id),
  ).resolves.toMatchObject({ id: rows[9]!.id });
});

it.each(["rich_text", "markdown"] as const)(
  "%s restores an archived point as a new same-epoch commit and preserves the pre-rollback snapshot",
  async (format) => {
    const { resource, initial, history } = await setup(format);
    const rows = await populate(resource.id, 30);
    await retainDocumentHistory(db, resource.id);
    const doc = new Doc();
    applyUpdate(doc, unb64(initial.update));
    let runtime: YjsDocument | undefined;
    if (format === "markdown") {
      const updates: Uint8Array[] = [];
      doc.on("update", (u) => updates.push(u));
      doc
        .getText("markdown")
        .insert(doc.getText("markdown").length, " CURRENT CONTENT");
      await createDocuments(db).exchange(owner, resource.id, {
        update: b64(updates[0]!),
      });
    } else {
      runtime = new YjsDocument(doc);
      const block = runtime
        .getValue()
        .find((n: any) =>
          n.children?.some((leaf: any) =>
            leaf.text?.includes("Original content"),
          ),
        ) as any;
      await createDocuments(db).exchange(owner, resource.id, {
        update: b64(runtime.editText(block.id, 0, 0, "CURRENT CONTENT ")),
      });
    }
    const preview = await history.version(owner, resource.id, rows[9]!.id);
    const restored = await createDocuments(db).exchange(owner, resource.id, {
      restoreVersion: rows[9]!.id,
      expectedSeq: preview.currentSeq,
    });
    expect(restored).toMatchObject({ epochId: initial.epochId, changed: true });
    const current = await createDocuments(db).exchange(owner, resource.id, {});
    const currentDoc = new Doc();
    applyUpdate(currentDoc, unb64(current.update));
    if (format === "markdown")
      expect(currentDoc.getText("markdown").toString()).not.toContain(
        "CURRENT CONTENT",
      );
    else {
      const model = new YjsDocument(currentDoc);
      expect(JSON.stringify(model.getValue())).not.toContain("CURRENT CONTENT");
      model.destroy();
    }
    const preserved = await recent(resource.id);
    expect(preserved.length).toBeGreaterThanOrEqual(21);
    const beforeRollback = preserved.find((r) => r.seq === preview.currentSeq)!;
    expect(
      (await history.version(owner, resource.id, beforeRollback.id)).text,
    ).toContain("CURRENT CONTENT");
    await expect(
      createDocuments(db).exchange(owner, resource.id, {
        restoreVersion: rows[9]!.id,
        expectedSeq: preview.currentSeq,
      }),
    ).rejects.toMatchObject({ status: 409 });
    runtime?.destroy();
    doc.destroy();
    currentDoc.destroy();
  },
);

it("merges cross-tier pagination without gaps, duplicates or storage metadata", async () => {
  const { resource, history } = await setup();
  await populate(resource.id, 1030);
  while (await retainDocumentHistory(db, resource.id)) {
    /* drain bounded batches */
  }
  const first = await history.versions(owner, resource.id);
  const second = await history.versions(owner, resource.id, first.nextCursor!);
  const ids = [...first.items, ...second.items].map((r) => r.id);
  expect(first.items).toHaveLength(100);
  expect(second.items).toHaveLength(21);
  expect(new Set(ids).size).toBe(121);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify(first)).not.toMatch(
    /object_key|store_id|sha256|archive_version/,
  );
});

it("retries a durable retention job after a storage failure without consuming snapshots", async () => {
  const worker = createHistoryWorker(db, {
    ...storageRuntime(),
    root: directory,
  });
  const { resource } = await setup();
  await populate(resource.id, 30);
  bindHistoryFileStore(db, {
    ...store,
    putImmutable: async () => {
      throw new Error("storage outage");
    },
  });
  expect(await worker.pump()).toBe(0);
  expect(await recent(resource.id)).toHaveLength(30);
  const job = await db
    .selectFrom("projection_jobs")
    .selectAll()
    .where("id", "=", `history-retention:${resource.id}`)
    .executeTakeFirstOrThrow();
  expect(job).toMatchObject({ status: "retry", attempts: 1 });
  bindHistoryFileStore(db, store);
  await db
    .updateTable("projection_jobs")
    .set({ available_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", job.id)
    .execute();
  expect(await worker.pump()).toBe(1);
  expect(await recent(resource.id)).toHaveLength(20);
  expect(await archives(resource.id)).toHaveLength(1);
  expect(
    await db
      .selectFrom("projection_jobs")
      .select("id")
      .where("id", "=", job.id)
      .executeTakeFirst(),
  ).toBeUndefined();
  worker.dispose();
});

it("preserves missing recovery metadata without inventing a baseline for an old snapshot", async () => {
  const { resource, history } = await setup();
  const rows = await populate(resource.id, 30);
  await db
    .updateTable("document_versions")
    .set({ recovery_json: null })
    .where("id", "=", rows[9]!.id)
    .execute();
  await retainDocumentHistory(db, resource.id);
  expect((await history.versions(owner, resource.id)).items).toHaveLength(21);
  await expect(
    history.version(owner, resource.id, rows[9]!.id),
  ).rejects.toMatchObject({ status: 409 });
});

it("blocks host startup during an interrupted rollback and resumes without resampling already imported points", async () => {
  const { resource } = await setup();
  await populate(resource.id, 40);
  await retainDocumentHistory(db, resource.id);
  const indexes = (await archives(resource.id)).sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const second = indexes[1]!;
  const bytes = await readFile(join(directory, second.object_key));
  await writeFile(join(directory, second.object_key), Buffer.from("corrupt"));
  await expect(rollbackHistoryStorage(db)).rejects.toMatchObject({
    status: 503,
  });
  await expect(validateSchema(db)).rejects.toThrow("baseline");
  expect(await recent(resource.id)).toHaveLength(21);
  expect(await archives(resource.id)).toHaveLength(1);
  await writeFile(join(directory, second.object_key), bytes);
  expect(await rollbackHistoryStorage(db)).toBe(1);
  expect(await recent(resource.id)).toHaveLength(22);
});

it("retains attachment dependencies through sampling and trash, and only reclaims archive files after explicit permanent deletion", async () => {
  const { resource, history } = await setup();
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const assetId = randomUUID();
  await db
    .insertInto("assets")
    .values({
      id: assetId,
      owner_id: owner.id,
      resource_id: resource.id,
      purpose: "attachment",
      profile_id: profile.id,
      object_key: `host/objects/image/${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}/original`,
      filename: "history.png",
      mime: "image/png",
      size: 12,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  const rows = await populate(resource.id, 30);
  await retainDocumentHistory(db, resource.id);
  const index = (await archives(resource.id))[0]!;
  expect(
    await db
      .selectFrom("assets")
      .select("id")
      .where("id", "=", assetId)
      .executeTakeFirst(),
  ).toBeDefined();
  const content = createContent(db);
  await content.trash(owner, resource.id, resource.version);
  await cleanupHistoryGarbage(db, Date.now() + 7200_000);
  expect(await readFile(join(directory, index.object_key))).toBeDefined();
  const deleted = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", resource.id)
    .executeTakeFirstOrThrow();
  await content.purgeDeleted(owner, resource.id, deleted.version);
  expect(await archives(resource.id)).toHaveLength(0);
  await cleanupHistoryGarbage(db, Date.now() + 7200_000);
  await expect(
    readFile(join(directory, index.object_key)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires an explicit exact-baseline upgrade and can return all retained versions to the old database shape", async () => {
  const { resource } = await setup();
  const rows = await populate(resource.id, 30);
  for (const table of Object.keys(historyTables))
    await sql.raw(`DROP TABLE ${table}`).execute(db);
  await db
    .deleteFrom("projection_jobs")
    .where("kind", "=", "history-retention")
    .execute();
  await db
    .updateTable("schema_baseline")
    .set({ id: PRE_HISTORY_SCHEMA_BASELINE })
    .execute();
  await expect(validateSchema(db)).rejects.toThrow("baseline");
  await upgradeHistorySchema(db);
  expect(
    JSON.parse(
      (
        await db
          .selectFrom("projection_jobs")
          .select("payload")
          .where("id", "=", `history-retention:${resource.id}`)
          .executeTakeFirstOrThrow()
      ).payload,
    ),
  ).toEqual({ resourceId: resource.id });
  await validateSchema(db);
  expect(await recent(resource.id)).toHaveLength(30);
  expect(
    await db.selectFrom("schema_baseline").select("id").executeTakeFirst(),
  ).toEqual({ id: HISTORY_SCHEMA_BASELINE });
  await expect(upgradeHistorySchema(db)).rejects.toThrow("accepts only");
  await retainDocumentHistory(db, resource.id);
  const index = (await archives(resource.id))[0]!;
  expect(await rollbackHistoryStorage(db)).toBe(1);
  expect((await recent(resource.id)).map((r) => r.id).sort()).toEqual(
    [rows[9]!.id, ...rows.slice(10).map((r) => r.id)].sort(),
  );
  expect(
    await db.selectFrom("schema_baseline").select("id").executeTakeFirst(),
  ).toEqual({ id: PRE_HISTORY_SCHEMA_BASELINE });
  expect(await readFile(join(directory, index.object_key))).toBeDefined();
});
