import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { type DB } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createDocuments, b64, unb64 } from "./editor-client.js";
import {
  visibleUsers,
  notificationPage,
  normalizeComment,
  type CommentBody,
} from "@core/modules/interactions/community.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  Doc,
  YjsDocument,
  applyUpdate,
  encodeStateAsUpdate,
} from "slatetsx-kit-editor/yjs";
import { composeComment } from "../apps/web/src/features/comments/comment-body.js";
let db: DB,
  owner: Actor,
  bob: Actor,
  outsider: Actor,
  content: ReturnType<typeof createContent>;
const password = "community-test-password";
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "owner",
        publicId: "owner.custom",
        displayName: "Owner",
        password,
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  bob = {
    ...(await createUser(
      db,
      { login: "bobby", publicId: "bob.custom", displayName: "Bob", password },
      { actor: owner },
    )),
    admin: 0,
  };
  outsider = {
    ...(await createUser(
      db,
      { login: "outsider", displayName: "Outsider", password },
      { actor: owner },
    )),
    admin: 0,
  };
  content = createContent(db);
});
afterEach(async () => {
  await db.destroy();
});
const resource = (
  kind: "document" | "library" = "document",
  libraryId?: string,
) =>
  content.create(owner, {
    kind,
    format: "rich_text",
    title: "Private",
    ...(libraryId ? { libraryId } : {}),
  });
