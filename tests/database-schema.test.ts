import { readFile } from "node:fs/promises";
import ts from "typescript";
import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";

it("creates every typed core table without retired business tables or columns", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const source = ts.createSourceFile("schema.ts", await readFile(new URL("../packages/db/src/schema.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const schema = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === "Schema")!;
    const actual = await db.introspection.getTables();
    const names = actual.map(table => table.name);
    for (const member of schema.members)
      if (ts.isPropertySignature(member)) expect(names, `Missing core table ${member.name.getText(source)}`).toContain(member.name.getText(source));
    expect(names.some(name => /^(mail_|mailbox|membership_|moderation_)/.test(name))).toBe(false);
    for (const removed of ["plugin_data", "ai_grants", "ai_credentials", "quota_usage", "user_activity"])
      expect(names).not.toContain(removed);
    for (const column of ["points", "base_points", "allocations"])
      expect(actual.find(table => table.name === "ai_calls")!.columns.map(field => field.name)).not.toContain(column);
    expect(actual.find(table => table.name === "users")!.columns.map(column => column.name)).not.toContain("base_level");
  } finally { await db.destroy(); }
});
