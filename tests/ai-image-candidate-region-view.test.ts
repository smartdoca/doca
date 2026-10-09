import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { readRawImageCandidate } from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import { rawImageCandidateCanvas } from "../apps/server/src/services/ai/image-candidates.js";
import { hoistToolImages } from "../apps/server/src/services/ai/tool-media.js";
import {
  imageCandidateRegionViewInputSchema,
  imageCandidateRegionViewOutputSchema,
  viewImageCandidateRegion,
  imageCandidateRegionViewModelOutput,
  type ImageCandidateRegionViewInput,
} from "../apps/server/src/services/ai/image-candidate-region-view.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  ctx: ToolContext,
  sessionId: string,
  sourceId: string,
  operationId: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const password = "isolated-candidate-view-2026",
  origin = "http://localhost:39321";
const runtime = () => ({ ...storage.storageRuntime(), root });
const nativeMarker = "provider-native-usage-is-private";

beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-candidate-view-"));
  owner = {
    ...(await createUser(
      db,
      { login: "candidate-owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      maxSteps: 8,
      vendors: [
        {
          id: "mock",
          name: "Mock",
          provider: "compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "isolated-only",
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
  operationId = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Candidate",
      model_id: "chat",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  ctx = await newJob(sessionId);
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: [sourceId] }) })
    .where("id", "=", ctx.jobId!)
    .execute();
  const source = await sharp({
    create: { width: 1500, height: 2000, channels: 3, background: "#1452a1" },
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
      source,
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
      size: source.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function newJob(session: string) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      session_id: session,
      user_id: owner.id,
      model_id: "chat",
      status: "running",
      input: "{}",
      digest: id,
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
  return { actor: owner, jobId: id, lease, writable: true } as ToolContext;
}
const regions = [
  {
    label: "native coordinate fixture",
    points: [
      [464.5 / 1500, 627.5 / 2000],
      [1321.5 / 1500, 627.5 / 2000],
      [1321.5 / 1500, 1656.5 / 2000],
      [464.5 / 1500, 1656.5 / 2000],
    ] as [number, number][],
  },
];
async function generate() {
  // Deliberately equal source/raw dimensions: source coordinates still require
  // the recorded padded workspace transform rather than native raw sampling.
  const pixels = Buffer.alloc(1500 * 2000 * 4);
  for (let y = 0; y < 2000; y++)
    for (let x = 0; x < 1500; x++) {
      const i = (y * 1500 + x) * 4;
      pixels[i] = Math.floor(x / 6);
      pixels[i + 1] = Math.floor(y / 8);
      pixels[i + 2] = 30;
      pixels[i + 3] = 255;
    }
  const png = await sharp(pixels, {
    raw: { width: 1500, height: 2000, channels: 4 },
  })
    .png()
    .toBuffer();
  return generateImageAsset(
    db,
    ctx,
    {
      prompt: "修改目标",
      referenceImageIds: [sourceId],
      editRegions: regions,
      size: "1536x2048",
    },
    operationId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: png.toString("base64") }],
          usage: { input_images: 1, note: nativeMarker },
        })) as typeof fetch,
    },
  );
}
function input(): ImageCandidateRegionViewInput {
  return {
    generationOperationId: operationId,
    region: {
      left: 300 / 1500,
      top: 470 / 2000,
      width: 550 / 1500,
      height: 400 / 2000,
    },
    points: [
      [300 / 1500, 470 / 2000],
      [840 / 1500, 820 / 2000],
    ],
  };
}
async function snapshot() {
  return Promise.all([
    db.selectFrom("assets").selectAll().execute(),
    db.selectFrom("file_storage_objects").selectAll().execute(),
    db.selectFrom("file_items").selectAll().execute(),
    db.selectFrom("ai_operations").selectAll().execute(),
    db.selectFrom("ai_calls").selectAll().execute(),
  ]);
}
const options = () => ({ storage: runtime(), vision: true });
const rgba = (data: Buffer, width: number, x: number, y: number) => [
  ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

it("projects equal-sized raw through the actual padded viewport and returns two native PNG crops with exact point facts, without writes or image usage", async () => {
  await generate();
  const before = await snapshot(),
    usage = await usageSummary(db, owner.id);
  const raw = await readRawImageCandidate(db, ctx, operationId, runtime());
  expect(raw.candidate.transform).toEqual({
    kind: "viewport",
    rect: { left: 310, top: 473, width: 1166, height: 1338 },
    workspace: {
      width: 1166,
      height: 1555,
      left: 0,
      top: 108,
      contentWidth: 1166,
      contentHeight: 1338,
    },
  });
  const facts = await viewImageCandidateRegion(
    db,
    { ...ctx, writable: false },
    input(),
    options(),
  );
  expect(imageCandidateRegionViewOutputSchema.parse(facts)).toEqual(facts);
  expect(facts).toMatchObject({
    readonly: true,
    source: { width: 1500, height: 2000 },
    raw: { nativeSize: { width: 1500, height: 2000 } },
    nativeRect: { left: 300, top: 470, width: 550, height: 400 },
    coverage: {
      generatedPixels: 540 * 397,
      ungeneratedPixels: 220000 - 540 * 397,
      totalPixels: 220000,
    },
  });
  expect(facts.points[0]).toMatchObject({
    pixel: { x: 300, y: 470 },
    generated: false,
    rawOrigin: "source-outside-generation-window",
    sourceRGBA: [20, 82, 161, 255],
    rawRGBA: [20, 82, 161, 255],
  });
  const canvas = await sharp(
    await rawImageCandidateCanvas(
      raw.candidate,
      raw.data,
      raw.sources[0]!.data,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
  const nativeRaw = await sharp(raw.data).ensureAlpha().raw().toBuffer();
  expect(facts.points[1]).toMatchObject({
    pixel: { x: 840, y: 820 },
    generated: true,
    rawOrigin: "generated-candidate",
    rawRGBA: rgba(canvas, 1500, 840, 820),
  });
  expect(facts.points[1]!.rawRGBA).not.toEqual(rgba(nativeRaw, 1500, 840, 820));
  const output = await imageCandidateRegionViewModelOutput(
    db,
    ctx,
    input(),
    facts,
    options(),
  );
  const media = output.value.filter((part) => part.type === "media");
  expect(media).toHaveLength(2);
  for (const [index, frame] of media.entries()) {
    expect(frame.mediaType).toBe("image/png");
    const decoded = await sharp(Buffer.from(frame.data, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({
      width: 550,
      height: 400,
      channels: 4,
    });
    expect(rgba(decoded.data, 550, 540, 350)).toEqual(
      index === 0 ? facts.points[1]!.sourceRGBA : facts.points[1]!.rawRGBA,
    );
  }
  expect(JSON.stringify(facts)).not.toMatch(
    /nativeUsage|objectKey|profileId|base64|provider-native/,
  );
  expect(await snapshot()).toEqual(before);
  expect(await usageSummary(db, owner.id)).toEqual(usage);
});

it("uses strict mandatory inputs and floor/ceil without fitting oversize crops; coordinate 1 samples the final source pixel", async () => {
  await generate();
  for (const bad of [
    { generationOperationId: operationId },
    { ...input(), points: undefined },
    { ...input(), extra: true },
    { ...input(), points: Array.from({ length: 17 }, () => [0.3, 0.3]) },
    { ...input(), region: { left: 0.9, top: 0, width: 0.2, height: 0.1 } },
  ])
    expect(imageCandidateRegionViewInputSchema.safeParse(bad).success).toBe(
      false,
    );
  await expect(
    viewImageCandidateRegion(
      db,
      ctx,
      {
        ...input(),
        region: { left: 0, top: 0, width: 1, height: 0.1 },
        points: [],
      },
      options(),
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    viewImageCandidateRegion(
      db,
      ctx,
      { ...input(), points: [[1, 1]] },
      options(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  const facts = await viewImageCandidateRegion(
    db,
    ctx,
    {
      generationOperationId: operationId,
      region: {
        left: 1498.2 / 1500,
        top: 1998.2 / 2000,
        width: 1.8 / 1500,
        height: 1.8 / 2000,
      },
      points: [[1, 1]],
    },
    options(),
  );
  expect(facts.nativeRect).toEqual({
    left: 1498,
    top: 1998,
    width: 2,
    height: 2,
  });
  expect(facts.points[0]).toMatchObject({
    pixel: { x: 1499, y: 1999 },
    generated: false,
    rawRGBA: [20, 82, 161, 255],
  });
});

it("reauthorizes source/raw and rejects changed facts, revoked ACL, wrong session, nonvision and cancellation", async () => {
  await generate();
  const facts = await viewImageCandidateRegion(db, ctx, input(), options());
  await expect(
    imageCandidateRegionViewModelOutput(
      db,
      ctx,
      input(),
      {
        ...facts,
        points: facts.points.map((point) => ({
          ...point,
          rawRGBA: [1, 2, 3, 255],
        })),
      },
      options(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    viewImageCandidateRegion(db, ctx, input(), { ...options(), vision: false }),
  ).rejects.toMatchObject({ status: 409 });
  const signal = AbortSignal.abort();
  await expect(
    viewImageCandidateRegion(db, ctx, input(), { ...options(), signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const other = {
    ...(await createUser(
      db,
      { login: "candidate-other", displayName: "Other", password },
      { actor: owner },
    )),
    admin: 0,
  };
  await expect(
    viewImageCandidateRegion(db, { actor: other }, input(), options()),
  ).rejects.toMatchObject({ status: 422 });
  const otherSession = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: otherSession,
      user_id: owner.id,
      title: "Other isolated session",
      model_id: "chat",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await expect(
    viewImageCandidateRegion(
      db,
      await newJob(otherSession),
      input(),
      options(),
    ),
  ).rejects.toThrow("不属于当前会话");
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", sourceId)
    .execute();
  await expect(
    imageCandidateRegionViewModelOutput(db, ctx, input(), facts, options()),
  ).rejects.toThrow("参考图片不存在");
});

it("keeps its two native frames atomic when capacity is insufficient and gives a tool-specific retry without proof claims", async () => {
  await generate();
  const facts = await viewImageCandidateRegion(db, ctx, input(), options()),
    envelope = await imageCandidateRegionViewModelOutput(
      db,
      ctx,
      input(),
      facts,
      options(),
    );
  const value = envelope.value.map((part) =>
    part.type === "media"
      ? {
          type: "file",
          mediaType: part.mediaType,
          data: { type: "data", data: part.data },
        }
      : part,
  );
  const prompt: any = [
    { role: "assistant", content: [] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "image_candidate_region_view",
          toolCallId: "crop",
          output: { type: "content", value },
        },
      ],
    },
  ];
  const incomplete = hoistToolImages(prompt, 1);
  expect(
    incomplete
      .flatMap((message: any) => message.content)
      .filter((part: any) => part.type === "file"),
  ).toHaveLength(0);
  expect(JSON.stringify(incomplete)).toContain(
    "重新调用 image_candidate_region_view",
  );
  expect(
    JSON.parse(incomplete[1].content[0].output.value.at(-1).text).visualInput
      .transmittedImageCount,
  ).toBe(0);
  const complete = hoistToolImages(prompt, 2);
  const frames = complete
    .at(-1)
    .content.filter((part: any) => part.type === "file");
  expect(frames.map((frame: any) => frame.data.data)).toEqual(
    value
      .filter((part) => part.type === "file")
      .map((part: any) => part.data.data),
  );
});

it.each([false, true])(
  "requires complete candidate frames in a prior SDK round, transports unchanged PNG bytes and cannot replace edit preview proof (omitted candidate: %s)",
  async (omitted) => {
    await generate();
    const expected = await viewImageCandidateRegion(
      db,
      ctx,
      input(),
      options(),
    );
    const expectedOutput = await imageCandidateRegionViewModelOutput(
      db,
      ctx,
      input(),
      expected,
      options(),
    );
    const expectedPNG = expectedOutput.value
      .filter((part) => part.type === "media")
      .map((part) => part.data);
    await db
      .updateTable("ai_jobs")
      .set({ status: "completed", lease: null, lease_until: null })
      .where("id", "=", ctx.jobId!)
      .execute();
    const before = await snapshot();
    const usageBefore = (await usageSummary(db, owner.id)).calls.filter(
      (call) => call.callKind === "image",
    );
    let calls = 0,
      callbackError: unknown;
    const namesById = new Map<string, string>();
    const cropCall = () => ({
      name: "image_candidate_region_view",
      args: input(),
    });
    app = await createApp(db, {
      origin,
      storage: runtime(),
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        imageFetch: (async () => {
          throw Error("A diagnostic must never call an image provider");
        }) as typeof fetch,
        fetch: (async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          calls++;
          const stage = calls - (omitted ? 1 : 0);
          try {
            if (calls === 1)
              expect(
                body.tools.some(
                  (tool: any) =>
                    tool.function?.name === "image_candidate_region_view",
                ),
              ).toBe(true);
            const tools = body.messages.filter(
              (message: any) => message.role === "tool",
            );
            if (omitted && calls === 2) {
              const images = body.messages.flatMap((message: any) =>
                Array.isArray(message.content)
                  ? message.content.filter(
                      (part: any) => part.type === "image_url",
                    )
                  : [],
              );
              expect(images).toHaveLength(2);
              const candidate = tools.findLast(
                (message: any) =>
                  namesById.get(message.tool_call_id) ===
                  "image_candidate_view",
              );
              expect(
                JSON.parse(JSON.parse(candidate.content).at(-1).text)
                  .visualInput,
              ).toMatchObject({
                originalImageCount: 3,
                transmittedImageCount: 0,
              });
              expect(candidate.content).toContain(
                "单独重新调用 image_candidate_view",
              );
            }
            if (stage === 2 || stage === 3) {
              const cropped = tools.findLast(
                (message: any) =>
                  namesById.get(message.tool_call_id) ===
                  "image_candidate_region_view",
              );
              expect(cropped.content).toContain(
                "image_candidate_view_required",
              );
            }
            if (stage === 3) {
              const images = body.messages.flatMap((message: any) =>
                Array.isArray(message.content)
                  ? message.content.filter(
                      (part: any) => part.type === "image_url",
                    )
                  : [],
              );
              expect(images).toHaveLength(3);
            }
            if (stage === 4) {
              const cropped = tools.findLast(
                (message: any) =>
                  namesById.get(message.tool_call_id) ===
                  "image_candidate_region_view",
              );
              expect(cropped.content).toContain("diagnostic-only");
              expect(cropped.content).not.toMatch(
                /nativeUsage|objectKey|profileId|provider-native/,
              );
              const pairs = body.messages.flatMap((message: any) =>
                Array.isArray(message.content)
                  ? message.content.flatMap((part: any, index: number) =>
                      part.type === "image_url"
                        ? [{ image: part, caption: message.content[index - 1] }]
                        : [],
                    )
                  : [],
              );
              expect(pairs).toHaveLength(2);
              for (const [index, pair] of pairs.entries()) {
                const caption = JSON.parse(pair.caption.text);
                expect(caption).toMatchObject({
                  toolName: "image_candidate_region_view",
                  coordinateSpace: "source",
                  view:
                    index === 0 ? "source-region" : "source-projection-region",
                  sourceRect: expected.nativeRect,
                  contentRect: { left: 0, top: 0, width: 550, height: 400 },
                  generatedWindow: expected.generatedWindow,
                });
                expect(pair.image.image_url.url).toBe(
                  `data:image/png;base64,${expectedPNG[index]}`,
                );
              }
            }
            if (stage === 5) {
              const composed = tools.findLast(
                (message: any) =>
                  namesById.get(message.tool_call_id) === "image_recompose",
              );
              expect(composed.content).toContain("image_edit_preview_required");
              expect(composed.content).toContain("parameters_not_viewed");
            }
          } catch (error) {
            callbackError ??= error;
            throw error;
          }
          const actions =
            omitted && calls === 1
              ? [
                  {
                    name: "image_edit_preview",
                    args: { referenceImageId: sourceId, editRegions: regions },
                  },
                  {
                    name: "image_candidate_view",
                    args: { generationOperationId: operationId },
                  },
                ]
              : stage === 1
                ? [cropCall()]
                : stage === 2
                  ? [
                      {
                        name: "image_candidate_view",
                        args: { generationOperationId: operationId },
                      },
                      ...(!omitted ? [cropCall()] : []),
                    ]
                  : stage === 3
                    ? [cropCall()]
                    : stage === 4
                      ? [
                          {
                            name: "image_recompose",
                            args: {
                              generationOperationId: operationId,
                              referenceImageId: sourceId,
                              editRegions: regions,
                              filename: "must-not-compose.png",
                            },
                          },
                        ]
                      : [];
          const message = actions.length
            ? {
                role: "assistant",
                content: null,
                tool_calls: actions.map((action) => {
                  const id = randomUUID();
                  namesById.set(id, action.name);
                  return {
                    id,
                    type: "function",
                    function: {
                      name: action.name,
                      arguments: JSON.stringify(action.args),
                    },
                  };
                }),
              }
            : {
                role: "assistant",
                content: "已诊断同坐标像素，尚未建立编辑或验收证明。",
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
                  finish_reason: actions.length ? "tool_calls" : "stop",
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
      headers: { origin, host: "localhost:39321" },
      payload: { login: "candidate-owner", password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const headers = {
        origin,
        host: "localhost:39321",
        cookie: String(login.headers["set-cookie"]).split(";")[0]!,
      },
      jobId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionId}/messages`,
      headers,
      payload: {
        id: jobId,
        modelId: "chat",
        scope: "all",
        text: "只读诊断候选坐标和像素，暂不交付。",
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    let job: any;
    for (let attempt = 0; attempt < 300; attempt++) {
      job = (
        await app.inject({ url: `/api/v1/ai/sessions/${sessionId}`, headers })
      )
        .json()
        .jobs.find((entry: any) => entry.id === jobId);
      if (job && !["queued", "running"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (callbackError) throw callbackError;
    expect(job?.status, job?.error).toBe("completed");
    expect(calls).toBe(omitted ? 6 : 5);
    const after = await snapshot();
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(
      (await usageSummary(db, owner.id)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toEqual(usageBefore);
    const saved = (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).result;
    expect(saved).not.toMatch(
      /base64|data:image|nativeUsage|objectKey|profileId|provider-native/,
    );
  },
  30000,
);
