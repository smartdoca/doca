import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import {
  aiConfig,
  aiDefaults,
  saveAIConfig,
  type AIModel,
} from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { systemErrorReason } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
} from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { fixtureReviewRequestMetadata } from "./fixtures/ai-image-review-sources.js";
import {
  completeImageReviewSchema,
  reviewImageDelivery,
} from "../apps/server/src/services/ai/image-review.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  ctx: ToolContext,
  model: AIModel;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-image-review-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "review-owner",
        displayName: "Review",
        password: "isolated-review-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      vendors: [
        {
          id: "review-vendor",
          name: "Review",
          provider: "doubao",
          baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
          apiKey: "test-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "review",
          vendorId: "review-vendor",
          model: "doubao-seed-2.1-pro",
          alias: "Review",
          enabled: true,
          vision: true,
          tools: false,
          apiMode: "chat",
          maxInput: 64000,
          maxOutput: 6000,
        },
      ],
    },
    0,
  );
  model = (await aiConfig(db)).models[0]!;
  const now = new Date().toISOString(),
    session = randomUUID(),
    job = randomUUID(),
    lease = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: session,
      user_id: owner.id,
      title: "Review",
      model_id: "review",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("ai_jobs")
    .values({
      id: job,
      session_id: session,
      user_id: owner.id,
      model_id: "review",
      status: "running",
      input: "{}",
      digest: job,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 60000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { actor: owner, jobId: job, lease };
});
afterEach(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function savedCandidate(
  options: {
    inputImages?: number;
    exportOnly?: boolean;
    editRegions?: boolean;
    identities?: number;
    generationPrompt?: string;
    sourceData?: Buffer;
    candidateData?: Buffer;
  } = {},
) {
  const references: string[] = [];
  let candidate = "";
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const storage = createStorage({ ...storageRuntime(), root });
  for (let index = 0; index < 2 + (options.identities ?? 0); index++) {
    const id = randomUUID();
    const data =
      (index === 0
        ? options.sourceData
        : index === 1
          ? options.candidateData
          : undefined) ??
      (await sharp({
        create: {
          width: index < 2 ? 1200 : 400,
          height: index < 2 ? 1800 : 600,
          channels: 3,
          background:
            index === 1 && !options.exportOnly ? "#0033bb" : "#cc3322",
        },
      })
        .png()
        .toBuffer());
    const key = objectKey(id, "image/png");
    await storage.put(
      storageConfigForProfile({ ...storageRuntime(), root }, profile),
      key,
      data,
      "image/png",
      `ref-${index}.png`,
    );
    await db
      .insertInto("assets")
      .values({
        id,
        owner_id: owner.id,
        uploaded_by: owner.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename: `ref-${index}.png`,
        mime: "image/png",
        size: data.length,
        created_at: new Date().toISOString(),
        deleted_at: null,
      })
      .execute();
    if (index === 1) candidate = id;
    else references.push(id);
  }
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: references }) })
    .where("id", "=", ctx.jobId!)
    .execute();
  const receipt = {
    kind: "image_generation",
    state: "saved",
    assetId: candidate,
    ...(options.exportOnly ? { origin: "reference-export" } : {}),
    ...(options.inputImages !== undefined
      ? { providerImageUsage: { inputImages: options.inputImages } }
      : {}),
    generation: {
      prompt:
        options.generationPrompt ??
        "生成时图1是原页，图2为爸爸；执行者建议全部水彩卡通化。",
      referenceImageIds: references,
      ...(options.editRegions
        ? {
            editRegions: [
              {
                label: "target",
                points: [
                  [0.1, 0.2],
                  [0.7, 0.2],
                  [0.7, 0.8],
                  [0.1, 0.8],
                ],
              },
            ],
          }
        : {}),
    },
  };
  await db
    .insertInto("ai_operations")
    .values({
      id: randomUUID(),
      user_id: owner.id,
      job_id: ctx.jobId!,
      digest: randomUUID(),
      result: JSON.stringify(receipt),
      created_at: new Date().toISOString(),
    })
    .execute();
  return {
    assetId: candidate,
    sceneContext: null,
    userRequestMetadata: fixtureReviewRequestMetadata(userRequests, ctx.jobId!),
    referenceImageId: references[0]!,
    references,
    taskScope: {
      kind: "single-image" as const,
      referenceImageId: references[0]!,
    },
  };
}

