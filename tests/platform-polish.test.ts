import { openTestDatabase as openDatabase } from "./database.js";
import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  Doc,
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
  createYjsAdapter,
} from "slatetsx-kit-editor/yjs";
import { DocaYjsDocument } from "@core/modules/documents/codecs/rich-runtime.js";
import { documentMentions } from "@core/modules/interactions/community.js";
import { userCardUrl } from "@core/modules/deployment/user-card.js";
import {} from "@db/index.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "../apps/server/src/app/create-app.js";

it("encodes user-card variables and rejects executable, credentialed and protocol-relative URLs", () => {
  expect(
    userCardUrl("https://example.com/u/{userId}?id={uid}", "张 三/a", "uuid"),
  ).toBe("https://example.com/u/%E5%BC%A0%20%E4%B8%89%2Fa?id=uuid");
  expect(userCardUrl("/users/{userId}", "a", "b")).toBe("/users/a");
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,test",
    "//evil.test",
    "/\\evil.test",
    "https://user:pass@host",
    "https://host/{unknown}",
  ])
    expect(userCardUrl(url, "a", "b")).toBeNull();
});

it("preserves host mention links through replicas, edits, checkpoints and comment anchors", () => {
  const a = new Doc(),
    b = new Doc(),
    ra = new DocaYjsDocument(a),
    rb = new DocaYjsDocument(b),
    uid = randomUUID();
  try {
    ra.initialize([
      {
        id: "p",
        type: "paragraph",
        children: [
          { text: "hello " },
          {
            id: "mention",
            type: "link",
            url: `#/u/${uid}`,
            children: [{ text: "@用户" }],
          },
          { text: " world" },
        ],
      },
    ]);
    applyUpdate(b, encodeStateAsUpdate(a), "remote");
    const anchor = ra.createCommentAnchor("p", 6, 9);
    ra.editText("p", 0, 0, "A");
    rb.editText("p", 12, 0, "B");
    const ua = encodeStateAsUpdate(a),
      ub = encodeStateAsUpdate(b);
    applyUpdate(a, ub, "remote");
    applyUpdate(b, ua, "remote");
    expect(ra.getValue()).toEqual(rb.getValue());
    expect(documentMentions(rb.getValue()).get("mention")).toBe(uid);
    const saved = new Doc();
    applyUpdate(saved, encodeStateAsUpdate(b));
    const rr = new DocaYjsDocument(saved);
    expect(rr.getValue()).toEqual(rb.getValue());
    expect(rr.resolveCommentAnchor(anchor).start).toBe(7);
    rr.destroy();
    saved.destroy();
    let writes = 0;
    a.on("update", () => writes++);
    for (let i = 0; i < 4; i++)
      applyUpdate(a, encodeStateAsUpdate(b, encodeStateVector(a)), "remote");
    expect(writes).toBe(0);
  } finally {
    ra.destroy();
    rb.destroy();
    a.destroy();
    b.destroy();
  }
});

it("preserves current atomic mention identities without writes during projection", () => {
  const doc = new Doc(),
    runtime = new DocaYjsDocument(doc),
    uid = randomUUID();
  runtime.initialize([
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "new " },
        {
          type: "custom:user-mention",
          id: "m",
          userId: uid,
          label: "User",
          children: [{ text: "" }],
        },
        { text: " tail" },
      ],
    },
  ]);
  let updates = 0;
  doc.on("update", () => updates++);
  const value = runtime.getValue();
  expect(JSON.stringify(value)).toContain("new ");
  expect(JSON.stringify(value)).toContain(" tail");
  expect(documentMentions(value).get("m")).toBe(uid);
  createYjsAdapter(runtime);
  expect(updates).toBe(0);
  runtime.destroy();
  doc.destroy();
});

it("limits library catalogue to owners and whole-library writers, not public readers or document-only grantees", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const owner = {
      ...(await createUser(
        db,
        {
          login: "owner",
          displayName: "Owner",
          password: "test-password-2026",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    const other = {
      ...(await createUser(
        db,
        {
          login: "other",
          displayName: "Other",
          password: "test-password-2026",
        },
        { actor: owner },
      )),
      admin: 0,
    };
    const service = createContent(db);
    const lib = await service.create(owner, {
      kind: "library",
      format: "rich_text",
      title: "Team",
    });
    const doc = await service.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Shared page",
      libraryId: lib.id,
    });
    await service.permissions(owner, doc.id, {
      version: doc.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: other.id, role: "editor" }],
    });
    expect(
      (await service.list(other, { scope: "libraries" })).items,
    ).toHaveLength(0);
    expect((await service.list(other, { scope: "shared" })).items).toHaveLength(
      1,
    );
    await service.visit(other, doc.id);
    expect((await service.list(other, { scope: "shared" })).items).toHaveLength(
      1,
    );
    await db
      .insertInto("resource_collections")
      .values({
        resource_id: doc.id,
        resource_kind: "document",
        user_id: other.id,
        created_at: new Date().toISOString(),
      })
      .execute();
    expect(
      (
        await service.list(other, { scope: "shared", kind: "document" })
      ).items.map((x) => x.id),
    ).toContain(doc.id);
    await service.permissions(owner, lib.id, {
      version: lib.version,
      accessMode: "custom",
      visibility: "public",
      grants: [],
    });
    expect(
      (await service.list(other, { scope: "libraries" })).items,
    ).toHaveLength(0);
    const latest = await service.detail(owner, lib.id);
    await service.permissions(owner, lib.id, {
      version: latest.resource.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: other.id, role: "editor" }],
    });
    expect(
      (await service.list(other, { scope: "libraries" })).items.map(
        (x) => x.id,
      ),
    ).toEqual([lib.id]);
    await expect(
      service.comment(owner, lib.id, "no comments", null),
    ).rejects.toThrow("知识库本身不支持评论");
  } finally {
    await db.destroy();
  }
});

it("only administrators can change user-card configuration, with revision and URL validation", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const origin = "http://localhost:39130";
  const owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await createUser(
    db,
    { login: "other", displayName: "Other", password: "test-password-2026" },
    { actor: owner },
  );
  const app = await createApp(db, { origin });
  try {
    const login = async (login: string) =>
      String(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            headers: { origin, host: "localhost:39130" },
            payload: { login, password: "test-password-2026" },
          })
        ).headers["set-cookie"],
      ).split(";")[0]!;
    const admin = await login("owner"),
      other = await login("other");
    const config = {
      enabled: true,
      text: "打开人员主页",
      style: "link",
      url: "https://example.com/u/{userId}",
      revision: 0,
    };
    const put = (cookie: string, payload: object) =>
      app.inject({
        method: "PUT",
        url: "/api/v1/admin/user-card-settings",
        headers: { origin, cookie, host: "localhost:39130" },
        payload,
      });
    expect((await put(other, config)).statusCode).toBe(403);
    expect(
      (await put(admin, { ...config, url: "javascript:alert(1)" })).statusCode,
    ).toBe(400);
    expect((await put(admin, config)).statusCode).toBe(200);
    expect((await put(admin, config)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          url: "/api/v1/user-card-settings",
          headers: { host: "localhost:39130" },
        })
      ).json(),
    ).toMatchObject({ ...config, revision: 1 });
  } finally {
    await app.close();
    await db.destroy();
  }
});
