import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  prepareImageEditMask,
  type ImageEditMaskInput,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import { editMask } from "../apps/server/src/services/ai/image-edit-regions.js";
import type { ImageMaskGeometryOutput } from "../apps/server/src/services/ai/image-mask-geometry.js";
import { prepareImageMaskSegment } from "../apps/server/src/services/ai/image-mask-segment.js";
import type { SegmentationProfileStatus } from "../apps/server/src/services/ai/segmentation-profile.js";
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
function maskInput(): ImageEditMaskInput {
  return {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    sourceTarget: {
      proposalIds: [],
      include: [region(16, 12, 80, 72), region(8, 80, 16, 88)],
      exclude: [region(32, 24, 48, 36)],
    },
    generatedTarget: {
      proposalIds: [],
      include: [region(64, 24, 112, 72)],
      exclude: [],
    },
    protected: {
      proposalIds: [],
      include: [region(32, 24, 48, 36), region(0, 0, 8, 8)],
      exclude: [],
    },
    allowedOcclusion: empty(),
    textEdits: empty(),
  };
}
type Call = { name: string; args: unknown };
const view = (): Call => ({
  name: "image_candidate_view",
  args: { generationOperationId: generationId },
});
const prepare = (): Call => ({ name: "image_mask_prepare", args: maskInput() });
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
  root = await mkdtemp(join(tmpdir(), "doca-image-mask-flow-"));
  owner = {
    ...(await createUser(
      db,
      { login: "mask-flow-owner", displayName: "Mask flow", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      maxSteps: 12,
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
      title: "Mask flow",
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
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function run(
  script: (body: any, step: number, jobId: string) => Promise<Call[]> | Call[],
  options: {
    segmentationProfile?: SegmentationProfileStatus;
    expectedStatus?: string;
  } = {},
) {
  const jobId = randomUUID(),
    bodies: any[] = [],
    callbackErrors: unknown[] = [];
  let imageCalls = 0;
  app = await createApp(db, {
    origin,
    storage: runtime(),
    ai: {
      segmentationProfile: options.segmentationProfile,
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async () => {
        imageCalls++;
        throw Error("Mask flow must not invoke an image provider");
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        let calls: Call[];
        try {
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
    payload: { login: "mask-flow-owner", password },
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
  expect(job?.status, job?.error).toBe(options.expectedStatus ?? "completed");
  expect(imageCalls).toBe(0);
  return { jobId, bodies, job };
}

async function seedStrictProposals() {
  const profile = await fixtureSegmentationProfile(root),
    jobId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sessionId,
      user_id: owner.id,
      model_id: "chat",
      status: "running",
      input: "{}",
      result: "{}",
      error: "",
      digest: jobId,
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const ctx = { actor: owner, jobId, lease, writable: true } as ToolContext;
  const proposals: Record<"source" | "generated" | "protected", string> = {
    source: "",
    generated: "",
    protected: "",
  };
  for (const [role, bounds] of [
    ["source", [16, 12, 80, 72]],
    ["generated", [64, 24, 112, 72]],
    ["protected", [0, 0, 8, 8]],
  ] as const) {
    const [left, top, right, bottom] = bounds,
      pixels = Buffer.alloc(128 * 96);
    for (let y = top; y < bottom; y++)
      pixels.fill(255, y * 128 + left, y * 128 + right);
    const receiptId = randomUUID();
    const result = await prepareImageMaskSegment(
      db,
      ctx,
      {
        source:
          role === "generated"
            ? { kind: "raw", generationOperationId: generationId }
            : { kind: "reference", referenceImageId: sourceId },
        targets: [
          {
            label: `${role} fixture target`,
            box: [left / 128, top / 96, right / 128, bottom / 96],
            positivePoints: [[(left + 1) / 128, (top + 1) / 96]],
            negativePoints: [[127 / 128, 95 / 96]],
          },
        ],
        exclusions: [],
      },
      receiptId,
      {
        profile,
        storage: runtime(),
        worker: fixtureSegmentationWorker(pixels),
      },
    );
    expect(result.usable).toBe(true);
    proposals[role] = receiptId;
  }
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", jobId)
    .execute();
  const input = maskInput();
  input.sourceTarget.proposalIds = [proposals.source];
  input.generatedTarget.proposalIds = [proposals.generated];
  input.protected.proposalIds = [proposals.protected];
  return { proposals, input, profile: { status: "ready", profile } as const };
}

async function assertFrames(body: any, name: string, count: number) {
  const metadata = JSON.parse(lastTool(body, name));
  for (const forbidden of [
    "base64",
    "data:image/",
    "objectKey",
    "nativeUsage",
    "profileId",
  ])
    expect(lastTool(body, name)).not.toContain(forbidden);
  const transmission = JSON.parse(metadata.at(-1).text).visualInput;
  expect(transmission).toMatchObject({
    originalImageCount: count,
    transmittedImageCount: count,
    untransmitted: [],
  });
  const images = imageParts(body);
  expect(images).toHaveLength(count);
  for (const [index, image] of images.entries()) {
    const caption = JSON.parse(image.label.text);
    expect(caption).toMatchObject({
      toolName: name,
      toolImage: index + 1,
      referenceImageId: sourceId,
      generationOperationId: generationId,
    });
    const pixels = Buffer.from(
      image.part.image_url.url.split(",")[1],
      "base64",
    );
    expect(image.part.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    const decoded = await sharp(pixels)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(
      Math.max(decoded.info.width, decoded.info.height),
    ).toBeLessThanOrEqual(1600);
    expect(decoded.data.length).toBeGreaterThan(1000);
    if (
      ["image_mask_prepare", "image_mask_view", "image_mask_refine"].includes(
        name,
      )
    ) {
      const coordinates = JSON.parse(metadata[index + 1].text);
      expect(caption.sourceRect).toEqual(coordinates.sourceRect);
      expect(caption.contentRect).toEqual(coordinates.contentRect);
      // The green intersection is translucent over blue/red fixture pixels;
      // it need not become green-dominant. Check actual pixels at a declared
      // source coordinate inside the shared target, not the legend text.
      const rect = coordinates.sourceRect,
        content = coordinates.contentRect;
      const x =
        content.left +
        Math.floor(((72 - rect.left) * content.width) / rect.width);
      const y =
        content.top +
        Math.floor(((48 - rect.top) * content.height) / rect.height);
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      const base = index === 0 ? [20, 82, 161] : [210, 40, 20];
      const overlay = [0, 185, 100],
        alpha = 90 / 255;
      for (let channel = 0; channel < 3; channel++) {
        const expected = Math.round(
          base[channel]! * (1 - alpha) + overlay[channel]! * alpha,
        );
        expect(
          Math.abs(decoded.data[offset + channel]! - expected),
        ).toBeLessThanOrEqual(12);
      }
    }
  }
  return JSON.parse(metadata[0].text);
}

it("requires actual candidate and two-frame mask inspection in later model rounds, then composes exact local RGBA without another image call", async () => {
  const paidBefore = await imageUsage();
  const assetsBefore = await db.selectFrom("assets").select("id").execute();
  const generationBefore = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", generationId)
    .executeTakeFirstOrThrow();
  let maskReceiptId = "";
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [prepare()];
    if (step === 2) {
      expect(lastTool(body, "image_mask_prepare")).toContain(
        "先单独 image_candidate_view",
      );
      expect(
        await db
          .selectFrom("ai_operations")
          .select("id")
          .where("result", "like", '%"kind":"image_edit_mask"%')
          .execute(),
      ).toHaveLength(0);
      return [view(), prepare()];
    }
    if (step === 3) {
      expect(lastTool(body, "image_mask_prepare")).toContain("后续模型轮次");
      await assertFrames(body, "image_candidate_view", 3);
      expect(
        await db
          .selectFrom("ai_operations")
          .select("id")
          .where("result", "like", '%"kind":"image_edit_mask"%')
          .execute(),
      ).toHaveLength(0);
      // Stable host operation ID lets this same response name the pending mask.
      // The actual receipt is checked next; no proof or mask is seeded here.
      const hash = digest({ jobId, input: { imageMaskPrepare: maskInput() } });
      maskReceiptId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return [prepare(), compose(maskReceiptId)];
    }
    if (step === 4) {
      expect(lastTool(body, "image_mask_compose")).toContain(
        "下一模型轮次才可合成",
      );
      expect(await imageOperations(jobId)).toHaveLength(0);
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      expect(facts).toMatchObject({
        maskReceiptId,
        referenceImageId: sourceId,
        generationOperationId: generationId,
        diagnostics: { safeToCompose: true, semanticCoverage: "unverified" },
      });
      expect(facts.coverage.editablePixels).toBeGreaterThan(0);
      expect(await imageUsage()).toEqual(paidBefore);
      return [compose(maskReceiptId)];
    }
    expect(step).toBe(5);
    expect(receipt(body, "image_mask_compose")).toMatchObject({
      state: "saved",
      origin: "local-recomposition",
      filename: "masked-result.png",
      generationOperationId: generationId,
      preservation: { protectedPixelsChanged: 0 },
    });
    return [];
  });
  expect(result.bodies).toHaveLength(5);
  const operations = await imageOperations(result.jobId);
  expect(operations).toHaveLength(1);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", operations[0].assetId)
    .executeTakeFirstOrThrow();
  expect(asset).toMatchObject({
    mime: "image/png",
    filename: "masked-result.png",
  });
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
  const rgba = (pixels: Buffer) =>
    sharp(pixels)
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
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 128; x++) {
      const inOld = x >= 16 && x < 80 && y >= 12 && y < 72;
      const inHole = x >= 32 && x < 48 && y >= 24 && y < 36;
      const inNew = x >= 64 && x < 112 && y >= 24 && y < 72;
      const inSeparate = x >= 8 && x < 16 && y >= 80 && y < 88;
      const expected =
        (inOld && !inHole) || inNew || inSeparate
          ? generated.data
          : source.data;
      const offset = (y * 128 + x) * 4;
      expect(actual.data.subarray(offset, offset + 4)).toEqual(
        expected.subarray(offset, offset + 4),
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
  expect(await db.selectFrom("assets").select("id").execute()).toHaveLength(
    assetsBefore.length + 1,
  );
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

it("refines a retained mask by compact references only after actual prior frames, then composes exact protected pixels for free", async () => {
  const input = maskInput();
  input.sourceTarget.exclude = [];
  input.protected.include = [
    ...input.protected.include,
    region(96, 30, 104, 42),
  ];
  const base = await seedRetainedMask(input),
    before = await localImageState();
  const refine: Call = {
    name: "image_mask_refine",
    args: {
      baseMaskReceiptId: base.receiptId,
      sourceExclude: [{ selection: "source-protected" }],
      allowedOcclusionAdd: [{ selection: "generated-protected" }],
      sourceInclude: [],
      generatedInclude: [],
      generatedExclude: [],
    },
  };
  let refinedId = "";
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [maskView(base.receiptId), refine];
    }
    if (step === 3) {
      expect(lastTool(body, "image_mask_refine")).toContain("下一模型轮次");
      expect(await localImageState()).toEqual(before);
      const facts = await assertFrames(body, "image_mask_view", 2);
      expect(facts.diagnostics.safeToCompose).toBe(false);
      return [refine];
    }
    if (step === 4) {
      const facts = await assertFrames(body, "image_mask_refine", 2);
      refinedId = facts.maskReceiptId;
      expect(refinedId).not.toBe(base.receiptId);
      expect(facts.refinement).toMatchObject({
        baseMaskReceiptId: base.receiptId,
        baseMaskReceiptDigest: base.digest,
        roundTripExact: true,
        semanticCoverage: "unverified",
        sourceExcluded: [
          { selection: "source-protected", selectedPixels: 192 },
        ],
        allowedOcclusionAdded: [
          { selection: "generated-protected", selectedPixels: 96 },
        ],
      });
      expect(facts.diagnostics).toMatchObject({
        protectionConflictPixels: 0,
        safeToCompose: true,
      });
      expect(facts).not.toHaveProperty("geometry");
      const state = await localImageState();
      expect(state.operations).toHaveLength(before.operations.length + 1);
      expect(state.assets).toEqual(before.assets);
      expect(state.usage).toEqual(before.usage);
      expect(state.operations.find((row) => row.id === base.receiptId)).toEqual(
        before.operations.find((row) => row.id === base.receiptId),
      );
      return [compose(refinedId)];
    }
    expect(step).toBe(5);
    expect(await imageOperations(jobId)).toHaveLength(1);
    const composed = receipt(body, "image_mask_compose");
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", composed.assetId)
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", asset.profile_id)
      .executeTakeFirstOrThrow();
    const object = await storage
      .createStorage(runtime())
      .read(
        storage.storageConfigForProfile(runtime(), profile),
        asset.object_key,
      );
    const decoded = await sharp(object).ensureAlpha().raw().toBuffer();
    const source = await sharp(sourcePixels).ensureAlpha().raw().toBuffer();
    const raw = await sharp(generatedPixels).ensureAlpha().raw().toBuffer();
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 128; x++) {
        const old =
          ((x >= 16 && x < 80 && y >= 12 && y < 72) ||
            (x >= 8 && x < 16 && y >= 80 && y < 88)) &&
          !(x >= 32 && x < 48 && y >= 24 && y < 36);
        const generated = x >= 64 && x < 112 && y >= 24 && y < 72;
        const offset = (y * 128 + x) * 4,
          expected = old || generated ? raw : source;
        expect(decoded.subarray(offset, offset + 4)).toEqual(
          expected.subarray(offset, offset + 4),
        );
      }
    return [];
  });
  expect(result.bodies).toHaveLength(5);
  expect(await imageUsage()).toEqual(before.usage);
}, 30000);

it("returns current SDK invalid-input failures without trying to preview a missing mask receipt", async () => {
  const before = await localImageState();
  const result = await run(async (body, step) => {
    if (step === 1) return [{ name: "image_mask_prepare", args: {} }];
    if (step === 2) {
      expect(lastTool(body, "image_mask_prepare")).toContain('"error":true');
      expect(lastTool(body, "image_mask_prepare")).toContain("不是成功回执");
      expect(imageParts(body)).toHaveLength(0);
      expect(await localImageState()).toEqual(before);
      return [view()];
    }
    expect(step).toBe(3);
    await assertFrames(body, "image_candidate_view", 3);
    expect(await localImageState()).toEqual(before);
    return [];
  });
  expect(result.bodies).toHaveLength(3);
}, 30000);

it("sends all native region PNG pixels through the real SDK without granting full-mask composition proof", async () => {
  const base = await seedRetainedMask(),
    before = await localImageState();
  const rect = { left: 16, top: 12, width: 64, height: 60 };
  const regionView: Call = {
    name: "image_mask_region_view",
    args: {
      maskReceiptId: base.receiptId,
      region: {
        left: rect.left / 128,
        top: rect.top / 96,
        width: rect.width / 128,
        height: rect.height / 96,
      },
      points: [[32 / 128, 24 / 96]],
    },
  };
  const result = await run(async (body, step) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [regionView];
    }
    if (step === 3) {
      const facts = receipt(body, "image_mask_region_view");
      expect(facts).toMatchObject({
        readonly: true,
        state: "diagnostic-only",
        nativeRect: rect,
        points: [{ pixel: { x: 32, y: 24 }, S: 0, G: 0, P: 255, selected: 0 }],
      });
      const frames = imageParts(body);
      expect(frames).toHaveLength(3);
      for (const [index, frame] of frames.entries()) {
        expect(frame.part.image_url.url).toMatch(/^data:image\/png;base64,/);
        const label = JSON.parse(frame.label.text);
        expect(label).toMatchObject({
          toolName: "image_mask_region_view",
          sourceRect: rect,
          coordinateSpace: "source",
        });
        const bytes = Buffer.from(
          frame.part.image_url.url.split(",")[1],
          "base64",
        );
        const decoded = await sharp(bytes)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(decoded.info).toMatchObject({
          width: rect.width,
          height: rect.height,
          channels: 4,
        });
        if (index < 2) {
          const expected = await sharp(
            index === 0 ? sourcePixels : generatedPixels,
          )
            .ensureAlpha()
            .extract(rect)
            .raw()
            .toBuffer();
          expect(decoded.data.equals(expected)).toBe(true);
        }
      }
      expect(await localImageState()).toEqual(before);
      return [compose(base.receiptId)];
    }
    if (step === 4) {
      expect(lastTool(body, "image_mask_compose")).toContain("image_mask_view");
      expect(await localImageState()).toEqual(before);
      return [maskView(base.receiptId)];
    }
    expect(step).toBe(5);
    await assertFrames(body, "image_mask_view", 2);
    return [];
  });
  expect(result.bodies).toHaveLength(5);
  expect(await localImageState()).toEqual(before);
}, 30000);

/** A real immutable mask from a completed prior job, without runtime proof. */
async function seedRetainedMask(input = maskInput()) {
  const jobId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      user_id: owner.id,
      session_id: sessionId,
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
  const receipt = await prepareImageEditMask(
    db,
    { actor: owner, jobId, lease },
    input,
    randomUUID(),
    { storage: runtime() },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", jobId)
    .execute();
  return receipt;
}
const maskView = (maskReceiptId: string): Call => ({
  name: "image_mask_view",
  args: { maskReceiptId },
});
const maskGeometry = (maskReceiptId: string): Call => ({
  name: "image_mask_geometry",
  args: { maskReceiptId, selection: "generated-protected" },
});
async function localImageState() {
  return {
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    files: await db
      .selectFrom("file_items")
      .selectAll()
      .orderBy("id")
      .execute(),
    usage: await imageUsage(),
  };
}

it("restores a retained old-job mask only after actual candidate and two-frame later-round viewing, then computes geometry and composes exact free pixels", async () => {
  const input = maskInput();
  input.protected.include = [
    ...input.protected.include,
    region(96, 30, 104, 42),
  ];
  input.allowedOcclusion.include = [region(96, 30, 104, 42)];
  const savedMask = await seedRetainedMask(input),
    before = await localImageState();
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [maskView(savedMask.receiptId)];
    if (step === 2) {
      expect(lastTool(body, "image_mask_view")).toContain(
        "image_candidate_view",
      );
      expect(await localImageState()).toEqual(before);
      return [view(), maskView(savedMask.receiptId)];
    }
    if (step === 3) {
      expect(lastTool(body, "image_mask_view")).toMatch(
        /后续模型轮次|下一轮|下一模型轮次/,
      );
      await assertFrames(body, "image_candidate_view", 3);
      expect(await localImageState()).toEqual(before);
      return [
        maskView(savedMask.receiptId),
        maskGeometry(savedMask.receiptId),
        compose(savedMask.receiptId),
      ];
    }
    if (step === 4) {
      expect(lastTool(body, "image_mask_geometry")).toContain("下一模型轮次");
      expect(lastTool(body, "image_mask_compose")).toMatch(
        /下一模型轮次|完整覆盖诊断/,
      );
      const facts = await assertFrames(body, "image_mask_view", 2);
      expect(facts).toMatchObject({
        readonly: true,
        version: 2,
        maskReceiptId: savedMask.receiptId,
        digest: savedMask.digest,
        generationOperationId: generationId,
        referenceImageId: sourceId,
        diagnostics: { semanticCoverage: "unverified", safeToCompose: true },
      });
      expect(await localImageState()).toEqual(before);
      return [maskGeometry(savedMask.receiptId)];
    }
    if (step === 5) {
      const geometry = JSON.parse(lastTool(body, "image_mask_geometry"));
      expect(geometry).toMatchObject({
        state: "ready",
        maskReceiptId: savedMask.receiptId,
        maskReceiptDigest: savedMask.digest,
        diagnostics: {
          selectedPixels: 96,
          roundTripExact: true,
          semanticCoverage: "unverified",
        },
      });
      expect(geometry.geometry).toEqual({
        proposalIds: [],
        include: [
          {
            label: "pixel rectangle 1",
            points: [
              [96 / 128, 30 / 96],
              [104 / 128, 30 / 96],
              [104 / 128, 42 / 96],
              [96 / 128, 42 / 96],
            ],
          },
        ],
        exclude: [],
      });
      expect(await localImageState()).toEqual(before);
      return [compose(savedMask.receiptId)];
    }
    expect(step).toBe(6);
    expect(receipt(body, "image_mask_compose")).toMatchObject({
      state: "saved",
      origin: "local-recomposition",
      generationOperationId: generationId,
    });
    expect(await imageOperations(jobId)).toHaveLength(1);
    return [];
  });
  const operation = (await imageOperations(result.jobId))[0],
    asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", operation.assetId)
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
  const actual = await sharp(final).ensureAlpha().raw().toBuffer(),
    original = await sharp(sourcePixels).ensureAlpha().raw().toBuffer(),
    generated = await sharp(generatedPixels).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 128; x++) {
      const old = x >= 16 && x < 80 && y >= 12 && y < 72,
        hole = x >= 32 && x < 48 && y >= 24 && y < 36,
        added = x >= 64 && x < 112 && y >= 24 && y < 72,
        separate = x >= 8 && x < 16 && y >= 80 && y < 88,
        expected = (old && !hole) || added || separate ? generated : original,
        offset = (y * 128 + x) * 4;
      expect(actual.subarray(offset, offset + 4)).toEqual(
        expected.subarray(offset, offset + 4),
      );
    }
  expect(await imageUsage()).toEqual(before.usage);
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", savedMask.receiptId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(JSON.stringify(savedMask));
  expect(result.bodies).toHaveLength(6);
}, 30000);

it("atomically withholds both retained-mask frames when the budget has one slot and invalidates its previous real-view proof", async () => {
  const savedMask = await seedRetainedMask(),
    before = await localImageState();
  const result = await run(async (body, step) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [maskView(savedMask.receiptId)];
    }
    if (step === 3) {
      await assertFrames(body, "image_mask_view", 2);
      return [
        {
          name: "image_view",
          args: { referenceImageIds: [sourceId, seedAssetId] },
        },
        { name: "image_view", args: { referenceImageIds: [sourceId] } },
        maskView(savedMask.receiptId),
      ];
    }
    if (step === 4) {
      const metadata = JSON.parse(lastTool(body, "image_mask_view"));
      expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
        originalImageCount: 2,
        transmittedImageCount: 0,
      });
      expect(
        JSON.parse(metadata.at(-1).text).visualInput.untransmitted,
      ).toHaveLength(2);
      expect(receipt(body, "image_mask_view").maskReceiptId).toBe(
        savedMask.receiptId,
      );
      expect(imageParts(body)).toHaveLength(3);
      expect(
        imageParts(body).every(
          (pair: any) => JSON.parse(pair.label.text).toolName === "image_view",
        ),
      ).toBe(true);
      expect(await localImageState()).toEqual(before);
      return [maskGeometry(savedMask.receiptId), compose(savedMask.receiptId)];
    }
    expect(step).toBe(5);
    expect(lastTool(body, "image_mask_geometry")).toContain(
      "实际查看完整与局部诊断",
    );
    expect(lastTool(body, "image_mask_compose")).toContain(
      "实际查看完整覆盖诊断",
    );
    return [];
  });
  expect(result.bodies).toHaveLength(5);
  expect(await localImageState()).toEqual(before);
}, 30000);