function requestMetadata(body: any) {
  const texts = body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
      : [],
  );
  return JSON.parse(
    texts.find((text: string) => text.startsWith('{"requiredChecks"')),
  );
}
function expectNonCitableHostPixels(
  body: any,
  expected: any,
  requests: string[],
) {
  const metadata = requestMetadata(body),
    inspection = metadata.hostPixelInspection;
  expect(inspection).toEqual({
    ...expected,
    applicationRule: expect.any(String),
  });
  expect(inspection.applicationRule.trim().length).toBeGreaterThan(0);
  const texts = body.messages
    .flatMap((message: any) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text);
  const formal = texts.find((text: string) =>
    text.startsWith("【最高验收依据：用户原始要求及亲自确认的澄清】\n"),
  );
  expect(JSON.parse(formal.slice(formal.indexOf("\n") + 1))).toEqual(requests);
  if (metadata.reviewMode === "native-detail") {
    const quotes = JSON.parse(
      texts.find((text: string) =>
        text.startsWith('{"allowedAuthorizationQuotes"'),
      ),
    ).allowedAuthorizationQuotes;
    expect(quotes).toEqual(
      requests.map((request, requestIndex) => ({
        requestIndex,
        quotes: [request],
      })),
    );
  }
  return inspection;
}
function expectNativeReviewSchema(body: any) {
  const metadata = requestMetadata(body),
    format = body.response_format;
  expect(format.type).toBe("json_schema");
  expect(format.json_schema.strict).toBe(true);
  const detail = metadata.reviewMode === "native-detail";
  expect(format.json_schema.name).toBe(
    detail ? "doca_image_review_native_detail" : "doca_image_review_global",
  );
  const schema = format.json_schema.schema;
  const review = detail ? schema.properties.tiles.items : schema;
  expect(review.properties.verdict.enum).toEqual(["pass", "revise"]);
  expect(review.properties.checks).toMatchObject({
    type: "array",
    minItems: metadata.requiredChecks.length,
    maxItems: metadata.requiredChecks.length,
  });
  expect(review.properties.checks.items.properties.id.enum).toEqual(
    metadata.requiredChecks.map((check: any) => check.id),
  );
  if (detail) {
    expect(metadata.tiles).toHaveLength(1);
    expect(schema.properties.tiles).toMatchObject({
      type: "array",
      minItems: metadata.tiles.length,
      maxItems: metadata.tiles.length,
    });
    expect(review.properties.tileId.enum).toEqual(
      metadata.tiles.map((tile: any) => tile.id),
    );
    expect(review.properties.people.properties.sourceCount.type).toBe(
      "integer",
    );
    expect(review.properties.people.properties.candidateCount.type).toBe(
      "integer",
    );
    expect(
      review.properties.differences.items.properties.authorization.anyOf.at(-1),
    ).toEqual({ type: "null" });
  }
  const supported = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "enum",
    "const",
    "anyOf",
  ]);
  function inspect(node: any) {
    expect(Object.keys(node).every((key) => supported.has(key))).toBe(true);
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required.slice().sort()).toEqual(
        Object.keys(node.properties).sort(),
      );
      for (const child of Object.values(node.properties)) inspect(child);
    }
    if (node.items) inspect(node.items);
    for (const child of node.anyOf ?? []) inspect(child);
  }
  inspect(schema);
}
function hostReviewScope(body: any) {
  const texts = body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
      : [],
  );
  const text = texts.find((value: string) =>
    value.startsWith("【宿主确认的当前来源范围】\n"),
  );
  return JSON.parse(text.slice(text.indexOf("\n") + 1));
}
function completeReport(body: any, failedId?: string): any {
  const report = {
    verdict: failedId ? "revise" : "pass",
    summary: failedId ? "候选有硬边，不能交付" : "本页全部相关标准满足",
    checks: requestMetadata(body).requiredChecks.map((check: any) => ({
      id: check.id,
      passed: check.id !== failedId,
      evidence:
        check.id === failedId
          ? "实际结果脸颊边缘有矩形贴片和旧脸残留"
          : "对照本页原图、候选与当前组参考，相关内容符合",
    })),
  };
  const metadata = requestMetadata(body);
  if (metadata.reviewMode === "native-detail")
    return {
      tiles: metadata.tiles.map((tile: any) => ({
        ...report,
        checks: report.checks.map((check: any) => ({ ...check })),
        tileId: tile.id,
        people: {
          sourceCount: 0,
          candidateCount: 0,
          evidence: "本测试原生分块实际为纯色，没有人物",
        },
        differences: [],
      })),
    };
  return report;
}
function visionResponse(body: any, report: any) {
  return Response.json({
    id: "review",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(report) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  });
}
const userRequests = [
  "只把指定人物换成真人，原背景、姿态与文字不变。Kipper对应Zeze。",
];
const criteria = ["背景逐像素保留", "Zeze保持已确认的角色对应"];

async function configure(patch: Partial<AIModel>) {
  const config = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      vendors: [
        {
          id: "review-vendor",
          name: "Review",
          provider: patch.provider ?? "doubao",
          baseUrl:
            patch.baseUrl ?? "https://ark.cn-beijing.volces.com/api/plan/v3",
          apiKey: "test-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "review",
          vendorId: "review-vendor",
          model: patch.model ?? "doubao-seed-2.1-pro",
          alias: "Review",
          enabled: true,
          vision: true,
          tools: false,
          apiMode: "chat",
          maxInput: 64000,
          maxOutput: 6000,
        },
      ],
    },
    config.revision,
  );
  model = (await aiConfig(db)).models[0]!;
}

function rawResponse(body: any, content: string, finishReason = "stop") {
  return Response.json({
    id: "review",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  });
}

