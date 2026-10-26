import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { build } from "vite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { unzipSync } from "fflate";
import type { DB } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import { createApp } from "@server/app/create-app.js";
import { storageRuntime } from "@server/adapters/storage.js";
import {
  createBrowserClipper,
  imageMarker,
} from "@server/services/browser-clipper.js";

beforeAll(async () => {
  await build({
    configFile: "apps/browser-extension/vite.config.ts",
    logLevel: "silent",
  });
}, 30_000);

let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  owner: Actor,
  other: Actor,
  cookie: string,
  root: string;
const host = "localhost:39472",
  origin = "http://" + host,
  extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  password = "isolated-clipper-password";
const defaults = {
  name: "故障案例",
  enabled: true,
  isDefault: true,
  strategy: "create",
  libraryId: null,
  parentId: null,
  targetId: null,
  titleTemplate: "{title}",
  aiInstruction: "",
};
const request = (
  method: any,
  path: string,
  payload?: any,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host, origin, cookie, ...headers },
    payload,
  });
const external = (
  method: any,
  path: string,
  token: string,
  payload?: any,
  headers: Record<string, string> = {},
) =>
  request(method, "/browser-clipper" + path, payload, {
    cookie: "",
    origin: extensionOrigin,
    authorization: "Bearer " + token,
    ...headers,
  });
