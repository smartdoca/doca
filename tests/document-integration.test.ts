import { openTestDatabase as openDatabase } from "./database.js";
import { it, expect } from "vitest";
import { createEditor, Editor, Node, Transforms } from "slate";
import { withHistory, HistoryEditor } from "slate-history";
import {} from "@db/index.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { notificationPage } from "@core/modules/interactions/community.js";
import { createDocuments, b64, unb64 } from "./editor-client.js";
import { distributionDefaults } from "@core/modules/deployment/policies.js";
import {
  indexDocumentReferences,
  documentReferenceIds,
} from "@core/modules/documents/references.js";
import {
  richTextMatches,
  replaceRichText,
} from "../apps/web/src/features/search/rich-text-search.js";

import { Doc, encodeStateAsUpdate, applyUpdate } from "slatetsx-kit-editor/yjs";
import { DocaYjsDocument } from "@core/modules/documents/codecs/rich-runtime.js";

it("finds across formatted leaves, replaces backwards with undo, excluding atomic references", () => {
  const e = withHistory(createEditor());
  e.isInline = (n) => n.type === "link";
  e.isVoid = (n) => n.type === "link" && n.url.startsWith("#/r/");
  e.children = [
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "ab", bold: true },
        { text: "c abc " },
        {
          id: "ref",
          type: "link",
          url: "#/r/11111111-1111-4111-8111-111111111111",
          children: [{ text: "abc" }],
        },
        { text: " end" },
      ],
    },
    {
      id: "code",
      type: "code-block",
      code: "abc abc",
      children: [{ text: "" }],
    },
  ];
  expect(richTextMatches(e, "abc")).toHaveLength(4);
  const original = structuredClone(e.children);
  HistoryEditor.withNewBatch(e, () =>
    expect(replaceRichText(e, "abc", "x", true)).toBe(4),
  );
  expect(Node.string(e.children[0]!)).toBe("x x abc end");
  expect((e.children[1] as { code: string }).code).toBe("x x");
  e.undo();
  expect(e.children).toEqual(original);
});

it("internal document links are atomic to backspace and survive CRDT roundtrip", () => {
  const e = createEditor();
  e.isInline = (n) => n.type === "link";
  e.isVoid = (n) => n.type === "link" && n.url.startsWith("#/r/");
  e.children = [
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "before " },
        {
          id: "ref",
          type: "link",
          url: "#/r/11111111-1111-4111-8111-111111111111",
          children: [{ text: "immutable title" }],
        },
        { text: " after" },
      ],
    },
  ];
  Editor.normalize(e, { force: true });
  expect(Node.string(e.children[0]!)).toBe("before immutable title after");
  const a = new Doc(),
    b = new Doc(),
    ra = new DocaYjsDocument(a),
    rb = new DocaYjsDocument(b);
  try {
    ra.initialize(e.children as any);
    applyUpdate(b, encodeStateAsUpdate(a));
    expect(documentReferenceIds(rb.getValue())).toEqual(
      new Set(["11111111-1111-4111-8111-111111111111"]),
    );
    Transforms.select(e, { path: [0, 2], offset: 0 });
    e.deleteBackward("character");
    expect(Node.string(e.children[0]!)).toBe("before  after");
  } finally {
    ra.destroy();
    rb.destroy();
    a.destroy();
    b.destroy();
  }
});

