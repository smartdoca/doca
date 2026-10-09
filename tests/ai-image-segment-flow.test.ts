import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import {
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  rawImageCandidateReceiptId,
  rawImageCandidateSchema,
} from "../apps/server/src/services/ai/image-candidates.js";
import type { ImageEditMaskInput } from "../apps/server/src/services/ai/image-edit-mask.js";
import * as segmentation from "../apps/server/src/services/ai/image-mask-segment.js";
import type {
  SegmentationProfileStatus,
  VerifiedSegmentationProfile,
} from "../apps/server/src/services/ai/segmentation-profile.js";
import {
  fixtureSegmentationProfile,
  fixtureSegmentationWorker,
} from "./fixtures/ai-mask-segment-fixture.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let sourceId: string,
  generationId: string,
  sessionId: string,
  seedAssetId: string;
let sourcePixels: Buffer, generatedPixels: Buffer;
let segmentProfile: VerifiedSegmentationProfile;
let workerCalls = 0;
const realPrepareSegment = segmentation.prepareImageMaskSegment;
const origin = "http://localhost:39323",
  password = "isolated-mask-flow-2026";
const runtime = () => ({ ...storage.storageRuntime(), root });
const region = (left: number, top: number, right: number, bottom: number) => ({
  label: "fixture target",
  points: [
    [left / 128, top / 96],
    [right / 128, top / 96],
    [right / 128, bottom / 96],
    [left / 128, bottom / 96],
  ] as [number, number][],
});
const empty = () => ({ proposalIds: [], include: [], exclude: [] });
function maskInput(sourceProposal = "", rawProposal = ""): ImageEditMaskInput {
  return {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    sourceTarget: {
      ...empty(),
      proposalIds: sourceProposal ? [sourceProposal] : [],
    },
    generatedTarget: {
      ...empty(),
      proposalIds: rawProposal ? [rawProposal] : [],
    },
    protected: {
      ...empty(),
      include: [region(32, 24, 48, 36), region(0, 0, 8, 8)],
    },
    allowedOcclusion: empty(),
    textEdits: empty(),
  };
}
function segmentInput(
  kind: "reference" | "raw",
): segmentation.ImageMaskSegmentInput {
  return {
    source:
      kind === "reference"
        ? { kind, referenceImageId: sourceId }
        : { kind, generationOperationId: generationId },
    targets: [
      {
        label: "complete target including separated part",
        box: [0, 0, 1, 1],
        positivePoints: [
          kind === "reference" ? [20 / 128, 20 / 96] : [72 / 128, 48 / 96],
        ],
        negativePoints: [[0, 0]],
      },
    ],
    exclusions: [],
  };
}
function binaryFixture(kind: "reference" | "raw") {
  const result = Buffer.alloc(128 * 96);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 128; x++) {
      const old = x >= 16 && x < 80 && y >= 12 && y < 72;
      const hole = x >= 32 && x < 48 && y >= 24 && y < 36;
      const separate = x >= 8 && x < 16 && y >= 80 && y < 88;
      const expanded = x >= 64 && x < 112 && y >= 24 && y < 72;
      if (kind === "reference" ? (old && !hole) || separate : expanded)
        result[y * 128 + x] = 255;
    }
  return result;
}
function hostOperationId(jobId: string, input: unknown) {
  const hash = digest({ jobId, input });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

type Call = { name: string; args: unknown };
const view = (): Call => ({
  name: "image_candidate_view",
  args: { generationOperationId: generationId },
});
const segment = (kind: "reference" | "raw"): Call => ({
  name: "image_mask_segment",
  args: segmentInput(kind),
});
const prepare = (sourceProposal = "", rawProposal = ""): Call => ({
  name: "image_mask_prepare",
  args: maskInput(sourceProposal, rawProposal),
});
const compose = (maskReceiptId: string): Call => ({
  name: "image_mask_compose",
  args: {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    maskReceiptId,
    filename: "masked-result.png",
  },
});
const lastTool = (body: any, name: string) => {
  const call = body.messages
    .flatMap((message: any) =>
      message.role === "assistant" ? (message.tool_calls ?? []) : [],
    )
    .findLast((item: any) => item.function?.name === name);
  return (
    body.messages.findLast(
      (message: any) =>
        message.role === "tool" && message.tool_call_id === call?.id,
    )?.content ?? ""
  );
};
const receipt = (body: any, name: string) =>
  JSON.parse(JSON.parse(lastTool(body, name))[0].text);
const imageParts = (body: any) =>
  body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part: any, index: number) =>
          part.type === "image_url"
            ? [{ part, label: message.content[index - 1] }]
            : [],
        )
      : [],
  );
