import { installTemplate } from "./creation-resource-fixtures.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  blankTemplateContent,
} from "@core/modules/templates/templates.js";
import {
  createPublicDocumentReads,
  createPublicLibraries,
} from "@core/modules/documents/public-read.js";
import {
  createDocuments,
  b64,
  unb64,
} from "@core/modules/collaboration/documents.js";
import { MARKDOWN_CODEC } from "@core/modules/documents/codecs/markdown.js";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import { createServerDocumentsCapability } from "@server/plugins/documents-capability-adapter.js";

let db: DB, admin: Actor, owner: Actor, outsider: Actor;
const context = (user: Actor): PluginRequestContext => ({
  requestId: "test",
  principal: {
    id: user.id,
    displayName: user.display_name,
    publicId: "",
    admin: !!user.admin,
  },
  signal: new AbortController().signal,
});
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  admin = {
    ...(await createUser(
      db,
      { login: "admin", displayName: "Admin", password: "public-read-admin" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "public-read-owner" },
      { actor: admin },
    )),
    admin: 0,
  };
  outsider = {
    ...(await createUser(
      db,
      {
        login: "outsider",
        displayName: "Outsider",
        password: "public-read-outsider",
      },
      { actor: admin },
    )),
    admin: 0,
  };
});
afterEach(() => db.destroy());
it.each([
  "markdown",
  "rich_text",
  "spreadsheet",
  "canvas",
  "presentation",
] as const)(
  "reads %s native content without creating commits, history or epochs",
  async (format) => {
    const content = createContent(db),
      service = createPublicDocumentReads(db);
    const native =
      format === "markdown"
        ? "# 中文\n\n" + "完整正文".repeat(20000)
        : format === "rich_text"
          ? [
              {
                id: randomUUID(),
                type: "paragraph",
                children: [{ text: "中文原始格式", bold: true }],
              },
            ]
          : blankTemplateContent(format);
    if (format === "spreadsheet") {
      const workbook = native as any;
      workbook.sheets[workbook.sheetOrder[0]].cellData = {
        0: { 0: { v: 42 }, 1: { f: "=A1*2", v: 84 } },
      };
    }
    const template = installTemplate(db, format, native);
    const doc = await content.create(owner, {
      kind: "document",
      format,
      title: "完整读取",
      template: template.selection,
    });
    const before = await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", doc.id)
      .executeTakeFirst();
    const epochs = await db.selectFrom("editor_epochs").selectAll().execute();
    const updates = await db
      .selectFrom("document_updates")
      .selectAll()
      .execute();
    const snap = await service.readSnapshot(context(owner), {
      documentId: doc.id,
    });
    expect(snap).toMatchObject({
      documentId: doc.id,
      format,
      seq: before!.seq,
    });
    expect(snap.revision).toMatch(/^[a-f0-9]{64}$/);
    if (format === "markdown" || format === "rich_text")
      expect(snap.content).toEqual(native);
    else if (format === "spreadsheet")
      expect(JSON.stringify(snap.content)).toContain("=A1*2");
    else if (format === "canvas")
      expect(snap.content).toHaveProperty("scene.children");
    else expect(snap.content).toHaveProperty("slideOrder");
    expect(
      await service.readSnapshot(context(owner), {
        documentId: doc.id,
        expectedRevision: snap.revision,
      }),
    ).toEqual(snap);
    await expect(
      service.readSnapshot(context(owner), {
        documentId: doc.id,
        expectedRevision: "stale",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.readSnapshot(context(outsider), { documentId: doc.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db
        .selectFrom("document_states")
        .selectAll()
        .where("resource_id", "=", doc.id)
        .executeTakeFirst(),
    ).toEqual(before);
    expect(await db.selectFrom("editor_epochs").selectAll().execute()).toEqual(
      epochs,
    );
    expect(
      await db.selectFrom("document_updates").selectAll().execute(),
    ).toEqual(updates);
  },
);
it("reads persisted updates with a matching revision and rejects uninitialized/deleted documents and disabled principals", async () => {
  const content = createContent(db),
    service = createPublicDocumentReads(db),
    documents = createDocuments(db);
  const doc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Persisted",
  });
  await expect(
    service.readSnapshot(context(owner), { documentId: doc.id }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await db.selectFrom("document_states").selectAll().execute()).toEqual(
    [],
  );
  const baseline = await documents.exchange(owner, doc.id, MARKDOWN_CODEC);
  const initial = await service.readSnapshot(context(owner), {
    documentId: doc.id,
  });
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, unb64(baseline.update));
    const vector = Y.encodeStateVector(ydoc);
    ydoc.getText("markdown").insert(0, "新正文和图片");
    await documents.exchange(owner, doc.id, {
      ...MARKDOWN_CODEC,
      epochId: baseline.epochId,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(ydoc, vector)),
    });
  } finally {
    ydoc.destroy();
  }
  const saved = await service.readSnapshot(context(owner), {
    documentId: doc.id,
  });
  expect(saved.content).toBe("新正文和图片" + initial.content);
  expect(saved.revision).not.toBe(initial.revision);
  await expect(
    service.readSnapshot(context(owner), {
      documentId: doc.id,
      expectedRevision: initial.revision,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .updateTable("resources")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", doc.id)
    .execute();
  await expect(
    service.get(context(owner), { documentId: doc.id }),
  ).rejects.toMatchObject({ status: 404 });
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", owner.id)
    .execute();
  await expect(
    service.get(context(owner), { documentId: doc.id }),
  ).rejects.toMatchObject({ status: 401 });
});
it("traverses only direct library children, validates parents, and respects library access", async () => {
  const content = createContent(db),
    libraries = createPublicLibraries(db);
  const library = await content.create(owner, {
    kind: "library",
    format: "rich_text",
    title: "Library",
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Child",
    libraryId: library.id,
  });
  const grandchild = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Grandchild",
    libraryId: library.id,
    parentId: child.id,
  });
  const unrelated = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Other",
  });
  expect(
    (await libraries.list(context(owner), {})).items.map((row) => row.id),
  ).toContain(library.id);
  expect(
    (
      await libraries.children(context(owner), {
        libraryId: library.id,
        parentId: null,
      })
    ).items.map((row) => row.id),
  ).toEqual([child.id]);
  expect(
    (
      await libraries.children(context(owner), {
        libraryId: library.id,
        parentId: child.id,
      })
    ).items.map((row) => row.id),
  ).toEqual([grandchild.id]);
  expect(
    (await libraries.path(context(owner), { resourceId: grandchild.id })).map(
      (row) => row.id,
    ),
  ).toEqual([library.id, child.id, grandchild.id]);
  await expect(
    libraries.children(context(owner), {
      libraryId: library.id,
      parentId: unrelated.id,
    }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    libraries.children(context(outsider), {
      libraryId: library.id,
      parentId: null,
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it("does not prematurely stop resource pagination after a large invisible prefix", async () => {
  const content = createContent(db);
  const sample = await content.create(outsider, {
    kind: "document",
    format: "markdown",
    title: "Hidden",
  });
  const row = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", sample.id)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("resources")
    .values(
      Array.from({ length: 240 }, (_, i) => ({
        ...row,
        id: `a${String(i).padStart(4, "0")}`,
      })),
    )
    .execute();
  await db
    .insertInto("resources")
    .values({ ...row, id: "zz-visible", owner_id: owner.id })
    .execute();
  const unavailable = async () => {
    throw new Error("Unused file method");
  };
  const { createFilesProviderV1 } =
    await import("../packages/files-capability/src/index.js");
  const files = createFilesProviderV1({
    receipts: { get: unavailable },
    folders: {
      create: unavailable,
      get: unavailable,
      list: unavailable,
      update: unavailable,
      delete: unavailable,
    },
    files: {
      create: unavailable,
      get: unavailable,
      list: unavailable,
      update: unavailable,
      delete: unavailable,
    },
    uploads: {
      begin: unavailable,
      get: unavailable,
      write: unavailable,
      complete: unavailable,
      abort: unavailable,
    },
    bindings: { bind: unavailable, unbind: unavailable, list: unavailable },
    content: {
      read: unavailable,
      resolveContent: unavailable,
      resolveDownload: unavailable,
    },
  });
  const service = createServerDocumentsCapability(db, files);
  const result = await service.resources.list(
    { principalId: owner.id },
    { limit: 1 },
  );
  expect(result.items.map((row) => String(row.id))).toEqual(["zz-visible"]);
  expect(result.cursor).toBeNull();
});
