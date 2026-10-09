import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";

const key = "DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE";
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("defaults to five and accepts higher positive safe decimal limits", async () => {
  const { parseImagePageAttemptLimit } =
    await import("../apps/server/src/services/ai/image-attempt-policy.js");
  expect(parseImagePageAttemptLimit(undefined)).toBe(5);
  expect(parseImagePageAttemptLimit("10")).toBe(10);
  expect(parseImagePageAttemptLimit("1")).toBe(1);
  expect(parseImagePageAttemptLimit(String(Number.MAX_SAFE_INTEGER))).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

it.each([
  "0",
  "",
  "-1",
  "1.5",
  "5.0",
  "1e2",
  " 5",
  "+5",
  "05",
  "9007199254740992",
  "sk-private-config-value",
])(
  "rejects invalid limit %s without echoing the supplied value",
  async (value) => {
    const { parseImagePageAttemptLimit } =
      await import("../apps/server/src/services/ai/image-attempt-policy.js");
    let failure: unknown;
    try {
      parseImagePageAttemptLimit(value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `${key} must be a positive safe decimal integer`,
    );
  },
);

it("does not read env at module import and keeps the startup limit until a simulated restart", async () => {
  const policy =
    await import("../apps/server/src/services/ai/image-attempt-policy.js");
  // bootstrap/config loads dotenv after createApp's dependencies have imported.
  vi.stubEnv(key, "9");
  expect(policy.imagePageAttemptLimit()).toBe(9);
  vi.stubEnv(key, "12");
  expect(policy.imagePageAttemptLimit()).toBe(9);
  vi.resetModules();
  const restarted =
    await import("../apps/server/src/services/ai/image-attempt-policy.js");
  expect(restarted.imagePageAttemptLimit()).toBe(12);
});

const receipt = (ordinal: number) => ({
  version: 1,
  scope: {
    version: 1,
    operationId: "11111111-1111-4111-a111-111111111111",
    taskRootJobId: "22222222-2222-4222-a222-222222222222",
    manifestDigest: "a".repeat(64),
  },
  referenceImageId: "33333333-3333-4333-a333-333333333333",
  ordinal,
});

it("retains valid historical ordinals after lowering the new-request budget without converting data", async () => {
  vi.stubEnv(key, "8");
  const { paidImageAttemptSchema } =
    await import("../apps/server/src/services/ai/image-batch-attempts.js");
  const old = receipt(6),
    before = JSON.stringify(old);
  expect(paidImageAttemptSchema.parse(old)).toEqual(old);
  expect(paidImageAttemptSchema.safeParse(receipt(0)).success).toBe(false);
  expect(paidImageAttemptSchema.safeParse(receipt(9)).success).toBe(true);
  expect(paidImageAttemptSchema.safeParse(receipt(Number.MAX_SAFE_INTEGER+1)).success).toBe(false);
  vi.resetModules();
  vi.stubEnv(key, "3");
  const restarted =
    await import("../apps/server/src/services/ai/image-batch-attempts.js");
  expect(restarted.paidImageAttemptSchema.safeParse(old).success).toBe(true);
  expect(restarted.paidImageAttemptSchema.parse(receipt(3))).toEqual(
    receipt(3),
  );
  expect(JSON.stringify(old)).toBe(before);
});

it("rejects invalid configuration at createApp startup before accessing the supplied database", async () => {
  vi.stubEnv(key, "0");
  const { createApp } = await import("../apps/server/src/app/create-app.js");
  const accessed = vi.fn(() => {
    throw new Error("database must not be touched");
  });
  const db = new Proxy({}, { get: accessed }) as DB;
  await expect(
    createApp(db, { origin: "http://fixture.invalid" }),
  ).rejects.toThrow(`${key} must be a positive safe decimal integer`);
  expect(accessed).not.toHaveBeenCalled();
});
