import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  blockDocument,
  moderationConfig,
  reportDocument,
} from "@core/modules/moderation/service.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import { createModerationWorker } from "../apps/server/src/jobs/moderation-worker.js";
import { createModerationProvider } from "../apps/server/src/adapters/moderation.js";
import { documentAccess } from "@core/modules/collaboration/documents.js";
import { provisionSurface } from "@core/modules/documents/codecs/surfaces.js";
let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  directory: string,
  admin: Actor,
  owner: Actor,
  reader: Actor;
let adminCookie: string,
  ownerCookie: string,
  readerCookie: string,
  content: ReturnType<typeof createContent>;
let suggestion = "Pass",
  unavailable = false;
const password = "test-password-2026",
  origin = "http://localhost:39371";
const cloud = vi.fn(async () => {
  if (unavailable) throw Error("test unavailable");
  return new Response(
    JSON.stringify({
      Response: {
        Suggestion: suggestion,
        Label: "Test",
        RequestId: "test-request",
      },
    }),
  );
});
function storage() {
  return {
    root: directory,
    credentials: {},
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  };
}
function request(
  method: "GET" | "POST" | "PUT",
  path: string,
  cookie = adminCookie,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { origin, host: "localhost:39371", cookie },
    ...(payload ? { payload } : {}),
  });
}
async function enabled() {
  const config = await moderationConfig(db);
  await db
    .updateTable("moderation_settings")
    .set({
      config: JSON.stringify({
        ...config,
        enabled: true,
        secretId: "test-key-id",
        secretKey: "test-secret",
      }),
    })
    .where("id", "=", "system")
    .execute();
}
async function doc(parentId?: string, libraryId?: string) {
  return content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Audit content",
    markdown: "# Audit content\n\nReview this text",
    parentId,
    libraryId,
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "doca-moderation-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  admin = {
    ...(await createUser(
      db,
      { login: "admin", displayName: "Admin", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { actor: admin },
    )),
    admin: 0,
  };
  reader = {
    ...(await createUser(
      db,
      { login: "reader", displayName: "Reader", password },
      { actor: admin },
    )),
    admin: 0,
  };
  content = createContent(db);
  suggestion = "Pass";
  unavailable = false;
  cloud.mockClear();
  app = await createApp(db, {
    origin,
    storage: storage(),
    moderation: { fetch: cloud as typeof fetch },
  });
  const login = async (login: string) =>
    String(
      (await request("POST", "/auth/login", "", { login, password })).headers[
        "set-cookie"
      ],
    ).split(";")[0]!;
  adminCookie = await login("admin");
  ownerCookie = await login("owner");
  readerCookie = await login("reader");
});
afterEach(async () => {
  await app.close();
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
});
it("blocks all normal access including owner/admin, history, sharing and search; retains audit and descendants", async () => {
  const library = await content.create(owner, {
      kind: "library",
      format: "rich_text",
      title: "Audit library",
    }),
    parent = await doc(undefined, library.id),
    r = await doc(parent.id);
  await content.permissions(owner, r.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "public",
    grants: [],
  });
  await blockDocument(db, r.id, true, admin.id, "Test block");
  for (const cookie of [ownerCookie, readerCookie, adminCookie, ""])
    expect(
      (await request("GET", `/resources/${r.id}`, cookie)).statusCode,
    ).toBe(404);
  expect(
    (await request("GET", `/resources/${r.id}/versions`, ownerCookie))
      .statusCode,
  ).toBe(404);
  await expect(documentAccess(db, owner, r.id)).rejects.toThrow();
  const list = await content.list(owner, { scope: "mine" });
  expect(list.items.some((x) => x.id === r.id)).toBe(false);
  await expect(content.trash(owner, parent.id, parent.version)).rejects.toThrow(
    "审计保留",
  );
  expect(
    (await request("GET", `/admin/moderation/documents/${r.id}`, readerCookie))
      .statusCode,
  ).toBe(403);
  const audit = await request("GET", `/admin/moderation/documents/${r.id}`);
  expect(audit.statusCode, audit.body).toBe(200);
  expect(audit.json().text).toContain("Review this text");
  await blockDocument(db, r.id, false, admin.id, "False positive");
  expect((await content.detail(owner, r.id)).resource.moderation_hold).toBe(1);
  await expect(
    content.trash(
      owner,
      r.id,
      (await content.detail(owner, r.id)).resource.version,
    ),
  ).rejects.toThrow("审计保留");
});
it("keeps reports private, deduplicates pending reports and revokes a banned user's sessions", async () => {
  const r = await doc();
  await content.permissions(owner, r.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "public",
    grants: [],
  });
  const report = await request(
    "POST",
    `/resources/${r.id}/reports`,
    readerCookie,
    { reason: "涉嫌违规，请核查" },
  );
  expect(report.statusCode, report.body).toBe(200);
  expect((await reportDocument(db, reader, r.id, "再次提交")).id).toBe(
    report.json().id,
  );
  expect(
    (
      await request(
        "GET",
        `/admin/moderation/cases/${report.json().id}`,
        ownerCookie,
      )
    ).statusCode,
  ).toBe(403);
  const result = await request(
    "POST",
    `/admin/moderation/cases/${report.json().id}/decide`,
    adminCookie,
    { decision: "block_user", reason: "审核确认该用户违规" },
  );
  expect(result.statusCode, result.body).toBe(200);
  expect((await request("GET", "/me", ownerCookie)).statusCode).toBe(401);
  expect(
    (
      await db
        .selectFrom("users")
        .select("status")
        .where("id", "=", owner.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("disabled");
  expect(
    (
      await request(
        "POST",
        `/admin/moderation/cases/${report.json().id}/decide`,
        adminCookie,
        { decision: "dismiss", reason: "repeat" },
      )
    ).statusCode,
  ).toBe(409);
});
it("coalesces modifications and rejects stale cloud results", async () => {
  await enabled();
  const r = await doc();
  await enqueueProjection(db, "search", r.id, { resourceId: r.id });
  await enqueueProjection(db, "search", r.id, { resourceId: r.id });
  const jobs = await db
    .selectFrom("projection_jobs")
    .selectAll()
    .where("kind", "=", "moderation-text")
    .execute();
  expect(jobs).toHaveLength(1);
  expect(Date.parse(jobs[0]!.available_at)).toBeGreaterThan(
    Date.now() + 110000,
  );
  const worker = createModerationWorker(db, storage(), {
    fetch: (async () => {
      await db
        .updateTable("document_states")
        .set({ text: "New safe revision" })
        .where("resource_id", "=", r.id)
        .execute();
      return new Response(
        JSON.stringify({ Response: { Suggestion: "Block" } }),
      );
    }) as typeof fetch,
  });
  await worker.review("text", r.id);
  expect(
    (
      await db
        .selectFrom("resources")
        .select("moderation_status")
        .where("id", "=", r.id)
        .executeTakeFirstOrThrow()
    ).moderation_status,
  ).toBe("active");
  expect(
    await db.selectFrom("moderation_cases").selectAll().execute(),
  ).toHaveLength(0);
});
it("automatically blocks current text and persists evidence without deleting document data", async () => {
  await enabled();
  const r = await doc();
  suggestion = "Block";
  await createModerationWorker(db, storage(), {
    fetch: cloud as typeof fetch,
  }).review("text", r.id);
  const row = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", r.id)
    .executeTakeFirstOrThrow();
  expect(row.moderation_status).toBe("blocked");
  expect(row.moderation_hold).toBe(1);
  const cases = await db.selectFrom("moderation_cases").selectAll().execute();
  expect(cases[0]?.evidence).toContain("Review this text");
  expect(cases[0]?.result).toContain("test-request");
  expect(
    await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", r.id)
      .executeTakeFirst(),
  ).toBeTruthy();
});
it("preserves immutable block evidence after unblocking and later edits", async () => {
  const r = await doc();
  const before = await db
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", r.id)
    .executeTakeFirstOrThrow();
  await db
    .transaction()
    .execute((tx) => blockDocument(tx, r.id, true, admin.id, "Archive test"));
  const archive = await db
    .selectFrom("moderation_cases")
    .selectAll()
    .where("kind", "=", "archive")
    .executeTakeFirstOrThrow();
  expect(JSON.parse(archive.result).state).toEqual(before);
  await db
    .transaction()
    .execute((tx) => blockDocument(tx, r.id, false, admin.id, "Lift block"));
  await db
    .updateTable("document_states")
    .set({ text: "Later revision" })
    .where("resource_id", "=", r.id)
    .execute();
  expect(
    await db
      .selectFrom("moderation_cases")
      .selectAll()
      .where("id", "=", archive.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(archive);
  expect(archive.evidence).toContain("Review this text");
});
it("provides privileged read-only previews for every document format and handles uninitialized documents", async () => {
  for (const format of [
    "rich_text",
    "markdown",
    "spreadsheet",
    "canvas",
    "presentation",
  ] as const) {
    const r =
      format === "markdown"
        ? await doc()
        : await content.create(owner, {
            kind: "document",
            format,
            title: `${format} audit`,
            ...(format === "rich_text"
              ? {
                  initialContent: {
                    schemaVersion: 2,
                    children: [
                      {
                        id: "audit-paragraph",
                        type: "paragraph",
                        children: [{ text: "Preview text" }],
                      },
                    ],
                  },
                }
              : {}),
          });
    if (["spreadsheet", "canvas", "presentation"].includes(format)) {
      expect(
        (
          await request("GET", `/admin/moderation/documents/${r.id}/preview`)
        ).json(),
      ).toEqual({ empty: true });
      await db.transaction().execute((tx) => provisionSurface(tx, r));
    }
    await db
      .transaction()
      .execute((tx) =>
        blockDocument(tx, r.id, true, admin.id, "Preview blocked document"),
      );
    const before = await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", r.id)
      .executeTakeFirstOrThrow();
    expect(
      (
        await request(
          "GET",
          `/admin/moderation/documents/${r.id}/preview`,
          ownerCookie,
        )
      ).statusCode,
    ).toBe(403);
    const preview = await request(
      "GET",
      `/admin/moderation/documents/${r.id}/preview`,
    );
    expect(preview.statusCode, preview.body).toBe(200);
    if (format === "markdown")
      expect(preview.json().markdown).toContain("Review this text");
    else if (format === "rich_text")
      expect(JSON.stringify(preview.json().value)).toContain("Preview text");
    else expect(preview.json().surface.format).toBe(format);
    expect(
      await db
        .selectFrom("document_states")
        .selectAll()
        .where("resource_id", "=", r.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  }
});
async function upload(id: string) {
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  return app.inject({
    method: "POST",
    url: `/api/v1/assets?purpose=attachment&resourceId=${id}&filename=test.png`,
    headers: {
      origin,
      host: "localhost:39371",
      cookie: ownerCookie,
      "content-type": "application/octet-stream",
    },
    payload: image,
  });
}
it("audits images immediately, retains rejected uploads and prevents non-admin reads", async () => {
  await enabled();
  const r = await doc();
  suggestion = "Block";
  const uploaded = await upload(r.id);
  expect(uploaded.statusCode, uploaded.body).toBe(422);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(asset.moderation_status).toBe("blocked");
  expect(asset.uploaded_by).toBe(owner.id);
  expect(
    (await request("GET", `/assets/${asset.id}/content`, ownerCookie))
      .statusCode,
  ).toBe(403);
  expect(
    (await request("GET", `/assets/${asset.id}/content?audit=1`, ownerCookie))
      .statusCode,
  ).toBe(403);
  expect(
    (await request("GET", `/assets/${asset.id}/content?audit=1`)).statusCode,
  ).toBe(200);
  expect((await content.detail(owner, r.id)).resource.moderation_status).toBe(
    "active",
  );
  const c = await db
    .selectFrom("moderation_cases")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(
    (
      await request(
        "POST",
        `/admin/moderation/cases/${c.id}/decide`,
        adminCookie,
        { decision: "approve_image", reason: "人工复核通过" },
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await request("GET", `/assets/${asset.id}/content`, ownerCookie))
      .statusCode,
  ).toBe(200);
});
it("fails closed on image provider errors and preserves the file and retry task", async () => {
  await enabled();
  const r = await doc();
  unavailable = true;
  expect((await upload(r.id)).statusCode).toBe(503);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(asset.moderation_status).toBe("pending");
  expect(
    (await request("GET", `/assets/${asset.id}/content?audit=1`)).statusCode,
  ).toBe(200);
  expect(
    await db
      .selectFrom("projection_jobs")
      .selectAll()
      .where("id", "=", `moderation-image:${asset.id}`)
      .executeTakeFirst(),
  ).toBeTruthy();
  unavailable = false;
  await createModerationWorker(db, storage(), {
    fetch: cloud as typeof fetch,
  }).tick();
  expect(
    (await request("GET", `/assets/${asset.id}/content`, ownerCookie))
      .statusCode,
  ).toBe(200);
});
it("does not return stored secrets and only permits administrator configuration", async () => {
  await enabled();
  const response = await request("GET", "/admin/moderation/settings");
  expect(response.body).not.toContain('"test-secret"');
  expect(response.json().secretKeyConfigured).toBe(true);
  expect(
    (await request("GET", "/admin/moderation/settings", readerCookie))
      .statusCode,
  ).toBe(403);
  const { secretKeyConfigured, provider, ...body } = response.json();
  body.delaySeconds = 90;
  expect(
    (await request("PUT", "/admin/moderation/settings", adminCookie, body))
      .statusCode,
  ).toBe(200);
  expect((await moderationConfig(db)).secretKey).toBe("test-secret");
});
it("sends all long Unicode content in valid bounded chunks to the fixed cloud endpoint", async () => {
  const input = "😀".repeat(21000),
    sent: string[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    expect(url).toBe("https://tms.tencentcloudapi.com");
    const data = JSON.parse(init.body);
    sent.push(Buffer.from(data.Content, "base64").toString());
    expect(init.headers.Authorization).toContain("TC3-HMAC-SHA256");
    return new Response(JSON.stringify({ Response: { Suggestion: "Pass" } }));
  });
  await createModerationProvider({ fetch: fetcher as typeof fetch }).text(
    await moderationConfig(db),
    input,
    "test-id",
  );
  expect(sent.length).toBe(3);
  expect(sent.every((s) => Array.from(s).length <= 10000)).toBe(true);
  expect(sent.join("").length).toBeGreaterThanOrEqual(input.length);
});