it("separates invitation access, direct sharing, library discovery and permission-filtered reference edges", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const member = {
    ...(await createUser(
      db,
      {
        login: "member",
        displayName: "Member",
        password: "test-password-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  const outsider = {
    ...(await createUser(
      db,
      {
        login: "outsider",
        displayName: "Outsider",
        password: "test-password-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  const s = createContent(db),
    origin = "http://localhost",
    app = await createApp(db, { origin });
  const login = async (login: string) =>
    String(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { host: "localhost", origin },
          payload: { login, password: "test-password-2026" },
        })
      ).headers["set-cookie"],
    ).split(";")[0]!;
  const cookie = await login("member"),
    adminCookie = await login("owner");
  try {
    const lib = await s.create(owner, {
      kind: "library",
      format: "rich_text",
      title: "Library",
    });
    const doc = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Direct",
      libraryId: lib.id,
    });
    const inherited = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Inherited",
      libraryId: lib.id,
    });
    await db
      .updateTable("distribution_settings")
      .set({
        config: JSON.stringify({
          ...distributionDefaults,
          grantMode: "invite",
        }),
      })
      .execute();
    await s.permissions(owner, lib.id, {
      version: lib.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: member.id, role: "editor" }],
    });
    expect(
      (await notificationPage(db, member, 0)).items.map((n) => n.type),
    ).toEqual(["resource.invited"]);
    await expect(s.detail(member, lib.id)).rejects.toThrow();
    expect((await s.list(member, { scope: "libraries" })).items).toHaveLength(
      0,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/me/invitations/${lib.id}`,
      headers: { host: "localhost", origin, cookie },
      payload: {
        accept: true,
        version: (
          await db
            .selectFrom("access_invitations")
            .select("version")
            .where("resource_id", "=", lib.id)
            .where("user_id", "=", member.id)
            .executeTakeFirstOrThrow()
        ).version,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await s.list(member, { scope: "libraries" })).items.map((x) => x.id),
    ).toEqual([lib.id]);
    expect((await s.detail(member, inherited.id)).resource.role).toBe("editor");
    await s.visit(member, inherited.id);
    expect((await s.list(member, { scope: "shared" })).items).toHaveLength(2);
    await db
      .updateTable("distribution_settings")
      .set({ config: JSON.stringify(distributionDefaults) })
      .execute();
    await s.permissions(owner, doc.id, {
      version: doc.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: member.id, role: "reader" }],
    });
    expect((await s.list(member, { scope: "shared" })).items).toHaveLength(2);
    await s.visit(member, doc.id);
    expect((await s.list(member, { scope: "shared" })).items).toHaveLength(2);
    const accepted = await app.inject({
      method: "PUT",
      url: `/api/v1/me/entries/${doc.id}`,
      headers: { host: "localhost", origin, cookie },
      payload: { state: "joined" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      (await s.list(member, { scope: "shared" })).items.map((x) => x.id).sort(),
    ).toEqual([doc.id, inherited.id].sort());
    const secret = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Secret",
    });
    await db
      .updateTable("distribution_settings")
      .set({
        config: JSON.stringify({
          ...distributionDefaults,
          grantMode: "invite",
        }),
      })
      .execute();
    await s.permissions(owner, secret.id, {
      version: secret.version,
      accessMode: "custom",
      visibility: "invited",
      grants: [{ userId: outsider.id, role: "reader" }],
    });
    const outsiderCookie = await login("outsider");
    expect(
      (await notificationPage(db, outsider, 0)).items.map((n) => n.type),
    ).toEqual(["resource.invited"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/me/invitations/${secret.id}`,
          headers: { host: "localhost", origin, cookie: outsiderCookie },
          payload: {
            accept: false,
            version: (
              await db
                .selectFrom("access_invitations")
                .select("version")
                .where("resource_id", "=", secret.id)
                .where("user_id", "=", outsider.id)
                .executeTakeFirstOrThrow()
            ).version,
          },
        })
      ).statusCode,
    ).toBe(200);
    const ticketHistory = await notificationPage(db, outsider, 0);
    expect(
      ticketHistory.items.every((n) => n.ticket_id && n.title !== "Secret"),
    ).toBe(true);
    expect(ticketHistory.unread).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/me/invitations/${secret.id}`,
          headers: { host: "localhost", origin, cookie: outsiderCookie },
          payload: { accept: true, version: 1 },
        })
      ).statusCode,
    ).toBe(409);
    await expect(s.detail(outsider, secret.id)).rejects.toThrow();
    const publicDoc = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Public",
    });
    await s.permissions(owner, publicDoc.id, {
      discoverable: true,
      version: publicDoc.version,
      accessMode: "custom",
      visibility: "public",
      grants: [],
    });
    await indexDocumentReferences(db, publicDoc.id, [
      { type: "link", url: `#/r/${secret.id}`, children: [{ text: "Secret" }] },
    ]);
    expect(
      (await s.references(owner, publicDoc.id)).outgoing.map((x) => x.id),
    ).toEqual([secret.id]);
    expect((await s.references(outsider, publicDoc.id)).outgoing).toEqual([]);
    expect((await s.references(null, publicDoc.id)).outgoing).toEqual([]);
    const anon = await app.inject({
      url: `/api/v1/resources/${publicDoc.id}/references`,
      headers: { host: "localhost" },
    });
    expect(anon.statusCode, anon.body).toBe(200);
    expect((await s.list(outsider, { scope: "shared" })).items).toEqual([]);
    expect(
      (await s.list(outsider, { scope: "all", q: "Public" })).items,
    ).toEqual([]);
    await db
      .updateTable("distribution_settings")
      .set({
        config: JSON.stringify({
          ...distributionDefaults,
          publicDiscovery: true,
        }),
      })
      .execute();
    expect(
      (await s.list(outsider, { scope: "discover", q: "Public" })).items.map(
        (x) => x.id,
      ),
    ).toEqual([publicDoc.id]);
    const currentLib = await s.detail(owner, lib.id);
    await s.permissions(owner, lib.id, {
      version: currentLib.resource.version,
      accessMode: "custom",
      visibility: "public",
      grants: [],
    });
    expect((await s.list(outsider, { scope: "libraries" })).items).toHaveLength(
      0,
    );
    const config = {
      ...distributionDefaults,
      publicLibraries: true,
      revision: 0,
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/distribution",
          headers: { host: "localhost", origin, cookie },
          payload: config,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/distribution",
          headers: { host: "localhost", origin, cookie: adminCookie },
          payload: config,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/admin/distribution",
          headers: { host: "localhost", origin, cookie: adminCookie },
          payload: config,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await s.list(outsider, { scope: "libraries" })).items.map((x) => x.id),
    ).toEqual([]);
  } finally {
    await app.close();
    await db.destroy();
  }
});