it("sends native strict closed schemas with one native tile per request and complete coverage", async () => {
  const candidate = await savedCandidate();
  const bodies: any[] = [];
  const result = await reviewImageDelivery(
    db,
    ctx,
    { ...candidate, userRequests, criteria, notes: "" },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return visionResponse(body, completeReport(body));
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(bodies).toHaveLength(3);
  for (const body of bodies) {
    expectNativeReviewSchema(body);
    expect(body.tools).toBeUndefined();
    expect(body.reasoning_effort).toBe("low");
  }
  const nativeBodies = bodies.slice(1);
  expect(
    nativeBodies
      .flatMap((body) =>
        requestMetadata(body).tiles.map((tile: any) => tile.id),
      )
      .toSorted(),
  ).toEqual(["detail-1-1", "detail-2-1"]);
  expect(requestMetadata(bodies[0]).detailCoveragePlan).toMatchObject({
    tileCount: 2,
    additionalCalls: 2,
  });
  for (const body of nativeBodies) {
    expect(requestMetadata(body).tiles).toHaveLength(1);
    expect(
      body.messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url"),
    ).toHaveLength(4);
  }
  const calls = await db
    .selectFrom("ai_calls")
    .select(["state", "input_tokens", "output_tokens"])
    .execute();
  expect(calls).toHaveLength(3);
  expect(
    calls.every(
      (call) =>
        call.state === "confirmed" &&
        call.input_tokens === 100 &&
        call.output_tokens === 100,
    ),
  ).toBe(true);
});

it.each([
  {
    label: "short requests retain exact punctuation and whitespace",
    requests: [
      "原要求不要改背景。\r\n",
      "  允许新人物附近变化，但不能改正文！  ",
      " \r\n\t",
    ],
  },
  {
    label: "long sentences split at original boundaries without losing text",
    requests: [
      "  " +
        "甲".repeat(580) +
        "。\r\n" +
        "乙".repeat(580) +
        "！\n" +
        "丙".repeat(580) +
        "。  ",
    ],
  },
  {
    label: "long unbroken text keeps a surrogate pair intact",
    requests: ["头".repeat(239) + "😀" + "尾".repeat(241)],
  },
  {
    label: "a CRLF at the hard limit remains intact",
    requests: ["开".repeat(239) + "\r\n" + "后".repeat(241)],
  },
])("binds exact native authorization quotes: $label", async ({ requests }) => {
  const candidate = await savedCandidate();
  let calls = 0;
  const result = await reviewImageDelivery(
    db,
    ctx,
    {
      ...candidate,
      userRequests: requests,
      userRequestMetadata: fixtureReviewRequestMetadata(requests, ctx.jobId!),
      criteria,
      notes: "",
    },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expectNativeReviewSchema(body);
        const formalText = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .find(
            (part: any) =>
              part.type === "text" &&
              part.text.startsWith(
                "【最高验收依据：用户原始要求及亲自确认的澄清】\n",
              ),
          )?.text;
        expect(
          JSON.parse(formalText.slice(formalText.indexOf("\n") + 1)),
        ).toEqual(requests);
        if (requestMetadata(body).reviewMode === "native-detail") {
          const table = JSON.parse(
            body.messages
              .flatMap((message: any) =>
                Array.isArray(message.content) ? message.content : [],
              )
              .find(
                (part: any) =>
                  part.type === "text" &&
                  part.text.startsWith('{"allowedAuthorizationQuotes"'),
              ).text,
          ).allowedAuthorizationQuotes;
          expect(table).toHaveLength(requests.length);
          const sourceMetadata = JSON.parse(
            body.messages
              .flatMap((message: any) =>
                Array.isArray(message.content) ? message.content : [],
              )
              .find(
                (part: any) =>
                  part.type === "text" &&
                  part.text.startsWith(
                    "【宿主来源归属及作用域资料；nonCitable",
                  ),
              )
              .text.split("\n")
              .slice(1)
              .join("\n"),
          );
          expect(sourceMetadata.nonCitable).toBe(true);
          expect(
            sourceMetadata.requests.map((source: any) => source.requestIndex),
          ).toEqual(requests.map((_text, index) => index));
          expect(hostReviewScope(body).nonCitable).toBe(true);
          const variants =
            body.response_format.json_schema.schema.properties.tiles.items
              .properties.differences.items.properties.authorization.anyOf;
          expect(variants.at(-1)).toEqual({ type: "null" });
          expect(
            variants
              .slice(0, -1)
              .map((variant: any) => variant.properties.requestIndex.const),
          ).toEqual(
            requests.flatMap((text, index) =>
              /\S/u.test(text) ? [index] : [],
            ),
          );
          for (const variant of variants.slice(0, -1)) {
            const index = variant.properties.requestIndex.const,
              quotes: string[] = variant.properties.quote.enum;
            expect(quotes.length).toBeGreaterThan(0);
            expect(
              quotes.every(
                (quote) =>
                  quote.length <= 240 &&
                  /\S/u.test(quote) &&
                  requests[index]!.includes(quote),
              ),
            ).toBe(true);
            expect(table[index].quotes.join("")).toBe(requests[index]);
            expect(quotes).toEqual([...new Set(table[index].quotes)]);
            expect(JSON.stringify(table)).not.toContain("host_scope");
            if (requests[index]!.length <= 240)
              expect(quotes).toEqual([requests[index]]);
            for (const quote of quotes) {
              for (let offset = 0; offset < quote.length; offset++) {
                const unit = quote.charCodeAt(offset);
                if (unit >= 0xd800 && unit <= 0xdbff)
                  expect(quote.charCodeAt(offset + 1)).toBeGreaterThanOrEqual(
                    0xdc00,
                  );
                if (unit >= 0xdc00 && unit <= 0xdfff)
                  expect(quote.charCodeAt(offset - 1)).toBeLessThanOrEqual(
                    0xdbff,
                  );
              }
              expect(quote.endsWith("\r")).toBe(false);
            }
          }
        }
        return visionResponse(body, completeReport(body));
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(calls).toBe(3);
});

it.each(["missing", "partial", "wrong-index", "wrong-count", "citable"])(
  "rejects %s host source metadata before any paid review rather than filling it",
  async (mode) => {
    const candidate = await savedCandidate();
    const metadata: any = structuredClone(candidate.userRequestMetadata);
    if (mode === "partial") delete metadata.requests[0].question;
    if (mode === "wrong-index") metadata.requests[0].requestIndex = 1;
    if (mode === "wrong-count") metadata.requests = [];
    if (mode === "citable") metadata.nonCitable = false;
    const operations = await db
      .selectFrom("ai_operations")
      .selectAll()
      .execute();
    await expect(
      reviewImageDelivery(
        db,
        ctx,
        {
          ...candidate,
          userRequests,
          userRequestMetadata:
            mode === "missing" ? (undefined as any) : metadata,
          criteria,
          notes: "",
        },
        {
          precision: "native",
          model,
          storage: { ...storageRuntime(), root },
          fetch: async () => {
            throw Error("Invalid host metadata must not call the provider");
          },
        },
      ),
    ).rejects.toThrow("图片验收必须提供有效的宿主当前来源范围");
    expect(await db.selectFrom("ai_calls").select("id").execute()).toHaveLength(
      0,
    );
    expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
      operations,
    );
  },
);

it.each([
  {
    model: "doubao-seed-2-1-pro-260628",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    model: "doubao-seed-2-1-pro-260915",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/",
  },
  {
    model: "doubao-seed-2.1-pro",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  },
])(
  "uses the current native JSON request for official model $model at $baseUrl",
  async (patch) => {
    await configure(patch);
    const candidate = await savedCandidate();
    let calls = 0;
    const result = await reviewImageDelivery(
      db,
      ctx,
      { ...candidate, userRequests, criteria, notes: "" },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          expectNativeReviewSchema(body);
          return visionResponse(body, completeReport(body, "integration"));
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.passed).toBe(false);
  },
);

it.each([
  { provider: "openai" as const },
  { model: "unknown-doubao-model" },
  { model: "doubao-seed-2.1-pro-260915" },
  { baseUrl: "https://review.invalid/v1" },
  { baseUrl: "https://ark.cn-beijing.volces.com/unknown/v1" },
])(
  "keeps the original plain request for an unverified model/endpoint %#",
  async (patch) => {
    await configure(patch);
    const candidate = await savedCandidate();
    const result = await reviewImageDelivery(
      db,
      ctx,
      { ...candidate, userRequests, criteria, notes: "" },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          expect(body.response_format).toBeUndefined();
          return visionResponse(body, completeReport(body, "integration"));
        },
      },
    );
    expect(result.passed).toBe(false);
  },
);

