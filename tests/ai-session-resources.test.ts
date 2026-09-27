import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { openTestDatabase } from "./database.js";
import {
  recordSessionResource,
  sessionResourceHistory,
} from "@core/modules/ai/session-resources.js";
it("records document, file and folder activity without granting session authority, isolates owners and deduplicates", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const userId = randomUUID(),
      other = randomUUID(),
      sessionId = randomUUID(),
      now = new Date().toISOString();
    await db
      .insertInto("users")
      .values(
        [userId, other].map((id) => ({
          id,
          login: id,
          display_name: id,
          password_hash: "unused",
          admin: 0,
          status: "active",
          created_at: now,
        })),
      )
      .execute();
    await db
      .insertInto("ai_sessions")
      .values({
        id: sessionId,
        user_id: userId,
        title: "Global",
        model_id: null,
        resource_ids: "[]",
        mentioned_resource_ids: "[]",
        approved_resource_ids: "[]",
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const doc = {
      id: randomUUID(),
      kind: "document",
      title: "Doc",
      href: "#/r/doc",
    };
    await recordSessionResource(db, userId, sessionId, doc);
    await recordSessionResource(db, userId, sessionId, {
      ...doc,
      title: "Updated",
    });
    await recordSessionResource(db, userId, sessionId, {
      id: randomUUID(),
      kind: "file",
      title: "File",
      href: "#/files?focus=file",
    });
    await recordSessionResource(db, userId, sessionId, {
      id: randomUUID(),
      kind: "folder",
      title: "Folder",
      href: "#/files?folder=folder",
    });
    const history = await sessionResourceHistory(db, userId, sessionId);
    expect(history).toHaveLength(3);
    expect(history.find((x) => x.id === doc.id)?.title).toBe("Updated");
    expect(await sessionResourceHistory(db, other, sessionId)).toEqual([]);
    await expect(
      recordSessionResource(db, other, sessionId, doc),
    ).rejects.toThrow();
    const session = await db
      .selectFrom("ai_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(session.resource_ids).toBe("[]");
    expect(session.approved_resource_ids).toBe("[]");
  } finally {
    await db.destroy();
  }
});