it.each(["source-acl", "mask-digest"] as const)(
  "keeps a retained mask and refuses view, geometry and compose after %s changes",
  async (kind) => {
    const savedMask = await seedRetainedMask();
    let before: Awaited<ReturnType<typeof localImageState>>;
    const result = await run(async (body, step) => {
      if (step === 1) return [view()];
      if (step === 2) {
        await assertFrames(body, "image_candidate_view", 3);
        return [maskView(savedMask.receiptId)];
      }
      if (step === 3) {
        await assertFrames(body, "image_mask_view", 2);
        if (kind === "source-acl")
          await db
            .updateTable("assets")
            .set({ deleted_at: new Date().toISOString() })
            .where("id", "=", sourceId)
            .execute();
        else
          await db
            .updateTable("ai_operations")
            .set({
              result: JSON.stringify({
                ...savedMask,
                maskDigest: "f".repeat(64),
              }),
            })
            .where("id", "=", savedMask.receiptId)
            .execute();
        before = await localImageState();
        return [maskView(savedMask.receiptId)];
      }
      if (step === 4) {
        expect(lastTool(body, "image_mask_view")).not.toContain(
          '"readonly":true',
        );
        // The runtime may retain the previous complete visual exchange in
        // history. No frame can belong to this failed, newly issued view.
        const failedCallId = body.messages
          .flatMap((message: any) =>
            message.role === "assistant" ? (message.tool_calls ?? []) : [],
          )
          .findLast(
            (call: any) => call.function?.name === "image_mask_view",
          )?.id;
        expect(failedCallId).toBeDefined();
        for (const pair of imageParts(body))
          expect(JSON.parse(pair.label.text).toolCallId).not.toBe(failedCallId);
        expect(await localImageState()).toEqual(before);
        return [
          maskGeometry(savedMask.receiptId),
          compose(savedMask.receiptId),
        ];
      }
      expect(step).toBe(5);
      expect(lastTool(body, "image_mask_geometry")).not.toContain(
        '"state":"ready"',
      );
      expect(lastTool(body, "image_mask_compose")).not.toContain(
        '"state":"saved"',
      );
      expect(await localImageState()).toEqual(before);
      return [];
    });
    expect(result.bodies).toHaveLength(5);
    expect(await localImageState()).toEqual(before!);
  },
  30000,
);

