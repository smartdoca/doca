import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import type { Schema } from "@db/index.js";
import { createAIRunner } from "@server/services/ai/runner.js";
import { readAIConversation } from "@server/services/ai/conversation.js";
import { memoryOwner, saveChatMessage } from "@server/services/ai/memory.js";

it("saves the new question before setup can fail, preserves resumed messages and leaves old failed records untouched", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const actor = await createUser(
    db,
    {
      login: "history-start",
      displayName: "History start",
      password: "isolated-history-start",
    },
    { bootstrap: true },
  );
  const now = new Date().toISOString();
  const session: Schema["ai_sessions"] = {
    id: randomUUID(),
    user_id: actor.id,
    title: "Setup failure",
    model_id: "unavailable",
    resource_ids: "[]",
    archived: 0,
    revision: 1,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto("ai_sessions").values(session).execute();
  const makeJob = (text: string): Schema["ai_jobs"] => ({
    id: randomUUID(),
    session_id: session.id,
    user_id: actor.id,
    model_id: "unavailable",
    status: "queued",
    input: JSON.stringify({
      text,
      scope: "all",
      references: [],
      attachments: [],
      files: [],
      skillIds: [],
      webSearch: false,
    }),
    digest: randomUUID(),
    result: "",
    error: "",
    lease: null,
    lease_until: null,
    attempts: 0,
    cancelled: 0,
    created_at: now,
    updated_at: now,
  });
  const old = {
    ...makeJob("Old missing question stays untouched"),
    status: "failed" as const,
  };
  await db.insertInto("ai_jobs").values(old).execute();
  const runner = createAIRunner(db, {
    memory: { driver: "sqlite", url: ":memory:" },
  });
  try {
    const memory = await runner.ensureThread(session);
    const history = async () =>
      (
        await memory.memory.recall({
          threadId: session.id,
          resourceId: memoryOwner(actor.id),
          perPage: false,
        })
      ).messages;
    const execute = async (job: Schema["ai_jobs"]) => {
      await db.insertInto("ai_jobs").values(job).execute();
      await runner.pump();
      for (let i = 0; i < 100; i++) {
        const row = await db
          .selectFrom("ai_jobs")
          .selectAll()
          .where("id", "=", job.id)
          .executeTakeFirstOrThrow();
        if (row.status === "failed") return row;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Setup failure did not finish");
    };
    const first = makeJob(
      "Keep this original question after model setup fails",
    );
    expect((await execute(first)).error).not.toBe("");
    const conversation = await readAIConversation(
      db,
      runner,
      actor.id,
      session,
      0,
    );
    expect(conversation.messages).toMatchObject([
      { id: first.id, role: "user", text: JSON.parse(first.input).text },
    ]);
    expect(conversation.jobs.find((job) => job.id === first.id)?.status).toBe(
      "failed",
    );
    const resumed = makeJob("Persisted resumed input");
    await saveChatMessage(
      memory.memory,
      actor.id,
      session.id,
      resumed.id,
      "user",
      "Original saved text",
      [],
      [],
      undefined,
      "Original context snapshot",
    );
    const before = JSON.stringify(
      (await history()).find((message) => message.id === resumed.id),
    );
    await execute(resumed);
    expect(
      JSON.stringify(
        (await history()).find((message) => message.id === resumed.id),
      ),
    ).toBe(before);
    expect((await history()).some((message) => message.id === old.id)).toBe(
      false,
    );
    expect(
      await db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", old.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(old);
  } finally {
    await runner.close();
    await db.destroy();
  }
});