it("rejects a stop response with a prematurely closed first object followed by a second tile, preserving confirmed usage", async () => {
  const candidate = await savedCandidate();
  let calls = 0;
  await expect(
    reviewImageDelivery(
      db,
      ctx,
      { ...candidate, userRequests, criteria, notes: "" },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          expectNativeReviewSchema(body);
          const report = completeReport(body);
          if (calls === 1) return visionResponse(body, report);
          expect(report.tiles).toHaveLength(1);
          const broken =
            JSON.stringify({ tiles: [report.tiles[0]] }) +
            "," +
            JSON.stringify(report.tiles[0]);
          return rawResponse(body, broken);
        },
      },
    ),
  ).rejects.toThrow("phase=native-detail；kind=json；issues=[]");
  // Both native requests in the bounded wave were already sent and are settled.
  expect(calls).toBe(3);
  const usage = await db
    .selectFrom("ai_calls")
    .select(["state", "input_tokens", "output_tokens"])
    .execute();
  expect(usage).toHaveLength(3);
  expect(
    usage.every(
      (call) =>
        call.state === "confirmed" &&
        call.input_tokens === 100 &&
        call.output_tokens === 100,
    ),
  ).toBe(true);
});

it.each(["invalid-json", "unknown-network"])(
  "waits for the sent native sibling to settle after %s without retrying or launching another wave",
  async (mode) => {
    const pixels = await sharp({
      create: { width: 1700, height: 1700, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const candidate = await savedCandidate({
      sourceData: pixels,
      candidateData: pixels,
    });
    const originalOperations = await db
      .selectFrom("ai_operations")
      .selectAll()
      .execute();
    const originalAssets = await db.selectFrom("assets").selectAll().execute();
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let finished = false,
      releaseAll = false;
    const attempt = reviewImageDelivery(
      db,
      ctx,
      { ...candidate, userRequests, criteria, notes: "" },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)),
            metadata = requestMetadata(body);
          expectNativeReviewSchema(body);
          if (metadata.reviewMode !== "native-detail")
            return visionResponse(body, completeReport(body));
          expect(metadata.tiles).toHaveLength(1);
          expect(metadata.coverage.tileCount).toBe(4);
          const id = metadata.tiles[0].id;
          started.push(id);
          if (!releaseAll)
            await new Promise<void>((resolve) => releases.set(id, resolve));
          expect(init?.signal?.aborted).not.toBe(true);
          if (id === "detail-1-1") {
            if (mode === "unknown-network")
              throw new Error("isolated connection lost after submission");
            return rawResponse(body, '{"tiles":[');
          }
          return visionResponse(body, completeReport(body));
        },
      },
    );
    void attempt.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      await expect.poll(() => started.length, { timeout: 5000 }).toBe(2);
      releases.get("detail-1-1")!();
      await expect
        .poll(
          async () =>
            (await db.selectFrom("ai_calls").select("state").execute()).filter(
              (call) =>
                call.state ===
                (mode === "invalid-json" ? "confirmed" : "pending"),
            ).length,
        )
        .toBe(mode === "invalid-json" ? 2 : 1);
      expect(finished).toBe(false);
      expect(started).toHaveLength(2);
      releases.get("detail-1-2")!();
      const error = await attempt.catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      if (mode === "invalid-json")
        expect(systemErrorReason(error)).toMatchObject({
          code: "image_review_result_invalid",
          data: { phase: "native-detail", kind: "json" },
        });
      expect(new Set(started)).toEqual(new Set(["detail-1-1", "detail-1-2"]));
      const calls = await db
        .selectFrom("ai_calls")
        .select(["id", "state", "usage", "input_tokens", "output_tokens"])
        .execute();
      expect(calls).toHaveLength(3);
      expect(new Set(calls.map((call) => call.id)).size).toBe(3);
      const confirmed = calls.filter((call) => call.state === "confirmed");
      expect(confirmed).toHaveLength(mode === "invalid-json" ? 3 : 2);
      expect(
        confirmed.every(
          (call) =>
            JSON.parse(call.usage).known &&
            call.input_tokens === 100 &&
            call.output_tokens === 100,
        ),
      ).toBe(true);
      const pending = calls.filter((call) => call.state === "pending");
      expect(pending).toHaveLength(mode === "invalid-json" ? 0 : 1);
      for (const call of pending)
        expect(JSON.parse(call.usage).known).toBe(false);
      expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
        originalAssets,
      );
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toEqual(originalOperations);
    } finally {
      releaseAll = true;
      for (const release of releases.values()) release();
      await attempt.catch(() => {});
    }
  },
  15000,
);