it("does not grant compose proof when ordinary images consume the budget and mask metadata arrives without its two diagnostic frames", async () => {
  const paidBefore = await imageUsage(),
    assetsBefore = await db.selectFrom("assets").selectAll().execute();
  let maskReceiptId = "";
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
        prepare(),
      ];
    }
    if (step === 3) {
      const facts = receipt(body, "image_mask_prepare");
      maskReceiptId = facts.maskReceiptId;
      expect(facts.diagnostics.safeToCompose).toBe(true);
      const metadata = JSON.parse(lastTool(body, "image_mask_prepare"));
      expect(
        JSON.parse(metadata.at(-1).text).visualInput,
        JSON.stringify({
          ordinary: lastTool(body, "image_view"),
          labels: imageParts(body).map((pair: any) => pair.label.text),
        }),
      ).toMatchObject({
        originalImageCount: 2,
        transmittedImageCount: 0,
      });
      expect(
        JSON.parse(metadata.at(-1).text).visualInput.untransmitted,
      ).toHaveLength(2);
      expect(
        metadata
          .slice(1, 3)
          .map((part: any) => JSON.parse(part.text).sourceRect),
      ).toHaveLength(2);
      expect(imageParts(body)).toHaveLength(3);
      for (const pair of imageParts(body))
        expect(JSON.parse(pair.label.text).toolName).toBe("image_view");
      expect(lastTool(body, "image_mask_prepare")).not.toContain("base64");
      return [compose(maskReceiptId)];
    }
    expect(step).toBe(4);
    expect(lastTool(body, "image_mask_compose")).toContain(
      "实际查看完整覆盖诊断",
    );
    return [];
  });
  expect(result.bodies).toHaveLength(4);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    assetsBefore,
  );
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("id", "=", maskReceiptId)
      .executeTakeFirst(),
  ).toBeDefined();
}, 30000);

