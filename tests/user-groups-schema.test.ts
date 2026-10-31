import { afterEach, expect, it } from "vitest";
import { sql } from "kysely";
import type { DB } from "@db/index.js";
import { createSchema } from "@db/create-schema.js";
import { groupTables } from "@db/groups-schema.js";
import { currentSchemaTables } from "@db/introspection.js";
import { openTestDatabase } from "./database.js";

let db: DB | undefined;
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});
async function priorFixture() {
  const connection = await openTestDatabase({
    driver: "sqlite",
    path: ":memory:",
  });
  db = connection;
  await connection
    .insertInto("users")
    .values({
      id: "retained",
      public_id: "retained",
      login: "retained",
      display_name: "保留用户",
      password_hash: "unchanged",
      admin: 0,
      status: "active",
      created_at: "2026-10-30",
    })
    .execute();
  const users = await connection.selectFrom("users").selectAll().execute();
  for (const table of [...groupTables].reverse())
    await connection.schema.dropTable(table).execute();
  const baseline = await connection
    .selectFrom("schema_baseline")
    .selectAll()
    .executeTakeFirstOrThrow();
  const footprint = JSON.parse(baseline.structure_json!);
  for (const table of groupTables) delete footprint[table];
  await connection
    .updateTable("schema_baseline")
    .set({ structure_json: JSON.stringify(footprint) })
    .execute();
  return { connection, users, baseline: baseline.id };
}

it("adds the approved group structure with empty memberships and preserves rows and compatibility generation on repeated/concurrent startup", async () => {
  const { connection, users, baseline } = await priorFixture();
  await Promise.all([createSchema(connection), createSchema(connection)]);
  for (const table of groupTables)
    expect(await connection.selectFrom(table).selectAll().execute()).toEqual(
      table === "group_directory_policies"
        ? [{ id: "system", user_id: null, mode: "member", revision: 1 }]
        : [],
    );
  expect(await connection.selectFrom("users").selectAll().execute()).toEqual(
    users,
  );
  expect(
    (
      await connection
        .selectFrom("schema_baseline")
        .select("id")
        .executeTakeFirstOrThrow()
    ).id,
  ).toBe(baseline);
  await createSchema(connection);
});
it("rejects an unreviewed difference without adding any group tables or modifying retained rows", async () => {
  const { connection, users } = await priorFixture();
  await sql`create table group_upgrade_review (id integer primary key, value text not null)`.execute(
    connection,
  );
  await sql`insert into group_upgrade_review values (1,'retain')`.execute(
    connection,
  );
  await expect(createSchema(connection)).rejects.toThrow(
    /group_upgrade_review/,
  );
  const names = (await currentSchemaTables(connection)).map(
    (table) => table.name,
  );
  expect(groupTables.some((table) => names.includes(table))).toBe(false);
  expect(await connection.selectFrom("users").selectAll().execute()).toEqual(
    users,
  );
  expect(
    (
      await sql<{
        value: string;
      }>`select value from group_upgrade_review`.execute(connection)
    ).rows,
  ).toEqual([{ value: "retain" }]);
});
it("refuses to silently recreate a previously installed group table", async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db.schema.dropTable("user_group_invite_links").execute();
  await expect(createSchema(db)).rejects.toThrow(/user_group_invite_links/);
  expect(
    (await currentSchemaTables(db)).some(
      (table) => table.name === "user_group_invite_links",
    ),
  ).toBe(false);
});

it("does not silently recreate a deleted group directory configuration row", async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db.deleteFrom("group_directory_policies").execute();
  await createSchema(db);
  expect(
    await db.selectFrom("group_directory_policies").selectAll().execute(),
  ).toEqual([]);
});