async function profile(settings: Record<string, unknown> = {}) {
  const result = await request("POST", "/me/browser-clipper/profiles", {
    ...defaults,
    ...settings,
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json();
}
async function authorize(installationId = randomUUID()) {
  const verifier = randomBytes(32).toString("hex"),
    challenge = createHash("sha256").update(verifier).digest("hex");
  const response = await request("POST", "/me/browser-clipper/authorize", {
    version: 2,
    installationId,
    challenge,
  });
  return {
    response,
    config: { version: 2, code: response.json().code, verifier },
    installationId,
  };
}
async function connect(ai = false) {
  const prepared = await authorize();
  expect(prepared.response.statusCode, prepared.response.body).toBe(200);
  const activated = await exchange(prepared.config);
  expect(activated.statusCode, activated.body).toBe(200);
  const connection = (await request("GET", "/me/browser-clipper/connections"))
    .json()
    .items.find((row: any) => row.id === activated.json().connectionId);
  if (!ai)
    await request("PUT", `/me/browser-clipper/connections/${connection.id}`, {
      revision: connection.revision,
      name: connection.name,
      assistantEnabled: false,
    });
  return { ...prepared, ...activated.json(), connection };
}
function exchange(config: any) {
  return external("POST", "/token", "", config);
}
function capture(
  profile: any,
  images: { id: string; url: string; name: string }[] = [],
  markdown = "## 现象\n\n设备无法启动。\n\n**排查**：检查电源。",
) {
  return {
    version: 1,
    requestId: randomUUID(),
    profileId: profile.id,
    profileRevision: profile.revision,
    mode: "selection",
    url: "https://source.example.test/article",
    title: "故障记录",
    capturedAt: new Date().toISOString(),
    markdown,
    images,
  };
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-clipper-test-"));
  owner = {
    ...(await createUser(
      db,
      { login: "clipperowner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      { login: "clipperother", displayName: "Other", password },
      { actor: owner },
    )),
    admin: 0,
  };
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: { memory: { driver: "sqlite", url: ":memory:" } },
  });
  const login = await request(
    "POST",
    "/auth/login",
    { login: "clipperowner", password },
    { cookie: "" },
  );
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

it("saves readable missing-image placeholders together with converted PNG assets under the existing protocol", async () => {
  const p = await profile(),
    c = await connect(),
    imageId = randomUUID();
  const png = await sharp({
    create: { width: 32, height: 20, channels: 4, background: "#3370ff80" },
  })
    .png()
    .toBuffer();
  const input = capture(
    p,
    [
      {
        id: imageId,
        name: "logo.png",
        url: "https://source.example.test/logo.svg",
      },
    ],
    `## 网页正文\n\n![Logo](${imageMarker(imageId)})\n\n[图片未保存：chart.avif（格式不支持或图片内容无效）](https://source.example.test/chart.avif)\n\n正文仍然保留。`,
  );
  const prepared = await external("POST", "/clips", c.token, input);
  expect(prepared.statusCode, prepared.body).toBe(200);
  const uploaded = await external(
    "PUT",
    `/clips/${input.requestId}/images/${imageId}`,
    c.token,
    png,
    { "content-type": "application/octet-stream" },
  );
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(200);
  const document = await readAIDocument(
    db,
    { actor: owner },
    committed.json().resourceId,
  );
  const body = JSON.stringify(document.value);
  expect(body).toContain('"type":"image"');
  expect(body).toContain("图片未保存：chart.avif");
  expect(body).toContain("https://source.example.test/chart.avif");
  expect(body).toContain("正文仍然保留");
  expect(body).not.toContain("clipper.invalid");
});

it("archives original image bytes and rich text atomically, with durable retries and no server source fetch", async () => {
  const p = await profile(),
    c = await connect(),
    imageId = randomUUID();
  const body = await sharp({
    create: { width: 32, height: 20, channels: 3, background: "#e0a040" },
  })
    .png()
    .toBuffer();
  const input = capture(
    p,
    [
      {
        id: imageId,
        url: "https://source.example.test/original.png",
        name: "original.png",
      },
    ],
    `## 故障现象\n\n无法启动\n\n![原图](${imageMarker(imageId)})\n\n| 项目 | 结果 |\n| --- | --- |\n| 电源 | 正常 |`,
  );
  const prepared = await external("POST", "/clips", c.token, input);
  expect(prepared.statusCode, prepared.body).toBe(200);
  expect(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("kind", "=", "document")
      .execute(),
  ).toEqual([]);
  const uploaded = await external(
    "PUT",
    `/clips/${input.requestId}/images/${imageId}`,
    c.token,
    body,
    { "content-type": "application/octet-stream" },
  );
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(200);
  const result = committed.json(),
    document = await readAIDocument(db, { actor: owner }, result.resourceId);
  expect(JSON.stringify(document.value)).toContain("故障现象");
  expect(JSON.stringify(document.value)).toContain('"type":"image"');
  expect(JSON.stringify(document.value)).toContain('"type":"table"');
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("resource_id", "=", result.resourceId)
    .executeTakeFirstOrThrow();
  const download = await request("GET", `/assets/${asset.id}/content`);
  expect(download.statusCode, download.body).toBe(200);
  expect(createHash("sha256").update(download.rawPayload).digest("hex")).toBe(
    createHash("sha256").update(body).digest("hex"),
  );
  const retries = await Promise.all([
    external("POST", `/clips/${input.requestId}/commit`, c.token, {}),
    external("POST", "/clips", c.token, input),
  ]);
  expect(retries.map((response) => response.json().resourceId)).toEqual([
    result.resourceId,
    result.resourceId,
  ]);
  expect(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("kind", "=", "document")
      .execute(),
  ).toHaveLength(1);
  expect(
    (await db.selectFrom("browser_clipper_receipts").selectAll().execute())[0]
      ?.payload_json,
  ).toBe("");
});

it("saves placeholders for images rejected during upload, preserving good images and later text", async () => {
  const p = await profile(),
    c = await connect(),
    missing = randomUUID(),
    valid = randomUUID();
  const input = capture(
    p,
    [
      {
        id: missing,
        name: "bad.avif",
        url: "https://source.example.test/bad.avif",
      },
      {
        id: valid,
        name: "valid.png",
        url: "https://source.example.test/valid.png",
      },
    ],
    `Before\n\n![Broken](${imageMarker(missing)})\n\n![Valid](${imageMarker(valid)})\n\nAfter`,
  );
  expect((await external("POST", "/clips", c.token, input)).statusCode).toBe(
    200,
  );
  expect(
    (
      await external(
        "PUT",
        `/clips/${input.requestId}/images/${missing}`,
        c.token,
        Buffer.from("not an image"),
        { "content-type": "application/octet-stream" },
      )
    ).statusCode,
  ).toBe(400);
  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  expect(
    (
      await external(
        "PUT",
        `/clips/${input.requestId}/images/${valid}`,
        c.token,
        png,
        { "content-type": "application/octet-stream" },
      )
    ).statusCode,
  ).toBe(200);
  const saved = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().warnings).toHaveLength(1);
  expect(saved.json().warnings[0].message).toContain("bad.avif");
  const document = await readAIDocument(
    db,
    { actor: owner },
    saved.json().resourceId,
  );
  const body = JSON.stringify(document.value);
  for (const text of [
    "Before",
    "Image not saved: bad.avif",
    "https://source.example.test/bad.avif",
    "After",
  ])
    expect(body).toContain(text);
  expect(body.match(/"type":"image"/g)).toHaveLength(1);
  expect(body).not.toContain("clipper.invalid");
});

it("saves a degraded page and placeholders atomically and reports warnings only for this conversion attempt", async () => {
  const p = await profile(),
    c = await connect();
  const input = capture(
    p,
    [],
    "Before\n\n$x^2$\n\n<div>Readable HTML</div>\n\nAfter",
  );
  expect((await external("POST", "/clips", c.token, input)).statusCode).toBe(
    200,
  );
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(200);
  expect(committed.json().warnings.map((item: any) => item.code)).toEqual([
    "format-degraded",
    "unsupported-content",
  ]);
  const doc = await readAIDocument(
    db,
    { actor: owner },
    committed.json().resourceId,
  );
  const body = JSON.stringify(doc.value);
  for (const text of [
    "Before",
    "$x^2$",
    "Readable HTML",
    "After",
    "Content not fully converted:",
  ])
    expect(body).toContain(text);
  const retry = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json().resourceId).toBe(committed.json().resourceId);
  expect(retry.json()).not.toHaveProperty("warnings");
  expect(
    await db
      .selectFrom("resources")
      .select("id")
      .where("kind", "=", "document")
      .execute(),
  ).toHaveLength(1);
});