it("rejects geometry without a mask proof, in the prepare round, and after a durable receipt's actual frames are omitted", async () => {
  const paidBefore = await imageUsage(),
    assetsBefore = await db.selectFrom("assets").selectAll().execute();
  const operationsBefore = await db
    .selectFrom("ai_operations")
    .selectAll()
    .execute();
  let maskReceiptId = "",
    snapshot: typeof operationsBefore = [];
  const geometry = (id: string): Call => ({
    name: "image_mask_geometry",
    args: { maskReceiptId: id, selection: "conflicts" },
  });
  const result = await run(async (body, step, jobId) => {
    if (step === 1) return [geometry(randomUUID())];
    if (step === 2) {
      expect(lastTool(body, "image_mask_geometry")).toContain("下一模型轮次");
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toEqual(operationsBefore);
      return [view()];
    }
    if (step === 3) {
      await assertFrames(body, "image_candidate_view", 3);
      const hash = digest({ jobId, input: { imageMaskPrepare: maskInput() } });
      maskReceiptId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return [prepare(), geometry(maskReceiptId)];
    }
    if (step === 4) {
      expect(lastTool(body, "image_mask_geometry")).toContain("下一模型轮次");
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      expect(facts.maskReceiptId).toBe(maskReceiptId);
      snapshot = await db.selectFrom("ai_operations").selectAll().execute();
      expect(snapshot).toHaveLength(operationsBefore.length + 1);
      // The idempotent prepare invalidates its prior proof. Ordinary frames
      // occupy the budget, so this durable receipt must not regain proof.
      return [
        {
          name: "image_view",
          args: { referenceImageIds: [sourceId, seedAssetId] },
        },
        { name: "image_view", args: { referenceImageIds: [sourceId] } },
        prepare(),
      ];
    }
    if (step === 5) {
      expect(receipt(body, "image_mask_prepare").maskReceiptId).toBe(
        maskReceiptId,
      );
      const metadata = JSON.parse(lastTool(body, "image_mask_prepare"));
      expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
        originalImageCount: 2,
        transmittedImageCount: 0,
      });
      expect(imageParts(body)).toHaveLength(3);
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toEqual(snapshot);
      return [geometry(maskReceiptId)];
    }
    expect(step).toBe(6);
    expect(lastTool(body, "image_mask_geometry")).toContain(
      "实际查看完整与局部诊断",
    );
    expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
      snapshot,
    );
    return [];
  });
  expect(result.bodies).toHaveLength(6);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    assetsBefore,
  );
}, 30000);

