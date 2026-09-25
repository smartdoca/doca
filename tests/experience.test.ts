import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { type DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createExperience } from "@core/workflows/experience.js";
import {
  createDocuments,
  documentAccess,
  unb64,
  b64,
} from "./editor-client.js";
import {
  Doc,
  YjsDocument,
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
} from "slatetsx-kit-editor/yjs";
import { createApp } from "../apps/server/src/app/create-app.js";
import { internalDocumentId } from "../apps/web/src/features/documents/internal-document-id.js";
let db: DB,
  owner: Actor,
  guest: Actor,
  content: ReturnType<typeof createContent>,
  service: ReturnType<typeof createExperience>;
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  guest = {
    ...(await createUser(
      db,
      { login: "guest", displayName: "Guest", password: "test-password-2026" },
      { actor: owner },
    )),
    admin: 0,
  };
  content = createContent(db);
  service = createExperience(db);
});
afterEach(() => db.destroy());
it("persists spreadsheet registers and rejects a different epoch", async () => {
  const r = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "表格",
  });
  const docs = createDocuments(db),
    initial = await docs.exchange(owner, r.id, {}),
    doc = new Doc();
  try {
    applyUpdate(doc, unb64(initial.update));
    const vector = encodeStateVector(doc),
      baseline = (initial as any).baseline;
    doc
      .getMap("exlsx:identity-cells")
      .set(
        JSON.stringify([
          baseline.snapshot.sheetOrder[0],
          "b:0",
          "b:0",
          "content",
        ]),
        {
          v: "Hello",
          f: null,
          p: null,
          t: null,
          si: null,
        },
      );
    const update = b64(encodeStateAsUpdate(doc, vector));
    await expect(
      docs.exchange(owner, r.id, { update, epochId: randomUUID() }),
    ).rejects.toThrow("谱系");
    const saved = await docs.exchange(owner, r.id, { update });
    expect(saved.seq).toBe(1);
    expect((await docs.exchange(owner, r.id, { update })).changed).toBe(false);
    doc.getMap("exlsx:metadata").set("workbookId", randomUUID());
    await expect(
      docs.exchange(owner, r.id, { update: b64(encodeStateAsUpdate(doc)) }),
    ).rejects.toThrow();
    await content.permissions(owner, r.id, {
      version: (await content.detail(owner, r.id)).resource.version,
      accessMode: "custom",
      visibility: "public",
      grants: [],
    });
    expect((await docs.exchange(null, r.id, {})).rank).toBe(1);
    await expect(docs.exchange(null, r.id, { update })).rejects.toThrow("只读");
  } finally {
    doc.destroy();
  }
});
it("counts at most one document visit per site-local day", async () => {
  const r = await create();
  await db
    .updateTable("settings")
    .set({ default_timezone: "America/Los_Angeles" })
    .where("id", "=", "system")
    .execute();
  await content.visit(owner, r.id, new Date("2026-09-11T06:00:00Z"));
  await content.visit(owner, r.id, new Date("2026-09-11T06:30:00Z"));
  await content.visit(owner, r.id, new Date("2026-09-11T07:01:00Z"));
  expect(
    await db
      .selectFrom("visit_events")
      .selectAll()
      .where("resource_id", "=", r.id)
      .execute(),
  ).toHaveLength(2);
});
it("stores rich-text page width on the document record", async () => {
  const r = await create();
  expect(r.page_width ?? "a4").toBe("a4");
  const saved = await content.setPageWidth(owner, r.id, "a3", r.version);
  expect(saved).toEqual({ ok: true, version: r.version + 1, pageWidth: "a3" });
  expect((await content.detail(owner, r.id)).resource.page_width).toBe("a3");
  expect(await service.info(owner, r.id, "stats")).toMatchObject({
    pageWidth: "a3",
    words: expect.any(Number),
    images: expect.any(Number),
    attachments: expect.any(Number),
  });
  const sheet = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "表格",
  });
  await expect(
    content.setPageWidth(owner, sheet.id, "fluid", sheet.version),
  ).rejects.toThrow("富文本");
  await expect(
    content.setPageWidth(guest, r.id, "fluid", saved.version),
  ).rejects.toThrow();
});
it("restores historical content as a new Yjs update with a stale-preview guard", async () => {
  const r = await create(),
    docs = createDocuments(db),
    doc = new Doc(),
    runtime = new YjsDocument(doc);
  try {
    applyUpdate(doc, unb64((await docs.exchange(owner, r.id, {})).update));
    const block = runtime.getValue()[0]! as any;
    await docs.exchange(owner, r.id, {
      update: b64(runtime.editText(block.id, 0, 0, "原始标题")),
    });
    const snap = await service.snapshot(owner, r.id);
    const preview = await service.version(owner, r.id, snap.id);
    await docs.exchange(owner, r.id, {
      update: b64(runtime.editText(block.id, 0, 4, "现在标题")),
    });
    await expect(
      docs.exchange(owner, r.id, {
        restoreVersion: snap.id,
        expectedSeq: preview.currentSeq,
      }),
    ).rejects.toThrow("预览后已变化");
    const latest = await service.version(owner, r.id, snap.id);
    await expect(
      docs.exchange(guest, r.id, {
        restoreVersion: snap.id,
        expectedSeq: latest.currentSeq,
      }),
    ).rejects.toThrow();
    const result = await docs.exchange(owner, r.id, {
      restoreVersion: snap.id,
      expectedSeq: latest.currentSeq,
    });
    applyUpdate(doc, unb64(result.update));
    expect((runtime.getValue()[0] as any).children[0].text).toBe("原始标题");
    expect((await content.detail(owner, r.id)).resource.title).toBe("原始标题");
    expect((await service.versions(owner, r.id)).items).toHaveLength(2);
    await docs.exchange(owner, r.id, {
      update: b64(runtime.editText(block.id, 4, 0, "继续编辑")),
    });
    expect((await content.detail(owner, r.id)).resource.title).toBe(
      "原始标题继续编辑",
    );
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});
it("normalizes only same-origin document links", () => {
  const id = randomUUID();
  expect(
    internalDocumentId(
      `https://docs.example/#/r/${id}?comment=${randomUUID()}`,
      "https://docs.example",
    ),
  ).toBe(id);
  expect(internalDocumentId(`#/r/${id}`, "https://docs.example")).toBe(id);
  expect(
    internalDocumentId(
      `https://evil.example/#/r/${id}`,
      "https://docs.example",
    ),
  ).toBeNull();
  expect(
    internalDocumentId(`javascript:alert(1)`, "https://docs.example"),
  ).toBeNull();
});
it("disconnects an open collaboration socket when its only link permission is revoked", async () => {
  const r = await create(),
    link = await service.setShare(owner, r.id, {
      enabled: true,
      role: "reader",
      version: null,
    });
  await service.redeem(guest, link.token!);
  const app = await createApp(db, { origin: "http://localhost:39130" });
  let ws: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    const login = async (name: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost:39130", origin: "http://localhost:39130" },
        payload: { login: name, password: "test-password-2026" },
      });
      return String(res.headers["set-cookie"]).split(";")[0]!;
    };
    const cookie = await login("guest"),
      ownerCookie = await login("owner");
    const headers = {
      host: "localhost:39130",
      origin: "http://localhost:39130",
      cookie,
    };
    ws = await app.injectWS("/api/v1/ws", {
      headers,
      rawHeaders: Object.entries(headers).flat(),
    });
    const synced = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(Error("sync timeout")), 2000);
      ws!.on("message", (message) => {
        if (JSON.parse(message.toString()).type === "sync-response") {
          clearTimeout(t);
          resolve();
        }
      });
    });
    ws.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "slate-kit",
        schemaVersion: 3,
        room: r.id,
        id: randomUUID(),
        vector: "AA==",
      }),
    );
    await synced;
    const closed = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(Error("revocation timeout")), 2000);
      ws!.once("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/resources/${r.id}/share-links/${link.id}/revoke`,
      headers: {
        host: "localhost:39130",
        origin: "http://localhost:39130",
        cookie: ownerCookie,
      },
      payload: { version: link.version },
    });
    expect(response.statusCode).toBe(200);
    expect(await closed).toBe(4403);
  } finally {
    ws?.close();
    await app.close();
  }
});
it("shows a share-link invitation before granting access when invitations require consent", async () => {
  const r = await create();
  const settings = await db
    .selectFrom("distribution_settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        ...JSON.parse(settings.config),
        resourcePolicies: { document: { grantMode: "invite" } },
      }),
      revision: settings.revision + 1,
    })
    .where("id", "=", "system")
    .execute();
  const link = await service.setShare(owner, r.id, {
    enabled: true,
    role: "reader",
    version: null,
  });
  const preview = await service.redeem(guest, link.token!, false);
  expect(preview).toMatchObject({ pending: true, id: r.id, title: "未命名" });
  await expect(documentAccess(db, guest, r.id)).rejects.toThrow();
  await service.redeem(guest, link.token!, true);
  expect((await documentAccess(db, guest, r.id)).rank).toBe(1);
});
const create = () =>
  content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "未命名",
  });