for (const format of ["rich_text", "markdown"] as const)
  it(`appends structured ${format} content once without replacing existing text or concurrent captures`, async () => {
    const target = await createContent(db).create(owner, {
      title: "原排查记录",
      kind: "document",
      format,
      ...(format === "markdown" ? { markdown: "# 原排查记录\n已有内容" } : {}),
    });
    const before = await readAIDocument(db, { actor: owner }, target.id);
    const p = await profile({ strategy: "append", targetId: target.id }),
      c = await connect();
    const first = capture(p, [], "## 第一条\n\n新增故障一"),
      second = capture(p, [], "## 第二条\n\n新增故障二");
    for (const input of [first, second])
      expect(
        (await external("POST", "/clips", c.token, input)).statusCode,
      ).toBe(200);
    const saved = await Promise.all([
      external("POST", `/clips/${first.requestId}/commit`, c.token, {}),
      external("POST", `/clips/${second.requestId}/commit`, c.token, {}),
    ]);
    for (const response of saved)
      expect(response.statusCode, response.body).toBe(200);
    expect(
      (await external("POST", `/clips/${first.requestId}/commit`, c.token, {}))
        .statusCode,
    ).toBe(200);
    const after = await readAIDocument(db, { actor: owner }, target.id);
    expect(after.epochId).toBe(before.epochId);
    expect(JSON.stringify(after.value)).toContain("原排查记录");
    expect(JSON.stringify(after.value).match(/新增故障一/g)).toHaveLength(1);
    expect(JSON.stringify(after.value).match(/新增故障二/g)).toHaveLength(1);
    expect(
      await db
        .selectFrom("resources")
        .selectAll()
        .where("kind", "=", "document")
        .execute(),
    ).toHaveLength(1);
  });