it("returns exact later-round G∩P∩clip minus text geometry, feeds it back into prepare, and keeps source/conflict math read-only", async () => {
  const paidBefore = await imageUsage(),
    assetsBefore = await db.selectFrom("assets").selectAll().execute();
  const operationsBefore = await db
    .selectFrom("ai_operations")
    .selectAll()
    .execute();
  const input = maskInput();
  input.protected = {
    proposalIds: [],
    include: [region(88, 30, 104, 50), region(70, 34, 78, 44)],
    exclude: [region(94, 38, 98, 42)],
  };
  input.textEdits = {
    proposalIds: [],
    include: [region(90, 32, 92, 34)],
    exclude: [],
  };
  const clipRegions = [region(90, 30, 100, 48)];
  const prepareInput = (args: ImageEditMaskInput): Call => ({
    name: "image_mask_prepare",
    args,
  });
  const geometry = (
    id: string,
    selection: "generated-protected" | "source-protected" | "conflicts",
    clip = false,
  ): Call => ({
    name: "image_mask_geometry",
    args: { maskReceiptId: id, selection, ...(clip ? { clipRegions } : {}) },
  });
  let firstReceiptId = "",
    secondReceiptId = "",
    firstReceipt = "",
    snapshot: typeof operationsBefore = [];
  async function checkExact(
    facts: ImageMaskGeometryOutput,
    expected: (x: number, y: number) => boolean,
  ) {
    expect(facts.state).toBe("ready");
    expect(facts.geometry).not.toBeNull();
    expect(facts.diagnostics).toMatchObject({
      semanticCoverage: "unverified",
      roundTripExact: true,
      failure: null,
    });
    expect(facts.geometry!.proposalIds).toEqual([]);
    const actual = Buffer.alloc(128 * 96);
    for (const [key, value] of [
      ["include", 255],
      ["exclude", 0],
    ] as const) {
      if (!facts.geometry![key].length) continue;
      const rendered = await editMask(sourcePixels, facts.geometry![key]);
      const alpha = await sharp(rendered)
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer();
      for (let i = 0; i < actual.length; i++)
        if (alpha[i] === 0) actual[i] = value;
    }
    let count = 0;
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 128; x++) {
        const selected = expected(x, y);
        if (selected) count++;
        expect(actual[y * 128 + x], `pixel ${x},${y}`).toBe(selected ? 255 : 0);
      }
    expect(facts.diagnostics.selectedPixels).toBe(count);
  }
  const result = await run(async (body, step) => {
    if (step === 1) return [view()];
    if (step === 2) {
      await assertFrames(body, "image_candidate_view", 3);
      return [prepareInput(input)];
    }
    if (step === 3) {
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      firstReceiptId = facts.maskReceiptId;
      expect(facts.diagnostics).toMatchObject({
        protectionConflictPixels: 384,
        safeToCompose: false,
      });
      snapshot = await db.selectFrom("ai_operations").selectAll().execute();
      expect(snapshot).toHaveLength(operationsBefore.length + 1);
      firstReceipt = snapshot.find((row) => row.id === firstReceiptId)!.result;
      return [geometry(firstReceiptId, "generated-protected", true)];
    }
    if (step === 4) {
      const facts = JSON.parse(
        lastTool(body, "image_mask_geometry"),
      ) as ImageMaskGeometryOutput;
      expect(facts).toMatchObject({
        maskReceiptId: firstReceiptId,
        referenceImageId: sourceId,
        generationOperationId: generationId,
        source: { width: 128, height: 96 },
      });
      expect(facts.maskReceiptDigest).toBe(JSON.parse(firstReceipt).digest);
      expect(facts.maskDigest).toBe(JSON.parse(firstReceipt).maskDigest);
      expect(facts.diagnostics.bounds).toEqual({
        left: 90,
        top: 30,
        width: 10,
        height: 18,
      });
      expect(facts.instruction).toContain("不是真实轮廓、遮挡授权或语义验收");
      await checkExact(
        facts,
        (x, y) =>
          x >= 90 &&
          x < 100 &&
          y >= 30 &&
          y < 48 &&
          !(x >= 94 && x < 98 && y >= 38 && y < 42) &&
          !(x >= 90 && x < 92 && y >= 32 && y < 34),
      );
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toEqual(snapshot);
      return [prepareInput({ ...input, allowedOcclusion: facts.geometry! })];
    }
    if (step === 5) {
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      secondReceiptId = facts.maskReceiptId;
      expect(secondReceiptId).not.toBe(firstReceiptId);
      expect(facts.coverage.allowedOcclusionPixels).toBe(160);
      expect(facts.diagnostics).toMatchObject({
        protectionConflictPixels: 224,
        textConflictPixels: 4,
        safeToCompose: false,
      });
      snapshot = await db.selectFrom("ai_operations").selectAll().execute();
      expect(snapshot).toHaveLength(operationsBefore.length + 2);
      expect(snapshot.find((row) => row.id === firstReceiptId)!.result).toBe(
        firstReceipt,
      );
      return [geometry(firstReceiptId, "source-protected")];
    }
    if (step === 6) {
      const facts = JSON.parse(
        lastTool(body, "image_mask_geometry"),
      ) as ImageMaskGeometryOutput;
      await checkExact(facts, (x, y) => x >= 70 && x < 78 && y >= 34 && y < 44);
      expect(facts.maskReceiptId).toBe(firstReceiptId);
      expect(
        await db.selectFrom("ai_operations").selectAll().execute(),
      ).toEqual(snapshot);
      return [geometry(secondReceiptId, "conflicts", true)];
    }
    expect(step).toBe(7);
    const facts = JSON.parse(
      lastTool(body, "image_mask_geometry"),
    ) as ImageMaskGeometryOutput;
    expect(facts.maskReceiptId).toBe(secondReceiptId);
    await checkExact(facts, (x, y) => x >= 90 && x < 92 && y >= 32 && y < 34);
    expect(facts.instruction).toContain("conflicts仅用于诊断");
    expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
      snapshot,
    );
    return [];
  });
  expect(result.bodies).toHaveLength(7);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
  expect(await imageUsage()).toEqual(paidBefore);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    assetsBefore,
  );
}, 30000);

