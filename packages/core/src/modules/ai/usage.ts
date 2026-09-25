import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { checkOperation } from "../../shared/plugin-services.js";
import { emitIntegrationEvent } from "../automation/events.js";
import {
  aiConfig,
  lockAIUser,
  requireModel,
  requireImageModel,
  displayModel,
  modelUsageRates,
} from "./config.js";

type ProviderUsage = {
  input: number;
  output: number;
  cached?: number;
  images?: number;
  raw?: unknown;
};
type UsageRates = ReturnType<typeof modelUsageRates>;
const precise = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
function ratedUsage(
  usage: Pick<ProviderUsage, "input" | "output" | "cached" | "images">,
  rates: UsageRates,
  callKind: "chat" | "image",
) {
  if (callKind === "image") {
    const image = precise((usage.images ?? 0) * rates.image);
    return { input: 0, output: 0, cached: 0, image, total: image };
  }
  const input = precise(usage.input * rates.input);
  const output = precise(usage.output * rates.output);
  const cached = precise(
    Math.min(usage.input, usage.cached ?? 0) * rates.input,
  );
  return { input, output, cached, image: 0, total: precise(input + output) };
}

export function aiPeriods(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (key: string) => parts.find((p) => p.type === key)!.value;
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const monday = new Date(`${date}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    day: date,
    week: monday.toISOString().slice(0, 10),
    month: date.slice(0, 7),
  };
}

/** Opens an actual provider attempt and snapshots usage rates; commercial balances and quotas remain external. */
export async function beginCall(
  db: DB,
  userId: string,
  modelId: string,
  jobId: string | null,
  inputUpper: number,
  outputUpper: number,
  imageCount?: number,
  imageSize?: string,
) {
  const id = randomUUID();
  return transact(db, async (tx) => {
    await lockAIUser(tx, userId);
    const { model, config } = await (
      imageCount === undefined ? requireModel : requireImageModel
    )(tx, userId, modelId);
    if (jobId) {
      const job = await tx
        .selectFrom("ai_jobs")
        .select(["status", "cancelled"])
        .where("id", "=", jobId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!job || job.cancelled || job.status !== "running")
        fail(409, "任务已停止");
    }
    await checkOperation(tx, userId, "ai.call", {
      callId: id,
      modelId,
      jobId,
      inputUpper,
      outputUpper,
      images: imageCount ?? 0,
      imageSize: imageSize ?? null,
    });
    const now = new Date().toISOString();
    const callKind = imageCount === undefined ? "chat" : "image";
    const rates = modelUsageRates(model);
    await tx
      .insertInto("ai_calls")
      .values({
        id,
        user_id: userId,
        job_id: jobId,
        model_id: modelId,
        model_snapshot: JSON.stringify({
          id: model.id,
          model: model.model,
          provider: model.provider,
          displayName: displayModel(config, model),
          callKind,
          usageRates: rates,
        }),
        periods: JSON.stringify(aiPeriods("UTC")),
        state: "reserved",
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        usage: JSON.stringify({
          known: false,
          estimate: {
            provider: {
              input: inputUpper,
              output: outputUpper,
              images: imageCount ?? 0,
            },
            rated: ratedUsage(
              { input: inputUpper, output: outputUpper, images: imageCount },
              rates,
              callKind,
            ),
          },
          imageSize,
        }),
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { id, model };
  });
}
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export async function settleCall(
  db: DB,
  id: string,
  usage: ProviderUsage | null,
  state = "confirmed",
) {
  return transact(db, async (tx) => {
    const first = await tx
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await lockAIUser(tx, first.user_id);
    const call = await tx
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (!["reserved", "pending"].includes(call.state)) return;
    if (!usage) {
      await tx
        .updateTable("ai_calls")
        .set({ state: "pending", updated_at: new Date().toISOString() })
        .where("id", "=", id)
        .execute();
      return;
    }
    const raw = usage.raw as Record<string, any> | undefined;
    const providerMetrics = {
      input: count(usage.input),
      output: count(usage.output),
      cached: count(usage.cached),
      images: count(usage.images),
      cacheWrite: count(
        raw?.inputTokenDetails?.cacheWriteTokens ??
          raw?.cache_creation_input_tokens,
      ),
      reasoning: count(
        raw?.outputTokenDetails?.reasoningTokens ??
          raw?.output_tokens_details?.reasoning_tokens,
      ),
      inputAudio: count(raw?.input_tokens_details?.audio_tokens),
      outputAudio: count(raw?.output_tokens_details?.audio_tokens),
    };
    const snapshot = JSON.parse(call.model_snapshot);
    const rates: UsageRates = snapshot.usageRates ?? {
      input: snapshot.inputRate ?? 1,
      output: snapshot.outputRate ?? 1,
      image: snapshot.imageRate ?? 1,
    };
    const callKind = snapshot.callKind === "image" ? "image" : "chat";
    const metrics = ratedUsage(usage, rates, callKind);
    await tx
      .updateTable("ai_calls")
      .set({
        state,
        input_tokens: providerMetrics.input ?? 0,
        output_tokens: providerMetrics.output ?? 0,
        cached_tokens: providerMetrics.cached ?? 0,
        usage: JSON.stringify({ known: true, metrics, providerMetrics, rates }),
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .execute();
    await emitIntegrationEvent(tx, "ai.usage.recorded", {
      callId: id,
      userId: call.user_id,
      modelId: call.model_id,
      jobId: call.job_id,
      state,
      metrics,
      units: "rated_tokens",
      provider: {
        metrics: providerMetrics,
        units:
          callKind === "image"
            ? { images: "image" }
            : { input: "token", output: "token", cached: "token" },
      },
    });
  });
}
export async function usageSummary(db: DB, userId: string) {
  const config = await aiConfig(db);
  const periods = aiPeriods("UTC");
  const calls = await db
    .selectFrom("ai_calls")
    .selectAll()
    .where("user_id", "=", userId)
    .where(
      "created_at",
      ">=",
      new Date(Date.now() - 40 * 86400000).toISOString(),
    )
    .orderBy("created_at", "desc")
    .execute();
  return {
    periods,
    tokens: Object.fromEntries(
      (["day", "week", "month"] as const).map((period) => [
        period,
        calls
          .filter(
            (c) =>
              JSON.parse(c.periods)[period] === periods[period] &&
              c.state !== "site_test",
          )
          .reduce(
            (total, c) => {
              const detail = JSON.parse(c.usage);
              const snapshot = JSON.parse(c.model_snapshot);
              const rates: UsageRates = detail.rates ??
                snapshot.usageRates ?? {
                  input: snapshot.inputRate ?? 1,
                  output: snapshot.outputRate ?? 1,
                  image: snapshot.imageRate ?? 1,
                };
              const metrics = detail.known
                ? typeof detail.metrics?.total === "number"
                  ? detail.metrics
                  : ratedUsage(
                      {
                        input: c.input_tokens,
                        output: c.output_tokens,
                        cached: c.cached_tokens,
                        images:
                          detail.providerMetrics?.images ??
                          detail.metrics?.images,
                      },
                      rates,
                      snapshot.callKind === "image" ? "image" : "chat",
                    )
                : { input: 0, output: 0, cached: 0, image: 0, total: 0 };
              return {
                input: precise(total.input + metrics.input),
                output: precise(total.output + metrics.output),
                cached: precise(total.cached + metrics.cached),
                image: precise(total.image + (metrics.image ?? 0)),
                total: precise(total.total + metrics.total),
              };
            },
            { input: 0, output: 0, cached: 0, image: 0, total: 0 },
          ),
      ]),
    ),
    calls: calls.slice(0, 100).map((c) => {
      const detail = JSON.parse(c.usage);
      const snapshot = JSON.parse(c.model_snapshot);
      const rates: UsageRates = detail.rates ??
        snapshot.usageRates ?? {
          input: snapshot.inputRate ?? 1,
          output: snapshot.outputRate ?? 1,
          image: snapshot.imageRate ?? 1,
        };
      const providerMetrics =
        detail.providerMetrics ??
        (detail.known
          ? {
              input: c.input_tokens,
              output: c.output_tokens,
              cached: c.cached_tokens,
              images: detail.metrics?.images,
            }
          : null);
      const metrics = detail.known
        ? typeof detail.metrics?.total === "number"
          ? detail.metrics
          : ratedUsage(
              providerMetrics,
              rates,
              snapshot.callKind === "image" ? "image" : "chat",
            )
        : null;
      return {
        id: c.id,
        jobId: c.job_id,
        modelId: c.model_id,
        model: snapshot.displayName ?? displayModel(config, snapshot),
        input: metrics?.input ?? null,
        output: metrics?.output ?? null,
        cached: metrics?.cached ?? null,
        image: metrics?.image ?? null,
        total: metrics?.total ?? null,
        images: providerMetrics?.images ?? null,
        metrics,
        callKind: snapshot.callKind ?? "chat",
        state: c.state,
        createdAt: c.created_at,
      };
    }),
  };
}
