import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { readNote, writeNote } from "../apps/server/src/services/ai/notes.js";

it("keeps one markdown note per user", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const owner = await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "owner-pass-2026" },
      { bootstrap: true },
    );
    const other = await createUser(
      db,
      { login: "other", displayName: "Other", password: "other-pass-2026" },
      { actor: { ...owner, admin: 1 } },
    );
    expect(await readNote(db, owner.id)).toEqual({
      content: "",
      updatedAt: null,
    });
    const saved = await writeNote(
      db,
      owner.id,
      "## 常用\r\n- 报告用中文",
    );
    expect(saved.content).toBe("## 常用\n- 报告用中文");
    expect(saved).not.toHaveProperty("secret");
    expect((await readNote(db, owner.id)).content).toBe(saved.content);
    expect(await readNote(db, other.id)).toEqual({
      content: "",
      updatedAt: null,
    });
    await expect(writeNote(db, owner.id, "x".repeat(8001))).rejects.toThrow(
      "8000",
    );
  } finally {
    await db.destroy();
  }
});