const imageUsage = async () =>
  (await usageSummary(db, owner.id)).calls.filter(
    (call) => call.callKind === "image",
  );
async function imageOperations(jobId?: string) {
  let query = db
    .selectFrom("ai_operations")
    .select("result")
    .where("result", "like", '%"kind":"image_generation"%');
  if (jobId) query = query.where("job_id", "=", jobId);
  return (await query.execute()).map((row) => JSON.parse(row.result));
}

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-image-segment-flow-"));
  owner = {
    ...(await createUser(
      db,
      { login: "segment-flow-owner", displayName: "Segment flow", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      maxSteps: 14,
      vendors: [
        {
          id: "mock",
          name: "Fixture",
          provider: "compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "chat",
          vendorId: "mock",
          model: "mock-chat",
          apiMode: "chat",
          alias: "Chat",
          enabled: true,
          tools: true,
          vision: true,
          maxInput: 64000,
          maxOutput: 2000,
        },
        {
          id: "image",
          vendorId: "mock",
          model: "gpt-image-test",
          alias: "Image",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          imageRate: 250,
          maxInput: 32000,
          maxOutput: 1000,
        },
      ],
    },
    0,
  );
  sessionId = randomUUID();
  sourceId = randomUUID();
  generationId = randomUUID();
  const now = new Date().toISOString(),
    jobId = randomUUID(),
    lease = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Segment flow",
      model_id: "chat",
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
      id: jobId,
      session_id: sessionId,
      user_id: owner.id,
      model_id: "chat",
      status: "running",
      input: JSON.stringify({ attachments: [sourceId] }),
      digest: jobId,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const ctx: ToolContext = { actor: owner, jobId, lease };
  sourcePixels = await sharp({
    create: { width: 128, height: 96, channels: 4, background: "#1452a1" },
  })
    .png()
    .toBuffer();
  generatedPixels = await sharp({
    create: { width: 128, height: 96, channels: 4, background: "#d22814" },
  })
    .png()
    .toBuffer();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const key = objectKey(sourceId, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), profile),
      key,
      sourcePixels,
      "image/png",
      "source.png",
    );
  await db
    .insertInto("assets")
    .values({
      id: sourceId,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: key,
      filename: "source.png",
      mime: "image/png",
      size: sourcePixels.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  const result = await generateImageAsset(
    db,
    ctx,
    {
      prompt: "Change only the selected target",
      referenceImageIds: [sourceId],
    },
    generationId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: generatedPixels.toString("base64") }],
          usage: { input_images: 1, input_tokens: 10, output_tokens: 20 },
        })) as typeof fetch,
    },
  );
  seedAssetId = result.assetId;
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", jobId)
    .execute();
  segmentProfile = await fixtureSegmentationProfile(root);
  workerCalls = 0;
  vi.spyOn(segmentation, "prepareImageMaskSegment").mockImplementation(
    async (database, context, input, operationId, options) =>
      realPrepareSegment(database, context, input, operationId, {
        ...options,
        worker: async (...args) => {
          workerCalls++;
          return fixtureSegmentationWorker(
            binaryFixture(
              input.source.kind === "reference" ? "reference" : "raw",
            ),
          )(...args);
        },
      }),
  );
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function run(
  script: (body: any, step: number, jobId: string) => Promise<Call[]> | Call[],
  options: { profile?: SegmentationProfileStatus; vision?: boolean } = {},
) {
  const jobId = randomUUID(),
    bodies: any[] = [],
    callbackErrors: unknown[] = [];
  let imageCalls = 0;
  if (options.vision === false) {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        models: config.models.map((model) =>
          model.id === "chat" ? { ...model, vision: false } : model,
        ),
      },
      revision,
    );
  }
  app = await createApp(db, {
    origin,
    storage: runtime(),
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      segmentationProfile: options.profile ?? {
        status: "ready",
        profile: segmentProfile,
      },
      imageFetch: (async () => {
        imageCalls++;
        throw Error("Segment flow must not invoke an image provider");
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        let calls: Call[];
        try {
          const exposedSegment = body.tools.find(
            (tool: any) => tool.function.name === "image_mask_segment",
          );
          if (exposedSegment) {
            for (const trustedOnly of [
              "sourcePath",
              "outputDir",
              "pythonPath",
              "workerPath",
              "checkpointPath",
              "engineRoot",
            ])
              expect(JSON.stringify(exposedSegment)).not.toContain(trustedOnly);
          }
          calls = await script(body, bodies.length, jobId);
        } catch (error) {
          callbackErrors.push(error);
          throw error;
        }
        const message = calls.length
          ? {
              role: "assistant",
              content: "仅依据实际发送的图像操作；文字说明不能代替预览像素。",
              tool_calls: calls.map((call) => ({
                id: randomUUID(),
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              })),
            }
          : {
              role: "assistant",
              content: "本地蒙版流程检查完成，保存候选仍待质量验收。",
            };
        return completionResponse(
          {
            id: randomUUID(),
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message,
                finish_reason: calls.length ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          },
          !!body.stream,
        );
      }) as typeof fetch,
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin, host: "localhost:39323" },
    payload: { login: "segment-flow-owner", password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const headers = {
    origin,
    host: "localhost:39323",
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
  };
  const sent = await app.inject({
    method: "POST",
    url: `/api/v1/ai/sessions/${sessionId}/messages`,
    headers,
    payload: {
      id: jobId,
      modelId: "chat",
      scope: "all",
      text: "先实际看候选，再用精确蒙版保留背景及孔洞，免费合成。",
    },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  let job: any;
  for (let attempt = 0; attempt < 300; attempt++) {
    job = (
      await app.inject({ url: `/api/v1/ai/sessions/${sessionId}`, headers })
    )
      .json()
      .jobs.find((item: any) => item.id === jobId);
    if (job && !["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(callbackErrors).toEqual([]);
  expect(job?.status, job?.error).toBe("completed");
  expect(imageCalls).toBe(0);
  return { jobId, bodies };
}

function lastExchange(body: any, name: string) {
  const calls = body.messages.flatMap((message: any) =>
    message.role === "assistant" ? (message.tool_calls ?? []) : [],
  );
  const call = calls.findLast((item: any) => item.function?.name === name);
  const text = body.messages.findLast(
    (message: any) =>
      message.role === "tool" && message.tool_call_id === call?.id,
  )?.content;
  return { call, metadata: JSON.parse(text) };
}
async function assertFrames(body: any, name: string, count: number) {
  const { call, metadata } = lastExchange(body, name);
  const facts = JSON.parse(metadata[0].text);
  if (name === "image_mask_segment") {
    const stored = await db
      .selectFrom("ai_operations")
      .select("result")
      .where("id", "=", facts.proposalReceiptId)
      .executeTakeFirstOrThrow();
    const bound = JSON.parse(stored.result);
    expect(facts.digest).toBe(bound.digest);
    expect(facts.source).toEqual(bound.binding.dimensions);
    expect(facts.generatedWindow).toEqual(bound.binding.generatedWindow);
    expect(facts.referenceImageId).toBe(bound.binding.referenceImageId);
    expect(facts.generationOperationId).toBe(
      bound.binding.raw?.generationOperationId ?? null,
    );
  }
  for (const forbidden of [
    "base64",
    "data:image/",
    "objectKey",
    "profileId",
    "artifacts",
    "stdout",
    "stderr",
    "sourcePath",
    "outputDir",
    "checkpointPath",
    "pythonPath",
    "workerPath",
  ])
    expect(lastTool(body, name)).not.toContain(forbidden);
  expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
    originalImageCount: count,
    transmittedImageCount: count,
    untransmitted: [],
  });
  const frames = imageParts(body).filter(
    (entry: any) => JSON.parse(entry.label.text).toolCallId === call.id,
  );
  expect(frames).toHaveLength(count);
  for (const [index, frame] of frames.entries()) {
    const caption = JSON.parse(frame.label.text);
    expect(caption).toMatchObject({
      toolName: name,
      toolImage: index + 1,
      referenceImageId: sourceId,
    });
    if (name !== "image_mask_segment" || facts.generationOperationId)
      expect(caption.generationOperationId).toBe(generationId);
    const pixels = Buffer.from(
      frame.part.image_url.url.split(",")[1],
      "base64",
    );
    expect(frame.part.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    const decoded = await sharp(pixels)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(
      Math.max(decoded.info.width, decoded.info.height),
    ).toBeLessThanOrEqual(1600);
    expect(decoded.data.length).toBeGreaterThan(1000);
    if (name === "image_candidate_view") continue;
    const coordinates = JSON.parse(metadata[index + 1].text);
    expect(caption.sourceRect).toEqual(coordinates.sourceRect);
    expect(caption.contentRect).toEqual(coordinates.contentRect);
    const rect = coordinates.sourceRect,
      content = coordinates.contentRect;
    const x =
      content.left +
      Math.floor(((72 - rect.left) * content.width) / rect.width);
    const y =
      content.top +
      Math.floor(((48 - rect.top) * content.height) / rect.height);
    const offset = (y * decoded.info.width + x) * decoded.info.channels;
    const base =
      name === "image_mask_prepare"
        ? index === 0
          ? [20, 82, 161]
          : [210, 40, 20]
        : facts.generationOperationId
          ? [210, 40, 20]
          : [20, 82, 161];
    const overlay =
      name === "image_mask_segment" ? [20, 220, 80] : [0, 185, 100];
    const alpha = name === "image_mask_segment" ? 0.45 : 90 / 255;
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(
          decoded.data[offset + c]! -
            Math.round(base[c]! * (1 - alpha) + overlay[c]! * alpha),
        ),
      ).toBeLessThanOrEqual(12);
  }
  return facts;
}
async function maskOperations(jobId?: string) {
  let query = db
    .selectFrom("ai_operations")
    .select("result")
    .where("result", "like", '%"kind":"image_edit_mask"%');
  if (jobId) query = query.where("job_id", "=", jobId);
  return (await query.execute()).map((row) => JSON.parse(row.result));
}

it("requires later-round raw and complete proposal inspections, then freely composes the actual old/new union with its hole and disconnected component", async () => {
  const paidBefore = await imageUsage();
  const generationBefore = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", generationId)
    .executeTakeFirstOrThrow();
  let sourceProposal = "",
    rawProposal = "",
    maskReceiptId = "";
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [segment("raw")];
    if (step === 2) {
      expect(lastTool(body, "image_mask_segment")).toContain(
        "先单独 image_candidate_view",
      );
      expect(workerCalls).toBe(0);
      return [view(), segment("raw")];
    }
    if (step === 3) {
      expect(lastTool(body, "image_mask_segment")).toContain(
        "下一模型轮次才可分割",
      );
      expect(workerCalls).toBe(0);
      await assertFrames(body, "image_candidate_view", 3);
      // Name the host's deterministic receipt, without inserting any row or proof.
      sourceProposal = hostOperationId(jobId, {
        imageMaskSegment: segmentInput("reference"),
      });
      return [segment("reference"), prepare(sourceProposal)];
    }
    if (step === 4) {
      // Concurrent preparation may run before the proposal is committed.
      // Both missing strict receipt and missing later-round proof must reject.
      expect(lastTool(body, "image_mask_prepare")).toMatch(
        /没有严格 version:1 分割提案回执|实际完整查看/,
      );
      expect(await maskOperations(jobId)).toHaveLength(0);
      const sourceFacts = await assertFrames(body, "image_mask_segment", 2);
      expect(sourceFacts).toMatchObject({
        proposalReceiptId: sourceProposal,
        state: "ready",
        usable: true,
        generationOperationId: null,
        diagnostics: {
          semanticCoverage: "unverified",
          pointConstraintsSatisfied: true,
        },
      });
      rawProposal = hostOperationId(jobId, {
        imageMaskSegment: segmentInput("raw"),
      });
      return [segment("raw"), prepare(sourceProposal, rawProposal)];
    }
    if (step === 5) {
      expect(lastTool(body, "image_mask_prepare")).toMatch(
        /没有严格 version:1 分割提案回执|后续模型轮次/,
      );
      expect(await maskOperations(jobId)).toHaveLength(0);
      const rawFacts = await assertFrames(body, "image_mask_segment", 2);
      expect(rawFacts).toMatchObject({
        proposalReceiptId: rawProposal,
        state: "ready",
        usable: true,
        generationOperationId: generationId,
      });
      maskReceiptId = hostOperationId(jobId, {
        imageMaskPrepare: maskInput(sourceProposal, rawProposal),
      });
      return [prepare(sourceProposal, rawProposal), compose(maskReceiptId)];
    }
    if (step === 6) {
      expect(lastTool(body, "image_mask_compose")).toContain(
        "下一模型轮次才可合成",
      );
      expect(await imageOperations(jobId)).toHaveLength(0);
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      expect(facts).toMatchObject({
        maskReceiptId,
        diagnostics: { safeToCompose: true, semanticCoverage: "unverified" },
        coverage: {
          sourceTargetPixels: 3712,
          generatedTargetPixels: 2304,
          expandedPixels: 1536,
        },
      });
      expect(await imageUsage()).toEqual(paidBefore);
      return [compose(maskReceiptId)];
    }
    expect(step).toBe(7);
    expect(receipt(body, "image_mask_compose")).toMatchObject({
      state: "saved",
      origin: "local-recomposition",
      generationOperationId: generationId,
      preservation: { protectedPixelsChanged: 0 },
    });
    return [];
  });
  expect(result.bodies).toHaveLength(7);
  expect(workerCalls).toBe(2);
  const masks = await maskOperations(result.jobId);
  expect(masks).toHaveLength(1);
  expect(masks[0]).toMatchObject({
    version: 2,
    proposalBindings: [
      expect.objectContaining({
        receiptId: expect.any(String),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({ receiptId: expect.any(String) }),
    ],
  });
  expect(
    masks[0].proposalBindings.map((item: any) => item.receiptId).sort(),
  ).toEqual([sourceProposal, rawProposal].sort());
  const generations = await imageOperations(result.jobId);
  expect(generations).toHaveLength(1);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", generations[0].assetId)
    .executeTakeFirstOrThrow();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const final = await storage
    .createStorage(runtime())
    .read(
      storage.storageConfigForProfile(runtime(), profile),
      asset.object_key,
      asset.size,
    );
  expect((await sharp(final).metadata()).format).toBe("png");
  const rgba = (data: Buffer) =>
    sharp(data)
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [actual, source, generated] = await Promise.all([
    rgba(final),
    rgba(sourcePixels),
    rgba(generatedPixels),
  ]);
  expect(actual.info).toMatchObject({ width: 128, height: 96, channels: 4 });
  const oldMask = binaryFixture("reference"),
    newMask = binaryFixture("raw");
  for (let i = 0; i < oldMask.length; i++) {
    const expected =
      oldMask[i] === 255 || newMask[i] === 255 ? generated.data : source.data;
    expect(actual.data.subarray(i * 4, i * 4 + 4)).toEqual(
      expected.subarray(i * 4, i * 4 + 4),
    );
  }
  expect(await imageUsage()).toEqual(paidBefore);
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", generationId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(generationBefore.result);
  const checkpoint = (
    await db
      .selectFrom("ai_jobs")
      .select("result")
      .where("id", "=", result.jobId)
      .executeTakeFirstOrThrow()
  ).result;
  expect(checkpoint).not.toContain("base64");
  expect(checkpoint).not.toContain("data:image/");
}, 30000);

it("does not grant prepare proof for a durable usable proposal when the image budget omits its complete two-frame diagnostic", async () => {
  const paidBefore = await imageUsage();
  let sourceProposal = "";
  const result = await run(async (body, step) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [
        {
          name: "image_view",
          args: { referenceImageIds: [sourceId, seedAssetId] },
        },
        { name: "image_view", args: { referenceImageIds: [sourceId] } },
        segment("reference"),
      ];
    }
    if (step === 3) {
      const { metadata } = lastExchange(body, "image_mask_segment");
      const facts = JSON.parse(metadata[0].text);
      sourceProposal = facts.proposalReceiptId;
      expect(facts).toMatchObject({
        state: "ready",
        usable: true,
        diagnostics: { pointConstraintsSatisfied: true },
      });
      expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
        originalImageCount: 2,
        transmittedImageCount: 0,
      });
      expect(
        JSON.parse(metadata.at(-1).text).visualInput.untransmitted,
      ).toHaveLength(2);
      const frames = imageParts(body);
      expect(frames).toHaveLength(3);
      for (const frame of frames)
        expect(JSON.parse(frame.label.text).toolName).toBe("image_view");
      const stored = await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", sourceProposal)
        .executeTakeFirstOrThrow();
      expect(JSON.parse(stored.result)).toMatchObject({
        kind: "image_mask_segment",
        state: "ready",
        usable: true,
      });
      return [prepare(sourceProposal)];
    }
    expect(step).toBe(4);
    const error = lastTool(body, "image_mask_prepare");
    const failure = JSON.parse(error);
    expect(failure).toMatchObject({
      error: true,
      code: "image_mask_segment_inspection_required",
      referenceImageId: sourceId,
      generationOperationId: generationId,
      missingProposalIds: [sourceProposal],
      missing: [
        {
          proposalReceiptId: sourceProposal,
          reason: "not_viewed_in_this_execution",
        },
      ],
      proposals: [
        {
          receiptId: sourceProposal,
          source: { kind: "reference", referenceImageId: sourceId },
          usable: true,
          groups: ["sourceTarget"],
        },
      ],
      next: [
        {
          toolName: "image_mask_segment_view",
          input: { proposalReceiptId: sourceProposal },
        },
      ],
    });
    expect(failure.missingProposalIds).toHaveLength(1);
    expect(failure.missing).toHaveLength(1);
    expect(failure.proposals).toHaveLength(1);
    expect(failure.next).toHaveLength(1);
    expect(error).not.toMatch(/base64|data:image\/|objectKey|profileId/);
    return [];
  });
  expect(result.bodies).toHaveLength(4);
  expect(workerCalls).toBe(1);
  expect(await maskOperations(result.jobId)).toHaveLength(0);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
}, 30000);