it("maintains and backfills reference edges from persisted CRDT without changing document sequence", async () => {
  const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const s = createContent(db),
    d = createDocuments(db);
  const source = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Source",
    }),
    target = await s.create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Target",
    });
  const doc = new Doc(),
    rt = new DocaYjsDocument(doc);
  try {
    applyUpdate(doc, unb64((await d.exchange(owner, source.id, {})).update));
    const old = rt.getValue(),
      next = structuredClone(old);
    (next[1] as any).children = [
      { text: "" },
      {
        id: "ref",
        type: "link",
        url: `#/r/${target.id}`,
        children: [{ text: "Target" }],
      },
      { text: "" },
    ];
    rt.acceptEditorValue(old, next);
    const written = await d.exchange(owner, source.id, {
      update: b64(encodeStateAsUpdate(doc)),
    });
    expect(
      (await s.references(owner, target.id)).incoming.map((x) => x.id),
    ).toEqual([source.id]);
    await db.deleteFrom("document_references").execute();
    await db.deleteFrom("document_reference_index").execute();
    expect(
      (await s.references(owner, source.id)).outgoing.map((x) => x.id),
    ).toEqual([target.id]);
    expect((await d.exchange(owner, source.id, {})).seq).toBe(written.seq);
    const before = rt.getValue(),
      after = structuredClone(before);
    (after[1] as any).children = [{ text: "removed" }];
    rt.acceptEditorValue(before, after);
    await d.exchange(owner, source.id, {
      update: b64(encodeStateAsUpdate(doc)),
    });
    expect((await s.references(owner, target.id)).incoming).toEqual([]);
  } finally {
    rt.destroy();
    doc.destroy();
    await db.destroy();
  }
});