it("stopping link admission retains grants; explicit source revocation preserves other sources", async () => {
  const r = await create();
  let link = await service.setShare(owner, r.id, {
    enabled: true,
    role: "editor",
    version: null,
  });
  await service.redeem(guest, link.token!);
  link = await service.setShare(owner, r.id, {
    enabled: false,
    role: "editor",
    version: link.version,
  });
  expect((await documentAccess(db, guest, r.id)).rank).toBe(3);
  await expect(service.redeem(guest, "bad")).rejects.toThrow();
  await content.permissions(owner, r.id, {
    version: (await content.detail(owner, r.id)).resource.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: guest.id, role: "commenter" }],
  });
  await service.revokeShare(owner, r.id, link.id, link.version);
  expect((await documentAccess(db, guest, r.id)).rank).toBe(2);
});
it("inherits link access, protects custom children, and preserves explicit sources when moving", async () => {
  const library = await content.create(owner, {
      kind: "library",
      format: "rich_text",
      title: "Library",
    }),
    r = await content.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "未命名",
      libraryId: library.id,
    }),
    child = await content.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "child",
      parentId: r.id,
    });
  const link = await service.setShare(owner, r.id, {
    enabled: true,
    role: "editor",
    version: null,
  });
  await service.redeem(guest, link.token!);
  expect((await content.detail(guest, child.id)).resource.role).toBe("editor");
  await content.permissions(owner, child.id, {
    version: child.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [],
  });
  await expect(content.detail(guest, child.id)).rejects.toThrow();
  await content.move(owner, r.id, {
    version: (await content.detail(owner, r.id)).resource.version,
    parentId: null,
    libraryId: null,
  });
  expect((await content.detail(guest, r.id)).resource.role).toBe("editor");
});
it("persists immutable snapshots and derives title from the first line including empty titles", async () => {
  const r = await create(),
    docs = createDocuments(db);
  const first = await docs.exchange(owner, r.id, {}),
    doc = new Doc(),
    runtime = new YjsDocument(doc);
  applyUpdate(doc, unb64(first.update));
  try {
    const block = runtime.getValue()[0]! as any;
    expect(block.children[0].text).toBe("");
    const snapshot = await service.snapshot(owner, r.id);
    const bytes = runtime.editText(block.id, 0, 0, "新标题");
    await docs.exchange(owner, r.id, { update: b64(bytes) });
    expect((await content.detail(owner, r.id)).resource.title).toBe("新标题");
    expect(
      (await service.version(owner, r.id, snapshot.id)).text,
    ).not.toContain("新标题");
    const empty = runtime.editText(block.id, 0, 3, "");
    await docs.exchange(owner, r.id, { update: b64(empty) });
    expect((await content.detail(owner, r.id)).resource.title).toBe("未命名");
    await expect(service.version(guest, r.id, snapshot.id)).rejects.toThrow();
    const other = await create();
    await expect(
      service.version(owner, other.id, snapshot.id),
    ).rejects.toThrow();
    for (let i = 0; i < 48; i++)
      await docs.exchange(owner, r.id, {
        update: b64(runtime.editText(block.id, i, 0, "a")),
      });
    expect((await service.versions(owner, r.id)).items.length).toBeGreaterThan(
      1,
    );
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});
it("paginates liker identities and restricts visit and audit records to managers", async () => {
  const r = await create();
  await content.permissions(owner, r.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: guest.id, role: "reader" }],
  });
  await content.visit(guest, r.id);
  await content.visit(guest, r.id);
  await content.reaction(owner, r.id, "like", true);
  expect((await service.likes(guest, r.id)).items[0]!.id).toBe(owner.id);
  expect(((await service.info(guest, r.id, "stats")) as any).visits).toBe(1);
  await expect(service.info(guest, r.id, "visits")).rejects.toThrow();
  await expect(service.info(guest, r.id, "audit")).rejects.toThrow();
  expect(
    ((await service.info(owner, r.id, "visits")) as any).items,
  ).toHaveLength(1);
  const users = Array.from({ length: 101 }, (_, i) => ({
    id: randomUUID(),
    login: "liker" + i,
    display_name: "Liker " + i,
    password_hash: "not-used",
    admin: 0,
    status: "active",
    created_at: new Date().toISOString(),
  }));
  await db.insertInto("users").values(users).execute();
  await db
    .insertInto("reactions")
    .values(
      users.map((u) => ({
        resource_id: r.id,
        user_id: u.id,
        kind: "like" as const,
      })),
    )
    .execute();
  const page = await service.likes(owner, r.id);
  expect(page.total).toBe(102);
  expect(page.items).toHaveLength(100);
  expect(
    (await service.likes(owner, r.id, page.nextOffset!)).items,
  ).toHaveLength(2);
});
it("requires login and origin protection on share and snapshot HTTP mutations", async () => {
  const app = await createApp(db, { origin: "http://localhost:39130" });
  try {
    const r = await create();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/share/redeem",
      headers: { host: "localhost:39130", origin: "http://localhost:39130" },
      payload: { token: "x".repeat(43) },
    });
    expect(response.statusCode).toBe(401);
    const csrf = await app.inject({
      method: "POST",
      url: `/api/v1/resources/${r.id}/versions`,
      headers: { host: "localhost:39130", origin: "https://evil.example" },
    });
    expect(csrf.statusCode).toBe(403);
    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/resources/${r.id}/likes?offset=-1`,
      headers: { host: "localhost:39130" },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