it("rejects an actually transmitted two-frame diagnostic-only proposal for its failed point constraints before checking visual-use proof", async () => {
  const paidBefore = await imageUsage();
  let failedProposal = "";
  const failedInput = segmentInput("reference");
  failedInput.targets[0]!.positivePoints = [[1 / 128, 1 / 96]];
  const result = await run(async (body, step) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [{ name: "image_mask_segment", args: failedInput }];
    }
    if (step === 3) {
      const facts = await assertFrames(body, "image_mask_segment", 2);
      expect(facts).toMatchObject({
        state: "diagnostic-only",
        usable: false,
        diagnostics: {
          pointConstraintsSatisfied: false,
          failureCode: "point_constraints_unsatisfied",
        },
      });
      failedProposal = facts.proposalReceiptId;
      return [prepare(failedProposal)];
    }
    expect(step).toBe(4);
    const error = lastTool(body, "image_mask_prepare");
    expect(error).toContain("未满足严格运行和点约束");
    expect(error).toContain("仅可诊断");
    expect(error).not.toContain("image_mask_segment_inspection_required");
    return [];
  });
  expect(result.bodies).toHaveLength(4);
  expect(workerCalls).toBe(1);
  const stored = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", failedProposal)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(stored.result)).toMatchObject({
    state: "diagnostic-only",
    usable: false,
  });
  expect(await maskOperations(result.jobId)).toHaveLength(0);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
}, 30000);

