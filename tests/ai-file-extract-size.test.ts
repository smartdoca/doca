import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { databaseDriver } from "@db/transactions.js";
import {
  storageRuntime,
  createStorage,
  storageConfigForProfile,
} from "@server/adapters/storage.js";
import { objectKey } from "@server/services/storage-policy.js";
import {
  loadFileExtract,
  processFileExtract,
  readExtractImages,
  waitFileExtract,
  waitForFileExtracts,
} from "@server/services/ai/file-extract.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>, root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-extract-size-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
});
afterEach(async () => {
  await waitForFileExtracts(db);
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const user = await createUser(
    db,
    {
      login: "size-qa",
      displayName: "Size QA",
      password: "isolated-size-qa-2026",
    },
    { bootstrap: true },
  );
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .executeTakeFirstOrThrow();
  const runtime = { ...storageRuntime(), root },
    config = storageConfigForProfile(runtime, profile),
    storage = createStorage(runtime);
  const png = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#83a7b2" },
  })
    .png()
    .toBuffer();
  const id = randomUUID(),
    key = objectKey(id, "image/png");
  await storage.put(config, key, png, "image/png", "size-qa.png");
  await db
    .insertInto("file_storage_objects")
    .values({
      id,
      profile_id: profile.id,
      object_key: key,
      sha256: createHash("sha256").update(png).digest("hex"),
      size: png.length,
      mime: "image/png",
      created_at: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id: randomUUID(),
      owner_id: user.id,
      parent_type: "system",
      parent_id: "ai",
      storage_object_id: id,
      name: "size-qa.png",
      mime: "image/png",
      size: png.length,
      metadata: "{}",
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  return { id, key, png, runtime, config, storage };
}
it("extracts matching PNG bytes using the current database's native bigint representation", async () => {
  const f = await fixture();
  const before = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", f.id)
    .executeTakeFirstOrThrow();
  expect(Number(before.size)).toBe(f.png.length);
  if (databaseDriver(db) === "postgres") {
    expect(typeof before.size).toBe("string");
    expect(f.png.length === before.size).toBe(false);
  }
  await processFileExtract(db, f.id, f.runtime);
  const parsed = await loadFileExtract(db, f.id);
  expect(parsed).toMatchObject({
    status: "ready",
    parts: [expect.objectContaining({ type: "image", mime: "image/png" })],
  });
  const images = await readExtractImages(db, f.id, parsed!.parts, f.runtime);
  expect(await sharp(images[0]!.data).metadata()).toMatchObject({
    width: 32,
    height: 24,
  });
  expect(
    await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", f.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(before);
});
it("rejects a genuinely short object and reprocesses a failed extraction on retry", async () => {
  const f = await fixture();
  await writeFile(join(root, f.key), f.png.subarray(0, f.png.length - 1));
  await processFileExtract(db, f.id, f.runtime);
  expect(await loadFileExtract(db, f.id)).toMatchObject({
    status: "failed",
    error: "file_content_size_changed",
  });
  await writeFile(join(root, f.key), f.png);
  expect(await waitFileExtract(db, f.id, f.runtime)).toMatchObject({
    status: "ready",
  });
});
