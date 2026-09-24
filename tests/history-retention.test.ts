import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  Doc,
  YjsDocument,
  applyUpdate,
  encodeStateAsUpdate,
} from "slatetsx-kit-editor/yjs";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { entitlementDefaults } from "@core/modules/entitlements/service.js";
import { createContent } from "@core/workflows/resources.js";
import { createHistory } from "@core/modules/history/service.js";
import { recordVersion } from "@core/modules/history/repository.js";
import { createDocuments, b64, unb64 } from "./editor-client.js";

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "history-owner",
        displayName: "History owner",
        password: "test-password-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());

async function setLimit(limit: number | null) {
  const config = entitlementDefaults();
  config.levels[0]!.limits["history.versions"] = limit;
  await db
    .updateTable("account_settings")
    .set({ config: JSON.stringify(config) })
    .where("id", "=", "entitlements")
    .execute();
}
async function setup(
  format: "rich_text" | "markdown" | "spreadsheet" | "canvas" = "markdown",
) {
  const resource = await createContent(db).create(owner, {
    kind: "document",
    format,
    title: "历史保留测试",
  });
  const docs = createDocuments(db);
  const initial = await docs.exchange(owner, resource.id, {});
  return { resource, docs, initial, history: createHistory(db) };
}
const versions = (id: string) =>
  db
    .selectFrom("document_versions")
    .selectAll()
    .where("resource_id", "=", id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();

it.each(["rich_text", "markdown", "spreadsheet", "canvas"] as const)(
  "%s manual snapshots replace the oldest history at the limit and remain previewable",
  async (format) => {
    await setLimit(2);
    const { resource, history } = await setup(format);
    const oldest = await history.snapshot(owner, resource.id);
    await db
      .updateTable("document_versions")
      .set({ created_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", oldest.id)
      .execute();
    const second = await history.snapshot(owner, resource.id);
    const newest = await history.snapshot(owner, resource.id);
    expect((await versions(resource.id)).map((v) => v.id).sort()).toEqual(
      [second.id, newest.id].sort(),
    );
    await expect(
      history.version(owner, resource.id, oldest.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      history.version(owner, resource.id, newest.id),
    ).resolves.toMatchObject({ id: newest.id });
  },
);

it("retains the newly inserted version even when its timestamp, sequence and UUID sort before existing history", async () => {
  await setLimit(1);
  const { resource, history } = await setup();
  const old = await history.snapshot(owner, resource.id);
  const row = (await versions(resource.id))[0]!;
  const id = "00000000-0000-4000-8000-000000000000";
  await recordVersion(db, { ...row, id });
  expect((await versions(resource.id)).map((v) => v.id)).toEqual([id]);
  await expect(history.version(owner, resource.id, old.id)).rejects.toThrow();
});

it("shrinks excess history on the next save, without touching another document or the live state", async () => {
  await setLimit(null);
  const a = await setup(),
    b = await setup();
  for (let i = 0; i < 4; i++) await a.history.snapshot(owner, a.resource.id);
  const other = await b.history.snapshot(owner, b.resource.id);
  const state = await db
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", a.resource.id)
    .executeTakeFirstOrThrow();
  await setLimit(1);
  const newest = await a.history.snapshot(owner, a.resource.id);
  expect((await versions(a.resource.id)).map((v) => v.id)).toEqual([newest.id]);
  expect((await versions(b.resource.id)).map((v) => v.id)).toEqual([other.id]);
  expect(
    await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", a.resource.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(state);
});

it("rolls back both eviction and insertion when the enclosing write fails", async () => {
  await setLimit(1);
  const { resource, history } = await setup();
  await history.snapshot(owner, resource.id);
  const before = await versions(resource.id);
  await expect(
    transact(db, async (tx) => {
      await recordVersion(tx, { ...before[0]!, id: randomUUID() });
      expect(
        (
          await tx
            .selectFrom("document_versions")
            .selectAll()
            .where("resource_id", "=", resource.id)
            .execute()
        )[0]!.id,
      ).not.toBe(before[0]!.id);
      throw new Error("simulated commit failure");
    }),
  ).rejects.toThrow("simulated commit failure");
  expect(await versions(resource.id)).toEqual(before);
  await expect(
    recordVersion(db, {
      ...before[0]!,
      id: randomUUID(),
      author_id: randomUUID(),
    }),
  ).rejects.toThrow();
  expect(await versions(resource.id)).toEqual(before);
});

it("concurrent snapshots respect the per-document retention bound", async () => {
  await setLimit(2);
  const { resource, history } = await setup();
  const saved = await Promise.all(
    Array.from({ length: 4 }, () => history.snapshot(owner, resource.id)),
  );
  const rows = await versions(resource.id);
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(saved.map((v) => v.id)).toContain(row.id);
});

it.each(["rich_text", "markdown"] as const)(
  "%s keeps saving, compacting and restoring current content after automatic history fills up",
  async (format) => {
    await setLimit(1);
    const { resource, docs, initial, history } = await setup(format);
    const old = await history.snapshot(owner, resource.id);
    const doc = new Doc();
    applyUpdate(doc, unb64(initial.update));
    const runtime = format === "rich_text" ? new YjsDocument(doc) : null;
    try {
      for (let i = 1; i <= 2; i++) {
        await db
          .updateTable("document_states")
          .set({ updated_at: "2000-01-01T00:00:00.000Z" })
          .where("resource_id", "=", resource.id)
          .execute();
        let update: string;
        if (runtime)
          update = b64(
            runtime.editText(
              (runtime.getValue()[0] as any).id,
              0,
              0,
              `编辑${i}`,
            ),
          );
        else {
          doc.getText("markdown").insert(0, `编辑${i}`);
          update = b64(encodeStateAsUpdate(doc));
        }
        const result = await docs.exchange(owner, resource.id, { update });
        expect(result).toMatchObject({
          seq: i,
          checkpointSeq: i,
          changed: true,
        });
        const rows = await versions(resource.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.seq).toBe(i);
        expect(rows[0]!.id).not.toBe(old.id);
        expect(
          (await history.version(owner, resource.id, rows[0]!.id)).text,
        ).toContain(`编辑${i}`);
      }
      expect(
        await db
          .selectFrom("document_updates")
          .selectAll()
          .where("resource_id", "=", resource.id)
          .execute(),
      ).toHaveLength(0);
      const reloaded = new Doc();
      try {
        applyUpdate(
          reloaded,
          unb64((await docs.exchange(owner, resource.id, {})).update),
        );
        expect(b64(encodeStateAsUpdate(reloaded))).toBe(
          b64(encodeStateAsUpdate(doc)),
        );
      } finally {
        reloaded.destroy();
      }
      const before = await versions(resource.id);
      expect(
        (
          await docs.exchange(owner, resource.id, {
            update: b64(encodeStateAsUpdate(doc)),
          })
        ).changed,
      ).toBe(false);
      expect(await versions(resource.id)).toEqual(before);
    } finally {
      runtime?.destroy();
      doc.destroy();
    }
  },
);

it("restores a full-history document and keeps a recoverable pre-restore snapshot", async () => {
  await setLimit(2);
  const { resource, docs, initial, history } = await setup();
  const target = await history.snapshot(owner, resource.id);
  const targetText = (await history.version(owner, resource.id, target.id))
    .text;
  const doc = new Doc();
  try {
    applyUpdate(doc, unb64(initial.update));
    doc.getText("markdown").insert(0, "恢复前内容");
    await docs.exchange(owner, resource.id, {
      update: b64(encodeStateAsUpdate(doc)),
    });
    await history.snapshot(owner, resource.id);
    const result = await docs.exchange(owner, resource.id, {
      restoreVersion: target.id,
      expectedSeq: 1,
    });
    expect(result.changed).toBe(true);
    applyUpdate(doc, unb64(result.update));
    expect(doc.getText("markdown").toString()).toBe(targetText);
    const rows = await versions(resource.id);
    expect(rows).toHaveLength(2);
    const texts = await Promise.all(
      rows.map(
        async (row) => (await history.version(owner, resource.id, row.id)).text,
      ),
    );
    expect(texts).toContain("恢复前内容" + targetText);
    expect(texts).toContain(targetText);
  } finally {
    doc.destroy();
  }
});

it("zero disables new snapshots while automatic saves still commit the current document", async () => {
  const { resource, docs, initial, history } = await setup();
  await history.snapshot(owner, resource.id);
  await setLimit(0);
  await expect(history.snapshot(owner, resource.id)).rejects.toThrow(
    "未启用历史版本保留",
  );
  const doc = new Doc();
  try {
    applyUpdate(doc, unb64(initial.update));
    doc.getText("markdown").insert(0, "正文继续保存");
    await db
      .updateTable("document_states")
      .set({ updated_at: "2000-01-01T00:00:00.000Z" })
      .where("resource_id", "=", resource.id)
      .execute();
    await expect(
      docs.exchange(owner, resource.id, {
        update: b64(encodeStateAsUpdate(doc)),
      }),
    ).resolves.toMatchObject({ seq: 1, checkpointSeq: 1, changed: true });
    expect(await versions(resource.id)).toEqual([]);
    const state = await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", resource.id)
      .executeTakeFirstOrThrow();
    expect(state.text).toContain("正文继续保存");
  } finally {
    doc.destroy();
  }
});