it("uses a frozen profile and rejects stale preparation instead of retargeting an in-flight capture", async () => {
  const p = await profile(),
    c = await connect(),
    first = capture(p);
  expect((await external("POST", "/clips", c.token, first)).statusCode).toBe(
    200,
  );
  const { id, ...input } = p;
  const changed = await request("PUT", "/me/browser-clipper/profiles/" + id, {
    ...input,
    titleTemplate: "新规则 {title}",
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(
    (await external("POST", "/clips", c.token, capture(p))).statusCode,
  ).toBe(409);
  const old = await external(
    "POST",
    `/clips/${first.requestId}/commit`,
    c.token,
    {},
  );
  expect(old.statusCode, old.body).toBe(200);
  expect(
    (
      await db
        .selectFrom("resources")
        .select("title")
        .where("id", "=", old.json().resourceId)
        .executeTakeFirst()
    )?.title,
  ).toBe("故障记录");
});

it("describes the frozen new-document title and destination without writes, including after the live profile changes", async () => {
  const content = createContent(db);
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "故障知识库",
  });
  const parent = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "维护记录",
    libraryId: library.id,
  });
  const replacement = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "新的保存位置",
  });
  const p = await profile({
    libraryId: library.id,
    parentId: parent.id,
    titleTemplate: "归档 {date} · {title}",
  });
  const c = await connect();
  const input = { ...capture(p), capturedAt: "2026-10-21T10:00:00.000Z" };
  expect((await external("POST", "/clips", c.token, input)).statusCode).toBe(
    200,
  );
  const clipper = createBrowserClipper(
    db,
    { ...storageRuntime(), root },
    async () => {},
  );
  const before = await db
    .selectFrom("browser_clipper_receipts")
    .selectAll()
    .execute();
  const resourcesBefore = await db
    .selectFrom("resources")
    .selectAll()
    .execute();
  const description = await clipper.describeCapture(
    owner,
    c.connectionId,
    input.requestId,
  );
  expect(description).toEqual({
    profileId: p.id,
    profileRevision: p.revision,
    strategy: "create",
    title: "归档 2026-10-21 · 故障记录",
    path: "故障知识库 / 维护记录",
  });
  expect(
    await db.selectFrom("browser_clipper_receipts").selectAll().execute(),
  ).toEqual(before);
  expect(await db.selectFrom("resources").selectAll().execute()).toEqual(
    resourcesBefore,
  );
  await expect(
    clipper.describeCapture(other, c.connectionId, input.requestId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    clipper.describeCapture(owner, randomUUID(), input.requestId),
  ).rejects.toMatchObject({ status: 404 });

  const { id, ...values } = p;
  const changed = await request("PUT", `/me/browser-clipper/profiles/${id}`, {
    ...values,
    libraryId: replacement.id,
    parentId: null,
    titleTemplate: "新规则 {title}",
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(
    await clipper.describeCapture(owner, c.connectionId, input.requestId),
  ).toEqual(description);
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(200);
  const saved = await db
    .selectFrom("resources")
    .select(["title", "library_id", "parent_id"])
    .where("id", "=", committed.json().resourceId)
    .executeTakeFirstOrThrow();
  expect(saved).toEqual({
    title: description.title,
    library_id: library.id,
    parent_id: parent.id,
  });
  expect(
    (
      await db
        .selectFrom("browser_clipper_receipts")
        .select("payload_json")
        .where("request_id", "=", input.requestId)
        .executeTakeFirstOrThrow()
    ).payload_json,
  ).toBe("");
  await expect(
    clipper.describeCapture(owner, c.connectionId, input.requestId),
  ).rejects.toMatchObject({ status: 409 });
  const repeated = await clipper.commit(owner, c.connectionId, input.requestId);
  expect(repeated.resourceId).toBe(committed.json().resourceId);
  expect(
    await db
      .selectFrom("resources")
      .select("id")
      .where("parent_id", "=", parent.id)
      .execute(),
  ).toHaveLength(1);
});

it("describes and appends to the frozen target even if the live profile switches to creating documents", async () => {
  const content = createContent(db);
  const target = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "原排查记录",
    markdown: "# 原排查记录\n\n原有内容必须保留。",
  });
  await readAIDocument(db, { actor: owner }, target.id);
  const replacement = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "新建目的地",
  });
  const p = await profile({
    strategy: "append",
    targetId: target.id,
    titleTemplate: "追加 {date} {title}",
  });
  const c = await connect();
  const input = { ...capture(p), capturedAt: "2026-10-21T10:00:00.000Z" };
  expect((await external("POST", "/clips", c.token, input)).statusCode).toBe(
    200,
  );
  const clipper = createBrowserClipper(
    db,
    { ...storageRuntime(), root },
    async () => {},
  );
  const description = await clipper.describeCapture(
    owner,
    c.connectionId,
    input.requestId,
  );
  expect(description).toEqual({
    profileId: p.id,
    profileRevision: p.revision,
    strategy: "append",
    title: "追加 2026-10-21 故障记录",
    path: "原排查记录",
  });
  const { id, ...values } = p;
  const changed = await request("PUT", `/me/browser-clipper/profiles/${id}`, {
    ...values,
    strategy: "create",
    targetId: null,
    libraryId: replacement.id,
    titleTemplate: "新的标题 {title}",
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(
    await clipper.describeCapture(owner, c.connectionId, input.requestId),
  ).toEqual(description);
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(200);
  expect(committed.json().resourceId).toBe(target.id);
  const saved = await readAIDocument(db, { actor: owner }, target.id);
  expect(JSON.stringify(saved.value)).toContain(description.title);
  expect(JSON.stringify(saved.value)).toContain("原有内容必须保留");
  expect(
    (
      await db
        .selectFrom("resources")
        .select("title")
        .where("id", "=", target.id)
        .executeTakeFirstOrThrow()
    ).title,
  ).toBe(description.path);
  expect(
    await db
      .selectFrom("resources")
      .select("id")
      .where("library_id", "=", replacement.id)
      .execute(),
  ).toEqual([]);
});

