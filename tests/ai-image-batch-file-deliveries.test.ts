import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { transact } from "@db/transactions.js";
import { openTestDatabase } from "./database.js";
import {
  imageBatchFileDeliveries,
  type ImageBatchFileDeliveryEntry,
} from "../apps/server/src/services/ai/image-batch-file-deliveries.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>;
let owner: Actor, other: Actor, sessionId: string, otherSessionId: string;
const now = "2026-10-05T10:00:00.000Z";
const sessionTitle = "Current delivery / & QA";

async function session(actor: Actor, title = sessionTitle) {
  const id = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title,
      model_id: null,
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "delivery-owner",
        displayName: "Owner",
        password: "isolated-delivery-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "delivery-other",
        displayName: "Other",
        password: "isolated-delivery-password",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  sessionId = await session(owner);
  otherSessionId = await session(other, "Other user's session");
});
afterEach(async () => {
  await db.destroy();
});

function entry(
  overrides: Partial<ImageBatchFileDeliveryEntry> = {},
): ImageBatchFileDeliveryEntry {
  return {
    bookIndex: 1,
    source: { fileId: randomUUID() },
    sourceFilename: "Original book.pdf",
    physicalPage: 1,
    referenceImageId: randomUUID(),
    assetId: randomUUID(),
    sourcePageFilename: "Original page.png",
    reviewPassed: true,
    ...overrides,
  };
}

async function storedDelivery(
  delivery: ImageBatchFileDeliveryEntry,
  options: {
    actor?: Actor;
    name?: string;
    metadata?: unknown;
    namespace?: string;
    parentType?: "system" | "folder" | "document";
    parentId?: string;
    objectId?: string;
    deleted?: boolean;
  } = {},
) {
  const id = randomUUID();
  const objectId = options.objectId ?? delivery.assetId;
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  if (
    !(await db
      .selectFrom("file_storage_objects")
      .select("id")
      .where("id", "=", objectId)
      .executeTakeFirst())
  ) {
    await db
      .insertInto("file_storage_objects")
      .values({
        id: objectId,
        profile_id: profile.id,
        object_key: `isolated-deliveries/${objectId}.png`,
        sha256: "a".repeat(64),
        size: 10,
        mime: "image/png",
        created_at: now,
      })
      .execute();
    await db
      .insertInto("assets")
      .values({
        id: objectId,
        owner_id: (options.actor ?? owner).id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: `isolated-deliveries/${objectId}.png`,
        filename: options.name ?? "Actual revised image.png",
        mime: "image/png",
        size: 10,
        created_at: now,
        deleted_at: null,
      })
      .execute();
  }
  await db
    .insertInto("file_items")
    .values({
      id,
      storage_namespace: options.namespace ?? "host",
      owner_id: (options.actor ?? owner).id,
      parent_type: options.parentType ?? "system",
      parent_id: options.parentId ?? "ai",
      storage_object_id: objectId,
      name: options.name ?? "Actual revised image.png",
      mime: "image/png",
      size: 10,
      metadata: JSON.stringify(
        options.metadata === undefined
          ? {
              assetId: delivery.assetId,
              aiSessionFolder: { sessionId, title: "Old session title" },
            }
          : options.metadata,
      ),
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: options.deleted ? now : null,
      delete_batch: options.deleted ? randomUUID() : null,
    })
    .execute();
  return id;
}

async function facts() {
  const tables = [
    "file_items",
    "file_storage_objects",
    "assets",
    "ai_sessions",
    "ai_jobs",
    "ai_operations",
    "ai_calls",
  ] as const;
  return Promise.all(
    tables.map(async (table) => ({
      table,
      rows: await db.selectFrom(table).selectAll().orderBy("id").execute(),
    })),
  );
}

it("resolves latest pages in their input order to actual file nodes and full current session navigation", async () => {
  const bookSource = { assetId: randomUUID() };
  const first = entry({ source: bookSource });
  const second = entry({ source: bookSource, physicalPage: 2 });
  const third = entry({ bookIndex: 2, reviewPassed: false });
  const firstId = await storedDelivery(first, { name: "Page 1 final.png" });
  const secondId = await storedDelivery(second, {
    name: "Page 2 revised after review.png",
  });
  const thirdId = await storedDelivery(third, { name: "Another book.png" });
  await storedDelivery(entry({ referenceImageId: second.referenceImageId }), {
    name: "Page 2 obsolete candidate.png",
  });
  const before = await facts();
  const result = await imageBatchFileDeliveries(db, owner.id, sessionId, [
    third,
    second,
    first,
  ]);
  expect(result.map((item) => item.fileId)).toEqual([
    thirdId,
    secondId,
    firstId,
  ]);
  expect(result[1]).toMatchObject({
    ...second,
    name: "Page 2 revised after review.png",
    mime: "image/png",
    path: `我的文件夹 / AI 助手 / ${sessionTitle}`,
    contentUrl: `/api/v1/files/items/${secondId}/content`,
    downloadUrl: `/api/v1/files/items/${secondId}/content?download=1`,
  });
  expect(result[0]!.reviewPassed).toBe(false);
  const url = new URL(result[1]!.href.slice(1), "https://doca.invalid");
  expect(url.pathname).toBe("/files");
  expect(url.searchParams.get("focus")).toBe(secondId);
  expect(url.searchParams.get("session")).toBe(sessionId);
  expect(JSON.parse(url.searchParams.get("path")!)).toEqual([
    { type: "system", id: "ai", name: "AI 助手" },
    {
      type: "system",
      id: `ai-session:${sessionId}`,
      name: sessionTitle,
    },
  ]);
  expect(
    new Set([second.referenceImageId, second.assetId, secondId]).size,
  ).toBe(3);
  expect(result[1]!.href).not.toContain("#/r/");
  expect(result[1]!.contentUrl).not.toContain(second.assetId);
  expect(await facts()).toEqual(before);
});

