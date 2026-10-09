import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import {
  newContinuationState,
  registerContinuationWait,
  refreshContinuations,
  wakeAIContinuations,
  readContinuationSnapshot,
} from "@server/services/ai/continuations.js";
import {
  aiServiceToken,
  aiContinuationsServiceToken,
  type AIContinuationsServiceV1,
  type AIServiceV1,
  type AIContinuationSnapshot,
  type PluginAIToolContext,
} from "@smartdoca/plugin-sdk/ai";
import { provideAI } from "@server/plugins/ai-capability.js";
import { AIContributionHost, createToolCall } from "@doca/ai-host";
import {
  definePlugin,
  type PluginLifecycleContext,
} from "@smartdoca/plugin-sdk";
import { runPluginContractHarness } from "@smartdoca/plugin-sdk/testing";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import type { AIContributionExecutionContext } from "@server/services/ai/runner.js";
import type { DB } from "@db/index.js";

let db: DB, actor: Actor, sessionId: string;
const input = { sourceId: "example.worker.jobs", operationId: "operation-1" };
let snapshots: Map<string, AIContinuationSnapshot>, authorized: boolean;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  actor = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
  sessionId = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: actor.id,
      title: "Wait test",
      model_id: "test",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  snapshots = new Map([
    [
      input.operationId,
      { version: 1, state: "running", revision: "1", summary: "Queued" },
    ],
  ]);
  authorized = true;
  pluginServices(db).continuations.set(input.sourceId, {
    id: input.sourceId,
    pluginId: "example.worker",
    async read(context, { operationId }) {
      return authorized && context.principal.id === actor.id
        ? snapshots.get(operationId)!
        : null;
    },
  });
});
afterEach(async () => {
  await db.destroy();
});
async function ticket(operationId = input.operationId) {
  const state = newContinuationState();
  await registerContinuationWait(
    db,
    actor,
    state,
    { ...input, operationId },
    new AbortController().signal,
  );
  return state;
}
async function job(
  state: unknown,
  id = randomUUID(),
  status: "awaiting_approval" | "completed" = "awaiting_approval",
) {
  const now = new Date().toISOString(),
    result = JSON.stringify({
      checkpoint: { continuations: state, stage: "execute" },
      progress: { phase: "waiting_dependency", events: [] },
    });
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      session_id: sessionId,
      user_id: actor.id,
      model_id: "test",
      status,
      result,
      input: "{}",
      digest: id,
      error: "",
      lease: null,
      lease_until: null,
      attempts: 0,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
const readJob = (id: string) =>
  db
    .selectFrom("ai_jobs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

it("claims concurrent duplicate completion notifications once and persists the result for restart", async () => {
  const id = await job(await ticket());
  snapshots.set(input.operationId, {
    version: 1,
    state: "completed",
    revision: "2",
    summary: "Saved",
    result: { recordId: "stable-result" },
  });
  const wakes = await Promise.all([
    wakeAIContinuations(db, input),
    wakeAIContinuations(db, input),
  ]);
  expect(wakes.reduce((sum, item) => sum + item.woken, 0)).toBe(1);
  const saved = await readJob(id);
  expect(saved.status).toBe("queued");
  expect(JSON.parse(saved.result).checkpoint.continuations).toMatchObject({
    waits: [],
    ready: [{ snapshot: { result: { recordId: "stable-result" } } }],
  });
  expect(JSON.parse(saved.result).progress.events).toHaveLength(1);
  expect(await wakeAIContinuations(db, input)).toEqual({ woken: 0 });
});
it("recovers a notification before parking and reaches tickets beyond the first scan page", async () => {
  const state = await ticket();
  snapshots.set(input.operationId, {
    version: 1,
    state: "completed",
    revision: "2",
    summary: "Done",
  });
  expect(await wakeAIContinuations(db, input)).toEqual({ woken: 0 });
  for (let index = 0; index < 55; index++) await job(state);
  expect(await wakeAIContinuations(db)).toEqual({ woken: 55 });
});
it("ignores running heartbeats and unchanged manual waits but wakes for a new human decision", async () => {
  const state = await ticket();
  snapshots.set(input.operationId, {
    version: 1,
    state: "running",
    revision: "2",
    summary: "Progress",
  });
  expect(await refreshContinuations(db, actor, state)).toBe(false);
  snapshots.set(input.operationId, {
    version: 1,
    state: "waiting_input",
    revision: "3",
    summary: "Review the result",
  });
  expect(await refreshContinuations(db, actor, state)).toBe(true);
  expect(state.ready).toHaveLength(1);
  state.ready = [];
  expect(await refreshContinuations(db, actor, state)).toBe(false);
  snapshots.set(input.operationId, {
    version: 1,
    state: "waiting_input",
    revision: "4",
    summary: "New review required",
  });
  expect(await refreshContinuations(db, actor, state)).toBe(true);
});
it("keeps another dependency pending when only one operation finishes", async () => {
  snapshots.set("operation-2", {
    version: 1,
    state: "running",
    revision: "1",
    summary: "Second",
  });
  const state = await ticket();
  await registerContinuationWait(
    db,
    actor,
    state,
    { ...input, operationId: "operation-2" },
    new AbortController().signal,
  );
  snapshots.set(input.operationId, {
    version: 1,
    state: "failed",
    revision: "2",
    summary: "Retry required",
  });
  expect(await refreshContinuations(db, actor, state)).toBe(true);
  expect(state.waits.map((item) => item.operationId)).toEqual(["operation-2"]);
  expect(state.ready[0]!.snapshot.state).toBe("failed");
});
it.each(["permission", "disabled", "source"])(
  "fails closed after %s revocation and preserves the saved checkpoint",
  async (reason) => {
    const id = await job(await ticket()),
      before = (await readJob(id)).result;
    if (reason === "permission") authorized = false;
    if (reason === "disabled")
      await db
        .updateTable("users")
        .set({ status: "disabled" })
        .where("id", "=", actor.id)
        .execute();
    if (reason === "source")
      pluginServices(db).continuations.delete(input.sourceId);
    expect(await wakeAIContinuations(db)).toEqual({ woken: 0 });
    expect(await readJob(id)).toMatchObject({
      status: "failed",
      result: before,
    });
  },
);
it("reads current administrator status rather than a stored principal snapshot", async () => {
  await db
    .updateTable("users")
    .set({ admin: 0 })
    .where("id", "=", actor.id)
    .execute();
  pluginServices(db).continuations.set(input.sourceId, {
    id: input.sourceId,
    pluginId: "example.worker",
    async read(context) {
      expect(context.principal.admin).toBe(false);
      return snapshots.get(input.operationId)!;
    },
  });
  await readContinuationSnapshot(db, { ...actor, admin: 1 }, input);
});
it("does not adapt historical jobs, cancel results, or malformed versioned tickets", async () => {
  const historical = await job(undefined, randomUUID(), "completed");
  const cancelled = await job(await ticket());
  await db
    .updateTable("ai_jobs")
    .set({ status: "cancelled", cancelled: 1 })
    .where("id", "=", cancelled)
    .execute();
  const invalid = await job({ version: 0, waits: [] });
  const before = (await readJob(invalid)).result;
  await wakeAIContinuations(db);
  expect((await readJob(historical)).status).toBe("completed");
  expect((await readJob(cancelled)).status).toBe("cancelled");
  expect(await readJob(invalid)).toMatchObject({
    status: "failed",
    result: before,
  });
});
it("waits until plugin registration finishes on host startup", async () => {
  const id = await job(await ticket());
  pluginServices(db).continuationsReady = false;
  pluginServices(db).continuations.delete(input.sourceId);
  await wakeAIContinuations(db);
  expect((await readJob(id)).status).toBe("awaiting_approval");
});
it("exposes wait only to a live authenticated tool and binds registrations to the installed plugin", async () => {
  pluginServices(db).continuations.clear();
  const host = new AIContributionHost<AIContributionExecutionContext>();
  const services = new Map<string, unknown>();
  provideAI(
    {
      provide(token: { id: string }, value: unknown) {
        services.set(token.id, value);
      },
    } as PluginLifecycleContext,
    db,
    host,
  );
  const ai = services.get(aiServiceToken.id) as AIServiceV1,
    continuations = services.get(
      aiContinuationsServiceToken.id,
    ) as AIContinuationsServiceV1;
  let captured!: PluginAIToolContext,
    waits = 0;
  await runPluginContractHarness(
    scopeInstalledPlugin(
      definePlugin({
        manifest: {
          schemaVersion: 1,
          id: "example.worker",
          version: "1.0.0",
          displayName: "Worker",
          sdkRange: "^0.1.10",
        },
        injections: { required: [aiServiceToken, aiContinuationsServiceToken] },
        async mount(context) {
          const scoped = context.inject(aiContinuationsServiceToken);
          expect(() =>
            scoped.registerSource({
              id: "other.worker.jobs",
              pluginId: "other.worker",
              async read() {
                return null;
              },
            }),
          ).toThrow("namespace");
          expect(() => scoped.wake("other.worker", input)).toThrow("namespace");
          scoped.registerSource({
            id: input.sourceId,
            pluginId: "example.worker",
            async read() {
              return snapshots.get(input.operationId)!;
            },
          });
          context.inject(aiServiceToken).registerTool({
            id: "example.worker.start",
            description: "Start",
            inputSchema: { type: "object" },
            async execute(_input, request) {
              captured = request;
              return {
                receipt: await scoped.wait("example.worker", request, input),
              };
            },
          });
          const pipeline = host.createToolPipeline({
            db,
            actor,
            sessionId,
            jobId: "job",
            async waitForContinuation(value) {
              waits++;
              return registerContinuationWait(
                db,
                actor,
                newContinuationState(),
                value,
                new AbortController().signal,
              );
            },
          });
          const result = await pipeline.execute({
            sessionId,
            turnId: "turn",
            call: createToolCall({
              sessionId,
              turnId: "turn",
              toolId: "example.worker.start",
              ordinal: 0,
              input: {},
            }),
            signal: new AbortController().signal,
          });
          expect(result.outcome.status).toBe("success");
          expect(waits).toBe(1);
          await expect(
            continuations.wait("example.worker", captured, input),
          ).rejects.toThrow("executing");
          await expect(
            continuations.wait("example.worker", { ...captured }, input),
          ).rejects.toThrow("executing");
        },
      }),
    ),
    {
      services: [
        { token: aiServiceToken, value: ai },
        { token: aiContinuationsServiceToken, value: continuations },
      ],
    },
  );
  expect(host.tools.size).toBe(0);
  expect(pluginServices(db).continuations.size).toBe(0);
});

it("commits a book run action with its durable receipt and replays it without creating another run", async () => {
  const { createKnowledgeBook } =
    await import("@core/modules/knowledge-books/management.js");
  const { persistBookRunAction } =
    await import("@server/services/ai/knowledge-book-continuation.js");
  const book = await createKnowledgeBook(db, actor, "Receipt test"),
    jobId = await job(undefined, randomUUID(), "completed");
  const operation = { id: randomUUID(), jobId, digest: "new-book-run-action" };
  let calls = 0;
  const execute = async () => {
    calls++;
    return { id: "one-run", status: "queued" };
  };
  expect(
    await persistBookRunAction(db, actor, book.id, operation, execute),
  ).toEqual({ id: "one-run", status: "queued" });
  expect(
    await persistBookRunAction(db, actor, book.id, operation, execute),
  ).toEqual({ id: "one-run", status: "queued" });
  expect(calls).toBe(1);
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", actor.id)
    .execute();
  await expect(
    persistBookRunAction(db, actor, book.id, operation, execute),
  ).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(1);
});

it("preserves an in-flight wait when the host starts shutdown during source authorization", async () => {
  const id = await job(await ticket()), before = (await readJob(id)).result;
  pluginServices(db).continuations.set(input.sourceId, { id: input.sourceId, pluginId: "example.worker", async read() {
    pluginServices(db).continuationsReady = false;
    return { version: 1, state: "completed", revision: "2", summary: "Saved before shutdown" };
  } });
  expect(await wakeAIContinuations(db)).toEqual({ woken: 0 });
  expect(await readJob(id)).toMatchObject({ status: "awaiting_approval", result: before });
});
