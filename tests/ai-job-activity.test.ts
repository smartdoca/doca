import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import { aiJobIsIdle } from "../apps/server/src/services/ai/job-activity.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>;
const now = Date.parse("2026-10-09T00:00:00.000Z");
const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
const job = { id: randomUUID(), user_id: randomUUID(), updated_at: at(16) };
beforeEach(async () => { db = await openTestDatabase({ driver: "sqlite", path: ":memory:" }); });
afterEach(async () => { await db.destroy(); });
async function call(minutes: number, overrides: { job_id?: string; user_id?: string; state?: string } = {}) {
  await db.insertInto("ai_calls").values({
    id: randomUUID(), user_id: job.user_id, job_id: job.id, model_id: "fixture",
    model_snapshot: "{}", periods: "[]", state: "reserved", input_tokens: 0,
    output_tokens: 0, cached_tokens: 0, usage: "", created_at: at(17), updated_at: at(minutes), ...overrides,
  }).execute();
}
it("keeps a long scene correction active after the last complete checkpoint becomes old", async () => {
  await call(16, { state: "settled" });
  await call(7);
  expect(await aiJobIsIdle(db, job, now)).toBe(false);
});
it("recognizes a finished independent review as activity before the next checkpoint", async () => {
  await call(1, { state: "settled" });
  expect(await aiJobIsIdle(db, job, now)).toBe(false);
});
it("still stops an unresponsive request rather than treating a reservation as perpetual activity", async () => {
  await call(16);
  expect(await aiJobIsIdle(db, job, now)).toBe(true);
});
it("does not let another task or account keep a stale task alive", async () => {
  await call(1, { job_id: randomUUID() });
  await call(1, { user_id: randomUUID() });
  expect(await aiJobIsIdle(db, job, now)).toBe(true);
});
it("uses a recent checkpoint when no inference request has begun", async () => {
  expect(await aiJobIsIdle(db, { ...job, updated_at: at(1) }, now)).toBe(false);
  expect(await aiJobIsIdle(db, job, now)).toBe(true);
});
it("does not count malformed timestamps as activity", async () => {
  expect(await aiJobIsIdle(db, { ...job, updated_at: "invalid" }, now)).toBe(true);
});
