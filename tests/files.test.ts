import { storageRuntime } from "@server/adapters/storage.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import sharp from "sharp";
import { createFileProcessingWorker } from "../apps/server/src/jobs/file-processing-worker.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { fail } from "@core/shared/errors.js";

const origin = "http://localhost:39130";
const password = "test-only-password-2026";
let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;
let directory = "";
let cookie = "";

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  payload?: any,
  contentType = "application/json",
) {
  return (app.inject as any)({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39130",
      origin,
      cookie,
      ...(payload === undefined ? {} : { "content-type": contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as Promise<any>;
}

beforeEach(async () => {
  directory = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "doca-files-test-"),
  );
  db = await openTestDatabase({
    driver: "sqlite",
    path: join(directory, "test.db"),
  });
  const admin = await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  await createUser(
    db,
    { login: "alice", displayName: "Alice", password },
    { actor: { ...admin, admin: 1 } as Actor },
  );
  app = await createApp(db, {
    origin,
    storage: {
      configuration: storageRuntime().configuration,
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39130", origin },
    payload: { login: "alice", password },
  });
  expect(login.statusCode, login.body).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("removes the old knowledge overview dashboard", async () => {
  const overview = await request("GET", "/knowledge/overview");
  expect(overview.statusCode).toBe(404);
});

it("detects real file types, preserves originals, generates reusable thumbnails, and authorizes derived downloads", async () => {
  const png = await sharp({
    create: { width: 640, height: 320, channels: 3, background: "#8752cc" },
  })
    .png()
    .toBuffer();
  const upload = await request(
    "POST",
    "/files/items?filename=pretend-video.mp4",
    png,
    "application/octet-stream",
  );
  expect(upload.statusCode, upload.body).toBe(200);
  const item = upload.json();
  expect(item.mime).toBe("image/png");
  const object = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", item.storage_object_id)
    .executeTakeFirstOrThrow();
  expect(object.category).toBe("image");
  expect(object.object_key).toMatch(
    /^host\/objects\/image\/[a-f0-9]{2}\/[a-f0-9]{2}\/[^/]+\/original$/,
  );
  expect(
    (await request("GET", `/files/items/${item.id}/content`)).rawPayload,
  ).toEqual(png);
  const duplicate = await request(
    "POST",
    "/files/items?filename=same.png",
    png,
    "application/octet-stream",
  );
  expect(duplicate.json().storage_object_id).toBe(item.storage_object_id);
  const worker = createFileProcessingWorker(db, {
    configuration: storageRuntime().configuration,
    root: join(directory, "uploads"),
    credentials: {},
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  });
  await worker.pump();
  // The app worker can hold the lease before this explicit pump claims it.
  // Wait for the observable result from whichever worker wins the lease.
  const preview = await vi.waitFor(
    async () => {
      const result = await request(
        "GET",
        `/files/items/${item.id}/content?variant=thumbnail`,
      );
      expect(result.statusCode, result.body).toBe(200);
      return result;
    },
    { timeout: 5000, interval: 50 },
  );
  expect(await sharp(preview.rawPayload).metadata()).toMatchObject({
    format: "webp",
    width: 480,
    height: 240,
  });
  await enqueueProjection(db, "file-thumbnail", object.id, {
    objectId: object.id,
  });
  await worker.pump();
  expect(
    await db
      .selectFrom("file_derivatives")
      .selectAll()
      .where("source_id", "=", object.id)
      .execute(),
  ).toHaveLength(1);
  const otherLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39130", origin },
    payload: { login: "admin", password },
  });
  const outsider = await app.inject({
    url: `/api/v1/files/items/${item.id}/content?variant=thumbnail`,
    headers: {
      host: "localhost:39130",
      cookie: String(otherLogin.headers["set-cookie"]).split(";")[0]!,
    },
  });
  expect(outsider.statusCode).toBe(404);
});

it("serves authenticated byte ranges and rejects unsatisfiable ranges", async () => {
  const upload = await request(
    "POST",
    "/files/items?filename=range.txt",
    Buffer.from("0123456789"),
    "application/octet-stream",
  );
  const url = `/api/v1/files/items/${upload.json().id}/content`;
  const get = (range: string) =>
    app.inject({ url, headers: { host: "localhost:39130", cookie, range } });
  const partial = await get("bytes=2-5");
  expect(partial.statusCode).toBe(206);
  expect(partial.body).toBe("2345");
  expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
  expect(partial.headers["content-length"]).toBe("4");
  expect((await get("bytes=-3")).body).toBe("789");
  expect((await get("bytes=7-")).body).toBe("789");
  const invalid = await get("bytes=10-20");
  expect(invalid.statusCode).toBe(416);
  expect(invalid.headers["content-range"]).toBe("bytes */10");
  const denied = await app.inject({
    url,
    headers: { host: "localhost:39130", range: "bytes=0-1" },
  });
  expect(denied.statusCode).toBe(401);
});

it("retries a persisted thumbnail job after storage becomes available again", async () => {
  const png = await sharp({
    create: { width: 12, height: 12, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const upload = await request(
    "POST",
    "/files/items?filename=retry.png",
    png,
    "application/octet-stream",
  );
  expect(upload.statusCode, upload.body).toBe(200);
  const object = await db
    .selectFrom("file_storage_objects")
    .selectAll()
    .where("id", "=", upload.json().storage_object_id)
    .executeTakeFirstOrThrow();
  const source = join(directory, "uploads", object.object_key);
  await rename(source, source + ".offline");
  const runtime = {
    configuration: storageRuntime().configuration,
    root: join(directory, "uploads"),
    credentials: {},
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  };
  await createFileProcessingWorker(db, runtime).pump();
  const jobId = `file-thumbnail:${object.id}`;
  const job = await db
    .selectFrom("projection_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
  expect(job.attempts).toBe(1);
  expect(job.last_error).toBeTruthy();
  await rename(source + ".offline", source);
  await db
    .updateTable("projection_jobs")
    .set({ available_at: "2000-01-01T00:00:00.000Z" })
    .where("id", "=", jobId)
    .execute();
  await createFileProcessingWorker(db, runtime).pump();
  expect(
    await db
      .selectFrom("projection_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(
    (
      await request(
        "GET",
        `/files/items/${upload.json().id}/content?variant=thumbnail`,
      )
    ).statusCode,
  ).toBe(200);
});

it("rolls back object registration when a plugin rejects storage allocation", async () => {
  pluginServices(db).policies.set("test.storage", {
    id: "test.storage",
    async check(input) {
      if (
        input.action === "storage.allocate" &&
        Number(input.facts.additional) === 2
      )
        fail(413, "Storage denied by plugin");
    },
  });
  expect(
    (
      await request(
        "POST",
        "/files/items?filename=first.txt",
        Buffer.from("1234"),
        "application/octet-stream",
      )
    ).statusCode,
  ).toBe(200);
  const rejected = await request(
    "POST",
    "/files/items?filename=second.txt",
    Buffer.from("56"),
    "application/octet-stream",
  );
  expect(rejected.statusCode, rejected.body).toBe(413);
  expect(
    await db.selectFrom("file_storage_objects").selectAll().execute(),
  ).toHaveLength(1);
  expect(await db.selectFrom("file_items").selectAll().execute()).toHaveLength(
    1,
  );
});

it("supports the personal file lifecycle and keeps copies on the same object", async () => {
  const initial = await request(
    "GET",
    "/files?parentType=system&parentId=root",
  );
  expect(initial.statusCode, initial.body).toBe(200);
  expect(
    initial.json().folders.filter((x: { type: string }) => x.type === "system"),
  ).toHaveLength(0);

  const folder = await request("POST", "/files/folders", {
    name: "项目资料",
    parentId: null,
  });
  expect(folder.statusCode, folder.body).toBe(200);
  const folderId = folder.json().id;
  const aliased = await request("POST", "/files/folders", {
    name: "猫猫相册",
    parentId: "root",
  });
  expect(aliased.statusCode, aliased.body).toBe(200);
  expect(aliased.json().parent_id).toBeNull();
  const rootPage = await request(
    "GET",
    "/files?parentType=system&parentId=root",
  );
  expect(rootPage.json().folders.map((x: { name: string }) => x.name)).toEqual(
    expect.arrayContaining(["项目资料", "猫猫相册"]),
  );

  const upload = await request(
    "POST",
    `/files/items?parentType=folder&parentId=${folderId}&filename=说明.txt`,
    Buffer.from("文件预览内容"),
    "application/octet-stream",
  );
  expect(upload.statusCode, upload.body).toBe(200);
  const item = upload.json();
  expect(
    (await request("GET", "/files?parentType=system&parentId=root"))
      .json()
      .files.map((x: { name: string }) => x.name),
  ).not.toContain("说明.txt");

  const content = await request("GET", `/files/items/${item.id}/content`);
  expect(content.statusCode, content.body).toBe(200);
  expect(content.body).toBe("文件预览内容");

  const aiAttachment = await request("POST", `/files/items/${item.id}/attach`, {
    purpose: "ai_attachment",
  });
  expect(aiAttachment.statusCode, aiAttachment.body).toBe(200);
  const attachedFile = await db.selectFrom("file_items").selectAll().where("id", "=", aiAttachment.json().fileId).executeTakeFirstOrThrow();
  expect(JSON.parse(attachedFile.metadata).assetId).toBe(aiAttachment.json().id);
  expect(attachedFile.storage_object_id).toBe(item.storage_object_id);
  expect(aiAttachment.json()).toEqual(
    expect.objectContaining({ filename: "说明.txt", mime: "text/plain" }),
  );

  const copy = await request("POST", `/files/items/${item.id}/copy`, {
    parentType: "folder",
    parentId: folderId,
  });
  expect(copy.statusCode, copy.body).toBe(200);
  expect(copy.json().storage_object_id).toBe(item.storage_object_id);
  expect(copy.json().id).not.toBe(item.id);

  const renamed = await request("PATCH", `/files/items/${copy.json().id}`, {
    name: "副本.txt",
    version: 1,
  });
  expect(renamed.statusCode, renamed.body).toBe(200);

  const removed = await request("DELETE", `/files/items/${item.id}`, {
    version: 1,
  });
  expect(removed.statusCode, removed.body).toBe(200);
  const folderPage = await request(
    "GET",
    `/files?parentType=folder&parentId=${folderId}`,
  );
  expect(folderPage.json().files.map((x: { name: string }) => x.name)).toEqual([
    "副本.txt",
  ]);
});

it("lists shared folders separately and manages their share link", async () => {
  const created = await request("POST", "/files/folders", {
    name: "团队资料",
    parentId: "shared",
  });
  expect(created.statusCode, created.body).toBe(200);
  const folderId = created.json().id;

  const root = await request("GET", "/files?parentType=system&parentId=root");
  expect(
    root.json().folders.map((folder: { name: string }) => folder.name),
  ).not.toContain("共享文件夹");

  const shared = await request("GET", "/files/shared-folders");
  expect(shared.statusCode, shared.body).toBe(200);
  expect(shared.json().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: folderId,
        name: "团队资料",
        role: "owner",
      }),
    ]),
  );

  const link = await request("PUT", `/files/folders/${folderId}/share-link`, {
    enabled: true,
    role: "reader",
  });
  expect(link.statusCode, link.body).toBe(200);
  expect(link.json()).toEqual(
    expect.objectContaining({ enabled: true, role: "reader" }),
  );
  expect(link.json().url).toContain("#/shared-files/join?token=");

  const readBack = await request(
    "GET",
    `/files/folders/${folderId}/share-link`,
  );
  expect(readBack.statusCode, readBack.body).toBe(200);
  expect(readBack.json().token).toBe(link.json().token);
});

it("recursively copies folders into a shared destination without duplicating storage", async () => {
  const source = await request("POST", "/files/folders", {
    name: "待共享资料",
    parentId: null,
  });
  const child = await request("POST", "/files/folders", {
    name: "子目录",
    parentId: source.json().id,
  });
  const upload = await request(
    "POST",
    `/files/items?parentType=folder&parentId=${child.json().id}&filename=说明.txt`,
    Buffer.from("shared copy"),
    "application/octet-stream",
  );
  const shared = await request("POST", "/files/folders", {
    name: "共享目标",
    parentId: "shared",
  });

  const copied = await request(
    "POST",
    `/files/folders/${source.json().id}/copy`,
    { parentId: shared.json().id },
  );
  expect(copied.statusCode, copied.body).toBe(200);
  const copiedRoot = await request(
    "GET",
    `/files?parentType=folder&parentId=${copied.json().id}`,
  );
  expect(copiedRoot.json().folders).toHaveLength(1);
  const copiedChild = await request(
    "GET",
    `/files?parentType=folder&parentId=${copiedRoot.json().folders[0].id}`,
  );
  expect(copiedChild.json().files[0]).toEqual(
    expect.objectContaining({ name: "说明.txt" }),
  );
  const copiedInfo = await request(
    "GET",
    `/files/items/${copiedChild.json().files[0].id}/info`,
  );
  expect(copiedInfo.json().storage_object_id).toBe(
    upload.json().storage_object_id,
  );
});

it("copies a folder under a new name when the destination already has the original", async () => {
  const source = await request("POST", "/files/folders", {
    name: "新建文件夹",
    parentId: null,
  });
  expect(source.statusCode, source.body).toBe(200);
  const copied = await request(
    "POST",
    `/files/folders/${source.json().id}/copy`,
    {
      parentId: null,
      name: "新建文件夹 2",
    },
  );
  expect(copied.statusCode, copied.body).toBe(200);
  const root = await request("GET", "/files?parentType=system&parentId=root");
  const names = root
    .json()
    .folders.map((folder: { name: string }) => folder.name);
  expect(names).toEqual(expect.arrayContaining(["新建文件夹", "新建文件夹 2"]));
});

it("uploads zip files and groups copied files into one searchable physical resource", async () => {
  const firstFolder = await request("POST", "/files/folders", {
    name: "压缩包",
    parentId: null,
  });
  const secondFolder = await request("POST", "/files/folders", {
    name: "归档副本",
    parentId: null,
  });
  const uploaded = await request(
    "POST",
    `/files/items?parentType=folder&parentId=${firstFolder.json().id}&filename=project.zip`,
    Buffer.from("PK\u0003\u0004test archive"),
    "application/octet-stream",
  );
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  expect(uploaded.json().mime).toBe("application/zip");
  const copied = await request(
    "POST",
    `/files/items/${uploaded.json().id}/copy`,
    { parentType: "folder", parentId: secondFolder.json().id },
  );
  expect(copied.statusCode, copied.body).toBe(200);
  await db
    .updateTable("file_storage_objects")
    .set({ ai_description: "前端工程源码压缩归档，封面是一只橘色猫" })
    .where("id", "=", uploaded.json().storage_object_id)
    .execute();

  const search = await request("GET", "/files/search?q=前端工程");
  expect(search.statusCode, search.body).toBe(200);
  expect(search.json().items).toHaveLength(1);
  expect(search.json().items[0]).toEqual(
    expect.objectContaining({
      storageObjectId: uploaded.json().storage_object_id,
      mime: "application/zip",
    }),
  );
  expect(search.json().items[0].locations).toHaveLength(2);
  expect(
    search
      .json()
      .items[0].locations.map((location: { id: string }) => location.id),
  ).toEqual(expect.arrayContaining([uploaded.json().id, copied.json().id]));

  const aiSearch = await request("GET", "/files/search?q=猫猫图片&mode=ai");
  expect(aiSearch.statusCode, aiSearch.body).toBe(200);
  expect(aiSearch.json().items).toHaveLength(1);
  expect(aiSearch.json().items[0].description).toContain("橘色猫");
});

it("shows one physical image result with AI, document and personal locations", async () => {
  const document = await request("POST", "/resources", {
    kind: "document",
    format: "markdown",
    title: "猫咪观察文档",
    markdown: "# 猫咪观察",
  });
  const uploaded = await request(
    "POST",
    "/files/items?filename=orange-cat.webp",
    await sharp({
      create: {
        width: 24,
        height: 24,
        channels: 3,
        background: "orange",
      },
    })
      .webp()
      .toBuffer(),
    "application/octet-stream",
  );
  await request("POST", `/files/items/${uploaded.json().id}/attach`, {
    purpose: "ai_attachment",
  });
  await request("POST", `/files/items/${uploaded.json().id}/attach`, {
    purpose: "attachment",
    resourceId: document.json().id,
  });
  await db
    .updateTable("file_storage_objects")
    .set({ ai_description: "一只阳光下的橘色猫", ai_status: "ready" })
    .where("id", "=", uploaded.json().storage_object_id)
    .execute();

  const search = await request("GET", "/files/search?q=橘色猫");
  expect(search.statusCode, search.body).toBe(200);
  expect(search.json().items).toHaveLength(1);
  const locations = search.json().items[0].locations;
  expect(locations).toHaveLength(3);
  expect(
    locations.filter(
      (location: { parentType: string; parentId: string }) =>
        location.parentType === "system" && location.parentId === "ai",
    ),
  ).toHaveLength(1);
  expect(
    locations.find(
      (location: { parentType: string }) => location.parentType === "document",
    ).navigation,
  ).toEqual([
    expect.objectContaining({
      type: "document",
      id: document.json().id,
      name: "猫咪观察",
    }),
  ]);
});

it("keeps AI assistant files copy-only so originals stay in place", async () => {
  const uploaded = await request(
    "POST",
    "/files/items?filename=ai-cat.png",
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: "orange",
      },
    })
      .png()
      .toBuffer(),
    "application/octet-stream",
  );
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const attached = await request(
    "POST",
    `/files/items/${uploaded.json().id}/attach`,
    {
      purpose: "ai_attachment",
    },
  );
  expect(attached.statusCode, attached.body).toBe(200);
  const page = await request("GET", "/files?parentType=system&parentId=ai");
  expect(page.statusCode, page.body).toBe(200);
  const aiFile = page
    .json()
    .files.find((file: { name: string }) => file.name === "ai-cat.png");
  expect(aiFile).toMatchObject({ name: "ai-cat.png", locked: true });

  const moved = await request("PATCH", `/files/items/${aiFile.id}`, {
    parentType: "system",
    parentId: "root",
    version: aiFile.version,
  });
  expect(moved.statusCode, moved.body).toBe(403);

  const removed = await request("DELETE", `/files/items/${aiFile.id}`, {
    version: aiFile.version,
  });
  expect(removed.statusCode, removed.body).toBe(403);

  const copied = await request("POST", `/files/items/${aiFile.id}/copy`, {
    parentType: "system",
    parentId: "root",
  });
  expect(copied.statusCode, copied.body).toBe(200);
  expect(copied.json().id).not.toBe(aiFile.id);
  expect(copied.json().parent_id).toBe("root");

  const still = await request("GET", "/files?parentType=system&parentId=ai");
  expect(
    still.json().files.some((file: { id: string }) => file.id === aiFile.id),
  ).toBe(true);

  const intoAi = await request(
    "POST",
    `/files/items/${uploaded.json().id}/copy`,
    {
      parentType: "system",
      parentId: "ai",
    },
  );
  expect(intoAi.statusCode, intoAi.body).toBe(403);
});
