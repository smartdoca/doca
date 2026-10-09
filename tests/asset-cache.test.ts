import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "@server/app/create-app.js";
import {
  createStorage,
  storageRuntime,
  storageConfigForProfile,
} from "@server/adapters/storage.js";
import { derivativeKey } from "@server/services/storage-policy.js";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";

const origin = "http://localhost:39130";
let directory: string, db: DB, app: Awaited<ReturnType<typeof createApp>>;
let cookie: string, otherCookie: string, resourceId: string;
let runtime: ReturnType<typeof storageRuntime>;
let image: Buffer;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "doca-asset-cache-"));
  const storeId = storageRuntime().configuration.currentId;
  runtime = storageRuntime({
    DOCA_FILE_STORE_ID: storeId,
    DOCA_FILE_STORES_JSON: JSON.stringify({
      version: 1,
      stores: {
        [storeId]: { provider: "local", root: join(directory, "files") },
      },
    }),
  });
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const password = "isolated-cache-password-2026";
  const owner = {
    ...(await createUser(
      db,
      { login: "cache-owner", displayName: "Cache owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  } as Actor;
  await createUser(
    db,
    { login: "cache-other", displayName: "Other", password },
    { actor: owner },
  );
  resourceId = (
    await createContent(db).create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Isolated cache fixture",
    })
  ).id;
  app = await createApp(db, { origin, storage: runtime });
  const login = async (login: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39130", origin },
      payload: { login, password },
    });
    expect(response.statusCode, response.body).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0]!;
  };
  cookie = await login("cache-owner");
  otherCookie = await login("cache-other");
  image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function upload(
  purpose = "attachment",
  body = image,
  filename = "cache.png",
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/assets?purpose=${purpose}&filename=${filename}${purpose === "attachment" ? `&resourceId=${resourceId}` : ""}`,
    headers: {
      host: "localhost:39130",
      origin,
      cookie,
      "content-type": "application/octet-stream",
    },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}
function read(
  id: string,
  query = "",
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) {
  return app.inject({
    method,
    url: `/api/v1/assets/${id}/content${query}`,
    headers: { host: "localhost:39130", cookie, ...headers },
  });
}

it("privately caches document images, revalidates without bytes and checks permission before 304", async () => {
  const id = await upload();
  const first = await read(id);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.rawPayload).toEqual(image);
  expect(first.headers["cache-control"]).toBe(
    "private, max-age=3600, must-revalidate",
  );
  expect(first.headers.vary).toBe("Cookie, Authorization");
  const etag = String(first.headers.etag);
  expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
  for (const value of [etag, etag.slice(2), `"another", ${etag}`, "*"]) {
    const cached = await read(id, "", { "if-none-match": value });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
    expect(cached.headers.etag).toBe(etag);
    expect(cached.headers["cache-control"]).toBe(
      first.headers["cache-control"],
    );
  }
  expect(
    (await read(id, "", { "if-none-match": '"different"' })).rawPayload,
  ).toEqual(image);
  const head = await read(id, "", {}, "HEAD");
  expect(head.statusCode).toBe(200);
  expect(head.rawPayload.length).toBe(0);
  expect(head.headers.etag).toBe(etag);
  for (const range of ["bytes=999999-", "bytes=1-0", "bytes=0-1,2-3"]) {
    const invalid = await read(id, "", { range });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers["cache-control"]).toBe("no-store");
    expect(invalid.headers.etag).toBeUndefined();
  }
  const range = await read(id, "", { range: "bytes=0-3" });
  expect(range.statusCode).toBe(206);
  expect(range.rawPayload).toEqual(image.subarray(0, 4));
  expect(
    (await read(id, "", { range: "bytes=0-3", "if-range": etag })).rawPayload,
  ).toEqual(image);
  for (const deniedCookie of ["", otherCookie]) {
    const denied = await read(id, "", {
      cookie: deniedCookie,
      "if-none-match": etag,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(denied.headers.etag).toBeUndefined();
  }
  for (const query of ["?download=1", "?trashPreview=1", "?audit=1"]) {
    const response = await read(id, query, { "if-none-match": etag });
    expect(response.statusCode).not.toBe(304);
    expect(String(response.headers["cache-control"])).toContain("no-store");
    expect(response.headers.etag).toBeUndefined();
  }
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  await createStorage(runtime).remove(
    storageConfigForProfile(runtime, { id: asset.profile_id }),
    asset.object_key,
  );
  const unavailable = await read(id);
  expect(unavailable.statusCode).toBe(500);
  expect(unavailable.headers["cache-control"]).toBe("no-store");
  expect(unavailable.headers.etag).toBeUndefined();
});

it("keeps originals and thumbnails separate, and excludes AI attachments and non-images", async () => {
  const id = await upload();
  const original = await read(id);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const source = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("object_key", "=", asset.object_key)
    .executeTakeFirstOrThrow();
  const bytes = await sharp(image).webp().toBuffer();
  const key = derivativeKey(
    source.id,
    source.mime,
    "thumbnail-v1",
    "preview.webp",
  );
  await createStorage(runtime).put(
    storageConfigForProfile(runtime, { id: source.profile_id }),
    key,
    bytes,
    "image/webp",
    "thumbnail.webp",
  );
  await db
    .insertInto("file_derivatives")
    .values({
      id: randomUUID(),
      source_id: source.id,
      profile_id: source.profile_id,
      object_key: key,
      kind: "thumbnail",
      recipe: "thumbnail-v1",
      mime: "image/webp",
      size: bytes.length,
      created_at: new Date().toISOString(),
    })
    .execute();
  const thumbnail = await read(id, "?variant=thumbnail", {
    "if-none-match": String(original.headers.etag),
  });
  expect(thumbnail.statusCode).toBe(200);
  expect(thumbnail.rawPayload).toEqual(bytes);
  expect(thumbnail.headers.etag).not.toBe(original.headers.etag);
  expect(
    (
      await read(id, "?variant=thumbnail", {
        "if-none-match": String(thumbnail.headers.etag),
      })
    ).statusCode,
  ).toBe(304);
  for (const other of [
    await upload("ai_attachment"),
    await upload("attachment", Buffer.from("plain file"), "cache.txt"),
  ]) {
    const response = await read(other, "", { "if-none-match": "*" });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["cache-control"])).toContain("no-store");
    expect(response.headers.etag).toBeUndefined();
  }
});
