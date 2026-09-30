import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createContent } from "@core/workflows/resources.js";
import { createContentService } from "@core/modules/content/service.js";
import { builtinContentSource } from "@core/modules/content/builtin.js";
import { readChangedContent } from "@core/modules/content/snapshot.js";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";

let db: DB;
const owner = { id: randomUUID(), display_name: "Owner", admin: 0 };
const request: PluginRequestContext = {
  requestId: "content-block-test",
  principal: {
    id: owner.id,
    displayName: "Owner",
    publicId: "owner",
    admin: false,
  },
  signal: new AbortController().signal,
};
const stamp = new Date().toISOString();
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db
    .insertInto("users")
    .values({
      ...owner,
      login: owner.id,
      password_hash: "unused",
      status: "active",
      created_at: stamp,
    })
    .execute();
});
afterEach(() => db.destroy());

it("uses the shared block manifest and reads only modified text across complete reconciliations", async () => {
  const doc = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "Plan",
  });
  // Isolated readable projection fixture; no user document or editor session is touched.
  const writeText = async (text: string, seq: number) => {
    await db
      .insertInto("document_states")
      .values({
        resource_id: doc.id,
        codec: "markdown",
        checkpoint: "",
        checkpoint_seq: 0,
        seq,
        text,
        updated_at: stamp,
      })
      .onConflict((oc) => oc.column("resource_id").doUpdateSet({ text, seq }))
      .execute();
  };
  await writeText("# Monday\n\nSubmit budget\n\nSend invoice", 1);
  const service = createContentService(db);
  service.register(builtinContentSource(db, "documents"));
  const read = vi.fn(service.read);
  const consumer = { ...service, read };
  const input = {
    sourceId: "doca.documents.content",
    purpose: "analysis" as const,
    config: { resourceIds: [doc.id] },
  };
  const page = await service.list(request, {
    ...input,
    cursor: null,
    limit: 100,
  });
  expect(page.items).toHaveLength(3);
  expect(page.items.every((item) => !("text" in item))).toBe(true);
  const initial = await readChangedContent(consumer, request, input, new Map());
  expect(initial.changed).toHaveLength(3);
  read.mockClear();
  const unchanged = await readChangedContent(
    consumer,
    request,
    input,
    initial.fingerprints,
  );
  expect(unchanged.changed).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  await writeText("# Monday\n\nSubmit revised budget\n\nSend invoice", 2);
  const changed = await readChangedContent(
    consumer,
    request,
    input,
    initial.fingerprints,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(changed.changed.map((item) => item.text)).toEqual([
    "Submit revised budget",
  ]);
  expect(changed.removed).toHaveLength(1);
  // A changed document sequence alone must not invalidate unchanged blocks.
  read.mockClear();
  await writeText("# Monday\n\nSubmit revised budget\n\nSend invoice", 3);
  expect(
    (await readChangedContent(consumer, request, input, changed.fingerprints))
      .changed,
  ).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it("does not return new content under an old fingerprint and reflects lost resource access", async () => {
  const doc = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "Plan",
  });
  await db
    .insertInto("document_states")
    .values({
      resource_id: doc.id,
      codec: "markdown",
      checkpoint: "",
      checkpoint_seq: 0,
      seq: 1,
      text: "# Monday\n\nSubmit report",
      updated_at: stamp,
    })
    .execute();
  const service = createContentService(db);
  service.register(builtinContentSource(db, "documents"));
  const input = {
    sourceId: "doca.documents.content",
    purpose: "analysis" as const,
    config: { resourceIds: [doc.id] },
  };
  const initial = await readChangedContent(service, request, input, new Map());
  const report = initial.items.find(
    (item) => item.anchor?.heading === "Monday" && item.order === 1,
  )!;
  await db
    .updateTable("document_states")
    .set({ text: "# Tuesday\n\nSubmit report", seq: 2 })
    .where("resource_id", "=", doc.id)
    .execute();
  await expect(
    service.read(request, {
      ...input,
      ref: report.ref,
      fingerprint: report.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .updateTable("resources")
    .set({ deleted_at: stamp })
    .where("id", "=", doc.id)
    .execute();
  const removed = await readChangedContent(
    service,
    request,
    input,
    initial.fingerprints,
  );
  expect(removed.items).toEqual([]);
  expect(removed.removed).toHaveLength(2);
  expect(
    await service.read(request, {
      ...input,
      ref: report.ref,
      fingerprint: report.fingerprint,
    }),
  ).toBeNull();
});