it.each([
  {
    name: "disabled profile",
    status: { status: "disabled" } as SegmentationProfileStatus,
    vision: true,
  },
  {
    name: "unavailable profile",
    status: {
      status: "unavailable",
      code: "local_segmentation_unavailable",
    } as SegmentationProfileStatus,
    vision: true,
  },
  { name: "nonvisual chat model", status: undefined, vision: false },
])(
  "does not expose segmentation for $name",
  async ({ status, vision }) => {
    const paidBefore = await imageUsage();
    const result = await run(
      (body) => {
        const names = body.tools.map((tool: any) => tool.function.name);
        expect(names).not.toContain("image_mask_segment");
        // The public schema must never expose trusted installer paths or weights.
        for (const forbidden of [
          "pythonPath",
          "workerPath",
          "checkpointPath",
          "sourcePath",
          "outputDir",
        ])
          expect(JSON.stringify(body.tools)).not.toContain(forbidden);
        return [];
      },
      { profile: status, vision },
    );
    expect(result.bodies).toHaveLength(1);
    expect(workerCalls).toBe(0);
    expect(await maskOperations(result.jobId)).toHaveLength(0);
    expect(await imageUsage()).toEqual(paidBefore);
  },
  30000,
);

it("invalidates an inspected candidate after a valid coordinate-receipt change despite identical PNG bytes, then requires a fresh actual view", async () => {
  const paidBefore = await imageUsage();
  const originalGeneration = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", generationId)
    .executeTakeFirstOrThrow();
  const rawReceiptId = rawImageCandidateReceiptId(generationId);
  let rawProposal = "";
  const manual = (proposal = ""): Call => ({
    name: "image_mask_prepare",
    args: {
      ...maskInput("", proposal),
      sourceTarget: {
        ...empty(),
        include: [region(16, 12, 80, 72)],
        exclude: [region(32, 24, 48, 36)],
      },
      generatedTarget: proposal
        ? { ...empty(), proposalIds: [proposal] }
        : { ...empty(), include: [region(64, 24, 112, 72)] },
    },
  });
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [view()];
    if (step === 2) {
      const inspected = await assertFrames(body, "image_candidate_view", 3);
      expect(inspected.transform).toEqual({ kind: "full" });
      const lease = (
        await db
          .selectFrom("ai_jobs")
          .select("lease")
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow()
      ).lease!;
      const context: ToolContext = { actor: owner, jobId, lease };
      const before = await readRawImageCandidate(
        db,
        context,
        generationId,
        runtime(),
      );
      const changed = rawImageCandidateSchema.parse({
        ...before.candidate,
        transform: {
          kind: "viewport",
          rect: { left: 16, top: 0, width: 96, height: 96 },
          workspace: null,
        },
      });
      // This is a valid, sealed test record, not corrupt JSON or changed pixels.
      // Real backend reads below prove it remains independently readable.
      const { state: _state, ...candidateBase } = changed;
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(changed), digest: digest(candidateBase) })
        .where("id", "=", rawReceiptId)
        .where("user_id", "=", owner.id)
        .execute();
      const after = await readRawImageCandidate(
        db,
        context,
        generationId,
        runtime(),
      );
      expect(after.data).toEqual(before.data);
      expect(after.candidate.sha256).toBe(inspected.raw.sha256);
      expect(after.candidate.references).toEqual(before.candidate.references);
      expect(after.candidate.dimensions).toEqual(before.candidate.dimensions);
      expect(after.candidate.transform).not.toEqual(before.candidate.transform);
      return [segment("raw"), manual()];
    }
    if (step === 3) {
      expect(lastTool(body, "image_mask_segment")).toContain(
        "相同PNG字节不能授权新映射",
      );
      expect(lastTool(body, "image_mask_prepare")).toContain(
        "相同PNG字节不能授权新映射",
      );
      expect(workerCalls).toBe(0);
      expect(await maskOperations(jobId)).toHaveLength(0);
      return [view()];
    }
    if (step === 4) {
      const viewed = await assertFrames(body, "image_candidate_view", 3);
      expect(viewed.transform).toMatchObject({
        kind: "viewport",
        rect: { left: 16, top: 0, width: 96, height: 96 },
      });
      expect(viewed.generatedWindow).toEqual({
        left: 16,
        top: 0,
        width: 96,
        height: 96,
      });
      rawProposal = hostOperationId(jobId, {
        imageMaskSegment: segmentInput("raw"),
      });
      return [segment("raw")];
    }
    if (step === 5) {
      const facts = await assertFrames(body, "image_mask_segment", 2);
      expect(facts).toMatchObject({
        state: "ready",
        usable: true,
        proposalReceiptId: rawProposal,
        generatedWindow: { left: 16, top: 0, width: 96, height: 96 },
      });
      expect(workerCalls).toBe(1);
      return [manual(rawProposal)];
    }
    expect(step).toBe(6);
    const facts = await assertFrames(body, "image_mask_prepare", 2);
    expect(facts).toMatchObject({
      generatedWindow: { left: 16, top: 0, width: 96, height: 96 },
      diagnostics: { safeToCompose: true, semanticCoverage: "unverified" },
    });
    return [];
  });
  expect(result.bodies).toHaveLength(6);
  expect(workerCalls).toBe(1);
  const masks = await maskOperations(result.jobId);
  expect(masks).toHaveLength(1);
  expect(masks[0]).toMatchObject({
    version: 2,
    transform: {
      kind: "viewport",
      rect: { left: 16, top: 0, width: 96, height: 96 },
    },
    proposalBindings: [expect.objectContaining({ receiptId: rawProposal })],
  });
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", generationId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(originalGeneration.result);
}, 30000);