it("rejects trailing content after a complete global object rather than accepting a partial parsed object", async () => {
  const candidate = await savedCandidate();
  let calls = 0;
  await expect(
    reviewImageDelivery(
      db,
      ctx,
      { ...candidate, userRequests, criteria, notes: "" },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          expectNativeReviewSchema(body);
          return rawResponse(
            body,
            JSON.stringify(completeReport(body)) + " trailing content",
          );
        },
      },
    ),
  ).rejects.toThrow("phase=global；kind=json；issues=[]");
  expect(calls).toBe(1);
  expect(
    await db
      .selectFrom("ai_calls")
      .select(["state", "input_tokens", "output_tokens"])
      .execute(),
  ).toEqual([{ state: "confirmed", input_tokens: 100, output_tokens: 100 }]);
});

it.each([false, true])(
  "keeps batch completion separate from native page conditions without converting returned false (%s)",
  async (contradictoryFalse) => {
    const candidate = await savedCandidate();
    const taskScope = {
      kind: "batch-page" as const,
      bookIndex: 2,
      totalBooks: 8,
      filename: "Current book.pdf",
      physicalPage: 9,
      totalPages: 10,
      referenceImageId: candidate.referenceImageId,
    };
    const requests = [
      "处理全部8本文档95页；当前Current book.pdf物理第9页要修改，其他确实无需修改的71页原样交付。",
    ];
    const pageCriteria = [
      "8本95页全部保存、都有验收后才能整批完成",
      "只有确实无需编辑的71页才按原样条件交付",
      "每页完整布局与动作符合要求，整批95页均有review",
    ];
    let globalScope: any,
      calls = 0;
    const originalOperations = await db
      .selectFrom("ai_operations")
      .selectAll()
      .execute();
    const pending = reviewImageDelivery(
      db,
      ctx,
      {
        ...candidate,
        taskScope,
        userRequests: requests,
        userRequestMetadata: fixtureReviewRequestMetadata(requests, ctx.jobId!),
        criteria: pageCriteria,
        notes: "执行者错误地把此页叫另一本文档，不能改变来源。",
      },
      {
        precision: "native",
        model,
        storage: { ...storageRuntime(), root },
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body)),
            host = hostReviewScope(body),
            metadata = requestMetadata(body);
          expectNativeReviewSchema(body);
          expect(host.taskScope).toEqual(taskScope);
          expect(host.candidateAssetId).toBe(candidate.assetId);
          expect(host.origin).toBe(null);
          expect(host.applicationRule).toContain("同一本来源文件、同一物理页");
          expect(host.completionGate).toContain(
            "整批数量、来源覆盖和全页review由宿主持久批次完成门禁另验",
          );
          expect(
            metadata.requiredChecks
              .slice(-3)
              .map((check: any) => check.requirement),
          ).toEqual(pageCriteria);
          expect(JSON.stringify(body.messages)).toContain(requests[0]);
          const report = completeReport(body);
          if (metadata.reviewMode !== "native-detail") globalScope = host;
          else {
            expect(host.applicationRule).toBe(globalScope.applicationRule);
            expect(host.completionGate).toBe(globalScope.completionGate);
            const instruction = JSON.stringify(
              body.messages.filter((message: any) => message.role === "system"),
            );
            expect(instruction).toContain(
              "这些纯整批条件仍须返回对应criterion id，passed=true",
            );
            expect(instruction).toContain("复合标准先区分本页条款和纯整批条款");
            expect(instruction).toContain(
              "每个check的passed表示本块适用子条件是否满足",
            );
            expect(instruction).toContain("不要用false表达这种不适用");
            expect(instruction).toContain(
              "不得仅凭origin值推断此页不需修改或此条件不适用",
            );
            if (contradictoryFalse) {
              const check = report.tiles[0].checks.find(
                (value: any) => value.id === "criterion-1",
              );
              check.passed = false;
              check.evidence =
                "本块不适用71页原样条件；这是不适用，不是当前像素缺陷。";
              expect(report.tiles[0].verdict).toBe("pass");
            }
          }
          return visionResponse(body, report);
        },
      },
    );
    if (contradictoryFalse)
      await expect(pending).rejects.toThrow("phase=native-detail；kind=schema");
    else expect((await pending).passed).toBe(true);
    expect(calls).toBe(3);
    expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
      originalOperations,
    );
    expect(
      await db
        .selectFrom("ai_calls")
        .select(["state", "input_tokens", "output_tokens"])
        .execute(),
    ).toEqual(
      Array.from({ length: calls }, () => ({
        state: "confirmed",
        input_tokens: 100,
        output_tokens: 100,
      })),
    );
  },
);

