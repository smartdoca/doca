import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";

import { aiSessionFolderId } from "../apps/server/src/services/ai/file-locations.js";
import {
  captureAIInputFileSnapshot,
  verifyAIInputFileSnapshot,
} from "../apps/server/src/services/ai/ai-input-file-snapshot.js";
import { transact } from "@db/transactions.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  owner: Actor,
  reader: Actor,
  other: Actor;
const now = "2026-10-05T10:00:00.000Z";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "snapshot-owner",
        displayName: "Owner",
        password: "isolated-snapshot-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  reader = {
    ...(await createUser(
      db,
      {
        login: "snapshot-reader",
        displayName: "Reader",
        password: "isolated-snapshot-password",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "snapshot-other",
        displayName: "Other",
        password: "isolated-snapshot-password",
      },
      { actor: owner },
    )),
    admin: 0,
  };
});
afterEach(async () => {
  await db.destroy();
});
const folderRef = (id: string) => ({ kind: "folder" as const, id });
const fileRef = (id: string) => ({ kind: "file" as const, id });
async function folder(
  parent: string | null = null,
  actor = owner,
  id = randomUUID(),
) {
  await db
    .insertInto("file_folders")
    .values({
      id,
      owner_id: actor.id,
      parent_id: parent,
      name: "Fixture folder",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  return id;
}
async function file(
  parentType: "system" | "folder" | "document",
  parentId: string,
  options: {
    actor?: Actor;
    metadata?: object;
    name?: string;
    mime?: string;
  } = {},
) {
  const id = randomUUID(),
    objectId = randomUUID(),
    profile = await db
      .selectFrom("storage_profiles")
      .select("id")
      .executeTakeFirstOrThrow();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: `isolated-snapshot/${id}`,
      sha256: "a".repeat(64),
      size: 10,
      mime: options.mime ?? "application/pdf",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id,
      owner_id: (options.actor ?? owner).id,
      parent_type: parentType,
      parent_id: parentId,
      storage_object_id: objectId,
      name: options.name ?? "Fixture.pdf",
      mime: options.mime ?? "application/pdf",
      size: 10,
      metadata: JSON.stringify(options.metadata ?? {}),
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  return { id, objectId };
}
async function aiSession(actor = owner) {
  const id = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Fixture session",
      model_id: null,
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

it("captures every recursive file without the tool's 80-file display limit and preserves each original association", async () => {
  const root = await folder(),
    nested = await folder(root),
    selected: { id: string; objectId: string }[] = [];
  for (let i = 0; i < 101; i++)
    selected.push(await file("folder", i % 2 ? root : nested));
  const refs = [
    folderRef(root),
    folderRef(nested),
    { ...fileRef(selected[0]!.id), name: "untrusted client title" },
  ];
  const snapshot = await transact(db, (tx) =>
    captureAIInputFileSnapshot(tx, owner, refs),
  );
  expect(snapshot.version).toBe(1);
  expect(snapshot.files).toHaveLength(101);
  expect(
    snapshot.files.find((fact) => fact.fileId === selected[0]!.id),
  ).toMatchObject({
    storageObjectId: selected[0]!.objectId,
    filename: "Fixture.pdf",
    mime: "application/pdf",
    version: 1,
  });
  expect(
    snapshot.files.find((fact) => fact.fileId === selected[0]!.id)!
      .inputReferences,
  ).toEqual(
    expect.arrayContaining([
      fileRef(selected[0]!.id),
      folderRef(root),
      folderRef(nested),
    ]),
  );
  const added = await file("folder", nested);
  await db
    .updateTable("file_folders")
    .set({ version: 2 })
    .where("id", "=", root)
    .execute();
  expect(
    (await verifyAIInputFileSnapshot(db, owner, refs, snapshot)).files,
  ).toHaveLength(101);
  expect(snapshot.files.some((fact) => fact.fileId === added.id)).toBe(false);
});

it.each(["version", "name", "mime", "storage_object_id"] as const)(
  "rejects a frozen file whose %s changed",
  async (field) => {
    const source = await file("system", "root"),
      refs = [fileRef(source.id)],
      snapshot = await captureAIInputFileSnapshot(db, owner, refs);
    const replacement =
      field === "storage_object_id"
        ? (await file("system", "root")).objectId
        : undefined;
    const change =
      field === "version"
        ? { version: 2 }
        : field === "name"
          ? { name: "changed.pdf" }
          : field === "mime"
            ? { mime: "image/png" }
            : { storage_object_id: replacement! };
    await db
      .updateTable("file_items")
      .set(change)
      .where("id", "=", source.id)
      .execute();
    await expect(
      verifyAIInputFileSnapshot(db, owner, refs, snapshot),
    ).rejects.toMatchObject({ status: 409 });
  },
);

it("uses shared-folder ACLs for owner files and rejects current ACL revocation", async () => {
  const shared = await folder("shared"),
    nested = await folder(shared),
    source = await file("folder", nested);
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: shared,
      user_id: reader.id,
      role: "reader",
      version: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const refs = [folderRef("shared")],
    snapshot = await captureAIInputFileSnapshot(db, reader, refs);
  expect(snapshot.files.map((fact) => fact.fileId)).toContain(source.id);
  await expect(
    captureAIInputFileSnapshot(db, other, [folderRef(shared)]),
  ).rejects.toMatchObject({ status: 404 });
  await db
    .deleteFrom("file_folder_shares")
    .where("folder_id", "=", shared)
    .execute();
  await expect(
    verifyAIInputFileSnapshot(db, reader, refs, snapshot),
  ).rejects.toMatchObject({ status: 404 });
});

it("uses publication access for a selected public physical folder and revokes it immediately", async () => {
  const published = await folder(),
    child = await folder(published),
    source = await file("folder", child);
  await db
    .insertInto("folder_publications")
    .values({ folder_id: published, enabled: 1, revision: 1 })
    .execute();
  const refs = [folderRef(published)],
    snapshot = await captureAIInputFileSnapshot(db, other, refs);
  expect(snapshot.files.map((fact) => fact.fileId)).toEqual([source.id]);
  await db
    .updateTable("folder_publications")
    .set({ enabled: 0, revision: 2 })
    .where("folder_id", "=", published)
    .execute();
  await expect(
    verifyAIInputFileSnapshot(db, other, refs, snapshot),
  ).rejects.toMatchObject({ status: 404 });
});

it("traverses the complete personal root, including system entries, without exposing another user's root", async () => {
  const personal = await folder(),
    sources = [
      await file("system", "root"),
      await file("folder", personal),
      await file("system", "ai"),
    ];
  await file("system", "root", { actor: other });
  const snapshot = await captureAIInputFileSnapshot(db, owner, [
    folderRef("root"),
  ]);
  expect(snapshot.files.map((fact) => fact.fileId).sort()).toEqual(
    sources.map((source) => source.id).sort(),
  );
  expect(snapshot.folders.map((fact) => fact.folderId)).toEqual(
    expect.arrayContaining([
      "root",
      "ai",
      "shared",
      "documents",
      "documents-personal",
      "documents-shared",
      "documents-libraries",
      personal,
    ]),
  );
});

it("enumerates AI root and authorized virtual sessions without leaking other sessions or knowledge files", async () => {
  const session = await aiSession(),
    foreignSession = await aiSession(other),
    flat = await file("system", "ai"),
    expected = [flat.id];
  for (let i = 0; i < 85; i++)
    expected.push(
      (
        await file("system", "ai", {
          metadata: {
            aiSessionFolder: { sessionId: session, title: "Fixture session" },
          },
        })
      ).id,
    );
  await file("system", "ai", {
    actor: other,
    metadata: {
      aiSessionFolder: { sessionId: foreignSession, title: "Foreign" },
    },
  });
  const snapshot = await captureAIInputFileSnapshot(db, owner, [
    folderRef("ai"),
  ]);
  expect(snapshot.files.map((fact) => fact.fileId).sort()).toEqual(
    expected.sort(),
  );
  expect(
    snapshot.folders.some(
      (fact) => fact.folderId === aiSessionFolderId(session),
    ),
  ).toBe(true);
  expect(
    (
      await captureAIInputFileSnapshot(db, owner, [
        folderRef(aiSessionFolderId(session)),
      ])
    ).files,
  ).toHaveLength(85);
  await expect(
    captureAIInputFileSnapshot(db, owner, [
      folderRef(aiSessionFolderId(foreignSession)),
    ]),
  ).rejects.toMatchObject({ status: 404 });
});


it("recurses personal, shared and library document attachment directories using current document ACLs", async () => {
  const content = createContent(db),
    personal = await content.create(owner, {
      kind: "document",
      format: "markdown",
      title: "Personal",
    }),
    shared = await content.create(other, {
      kind: "document",
      format: "markdown",
      title: "Shared",
    }),
    library = await content.create(owner, {
      kind: "library",
      format: "markdown",
      title: "Library",
    });
  const libraryDoc = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Library document",
    libraryId: library.id,
  });
  const child = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Nested document",
    libraryId: library.id,
    parentId: libraryDoc.id,
  });
  await db
    .insertInto("grants")
    .values({
      resource_id: shared.id,
      user_id: owner.id,
      role: "reader",
      status: "active",
      source_type: "direct",
      source_id: owner.id,
      include_descendants: 1,
    })
    .execute();
  const sources = [
    await file("document", personal.id),
    await file("document", child.id),
    await file("document", libraryDoc.id),
    await file("document", shared.id, { actor: other }),
  ];
  const inaccessibleDoc = await content.create(other, {
    kind: "document",
    format: "markdown",
    title: "Private",
  });
  await file("document", inaccessibleDoc.id, { actor: other });
  const snapshot = await captureAIInputFileSnapshot(db, owner, [
    folderRef("documents"),
  ]);
  expect(snapshot.files.map((fact) => fact.fileId).sort()).toEqual(
    sources.map((source) => source.id).sort(),
  );
  expect(
    (await captureAIInputFileSnapshot(db, owner, [folderRef(personal.id)]))
      .files,
  ).toHaveLength(1);
  expect(
    (await captureAIInputFileSnapshot(db, owner, [folderRef(libraryDoc.id)]))
      .files,
  ).toHaveLength(2);
  expect(
    (
      await captureAIInputFileSnapshot(db, owner, [
        folderRef(`library:${library.id}`),
      ])
    ).files
      .map((fact) => fact.fileId)
      .sort(),
  ).toEqual([sources[1]!.id, sources[2]!.id].sort());
});

it("rejects missing/old snapshots, tampered associations, unknown directories and folder cycles", async () => {
  const root = await folder(),
    source = await file("folder", root),
    refs = [folderRef(root)],
    snapshot = await captureAIInputFileSnapshot(db, owner, refs);
  for (const invalid of [
    undefined,
    { ...snapshot, version: 0 },
    { ...snapshot, extra: true },
  ])
    await expect(
      verifyAIInputFileSnapshot(db, owner, refs, invalid),
    ).rejects.toMatchObject({ status: 409 });
  const changed = structuredClone(snapshot);
  changed.files[0]!.inputReferences = [fileRef(source.id)];
  await expect(
    verifyAIInputFileSnapshot(db, owner, refs, changed),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    captureAIInputFileSnapshot(db, owner, [folderRef("unknown-system")]),
  ).rejects.toMatchObject({ status: 400 });
  const nested = await folder(root);
  await db
    .updateTable("file_folders")
    .set({ parent_id: nested })
    .where("id", "=", root)
    .execute();
  await expect(
    captureAIInputFileSnapshot(db, owner, refs),
  ).rejects.toMatchObject({ status: 409 });
});