it("lists every missing proposal and its exact segment-view recovery through the real SDK, then prepares only after all complete diagnostics reach later model rounds", async () => {
  const seeded = await seedStrictProposals(),
    paidBefore = await imageUsage();
  const prepareBound: Call = { name: "image_mask_prepare", args: seeded.input };
  const masks = async (jobId: string) =>
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", jobId)
      .where("result", "like", '%"kind":"image_edit_mask"%')
      .execute();
  const result = await run(
    async (body, step, jobId) => {
      if (step === 1) return [view()];
      if (step === 2) return [prepareBound];
      if (step === 3) {
        const failure = JSON.parse(lastTool(body, "image_mask_prepare"));
        expect(failure.code).toBe("image_mask_segment_inspection_required");
        expect(failure.missingProposalIds.sort()).toEqual(
          Object.values(seeded.proposals).sort(),
        );
        expect(
          failure.next.map((call: any) => call.input.proposalReceiptId).sort(),
        ).toEqual(Object.values(seeded.proposals).sort());
        expect(
          failure.proposals.find(
            (p: any) => p.receiptId === seeded.proposals.generated,
          ),
        ).toMatchObject({
          source: { kind: "raw", generationOperationId: generationId },
          usable: true,
          groups: ["generatedTarget"],
        });
        expect(await masks(jobId)).toHaveLength(0);
        expect(lastTool(body, "image_mask_prepare")).not.toMatch(
          /objectKey|profileId|base64|nativeUsage/,
        );
        return [
          {
            name: "image_mask_segment_view",
            args: { proposalReceiptId: seeded.proposals.source },
          },
        ];
      }
      if (step === 4) {
        expect(imageParts(body)).toHaveLength(2);
        return [prepareBound];
      }
      if (step === 5) {
        const failure = JSON.parse(lastTool(body, "image_mask_prepare"));
        expect(failure.missingProposalIds.sort()).toEqual(
          [seeded.proposals.generated, seeded.proposals.protected].sort(),
        );
        expect(await masks(jobId)).toHaveLength(0);
        return [
          ...failure.next.map((call: any) => ({
            name: call.toolName,
            args: call.input,
          })),
          prepareBound,
        ];
      }
      if (step === 6) {
        expect(imageParts(body)).toHaveLength(4);
        expect(
          JSON.parse(
            lastTool(body, "image_mask_prepare"),
          ).missingProposalIds.sort(),
        ).toEqual(
          [seeded.proposals.generated, seeded.proposals.protected].sort(),
        );
        expect(await masks(jobId)).toHaveLength(0);
        return [prepareBound];
      }
      expect(step).toBe(7);
      const facts = await assertFrames(body, "image_mask_prepare", 2);
      expect(facts.referenceImageId).toBe(sourceId);
      expect(facts.generationOperationId).toBe(generationId);
      expect(await masks(jobId)).toHaveLength(1);
      return [];
    },
    { segmentationProfile: seeded.profile },
  );
  expect(result.bodies).toHaveLength(7);
  expect(await imageUsage()).toEqual(paidBefore);
  expect(await imageOperations(result.jobId)).toHaveLength(0);
});