it.each([
  ["missing-criterion", "global"],
  ["empty-checks-global", "global"],
  ["extra-check-global", "global"],
  ["veriction-global", "global"],
  ["duplicate-check", "global"],
  ["inconsistent-pass", "global"],
  ["missing-tile", "native-detail"],
  ["empty-checks", "native-detail"],
  ["extra-check-detail", "native-detail"],
  ["veriction-detail", "native-detail"],
  ["unconfirmed-quote", "native-detail"],
  ["unconfirmed-index", "native-detail"],
  ["cross-index-quote", "native-detail"],
  ["extra-final-punctuation", "native-detail"],
  ["host-scope-quote", "native-detail"],
])(
  "retains the strict host validation for %s with native JSON enabled",
  async (mode, phase) => {
    const candidate = await savedCandidate();
    const requests =
      mode === "cross-index-quote"
        ? ["禁止改正文。", "允许人物附近变化。"]
        : userRequests;
    let calls = 0;
    await expect(
      reviewImageDelivery(
        db,
        ctx,
        {
          ...candidate,
          userRequests: requests,
          userRequestMetadata: fixtureReviewRequestMetadata(
            requests,
            ctx.jobId!,
          ),
          criteria,
          notes: "",
        },
        {
          precision: "native",
          model,
          storage: { ...storageRuntime(), root },
          fetch: async (_url, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            expectNativeReviewSchema(body);
            const report = completeReport(body);
            if (phase === "global" || calls === 2) {
              const review = calls === 1 ? report : report.tiles[0];
              if (mode === "missing-criterion")
                review.checks = review.checks.filter(
                  (check: any) => check.id !== "criterion-1",
                );
              else if (mode.startsWith("extra-check"))
                review.checks[2].passed_note =
                  "Provider added an unrecognized field";
              else if (mode.startsWith("veriction")) {
                review.veriction = review.verdict;
                delete review.verdict;
              } else if (mode === "duplicate-check")
                review.checks[1] = { ...review.checks[0] };
              else if (mode === "inconsistent-pass")
                review.checks[0].passed = false;
              else if (mode === "missing-tile") report.tiles = [];
              else if (mode.startsWith("empty-checks")) review.checks = [];
              else
                review.differences = [
                  {
                    description: "Changed an object",
                    authorization: {
                      requestIndex: mode === "unconfirmed-index" ? 999 : 0,
                      quote:
                        mode === "unconfirmed-index"
                          ? requests[0]
                          : mode === "cross-index-quote"
                            ? requests[1]
                            : mode === "extra-final-punctuation"
                              ? requests[0] + "。"
                              : mode === "host-scope-quote"
                                ? candidate.userRequestMetadata.rules[0]
                                : "This is not a formal user quote",
                    },
                  },
                ];
            }
            return visionResponse(body, report);
          },
        },
      ),
    ).rejects.toThrow("kind=schema；issues=");
    expect(calls).toBe(phase === "global" ? 1 : 3);
    const usage = await db
      .selectFrom("ai_calls")
      .select(["state", "input_tokens", "output_tokens"])
      .execute();
    expect(usage).toHaveLength(calls);
    expect(
      usage.every(
        (call) =>
          call.state === "confirmed" &&
          call.input_tokens === 100 &&
          call.output_tokens === 100,
      ),
    ).toBe(true);
  },
);