async function grant(
  id: string,
  users: Actor[] = [bob],
  visibility: "invited" | "public" = "invited",
) {
  const r = (await content.detail(owner, id)).resource;
  await content.permissions(owner, id, {
    version: r.version,
    visibility,
    accessMode: "custom",
    grants: users.map((u) => ({ userId: u.id, role: "commenter" as const })),
  });
}
const rich = (...users: Actor[]): CommentBody => ({
  version: 1,
  blocks: [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Hello " },
        ...users.map((u) => ({
          type: "mention" as const,
          userId: u.id,
          label: "forged",
        })),
      ],
    },
  ],
});
it("assigns normalized unique public IDs and rejects collisions without merging users", async () => {
  expect(
    (
      await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", owner.id)
        .executeTakeFirstOrThrow()
    ).public_id,
  ).toBe("owner.custom");
  await expect(
    createUser(
      db,
      {
        login: "different",
        publicId: "OWNER.CUSTOM",
        displayName: "Other",
        password,
      },
      { actor: owner },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await visibleUsers(db, owner, "BOB.")).map((u) => u.id)).toEqual([
    bob.id,
  ]);
  expect(await visibleUsers(db, owner, "%")).toEqual([]);
  expect(
    (await visibleUsers(db, owner, "bob.custom")).map((u) => u.id),
  ).toEqual([bob.id]);
});
it("related directory includes inherited explicit library permissions, not public documents, and respects overrides", async () => {
  const lib = await resource("library");
  await grant(lib.id);
  await resource("document", lib.id);
  const pub = await resource();
  await grant(pub.id, [], "public");
  await db.updateTable("settings").set({ directory_mode: "related" }).execute();
  expect((await visibleUsers(db, bob, "")).map((u) => u.id).sort()).toEqual(
    [bob.id, owner.id].sort(),
  );
  expect(await visibleUsers(db, outsider, "")).toEqual([]);
  await db
    .updateTable("users")
    .set({ directory_mode: "none" })
    .where("id", "=", bob.id)
    .execute();
  expect(await visibleUsers(db, bob, "")).toEqual([]);
  await db
    .updateTable("users")
    .set({ directory_mode: "all" })
    .where("id", "=", bob.id)
    .execute();
  expect(await visibleUsers(db, bob, "")).toHaveLength(3);
  await db
    .updateTable("users")
    .set({ directory_mode: null })
    .where("id", "=", bob.id)
    .execute();
  await grant(lib.id, []);
  expect(await visibleUsers(db, bob, "")).toEqual([]);
});
it("cannot bypass directory restrictions by posting arbitrary user IDs for permissions or mentions", async () => {
  const r = await resource();
  await grant(r.id);
  await db
    .updateTable("users")
    .set({ directory_mode: "none" })
    .where("id", "=", owner.id)
    .execute();
  await expect(grant(r.id, [bob, outsider])).rejects.toMatchObject({
    status: 403,
  });
  await grant(r.id, [bob]); // Existing grants remain editable.
  await expect(
    content.comment(owner, r.id, "", null, undefined, rich(bob)),
  ).rejects.toMatchObject({ status: 403 });
});
it("stores structured comments, canonicalizes mentions, and only notifies recipients with access", async () => {
  const r = await resource();
  await grant(r.id);
  await content.comment(
    owner,
    r.id,
    "",
    null,
    undefined,
    rich(bob, outsider, owner),
  );
  const [c] = (await content.detail(owner, r.id)).comments;
  expect(JSON.parse(c!.body_json!).blocks[0].children[1]).toMatchObject({
    label: "Bob",
    publicId: "bob.custom",
  });
  const n = await notificationPage(db, bob, 0);
  expect(n.items.filter((x) => x.type === "comment.mentioned")).toHaveLength(1);
  expect(n.items.find((x) => x.type === "comment.mentioned")).toMatchObject({
    comment_id: c!.id,
    actor_id: owner.id,
    title: "Private",
  });
  expect((await notificationPage(db, outsider, 0)).unread).toBe(0);
  expect((await notificationPage(db, owner, 0)).unread).toBe(0);
  await content.updateComment(owner, r.id, c!.id, {
    version: c!.version,
    richBody: rich(bob, outsider, owner),
  });
  expect(
    (await notificationPage(db, bob, 0)).items.filter(
      (x) => x.type === "comment.mentioned",
    ),
  ).toHaveLength(1);
});
it("notifies owner once when mentioned in a comment, deduplicates repeated reactions, and hides revoked notifications", async () => {
  const r = await resource();
  await grant(r.id);
  await content.comment(bob, r.id, "", null, undefined, rich(owner));
  expect(
    (await notificationPage(db, owner, 0)).items.map((n) => n.type),
  ).toEqual(["comment.mentioned"]);
  for (const kind of ["like", "favorite"] as const) {
    await content.reaction(bob, r.id, kind, true);
    await content.reaction(bob, r.id, kind, true);
  }
  expect(
    (await notificationPage(db, owner, 0)).items.map((n) => n.type).sort(),
  ).toEqual(["comment.mentioned", "favorite.added", "like.added"]);
  await grant(r.id, []);
  expect(await notificationPage(db, bob, 0)).toEqual({
    items: [],
    unread: 0,
    nextOffset: null,
  });
});
it("validates comment images against their resource and image purpose; retains plain comment compatibility", async () => {
  const r = await resource(),
    other = await resource(),
    assetId = randomUUID();
  // Reference-only metadata fixture; no filesystem writes or private assets.
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("assets")
    .values({
      id: assetId,
      owner_id: owner.id,
      resource_id: r.id,
      purpose: "comment_image",
      profile_id: profile.id,
      object_key: "test.png",
      filename: "test.png",
      mime: "image/png",
      size: 20,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  const image: CommentBody = {
    version: 1,
    blocks: [{ type: "image", assetId, alt: "forged" }],
  };
  expect(
    (await normalizeComment(db, owner, r.id, image, "")).body.blocks[0],
  ).toMatchObject({ alt: "test.png" });
  await expect(
    normalizeComment(db, owner, other.id, image, ""),
  ).rejects.toMatchObject({ status: 400 });
  await db
    .updateTable("assets")
    .set({ mime: "text/html" })
    .where("id", "=", assetId)
    .execute();
  await expect(
    normalizeComment(db, owner, r.id, image, ""),
  ).rejects.toMatchObject({ status: 400 });
  await content.comment(owner, r.id, "legacy plain text", null);
  expect((await content.detail(owner, r.id)).comments[0]!.body).toBe(
    "legacy plain text",
  );
});
it("document mentions notify once per new mention node after durable updates, including a second mention of the same user", async () => {
  const r = await resource();
  await grant(r.id);
  const documents = createDocuments(db),
    doc = new Doc(),
    runtime = new YjsDocument(doc);
  try {
    applyUpdate(doc, unb64((await documents.exchange(owner, r.id, {})).update));
    const add = (key: string, u: Actor) =>
      runtime.execute({
        type: "insertBlock",
        block: {
          id: key,
          type: "paragraph",
          children: [
            { text: "Hello " },
            {
              id: key + "-mention",
              type: "link",
              url: `#/u/${u.id}`,
              children: [{ text: `@${u.display_name}` }],
            },
            { text: "!" },
          ],
        },
      });
    const first = add("first", bob);
    await documents.exchange(owner, r.id, { update: b64(first) });
    await documents.exchange(owner, r.id, { update: b64(first) });
    await documents.exchange(owner, r.id, { update: b64(add("second", bob)) });
    await documents.exchange(owner, r.id, {
      update: b64(add("third", outsider)),
    });
    expect(
      (await notificationPage(db, bob, 0)).items.filter(
        (n) => n.type === "document.mentioned",
      ),
    ).toHaveLength(2);
    expect((await notificationPage(db, outsider, 0)).items).toHaveLength(0);
    expect(
      (
        await documents.exchange(owner, r.id, {
          update: b64(encodeStateAsUpdate(doc)),
        })
      ).changed,
    ).toBe(false);
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});
it("HTTP directory policy requires admin, lookup follows policy, and read receipts only update the caller's notifications", async () => {
  const app = await createApp(db, { origin: "http://localhost:39130" });
  const request = (
    method: "GET" | "POST" | "PUT",
    path: string,
    cookie = "",
    payload?: object,
  ) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: {
        host: "localhost:39130",
        origin: "http://localhost:39130",
        cookie,
      },
      ...(payload ? { payload } : {}),
    });
  try {
    const login = async (login: string) =>
      String(
        (await request("POST", "/auth/login", "", { login, password })).headers[
          "set-cookie"
        ],
      ).split(";")[0]!;
    const ac = await login("owner.custom"),
      bc = await login("bob.custom");
    const policy = (await request("GET", "/admin/directory-policy", ac)).json();
    expect(
      (
        await request("PUT", "/admin/directory-policy", bc, {
          mode: "none",
          revision: policy.revision,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/admin/directory-policy", ac, {
          mode: "none",
          revision: policy.revision,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", "/users/lookup?q=owner.custom", bc)).json().items,
    ).toEqual([]);
    expect((await request("GET", "/me", ac)).json().user.public_id).toBe(
      "owner.custom",
    );
    await db.updateTable("settings").set({ directory_mode: "all" }).execute();
    const r = await resource();
    await grant(r.id);
    const n = (await notificationPage(db, bob, 0)).items[0]!;
    await request("POST", "/notifications/read", ac, { ids: [n.id] });
    expect((await notificationPage(db, bob, 0)).unread).toBe(1);
    await request("POST", "/notifications/read", bc, { ids: [n.id] });
    expect((await notificationPage(db, bob, 0)).unread).toBe(0);
    await content.comment(
      owner,
      r.id,
      "another notification",
      null,
      undefined,
      rich(bob),
    );
    await content.reaction(bob, r.id, "like", true);
    expect((await notificationPage(db, bob, 0)).unread).toBe(1);
    expect((await notificationPage(db, owner, 0)).unread).toBe(1);
    expect(
      (await request("POST", "/notifications/read-all", bc, {})).statusCode,
    ).toBe(200);
    expect((await notificationPage(db, bob, 0)).unread).toBe(0);
    expect((await notificationPage(db, owner, 0)).unread).toBe(1);
  } finally {
    await app.close();
  }
});
it("pins documents without notifying the owner and drops them when unpinned", async () => {
  const first = await resource();
  const second = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Later",
  });
  const library = await resource("library");
  await expect(content.reaction(owner, library.id, "pin", true)).rejects.toThrow(
    /只能置顶文档/,
  );
  await grant(first.id);
  await content.reaction(owner, first.id, "pin", true);
  await content.reaction(bob, first.id, "favorite", true);
  await content.reaction(bob, first.id, "pin", true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await content.reaction(owner, second.id, "pin", true);
  expect(
    (await content.list(owner, { scope: "pins" })).items.map((item) => item.id),
  ).toEqual([second.id, first.id]);
  const pinned = await content.list(bob, { scope: "pins" });
  expect(pinned.items.map((item) => item.id)).toEqual([first.id]);
  expect(pinned.items[0]).toMatchObject({ pinned: true, favorite: true });
  expect((await content.detail(bob, first.id)).pinned).toBe(true);
  const types = (await notificationPage(db, owner, 0)).items.map((item) => item.type);
  expect(types).toContain("favorite.added");
  expect(types).not.toContain("pin.added");
  await content.reaction(bob, first.id, "pin", false);
  expect((await content.list(bob, { scope: "pins" })).items).toEqual([]);
  expect((await content.detail(bob, first.id)).pinned).toBe(false);
});
it("comment tokenization never converts partial IDs or ordinary email text into a mention", () => {
  const mention = {
    type: "mention" as const,
    userId: "u",
    label: "Ann",
    publicId: "ann",
  };
  const body = composeComment("email@ann @anna @ann hello", {
    "@ann": mention,
  });
  expect(body.blocks).toEqual([
    {
      type: "paragraph",
      children: [
        { type: "text", text: "email@ann @anna " },
        mention,
        { type: "text", text: " hello" },
      ],
    },
  ]);
});