it("rejects proposal source/group confusion before asking for proof and reports each real source without inferring semantic roles from labels", async () => {
  const seeded = await seedStrictProposals(),
    paidBefore = await imageUsage(),
    assetsBefore = await db.selectFrom("assets").selectAll().execute();
  const wrong = structuredClone(seeded.input);
  wrong.sourceTarget.proposalIds = [
    seeded.proposals.generated,
    seeded.proposals.protected,
  ];
  wrong.generatedTarget.proposalIds = [seeded.proposals.source];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [{ name: "image_mask_prepare", args: wrong }];
      expect(step).toBe(2);
      const failure = JSON.parse(lastTool(body, "image_mask_prepare"));
      expect(failure.code).toBe("image_mask_proposal_binding_mismatch");
      expect(failure.issues).toEqual(
        expect.arrayContaining([
          {
            proposalReceiptId: seeded.proposals.generated,
            group: "sourceTarget",
            expectedSourceKind: "reference",
          },
          {
            proposalReceiptId: seeded.proposals.source,
            group: "generatedTarget",
            expectedSourceKind: "raw",
          },
        ]),
      );
      expect(failure.issues).toHaveLength(2);
      expect(
        failure.proposals.find(
          (p: any) => p.receiptId === seeded.proposals.protected,
        ),
      ).toMatchObject({
        source: { kind: "reference", referenceImageId: sourceId },
        usable: true,
        groups: ["sourceTarget", "protected"],
        targetLabels: ["protected fixture target"],
      });
      expect(lastTool(body, "image_mask_prepare")).not.toMatch(
        /objectKey|profileId|nativeUsage|base64/,
      );
      return [];
    },
    { segmentationProfile: seeded.profile },
  );
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("job_id", "=", result.jobId)
      .execute(),
  ).toHaveLength(0);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    assetsBefore,
  );
  expect(await imageUsage()).toEqual(paidBefore);
});