it("keeps every delivery beyond the file tool display limit and resolves reused assets without duplicating records", async () => {
  const entries = Array.from({ length: 101 }, (_, index) =>
    entry({ physicalPage: index + 1 }),
  );
  const fileIds = [];
  for (const item of entries) fileIds.push(await storedDelivery(item));
  const reused = { ...entries[0]!, bookIndex: 2 };
  const before = await facts();
  const result = await imageBatchFileDeliveries(db, owner.id, sessionId, [
    ...entries,
    reused,
  ]);
  expect(result).toHaveLength(102);
  expect(result.slice(0, 101).map((item) => item.fileId)).toEqual(fileIds);
  expect(result[101]!.fileId).toBe(fileIds[0]);
  expect(result[101]!.bookIndex).toBe(2);
  expect(await facts()).toEqual(before);
});

it.each([
  "missing",
  "deleted",
  "foreign-owner",
  "wrong-session",
  "wrong-object",
  "other-parent",
  "other-namespace",
  "ambiguous",
] as const)(
  "rejects %s file nodes without backfilling or changing any records",
  async (kind) => {
    const selected = entry();
    if (kind !== "missing")
      await storedDelivery(selected, {
        ...(kind === "deleted" ? { deleted: true } : {}),
        ...(kind === "foreign-owner" ? { actor: other } : {}),
        ...(kind === "wrong-session"
          ? {
              metadata: {
                assetId: selected.assetId,
                aiSessionFolder: {
                  sessionId: otherSessionId,
                  title: "Other session",
                },
              },
            }
          : {}),
        ...(kind === "wrong-object" ? { objectId: randomUUID() } : {}),
        ...(kind === "other-parent" ? { parentId: "root" } : {}),
        ...(kind === "other-namespace" ? { namespace: "external-plugin" } : {}),
      });
    if (kind === "ambiguous") await storedDelivery(selected);
    const before = await facts();
    await expect(
      imageBatchFileDeliveries(db, owner.id, sessionId, [selected]),
    ).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
  },
);

it.each([
  {},
  { assetId: randomUUID() },
  { aiSessionFolder: { sessionId: randomUUID(), title: "Unbound" } },
  { assetId: "invalid", aiSessionFolder: { sessionId: null, title: null } },
])(
  "rejects absent or malformed generation bindings rather than treating old flat entries as new deliveries",
  async (metadata) => {
    const selected = entry();
    await storedDelivery(selected, { metadata });
    const before = await facts();
    await expect(
      imageBatchFileDeliveries(db, owner.id, sessionId, [selected]),
    ).rejects.toMatchObject({ status: 409 });
    expect(await facts()).toEqual(before);
  },
);

it("rejects asset identity tampering even when the session marker and object ID are valid", async () => {
  const selected = entry();
  await storedDelivery(selected, {
    metadata: {
      assetId: randomUUID(),
      aiSessionFolder: { sessionId, title: sessionTitle },
    },
  });
  const before = await facts();
  await expect(
    imageBatchFileDeliveries(db, owner.id, sessionId, [selected]),
  ).rejects.toMatchObject({ status: 409 });
  expect(await facts()).toEqual(before);
});

it("rejects corrupt metadata with a safe error and preserves the original row", async () => {
  const selected = entry();
  const fileId = await storedDelivery(selected);
  const privateSentinel = "PRIVATE_SENTINEL_DO_NOT_LOG";
  await db
    .updateTable("file_items")
    .set({ metadata: `{${privateSentinel}` })
    .where("id", "=", fileId)
    .execute();
  const before = await facts();
  const failure = await imageBatchFileDeliveries(db, owner.id, sessionId, [
    selected,
  ]).catch((error: unknown) => error);
  expect(failure).toMatchObject({ status: 409 });
  expect(String(failure)).not.toContain(privateSentinel);
  expect(await facts()).toEqual(before);
});

it("authorizes the session even for an empty list and supports an existing read transaction", async () => {
  const before = await facts();
  expect(await imageBatchFileDeliveries(db, owner.id, sessionId, [])).toEqual(
    [],
  );
  await expect(
    imageBatchFileDeliveries(db, owner.id, otherSessionId, []),
  ).rejects.toMatchObject({ status: 404 });
  const selected = entry();
  const fileId = await storedDelivery(selected);
  const result = await transact(db, (tx) =>
    imageBatchFileDeliveries(tx, owner.id, sessionId, [selected]),
  );
  expect(result[0]!.fileId).toBe(fileId);
  // Only the test fixture insertion changed data; resolution itself is read-only.
  expect(
    (await facts()).filter(
      (table) =>
        !["file_items", "file_storage_objects", "assets"].includes(table.table),
    ),
  ).toEqual(
    before.filter(
      (table) =>
        !["file_items", "file_storage_objects", "assets"].includes(table.table),
    ),
  );
});

it("rejects malformed host entries instead of accepting asset URLs or source filenames as file nodes", async () => {
  const selected = entry();
  const before = await facts();
  await expect(
    imageBatchFileDeliveries(db, owner.id, sessionId, [
      { ...selected, physicalPage: 0 },
    ]),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    imageBatchFileDeliveries(db, owner.id, sessionId, [
      { ...selected, source: { assetId: randomUUID(), fileId: randomUUID() } },
    ]),
  ).rejects.toMatchObject({ status: 400 });
  expect(await facts()).toEqual(before);
});
