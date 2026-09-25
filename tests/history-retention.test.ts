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
  "%s snapshots remain independently readable without a membership quota",
  async (format) => {
    const { resource, history } = await setup(format);
    const first = await history.snapshot(owner, resource.id);
    const second = await history.snapshot(owner, resource.id);
    const third = await history.snapshot(owner, resource.id);
    expect((await versions(resource.id)).map(v => v.id).sort()).toEqual([first.id, second.id, third.id].sort());
    await expect(history.version(owner, resource.id, first.id)).resolves.toMatchObject({id:first.id});
  },
);