it("keeps a proposal missing when its receipt and labels arrive but the four-frame budget withholds its two actual diagnostics", async () => {
  const seeded = await seedStrictProposals(),
    paidBefore = await imageUsage(),
    assetsBefore = await db.selectFrom("assets").selectAll().execute();
  const input = maskInput();
  input.sourceTarget.proposalIds = [seeded.proposals.source];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [view()];
      if (step === 2) return [{ name: "image_mask_prepare", args: input }];
      if (step === 3) {
        expect(
          JSON.parse(lastTool(body, "image_mask_prepare")).missingProposalIds,
        ).toEqual([seeded.proposals.source]);
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [sourceId, seedAssetId] },
          },
          { name: "image_view", args: { referenceImageIds: [sourceId] } },
          {
            name: "image_mask_segment_view",
            args: { proposalReceiptId: seeded.proposals.source },
          },
        ];
      }
      if (step === 4) {
        const output = JSON.parse(lastTool(body, "image_mask_segment_view"));
        expect(JSON.parse(output.at(-1).text).visualInput).toMatchObject({
          originalImageCount: 2,
          transmittedImageCount: 0,
        });
        expect(imageParts(body)).toHaveLength(3);
        return [{ name: "image_mask_prepare", args: input }];
      }
      expect(step).toBe(5);
      const failure = JSON.parse(lastTool(body, "image_mask_prepare"));
      expect(failure.missingProposalIds).toEqual([seeded.proposals.source]);
      expect(failure.next).toEqual([
        {
          toolName: "image_mask_segment_view",
          input: { proposalReceiptId: seeded.proposals.source },
        },
      ]);
      return [{ name: "image_mask_prepare", args: input }];
    },
    { segmentationProfile: seeded.profile, expectedStatus: "failed" },
  );
  expect(result.bodies).toHaveLength(5);
  expect(result.job.error).toContain("连续三次");
  expect(
    await db
      .selectFrom("ai_operations")
      .select("id")
      .where("job_id", "=", result.jobId)
      .execute(),
  ).toHaveLength(0);
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(
    assetsBefore,
  );
  expect(await imageUsage()).toEqual(paidBefore);
});