it("uses the same expanded-title validation for capture descriptions and commits", async () => {
  const p = await profile({ titleTemplate: "{date} {title}" });
  const c = await connect();
  const input = { ...capture(p), title: "x".repeat(160) };
  expect((await external("POST", "/clips", c.token, input)).statusCode).toBe(
    200,
  );
  const clipper = createBrowserClipper(
    db,
    { ...storageRuntime(), root },
    async () => {},
  );
  await expect(
    clipper.describeCapture(owner, c.connectionId, input.requestId),
  ).rejects.toMatchObject({ status: 400, message: "clipper_title_too_long" });
  const committed = await external(
    "POST",
    `/clips/${input.requestId}/commit`,
    c.token,
    {},
  );
  expect(committed.statusCode, committed.body).toBe(400);
  expect(committed.json().message).toBe("clipper_title_too_long");
  expect(
    await db
      .selectFrom("resources")
      .select("id")
      .where("kind", "=", "document")
      .execute(),
  ).toEqual([]);
});

it("supports single-use login exchange, atomic token replacement and explicit revocation without deleting saved data", async () => {
  const p = await profile(),
    c = await connect(),
    first = capture(p);
  expect((await exchange(c.config)).statusCode).toBe(401);
  await external("POST", "/clips", c.token, first);
  const saved = await external(
    "POST",
    `/clips/${first.requestId}/commit`,
    c.token,
    {},
  );
  expect(saved.statusCode, saved.body).toBe(200);
  const connection = (
    await request("GET", "/me/browser-clipper/connections")
  ).json().items[0];
  const replacement = await authorize(c.installationId);
  expect((await external("GET", "/me", c.token)).statusCode).toBe(200);
  const rotated = await exchange(replacement.config);
  expect(rotated.statusCode, rotated.body).toBe(200);
  expect((await external("GET", "/me", c.token)).statusCode).toBe(401);
  const token = rotated.json().token,
    current = (await request("GET", "/me/browser-clipper/connections")).json()
      .items[0];
  const revoked = await request(
    "POST",
    `/me/browser-clipper/connections/${current.id}/revoke`,
    { revision: current.revision },
  );
  expect(revoked.statusCode, revoked.body).toBe(200);
  expect((await external("GET", "/me", token)).statusCode).toBe(401);
  expect(
    (await request("GET", "/resources/" + saved.json().resourceId)).statusCode,
  ).toBe(200);
  expect(
    (
      await db
        .selectFrom("browser_clipper_connections")
        .select("token_hash")
        .where("id", "=", current.id)
        .executeTakeFirst()
    )?.token_hash,
  ).toBeNull();
});