it.each(["global", "native-detail"])(
  "does not remove the native format or retry when the provider rejects %s",
  async (phase) => {
    const candidate = await savedCandidate();
    let calls = 0;
    await expect(
      reviewImageDelivery(
        db,
        ctx,
        { ...candidate, userRequests, criteria, notes: "" },
        {
          precision: "native",
          model,
          storage: { ...storageRuntime(), root },
          fetch: async (_url, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            expectNativeReviewSchema(body);
            if (phase === "native-detail" && calls === 1)
              return visionResponse(body, completeReport(body));
            return Response.json(
              {
                error: {
                  message: "response_format rejected",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            );
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(phase === "global" ? 1 : 3);
    expect(await db.selectFrom("ai_calls").select("id").execute()).toHaveLength(
      calls,
    );
  },
);

it("sends only source/candidate JPEG previews while preserving PNG references and every actual native detail pair", async () => {
  const candidate = await savedCandidate({ identities: 1 });
  const originalAssets = await db.selectFrom("assets").selectAll().execute();
  const originalOperations = await db
    .selectFrom("ai_operations")
    .selectAll()
    .execute();
  let calls = 0;
  const result = await reviewImageDelivery(
    db,
    ctx,
    { ...candidate, userRequests, criteria, notes: "" },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)),
          metadata = requestMetadata(body);
        const parts = body.messages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content : [],
        );
        const images = parts.filter((p: any) => p.type === "image_url");
        if (metadata.reviewMode !== "native-detail") {
          expect(images).toHaveLength(3);
          expect(metadata.view).toContain("有损构图预览");
          expect(metadata.view).toContain("不是原生像素或严格保留证明");
          for (const index of [0, 1]) {
            expect(images[index].image_url.url).toMatch(
              /^data:image\/jpeg;base64,/,
            );
            const actual = await sharp(
              Buffer.from(images[index].image_url.url.split(",")[1], "base64"),
            ).metadata();
            expect(actual.chromaSubsampling).toBe("4:4:4");
            expect(actual.exif).toBeUndefined();
            expect(Math.max(actual.width!, actual.height!)).toBe(1600);
            expect(
              parts.some(
                (part: any) =>
                  part.type === "text" &&
                  part.text.includes(`Image ${index + 1}:`) &&
                  part.text.includes("不可作为原生像素证明"),
              ),
            ).toBe(true);
          }
          expect(images[2].image_url.url).toMatch(/^data:image\/png;base64,/);
        } else {
          expect(images).toHaveLength(4);
          expect(metadata.tiles).toHaveLength(1);
          for (const image of images)
            expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);
          for (const tile of metadata.tiles)
            for (const [imageIndex, color] of [
              [tile.sourceImage, "#cc3322"],
              [tile.candidateImage, "#0033bb"],
            ] as const) {
              const actual = await sharp(
                Buffer.from(
                  images[imageIndex - 1].image_url.url.split(",")[1],
                  "base64",
                ),
              )
                .ensureAlpha()
                .raw()
                .toBuffer();
              const expected = await sharp({
                create: {
                  width: tile.sourceRect.width,
                  height: tile.sourceRect.height,
                  channels: 4,
                  background: color,
                },
              })
                .raw()
                .toBuffer();
              expect(actual.equals(expected)).toBe(true);
            }
        }
        return visionResponse(body, completeReport(body));
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(calls).toBe(3);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    originalAssets,
  );
  expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
    originalOperations,
  );
  expect(await db.selectFrom("ai_calls").select("state").execute()).toEqual([
    { state: "confirmed" },
    { state: "confirmed" },
    { state: "confirmed" },
  ]);
});

it("retains exact PNG source/result transport when no native detail request will follow", async () => {
  const pixels = await sharp({
    create: { width: 80, height: 120, channels: 4, background: "#537caa" },
  })
    .png()
    .toBuffer();
  const candidate = await savedCandidate({
    sourceData: pixels,
    candidateData: pixels,
    identities: 1,
  });
  let calls = 0;
  const expected = await sharp(pixels).ensureAlpha().raw().toBuffer();
  const result = await reviewImageDelivery(
    db,
    ctx,
    { ...candidate, userRequests, criteria, notes: "" },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)),
          metadata = requestMetadata(body);
        expect(metadata.detailCoveragePlan.tileCount).toBe(0);
        expect(metadata.view).toContain("全部图片保持PNG");
        const images = body.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "image_url");
        expect(images).toHaveLength(3);
        for (const image of images)
          expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);
        for (const image of images.slice(0, 2)) {
          const actual = await sharp(
            Buffer.from(image.image_url.url.split(",")[1], "base64"),
          )
            .ensureAlpha()
            .raw()
            .toBuffer();
          expect(actual.equals(expected)).toBe(true);
        }
        return visionResponse(body, completeReport(body));
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(calls).toBe(1);
});

it("sends one noncitable exact RGBA fact for differently compressed exports through JPEG previews and every native tile", async () => {
  const sourceData = await sharp({
    create: { width: 1500, height: 2000, channels: 4, background: "#537caa" },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const candidateData = await sharp(sourceData)
    .png({ compressionLevel: 9 })
    .toBuffer();
  expect(candidateData.equals(sourceData)).toBe(false);
  const decoded = await sharp(sourceData)
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  expect(decoded.length).toBe(1500 * 2000 * 4);
  expect(
    (
      await sharp(candidateData)
        .rotate()
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer()
    ).equals(decoded),
  ).toBe(true);
  const candidate = await savedCandidate({
    exportOnly: true,
    inputImages: 0,
    sourceData,
    candidateData,
  });
  const requests = [
    "本页没有需替换的目标人物，请完整原样导出并保留背景和文字。",
  ];
  const pixelFacts = {
    width: 1500,
    height: 2000,
    channels: 4,
    bytes: decoded.length,
    sha256: createHash("sha256").update(decoded).digest("hex"),
  };
  const expected = {
    nonCitable: true,
    sourceRef: candidate.referenceImageId,
    candidateAssetId: candidate.assetId,
    decodedPixels: "orientation-normalized sRGB RGBA",
    source: pixelFacts,
    candidate: pixelFacts,
    rgbaExact: true,
  };
  const originalAssets = await db.selectFrom("assets").selectAll().execute();
  const originalOperations = await db
    .selectFrom("ai_operations")
    .selectAll()
    .execute();
  const inspections: any[] = [],
    inspectedTiles: string[] = [];
  let calls = 0;
  const result = await reviewImageDelivery(
    db,
    ctx,
    {
      ...candidate,
      userRequests: requests,
      userRequestMetadata: fixtureReviewRequestMetadata(requests, ctx.jobId!),
      criteria: ["本页背景和文字逐像素保留", "完整原生细节覆盖"],
      notes: "",
    },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)),
          metadata = requestMetadata(body);
        expectNativeReviewSchema(body);
        inspections.push(expectNonCitableHostPixels(body, expected, requests));
        const images = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        if (metadata.reviewMode !== "native-detail") {
          expect(images).toHaveLength(2);
          expect(metadata.origin).toBe("reference-export");
          expect(metadata.view).toContain("有损构图预览");
          for (const image of images)
            expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
          expect(metadata.detailCoveragePlan).toMatchObject({
            tileCount: 2,
            additionalCalls: 2,
          });
        } else {
          expect(images).toHaveLength(4);
          expect(metadata.tiles).toHaveLength(1);
          const tile = metadata.tiles[0];
          inspectedTiles.push(tile.id);
          expect(tile.sourceRect).toEqual(tile.candidateRect);
          for (const index of [tile.sourceImage, tile.candidateImage]) {
            const image = images[index - 1];
            expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);
            const actual = await sharp(
              Buffer.from(image.image_url.url.split(",")[1], "base64"),
            )
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            expect([actual.info.width, actual.info.height]).toEqual([
              tile.sourceRect.width,
              tile.sourceRect.height,
            ]);
            expect(
              actual.data.equals(
                await sharp(sourceData)
                  .extract(tile.sourceRect)
                  .ensureAlpha()
                  .raw()
                  .toBuffer(),
              ),
            ).toBe(true);
          }
        }
        return visionResponse(body, completeReport(body));
      },
    },
  );
  expect(result.passed).toBe(true);
  expect(result.evidence).toContain("已核2/2块");
  expect(calls).toBe(3);
  expect(inspectedTiles.toSorted()).toEqual(["detail-1-1", "detail-2-1"]);
  expect(inspections).toHaveLength(3);
  for (const inspection of inspections)
    expect(inspection).toEqual(inspections[0]);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    originalAssets,
  );
  expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
    originalOperations,
  );
  const usage = await db
    .selectFrom("ai_calls")
    .select(["state", "input_tokens", "output_tokens"])
    .execute();
  expect(usage).toHaveLength(3);
  expect(
    usage.every(
      (call) =>
        call.state === "confirmed" &&
        call.input_tokens === 100 &&
        call.output_tokens === 100,
    ),
  ).toBe(true);
});

