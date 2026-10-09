import { afterEach, expect, it, vi } from "vitest";
import { createTranslator } from "@doca/i18n";
import { AppError, fail, systemErrorReason, systemErrorText } from "@core/shared/errors.js";
import { decodeSystemError, encodeSystemError } from "@doca/i18n";
import { errorDetails } from "../packages/ai-host/src/errors.js";
import { api } from "../apps/web/src/shared/api.js";
import { setAPIErrorLocale, systemErrorMessage } from "../apps/web/src/shared/system-errors.js";
import { modelConnectionError, modelConnectionReason, transientModelFailure } from "../apps/server/src/services/ai/providers.js";
import { applyProgressPatch, progressPatch, type AIProgress } from "@core/modules/ai/progress.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setAPIErrorLocale("zh");
});

it.each(["image_auth_failed", "image_candidate_region_invalid", "ai_workflow_incomplete", "image_review_result_invalid"])("keeps presentation metadata out of model-facing messages and tool error serialisation: %s", (code) => {
  const message = "图片模型认证失败，请检查厂商密钥";
  const original = new AppError(502, message);
  const error = new AppError(502, message, { code });
  expect(error.message).toBe(original.message);
  expect(JSON.stringify(error)).toBe(JSON.stringify(original));
  expect(Object.keys(error)).toEqual(Object.keys(original));
  expect(errorDetails(error)).toEqual(errorDetails(original));
  expect(systemErrorReason(error)).toEqual({ code });
  expect(decodeSystemError(systemErrorText(error))).toEqual({ code });
  try {
    fail(502, message, { code });
  } catch (failure) {
    expect(systemErrorReason(failure)).toEqual({ code });
  }
});

it("translates the new candidate-region validation reason in both catalogs", () => {
  const encoded = encodeSystemError({ code: "image_candidate_region_invalid" });
  expect(systemErrorMessage(encoded, createTranslator("zh"))).toContain("候选小框或核验点无效");
  expect(systemErrorMessage(encoded, createTranslator("en"))).toContain("Use full source-page coordinates");
});

it("leaves old text and untagged JSON unchanged in both languages", () => {
  for (const message of [
    "图片模型认证失败，请检查厂商密钥",
    "图生图调用失败（HTTP 422），请检查模型是否支持参考图片、接口及尺寸；不会自动改为文生图",
    "模型返回的中文回答保持原样。",
    '{"code":"image_auth_failed"}',
    '{"type":"system_error","version":2,"code":"image_auth_failed"}',
  ]) {
    expect(systemErrorMessage(message, createTranslator("en"))).toBe(message);
    expect(systemErrorMessage(message, createTranslator("zh"))).toBe(message);
  }
});

it("translates only new coded errors and preserves structured HTTP parameters", () => {
  const reason = { code: "image_edit_failed", data: { status: 422 } };
  const encoded = encodeSystemError(reason);
  expect(decodeSystemError(encoded)).toEqual(reason);
  expect(systemErrorMessage(encoded, createTranslator("zh"))).toBe(
    "图生图调用失败（HTTP 422），请检查模型是否支持参考图片、接口及尺寸；不会自动改为文生图",
  );
  expect(systemErrorMessage(encoded, createTranslator("en"))).toContain("image-to-image request failed (HTTP 422)");
  expect(systemErrorMessage(encoded, createTranslator("en"))).toContain("will not automatically switch");
  expect(systemErrorMessage(encodeSystemError({ code: "future_error" }), createTranslator("en")))
    .toBe("The operation failed. Try again or contact an administrator.");
});

it("presents a coded workflow connection interruption without exposing provider diagnostics", () => {
  const error = new AppError(502, "AI 模型连接中断，已保存成果保留，可重试继续。", {
    code: "ai_workflow_connection_interrupted",
  });
  const encoded = systemErrorText(error);
  expect(decodeSystemError(encoded)).toEqual({ code: "ai_workflow_connection_interrupted" });
  expect(systemErrorMessage(encoded, createTranslator("zh"))).toBe(error.message);
  expect(systemErrorMessage(encoded, createTranslator("en"))).toBe(
    "The model connection was interrupted. Saved work is retained; retry to continue.",
  );
  expect(encoded).not.toMatch(/UND_ERR|isRetryable|statusCode|cause/);
});

it.each([null, [], { status: null }, { status: {} }, { status: true }])(
  "does not interpret malformed error parameters %j", (data) => {
    const value = JSON.stringify({ type: "system_error", version: 1, code: "image_auth_failed", data });
    expect(decodeSystemError(value)).toBeUndefined();
  },
);

it("uses the current interface language for new HTTP errors without altering the request", async () => {
  const encoded = encodeSystemError({ code: "image_auth_failed" });
  const fetcher = vi.fn(async () => Response.json({ message: encoded }, { status: 502 }));
  vi.stubGlobal("fetch", fetcher);
  for (const locale of ["zh", "en"] as const) {
    setAPIErrorLocale(locale);
    await expect(api("/admin/ai/models/image/test", "POST", {})).rejects.toMatchObject({
      message: systemErrorMessage(encoded, createTranslator(locale)),
      status: 502,
      payload: { message: encoded },
    });
  }
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
});

it("keeps canonical provider errors and retry classification while translating their reasons", () => {
  for (const statusCode of [401, 402, 403, 404, 429, 413, 400, 422, 503]) {
    const provider = { statusCode, message: "secret provider response" };
    const message = modelConnectionError(provider);
    const error = new AppError(502, message, modelConnectionReason(provider));
    expect(systemErrorMessage(systemErrorText(error), createTranslator("zh"))).toBe(message);
    expect(systemErrorText(error)).not.toContain("secret provider response");
    expect(transientModelFailure(error)).toBe(transientModelFailure(new AppError(502, message)));
  }
  const limit = { statusCode: 400, message: "max_output_tokens maximum of 8192" };
  expect(modelConnectionReason(limit)).toEqual({ code: "model_output_limit", data: { maximum: "8,192" } });
});

it("preserves image failure metadata across checkpoints without changing model feedback", () => {
  const progress: AIProgress = {
    phase: "thinking", text: "原始模型回复", reasoning: "原始推理", sources: [],
    imageGenerationError: "图片模型认证失败，请检查厂商密钥",
    imageGenerationFailure: { code: "image_auth_failed" },
  };
  const snapshot = JSON.stringify(progress);
  expect(applyProgressPatch(undefined, progressPatch(undefined, progress))).toEqual(progress);
  const resolved = { ...progress, imageGenerationError: undefined, imageGenerationFailure: undefined };
  expect(applyProgressPatch(progress, progressPatch(progress, resolved))).toEqual(resolved);
  expect(JSON.stringify(progress)).toBe(snapshot);
});
