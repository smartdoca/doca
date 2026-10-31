// Seed with a retained released checkout, then verify with the candidate checkout.
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Isolated upgrade databases only");
const root = resolve(process.env.DOCA_GROUPS_UPGRADE_ROOT);
const source = resolve(process.env.DOCA_GROUPS_SOURCE_ROOT || process.cwd());
await mkdir(root, { recursive: true });
process.env.DOCA_FILE_STORE_ID = "groups-upgrade";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: {
    "groups-upgrade": { provider: "local", root: join(root, "files") },
  },
});
process.env.DOCA_CREDENTIAL_MASTER_KEY = "7".repeat(64);
const load = (path) => import(join(source, path));
const { openDatabase } = await load("packages/db/src/connection.ts");
const config = process.env.DOCA_GROUPS_UPGRADE_POSTGRES
  ? { driver: "postgres", url: process.env.DOCA_GROUPS_UPGRADE_POSTGRES }
  : { driver: "sqlite", path: join(root, "released.db") };
const db = await openDatabase(config);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
async function snapshot(tables) {
  const result = {};
  for (const table of tables) {
    const rows = await db.selectFrom(table).selectAll().execute();
    if (table === "schema_baseline")
      for (const row of rows) delete row.structure_json;
    result[table] = {
      rows: rows.length,
      hash: hash(
        rows
          .map(canonical)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    };
  }
  return result;
}
try {
  if (process.argv[2] === "seed") {
    const { createUser } = await load(
      "packages/core/src/modules/identity/passwords.ts",
    );
    const { createContent } = await load(
      "packages/core/src/workflows/resources.ts",
    );
    const owner = {
      ...(await createUser(
        db,
        {
          login: "groupsupgrade",
          displayName: "原始资源所有者",
          password: "isolated-group-upgrade-2026",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    const peer = await createUser(
      db,
      {
        login: "groupspeer",
        displayName: "已有协作者",
        password: "isolated-group-upgrade-2026",
      },
      { actor: owner },
    );
    const content = createContent(db);
    const library = await content.create(owner, {
      kind: "library",
      format: "markdown",
      title: "保留知识库",
    });
    const doc = await content.create(owner, {
      kind: "document",
      format: "markdown",
      title: "升级前原始正文",
      markdown: "# 原始正文\n升级不能改写个人、链接及继承权限。",
      libraryId: library.id,
    });
    const currentLibrary = await db
      .selectFrom("resources")
      .select("authz_revision")
      .where("id", "=", library.id)
      .executeTakeFirstOrThrow();
    await content.member(owner, library.id, peer.id, {
      revision: currentLibrary.authz_revision,
      role: "reader",
      includeDescendants: true,
    });
    const time = new Date().toISOString(),
      folderId = randomUUID();
    await db
      .insertInto("access_invitations")
      .values({
        resource_id: doc.id,
        user_id: peer.id,
        role: "editor",
        state: "pending",
        version: 2,
        include_descendants: 1,
        invited_by: owner.id,
        created_at: time,
        updated_at: time,
        expires_at: null,
        decided_by: null,
      })
      .execute();
    const token = randomBytes(32).toString("base64url");
    await db
      .insertInto("share_links")
      .values({
        resource_id: doc.id,
        token,
        token_hash: createHash("sha256").update(token).digest("hex"),
        generation: randomUUID(),
        revision: randomUUID(),
        role: "commenter",
        enabled: 1,
        created_by: owner.id,
        created_at: time,
        expires_at: null,
        include_descendants: 1,
        max_members: 5,
      })
      .execute();
    await db
      .insertInto("file_folders")
      .values({
        id: folderId,
        owner_id: owner.id,
        parent_id: "shared",
        name: "保留共享文件夹",
        version: 1,
        created_at: time,
        updated_at: time,
        deleted_at: null,
        delete_batch: null,
      })
      .execute();
    await db
      .insertInto("file_folder_shares")
      .values({
        folder_id: folderId,
        user_id: peer.id,
        role: "reader",
        version: 1,
        created_at: time,
        updated_at: time,
      })
      .execute();
    const tables = (await db.introspection.getTables())
      .filter((table) => !table.schema || table.schema === "public")
      .map((table) => table.name)
      .sort();
    const version = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    ).version;
    assert.equal(version, "0.2.27");
    assert(!tables.includes("user_groups"));
    await writeFile(
      join(root, "before.json"),
      JSON.stringify(
        { version, tables, snapshot: await snapshot(tables) },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ seeded: true, version, tables: tables.length }),
    );
  } else {
    assert.equal(process.argv[2], "check");
    const before = JSON.parse(
      await readFile(join(root, "before.json"), "utf8"),
    );
    assert.deepEqual(await snapshot(before.tables), before.snapshot);
    const { groupTables } = await load("packages/db/src/groups-schema.ts");
    for (const table of groupTables)
      assert.deepEqual(
        await db.selectFrom(table).selectAll().execute(),
        table === "group_directory_policies"
          ? [{ id: "system", user_id: null, mode: "member", revision: 1 }]
          : [],
      );
    const result = {
      passed: true,
      releasedVersion: before.version,
      preservedTables: before.tables.length,
      emptyNewTables: groupTables.length - 1,
      initializedGroupSearchScope: "member",
      engine: config.driver,
    };
    await writeFile(join(root, "report.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  await db.destroy();
}