it("revokes every token and pending activation, cancels related AI jobs, and preserves conversations", async () => {
  const p = await profile(),
    a = await connect(true),
    b = await connect(true);
  const session = await external("POST", "/assistant/sessions", a.token, {
    profileId: p.id,
    profileRevision: p.revision,
  });
  expect(session.statusCode, session.body).toBe(200);
  const sid = session.json().id,
    now = new Date().toISOString(),
    jobId = randomUUID();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sid,
      user_id: owner.id,
      model_id: "unconfigured",
      status: "awaiting_approval",
      input: "{}",
      digest: "test",
      result: "",
      error: "",
      lease: null,
      lease_until: null,
      attempts: 0,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .updateTable("browser_clipper_assistant_sessions")
    .set({ job_ids: JSON.stringify({ version: 1, ids: [jobId] }) })
    .where("session_id", "=", sid)
    .execute();
  const pending = await authorize(a.installationId);
  const revoked = await request("POST", "/me/browser-clipper/revoke-all", {});
  expect(revoked.statusCode, revoked.body).toBe(200);
  expect(revoked.json().revoked).toBe(2);
  for (const token of [a.token, b.token])
    expect((await external("GET", "/me", token)).statusCode).toBe(401);
  expect((await exchange(pending.config)).statusCode).toBe(401);
  expect(
    await db
      .selectFrom("ai_sessions")
      .select("id")
      .where("id", "=", sid)
      .executeTakeFirst(),
  ).toBeDefined();
  expect(
    await db
      .selectFrom("ai_jobs")
      .select(["status", "cancelled"])
      .where("id", "=", jobId)
      .executeTakeFirst(),
  ).toEqual({ status: "cancelled", cancelled: 1 });
});

