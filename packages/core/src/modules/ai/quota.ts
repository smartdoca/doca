import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  aiConfig,
  lockAIUser,
  requireModel,
  requireImageModel,
  displayModel,
  type AIModel,
} from "./config.js";
import { entitlements } from "../entitlements/service.js";

// All stored point quantities are integer thousandths, exact below MAX_SAFE_INTEGER.
export const pointUnits = (points: number) => Math.round(points * 1000);
export function aiPeriods(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (key: string) => parts.find((p) => p.type === key)!.value;
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const monday = new Date(date + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    day: date,
    week: monday.toISOString().slice(0, 10),
    month: date.slice(0, 7),
  };
}
type Allocation = { id: string; amount: number };
export function billedUnits(
  model: AIModel,
  input: number,
  output: number,
  cached = 0,
) {
  return Math.round(
    (Math.max(0, input - cached) * model.inputRate +
      output * model.outputRate +
      cached * model.cacheRate) /
      1_000,
  );
}
/** Reservations round up so any billable call always holds at least some credit. */
export function reservedUnits(
  model: AIModel,
  input: number,
  output: number,
  cached = 0,
) {
  return Math.ceil(
    (Math.max(0, input - cached) * model.inputRate +
      output * model.outputRate +
      cached * model.cacheRate) /
      1_000,
  );
}
export function imageRate(
  model: Pick<AIModel, "imageRate" | "imageSizeRates" | "outputRate">,
  size?: string,
) {
  return (
    (size ? model.imageSizeRates?.[size] : undefined) ??
    model.imageRate ??
    model.outputRate
  );
}
async function allowance(db: DB, userId: string) {
  const e = await entitlements(db, userId),
    config = await aiConfig(db),
    periods = aiPeriods(e.config.timezone);
  const limits = config.limits[e.level.id] ?? { day: 0, week: 0, month: 0 };
  const calls = await db
    .selectFrom("ai_calls")
    .selectAll()
    .where("user_id", "=", userId)
    .where(
      "created_at",
      ">=",
      new Date(Date.now() - 40 * 86400000).toISOString(),
    )
    .orderBy("created_at", "asc")
    .execute();
  const used = { day: 0, week: 0, month: 0 };
  for (const c of calls) {
    const p = JSON.parse(c.periods);
    for (const k of ["day", "week", "month"] as const)
      if (p[k] === periods[k]) used[k] += c.base_points;
  }
  const remaining = Math.max(
    0,
    Math.min(
      ...(["day", "week", "month"] as const).map((k) =>
        limits[k] == null ? Infinity : pointUnits(limits[k]) - used[k],
      ),
    ),
  );
  return { periods, limits, used, remaining, calls };
}
export async function reserveCall(
  db: DB,
  userId: string,
  modelId: string,
  jobId: string | null,
  inputUpper: number,
  outputUpper: number,
  imageCount?: number,
  imageSize?: string,
) {
  return transact(db, async (tx) => {
    await lockAIUser(tx, userId);
    const { model, config } = await (
      imageCount === undefined ? requireModel : requireImageModel
    )(tx, userId, modelId);
    if (imageCount !== undefined && imageCount !== 1)
      fail(400, "每次生成一张图片");
    const budget =
      imageCount === undefined
        ? reservedUnits(
            { ...model, inputRate: Math.max(model.inputRate, model.cacheRate) },
            inputUpper,
            outputUpper,
          )
        : pointUnits(imageRate(model, imageSize) * imageCount);
    if (jobId) {
      const job = await tx
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!job || job.cancelled || job.status !== "running")
        fail(409, "任务已停止");
      const spent = await tx
        .selectFrom("ai_calls")
        .select("points")
        .where("job_id", "=", jobId)
        .execute();
      const remaining =
        config.taskBudget === null
          ? Infinity
          : pointUnits(config.taskBudget) -
            spent.reduce((s, c) => s + c.points, 0);
      if (budget > remaining)
        fail(
          402,
          `任务积分预算不足：本次调用需预留 ${(budget / 1000).toFixed(3)} 积分，任务剩余 ${Math.max(0, remaining / 1000).toFixed(3)} 积分。请在「等级与会员 → AI 积分」检查模型倍率和任务预算；预留按上下文及最大输出估算，完成后按实际用量结算。`,
        );
    }
    const a = await allowance(tx, userId);
    const base = Math.min(budget, a.remaining);
    let rest = budget - base;
    const allocations: Allocation[] = [];
    const grants = await tx
      .selectFrom("ai_grants")
      .selectAll()
      .where("user_id", "=", userId)
      .where("remaining", ">", 0)
      .where((eb) =>
        eb.or([
          eb("expires_at", "is", null),
          eb("expires_at", ">", new Date().toISOString()),
        ]),
      )
      .execute();
    grants.sort(
      (a, b) =>
        (a.expires_at ?? "9999").localeCompare(b.expires_at ?? "9999") ||
        a.created_at.localeCompare(b.created_at),
    );
    for (const grant of grants) {
      if (!rest) break;
      const amount = Math.min(rest, grant.remaining);
      await tx
        .updateTable("ai_grants")
        .set({ remaining: grant.remaining - amount })
        .where("id", "=", grant.id)
        .execute();
      allocations.push({ id: grant.id, amount });
      rest -= amount;
    }
    if (rest > 0)
      fail(402, "AI 积分不足：日/周/月基础额度和额外积分无法覆盖本次调用");
    const id = randomUUID(),
      now = new Date().toISOString();
    const { apiKey: _key, baseUrl: _url, ...snapshot } = model;
    await tx
      .insertInto("ai_calls")
      .values({
        id,
        user_id: userId,
        job_id: jobId,
        model_id: modelId,
        model_snapshot: JSON.stringify({
          ...snapshot,
          imageRate: imageRate(model, imageSize),
          configRevision: config.revision,
          callKind: imageCount === undefined ? "chat" : "image",
          displayName: displayModel(config, model),
        }),
        periods: JSON.stringify(a.periods),
        state: "reserved",
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        points: budget,
        base_points: base,
        allocations: JSON.stringify(allocations),
        usage: "{}",
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { id, model, maximum: budget };
  });
}
export async function settleCall(
  db: DB,
  id: string,
  usage: {
    input: number;
    output: number;
    cached?: number;
    images?: number;
    raw?: unknown;
  } | null,
  state = "confirmed",
) {
  return transact(db, async (tx) => {
    const first = await tx
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await lockAIUser(tx, first.user_id);
    const c = await tx
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (c.state !== "reserved") return;
    if (!usage) {
      await tx
        .updateTable("ai_calls")
        .set({ state: "pending", updated_at: new Date().toISOString() })
        .where("id", "=", id)
        .execute();
      return;
    }
    const snapshot = JSON.parse(c.model_snapshot);
    if (usage.images !== undefined && ![0, 1].includes(usage.images))
      fail(400, "图片用量无效");
    const cost =
      usage.images !== undefined
        ? pointUnits((snapshot.imageRate ?? 0) * usage.images)
        : billedUnits(
            JSON.parse(c.model_snapshot),
            usage.input,
            usage.output,
            Math.min(usage.input, usage.cached ?? 0),
          );
    const charged = Math.min(c.points, cost); // Provider overruns are platform-owned, retained in raw usage.
    const base = Math.min(charged, c.base_points);
    let needed = charged - base;
    const allocated: Allocation[] = JSON.parse(c.allocations),
      final: Allocation[] = [];
    for (const a of allocated) {
      const used = Math.min(needed, a.amount);
      needed -= used;
      const grant = await tx
        .selectFrom("ai_grants")
        .selectAll()
        .where("id", "=", a.id)
        .executeTakeFirstOrThrow();
      await tx
        .updateTable("ai_grants")
        .set({ remaining: grant.remaining + a.amount - used })
        .where("id", "=", a.id)
        .execute();
      if (used) final.push({ id: a.id, amount: used });
    }
    await tx
      .updateTable("ai_calls")
      .set({
        state,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cached_tokens: usage.cached ?? 0,
        points: charged,
        base_points: base,
        allocations: JSON.stringify(final),
        usage: JSON.stringify({
          provider: usage.raw,
          actualPoints: cost,
          platformOverrun: Math.max(0, cost - charged),
        }),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .execute();
  });
}
export async function quotaSummary(db: DB, userId: string) {
  const a = await allowance(db, userId),
    config = await aiConfig(db);
  const grants = await db
    .selectFrom("ai_grants")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
  return {
    periods: a.periods,
    limits: a.limits,
    used: Object.fromEntries(
      Object.entries(a.used).map(([k, v]) => [k, v / 1000]),
    ),
    tokens: Object.fromEntries(
      (["day", "week", "month"] as const).map((period) => [
        period,
        a.calls
          .filter(
            (c) =>
              JSON.parse(c.periods)[period] === a.periods[period] &&
              c.state !== "site_test",
          )
          .reduce(
            (total, c) => ({
              input: total.input + c.input_tokens,
              output: total.output + c.output_tokens,
              cached: total.cached + c.cached_tokens,
            }),
            { input: 0, output: 0, cached: 0 },
          ),
      ]),
    ),
    bonus:
      grants
        .filter((g) => !g.expires_at || g.expires_at > new Date().toISOString())
        .reduce((s, g) => s + g.remaining, 0) / 1000,
    grants: grants.map((g) => ({
      ...g,
      amount: g.amount / 1000,
      remaining: g.remaining / 1000,
    })),
    calls: a.calls
      .reverse()
      .slice(0, 100)
      .map((c) => ({
        id: c.id,
        jobId: c.job_id,
        modelId: c.model_id,
        model: displayModel(
          config,
          config.models.find((m) => m.id === c.model_id) ??
            JSON.parse(c.model_snapshot),
        ),
        input: c.input_tokens,
        output: c.output_tokens,
        cached: c.cached_tokens,
        images: c.usage ? (JSON.parse(c.usage).provider?.images ?? 0) : 0,
        callKind: JSON.parse(c.model_snapshot).callKind ?? "chat",
        points: c.points / 1000,
        state: c.state,
        createdAt: c.created_at,
      })),
  };
}