it("keeps an identical RGBA export subject to actual target replacement checks and preserves its confirmed judge usage", async () => {
  const sourceData = await sharp({
    create: { width: 80, height: 120, channels: 4, background: "white" },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="24" height="50"><circle cx="12" cy="7" r="6" fill="red"/><rect x="6" y="15" width="12" height="28" fill="red"/></svg>',
        ),
        left: 28,
        top: 35,
      },
    ])
    .png({ compressionLevel: 0 })
    .toBuffer();
  const candidateData = await sharp(sourceData)
    .png({ compressionLevel: 9 })
    .toBuffer();
  expect(candidateData.equals(sourceData)).toBe(false);
  const decoded = await sharp(sourceData)
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  const candidate = await savedCandidate({
    exportOnly: true,
    inputImages: 0,
    sourceData,
    candidateData,
  });
  const pixelFacts = {
    width: 80,
    height: 120,
    channels: 4,
    bytes: decoded.length,
    sha256: createHash("sha256").update(decoded).digest("hex"),
  };
  const expected = {
    nonCitable: true,
    sourceRef: candidate.referenceImageId,
    candidateAssetId: candidate.assetId,
    decodedPixels: "orientation-normalized sRGB RGBA",
    source: pixelFacts,
    candidate: pixelFacts,
    rgbaExact: true,
  };
  const originalAssets = await db.selectFrom("assets").selectAll().execute();
  const originalOperations = await db
    .selectFrom("ai_operations")
    .selectAll()
    .execute();
  let calls = 0;
  const result = await reviewImageDelivery(
    db,
    ctx,
    {
      ...candidate,
      userRequests,
      criteria,
      notes: "原样导出，像素相同即可交付",
    },
    {
      precision: "native",
      model,
      storage: { ...storageRuntime(), root },
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body)),
          metadata = requestMetadata(body);
        expectNativeReviewSchema(body);
        expectNonCitableHostPixels(body, expected, userRequests);
        expect(metadata.reviewMode).not.toBe("native-detail");
        expect(metadata.detailCoveragePlan.tileCount).toBe(0);
        const images = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(images).toHaveLength(2);
        for (const image of images) {
          expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);
          const pixels = await sharp(
            Buffer.from(image.image_url.url.split(",")[1], "base64"),
          )
            .ensureAlpha()
            .raw()
            .toBuffer();
          expect(pixels.equals(decoded)).toBe(true);
          expect(
            (
              await sharp(pixels, {
                raw: { width: 80, height: 120, channels: 4 },
              }).stats()
            ).channels[1]!.min,
          ).toBe(0);
        }
        const report = completeReport(body, "target");
        report.summary =
          "实际原图与成品中的目标人物完全未改，不能完成 Zeze 真人替换";
        report.checks.find((check: any) => check.id === "target").evidence =
          "原生PNG显示同一个红色小人物，目标人物完全未改，RGBA相同不能满足真人替换要求";
        return visionResponse(body, report);
      },
    },
  );
  expect(result.passed).toBe(false);
  expect(result.evidence).toContain("目标人物完全未改");
  expect(calls).toBe(1);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    originalAssets,
  );
  expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
    originalOperations,
  );
  expect(
    await db
      .selectFrom("ai_calls")
      .select(["state", "input_tokens", "output_tokens"])
      .execute(),
  ).toEqual([{ state: "confirmed", input_tokens: 100, output_tokens: 100 }]);
});