it("keeps browser credentials out of ordinary APIs and rejects cookies, website origins, foreign captures and disabled AI", async () => {
  const p = await profile(),
    c = await connect(),
    input = capture(p);
  expect(
    (
      await request("GET", "/me", undefined, {
        cookie: "",
        authorization: "Bearer " + c.token,
      })
    ).statusCode,
  ).toBe(401);
  expect((await request("GET", "/browser-clipper/me")).statusCode).toBe(401);
  expect(
    (
      await external("POST", "/clips", c.token, input, {
        origin: "https://attacker.example",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await external("POST", "/assistant/sessions", c.token, {
        profileId: p.id,
        profileRevision: p.revision,
      })
    ).statusCode,
  ).toBe(403);
  await external("POST", "/clips", c.token, input);
  const second = await connect();
  expect(
    (await external("GET", `/clips/${input.requestId}`, second.token))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await external("POST", "/clips", c.token, {
        ...input,
        markdown: "changed",
      })
    ).statusCode,
  ).toBe(409);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", owner.id)
    .execute();
  expect(
    (await external("POST", `/clips/${input.requestId}/commit`, c.token, {}))
      .statusCode,
  ).toBe(401);
});

it("downloads a complete private package without caching secrets or changing the template", async () => {
  const c = await connect();
  const current = (
    await request("GET", "/me/browser-clipper/connections")
  ).json().items[0];
  const response = await request("POST", `/me/browser-clipper/download`, {});
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const files = unzipSync(response.rawPayload),
    config = JSON.parse(new TextDecoder().decode(files["connection.json"]));
  expect(config.origin).toBe(origin);
  expect(config).toEqual({ version: 2, origin });
  expect(config.token).toBeUndefined();
  for (const name of [
    "manifest.json",
    "background.js",
    "content.js",
    "capture.js",
    "ui.html",
    "ui.js",
    "ui.css",
    "messages.js",
    "icon.png",
    "generated/assistant.js",
    "generated/assistant.css",
    "image-processing.js",
    "svg-image.js",
  ])
    expect(files[name]?.length).toBeGreaterThan(0);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  expect(manifest.manifest_version).toBe(3);
  const release = await request("GET", "/browser-clipper/release", undefined, {
    cookie: "",
    origin: extensionOrigin,
  });
  expect(release.statusCode, release.body).toBe(200);
  expect(release.headers["cache-control"]).toBe("no-store");
  expect(release.json()).toEqual({
    version: manifest.version,
    filename: `doca-browser-assistant-${manifest.version}.zip`,
  });
  expect(response.headers["content-disposition"]).toBe(
    `attachment; filename="${release.json().filename}"`,
  );
  expect(manifest.permissions).toContain("scripting");
  expect(config.activationSecret).toBeUndefined();
  expect(
    JSON.stringify(
      (await request("GET", "/me/browser-clipper/connections")).json(),
    ),
  ).not.toContain(config.activationSecret);
});

it("requires website sign-in for authorization and stops token use when that exact website session is logged out", async () => {
  const c = await connect();
  expect((await external("GET", "/session", c.token)).statusCode).toBe(401);
  expect(
    (await external("GET", "/session", c.token, undefined, { cookie }))
      .statusCode,
  ).toBe(200);
  const before = cookie;
  await request("POST", "/auth/logout", {});
  expect((await external("GET", "/me", c.token)).statusCode).toBe(401);
  expect((await authorize(c.installationId)).response.statusCode).toBe(401);
  cookie = "";
  const login = await request("POST", "/auth/login", {
    login: "clipperowner",
    password,
  });
  expect(login.statusCode, login.body).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const fresh = await authorize(c.installationId),
    signed = await exchange(fresh.config);
  expect(signed.statusCode, signed.body).toBe(200);
  expect(signed.json().connectionId).toBe(c.connectionId);
  expect(
    (
      await external("GET", "/session", signed.json().token, undefined, {
        cookie: before,
      })
    ).statusCode,
  ).toBe(401);
});
it("rejects expired or incorrectly proved login codes and never restores revoked installations automatically", async () => {
  const c = await connect(),
    next = await authorize(c.installationId);
  expect(
    (await exchange({ ...next.config, verifier: "0".repeat(64) })).statusCode,
  ).toBe(401);
  await db
    .updateTable("browser_clipper_login_codes")
    .set({ expires_at: "2000-01-01T00:00:00Z" })
    .where(
      "code_hash",
      "=",
      createHash("sha256").update(next.config.code).digest("hex"),
    )
    .execute();
  expect((await exchange(next.config)).statusCode).toBe(401);
  const row = (await request("GET", "/me/browser-clipper/connections"))
    .json()
    .items.find((r: any) => r.id === c.connectionId);
  await request("POST", `/me/browser-clipper/connections/${row.id}/revoke`, {
    revision: row.revision,
  });
  expect((await authorize(c.installationId)).response.statusCode).toBe(403);
  const revoked = (await request("GET", "/me/browser-clipper/connections"))
    .json()
    .items.find((r: any) => r.id === row.id);
  await request("POST", `/me/browser-clipper/connections/${row.id}/restore`, {
    revision: revoked.revision,
  });
  expect((await external("GET", "/me", c.token)).statusCode).toBe(401);
  expect(
    (await exchange((await authorize(c.installationId)).config)).statusCode,
  ).toBe(200);
  expect(
    (await external("GET", "/me", "doca_browser_v1_" + "a".repeat(64)))
      .statusCode,
  ).toBe(401);
});
it("renews a short token under the same website session and isolates installations for another account", async () => {
  const c = await connect();
  await db
    .updateTable("browser_clipper_web_sessions")
    .set({ expires_at: "2000-01-01T00:00:00Z" })
    .where("connection_id", "=", c.connectionId)
    .execute();
  expect((await external("GET", "/me", c.token)).json().message).toBe(
    "clipper_token_expired",
  );
  const renewed = await exchange((await authorize(c.installationId)).config);
  expect(renewed.statusCode, renewed.body).toBe(200);
  expect(renewed.json().connectionId).toBe(c.connectionId);
  cookie = "";
  const login = await request("POST", "/auth/login", {
    login: "clipperother",
    password,
  });
  expect(login.statusCode, login.body).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const different = await exchange((await authorize(c.installationId)).config);
  expect(different.statusCode, different.body).toBe(200);
  expect(different.json().connectionId).not.toBe(c.connectionId);
  expect(different.json().userId).toBe(other.id);
  expect(
    (
      await external("GET", "/session", renewed.json().token, undefined, {
        cookie,
      })
    ).statusCode,
  ).toBe(401);
});
