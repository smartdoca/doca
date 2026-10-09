import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  storageConfigForProfile,
  storageRuntime,
} from "../apps/server/src/adapters/storage.js";
import type { EditRegions } from "../apps/server/src/services/ai/image-edit-regions.js";
import { generateTestImageAsset } from "./fixtures/ai-image-operation.js";
import { imagePaidAttemptReminder } from "../apps/server/src/services/ai/runner.js";
import * as modelImages from "../apps/server/src/services/ai/model-image.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let root: string;
let userId: string;
const origin = "http://localhost:39319";
const password = "isolated-image-preview-2026";

it("adds cap advice only for this strict paid-attempt ordinal at an explicit current limit, preserving the receipt and every absent or unsupported field", () => {
  const receipt = {
    kind: "image_generation",
    state: "saved",
    paidAttempt: {
      version: 1,
      scope: {
        version: 1,
        operationId: randomUUID(),
        taskRootJobId: randomUUID(),
        manifestDigest: "a".repeat(64),
      },
      referenceImageId: randomUUID(),
      ordinal: 1,
    },
  };
  const before = JSON.stringify(receipt);
  const reminder = imagePaidAttemptReminder(receipt, 1)!;
  expect(reminder).toContain("真实请求序号为1，当前上限为1");
  expect(reminder).toContain("原次数限制拒绝并停止任务");
  expect(reminder).toContain("image_candidate_view实际查看raw");
  expect(reminder).toContain("image_recompose/image_mask_compose本地修复");
  expect(reminder).toContain("如实报告未完成");
  expect(reminder).toContain("不能更换scope、模型或提示词重置次数");
  expect(reminder).not.toMatch(
    /已成功\d|剩余\d|费用|providerCallId|system_error/,
  );
  expect(imagePaidAttemptReminder(receipt, 2)).toBeUndefined();
  expect(imagePaidAttemptReminder({}, 1)).toBeUndefined();
  for (const origin of ["reference-export", "local-recomposition"])
    expect(imagePaidAttemptReminder({ ...receipt, origin }, 1)).toBeUndefined();
  const { ordinal: _ordinal, ...missingOrdinal } = receipt.paidAttempt;
  const { version: _version, ...missingVersion } = receipt.paidAttempt;
  for (const paidAttempt of [
    missingOrdinal,
    missingVersion,
    { ...receipt.paidAttempt, version: 0 },
    { ...receipt.paidAttempt, ordinal: "1" },
    { ...receipt.paidAttempt, ordinal: 0 },
    { ...receipt.paidAttempt, extra: true },
  ])
    expect(imagePaidAttemptReminder({ paidAttempt }, 1)).toBeUndefined();
  expect(JSON.stringify(receipt)).toBe(before);
});

function previewRequired(
  content: string,
  referenceImageId: string,
  editRegions: EditRegions,
) {
  const result = JSON.parse(content);
  expect(result).toMatchObject({
    error: true,
    code: "image_edit_preview_required",
    referenceImageId,
    reason: expect.stringMatching(/^(parameters_not_viewed|same_request)$/),
    exactMatchFields: [
      "referenceImageId",
      "labels",
      "regionOrder",
      "pointOrder",
      "coordinates",
    ],
    next: {
      toolName: "image_edit_preview",
      input: { referenceImageId, editRegions },
    },
  });
  expect(result.next).toEqual({
    toolName: "image_edit_preview",
    input: { referenceImageId, editRegions },
  });
  expect(result).not.toHaveProperty("editRegions");
  expect(result.instruction).toContain("每个label");
  expect(result.instruction).toContain("完整全页和局部两帧");
  expect(result.instruction).toContain("下一模型轮次");
  expect(result.instruction).toContain("不要重复相同");
  expect(result.instruction).toContain("不能通过image_recompose补出");
  expect(content).not.toContain("system_error");
  expect(content).not.toContain("availableViewedPreviews");
  expect(content).not.toContain("mismatchPaths");
  return result;
}

async function inputFixture() {
  const login = await app!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin, host: "localhost:39319" },
    payload: { login: "preview-owner", password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const headers = {
    origin,
    host: "localhost:39319",
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
  };
  const session = await app!.inject({
    method: "POST",
    url: "/api/v1/ai/sessions",
    headers,
    payload: { modelId: "chat", resourceIds: [] },
  });
  expect(session.statusCode, session.body).toBe(200);
  const source = await sharp({
    create: { width: 128, height: 96, channels: 3, background: "#135da8" },
  })
    .png()
    .toBuffer();
  const uploaded = await app!.inject({
    method: "POST",
    url: "/api/v1/assets?purpose=ai_attachment&filename=source.png",
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: source,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  return {
    headers,
    sessionId: session.json().id,
    referenceImageId: uploaded.json().id as string,
    source,
  };
}

async function executeFixture(
  fixture: Awaited<ReturnType<typeof inputFixture>>,
  callbackErrors: unknown[],
  expectedStatus: "completed" | "failed" = "completed",
) {
  const id = randomUUID();
  const sent = await app!.inject({
    method: "POST",
    url: `/api/v1/ai/sessions/${fixture.sessionId}/messages`,
    headers: fixture.headers,
    payload: {
      id,
      modelId: "chat",
      scope: "all",
      text: "检查完整局部覆盖预览，随后只修改已核对轮廓并保留背景。",
      attachments: [fixture.referenceImageId],
    },
  });
  expect(sent.statusCode, sent.body).toBe(200);
  let job: any;
  for (let attempt = 0; attempt < 300; attempt++) {
    job = (
      await app!.inject({
        url: `/api/v1/ai/sessions/${fixture.sessionId}`,
        headers: fixture.headers,
      })
    )
      .json()
      .jobs.find((row: any) => row.id === id);
    if (job && !["queued", "running"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(callbackErrors).toEqual([]);
  expect(job?.status, job?.error).toBe(expectedStatus);
  return id;
}

function reply(body: any, id: string) {
  return body.messages.findLast(
    (message: any) => message.role === "tool" && message.tool_call_id === id,
  )?.content;
}

function modelReply(
  body: any,
  calls: { id: string; name: string; args: unknown }[],
) {
  return completionResponse(
    {
      id: randomUUID(),
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: calls.length ? "tool_calls" : "stop",
          message: calls.length
            ? {
                role: "assistant",
                content: null,
                tool_calls: calls.map(({ id, name, args }) => ({
                  id,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                })),
              }
            : { role: "assistant", content: "已保存实际候选，仍待独立验收。" },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    },
    !!body.stream,
  );
}

const recoveryRegions: EditRegions = [
  {
    label: "fixture target, exact eight points",
    points: [
      [0.2, 0.2],
      [0.5, 0.2],
      [0.6, 0.3],
      [0.7, 0.4],
      [0.7, 0.6],
      [0.5, 0.7],
      [0.3, 0.7],
      [0.2, 0.5],
    ],
  },
  {
    label: "second separate target",
    points: [
      [0.8, 0.1],
      [0.9, 0.1],
      [0.9, 0.2],
      [0.8, 0.2],
    ],
  },
];

function receivedToolFrames(body: any, toolCallId: string) {
  const parts = body.messages.flatMap((message: any) =>
    Array.isArray(message.content) ? message.content : [],
  );
  return parts.filter((part: any, index: number) => {
    if (part.type !== "image_url") return false;
    const caption = parts[index - 1];
    return (
      caption?.type === "text" &&
      JSON.parse(caption.text).toolCallId === toolCallId
    );
  });
}

function receivedPreview(
  body: any,
  toolCallId: string,
  referenceImageId: string,
  frames = 2,
) {
  const metadata = JSON.parse(reply(body, toolCallId));
  const facts = JSON.parse(metadata[0].text);
  expect(facts).toMatchObject({
    referenceImageId,
    editRegions: recoveryRegions,
    source: { width: 128, height: 96 },
  });
  expect(JSON.parse(metadata.at(-1).text).visualInput.originalImageCount).toBe(
    2,
  );
  if (frames === 2)
    expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
      transmittedImageCount: 2,
      untransmitted: [],
    });
  const pixels = receivedToolFrames(body, toolCallId);
  expect(pixels).toHaveLength(frames);
  for (const frame of pixels)
    expect(frame.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  return facts;
}

async function seedRawCandidate(
  fixture: Awaited<ReturnType<typeof inputFixture>>,
) {
  const seedId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id: seedId,
      session_id: fixture.sessionId,
      user_id: userId,
      model_id: "chat",
      status: "running",
      input: JSON.stringify({ attachments: [fixture.referenceImageId] }),
      digest: seedId,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120_000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const generationOperationId = randomUUID();
  let seedCalls = 0;
  const generated = await sharp({
    create: { width: 128, height: 96, channels: 3, background: "#dc6830" },
  })
    .png()
    .toBuffer();
  const saved = await generateTestImageAsset(
    db,
    { actor, jobId: seedId, lease, writable: true },
    {
      prompt: "isolated retained raw for exact-preview recovery",
      referenceImageIds: [fixture.referenceImageId],
    },
    generationOperationId,
    {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        seedCalls++;
        return Response.json({
          data: [{ b64_json: generated.toString("base64") }],
          usage: { input_images: 1, input_tokens: 12, output_tokens: 30 },
        });
      }) as typeof fetch,
    },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", seedId)
    .execute();
  expect(seedCalls).toBe(1);
  expect(saved.state).toBe("saved");
  return { generationOperationId, saved };
}

async function changeIsolatedSource(
  referenceImageId: string,
  background = "#673a9c",
) {
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", referenceImageId)
    .executeTakeFirstOrThrow();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const changedPath = join(
    storageConfigForProfile({ ...storageRuntime(), root }, profile).root ??
      root,
    asset.object_key,
  );
  expect(changedPath.startsWith(`${root}/`)).toBe(true);
  const replacement = await sharp({
    create: { width: 128, height: 96, channels: 3, background },
  })
    .png()
    .toBuffer();
  await writeFile(changedPath, replacement);
  await db
    .updateTable("assets")
    .set({ size: replacement.length })
    .where("id", "=", referenceImageId)
    .execute();
  return replacement;
}

function limitPreviewFrames(retained: 0 | 1) {
  const normalize = modelImages.modelPromptImages;
  vi.spyOn(modelImages, "modelPromptImages").mockImplementation(
    async (prompt, preserved) => {
      const normalized = await normalize(prompt, preserved);
      let previewFrames = 0;
      return normalized.map((message) =>
        message.role !== "user" || !Array.isArray(message.content)
          ? message
          : {
              ...message,
              content: message.content.filter((part: any, index: number) => {
                if (
                  part.type !== "file" ||
                  !part.mediaType?.startsWith("image/")
                )
                  return true;
                const caption = message.content[index - 1];
                if (caption?.type !== "text" || !caption.text.startsWith("{"))
                  return true;
                const facts = JSON.parse(caption.text);
                return facts.toolName !== "image_edit_preview"
                  ? true
                  : previewFrames++ < retained;
              }),
            },
      );
    },
  );
}

type FixtureCall = { id: string; name: string; args: object };
async function recoveryExecutor(
  script: (body: any, step: number) => FixtureCall[] | Promise<FixtureCall[]>,
) {
  let steps = 0,
    imageCalls = 0;
  const errors: unknown[] = [];
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async () => {
        imageCalls++;
        const generated = await sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: "#dc6830",
          },
        })
          .png()
          .toBuffer();
        return Response.json({
          data: [{ b64_json: generated.toString("base64") }],
          usage: { input_images: 1, input_tokens: 12, output_tokens: 30 },
        });
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        try {
          return modelReply(body, await script(body, ++steps));
        } catch (error) {
          errors.push(error);
          throw error;
        }
      }) as typeof fetch,
    },
  });
  return {
    errors,
    steps: () => steps,
    imageCalls: () => imageCalls,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-ai-image-preview-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  userId = (
    await createUser(
      db,
      {
        login: "preview-owner",
        displayName: "Preview owner",
        password,
      },
      { bootstrap: true },
    )
  ).id;
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      maxSteps: 12,
      vendors: [
        {
          id: "fixture",
          name: "Isolated fixture",
          provider: "compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "chat",
          vendorId: "fixture",
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
          vendorId: "fixture",
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["preview-first", "edit-first"])(
  "requires a later model request after a coverage preview even for %s tool-call order, and keeps preview pixels outside JSON",
  async (sameRoundOrder) => {
    const regions: EditRegions = [
      {
        label: "目标色块",
        points: [
          [0.35, 0.3],
          [0.55, 0.3],
          [0.55, 0.6],
          [0.35, 0.6],
        ],
      },
    ];
    const changedRegions: EditRegions = [
      {
        label: "目标色块",
        points: [
          [0.32, 0.3],
          [0.55, 0.3],
          [0.55, 0.6],
          [0.35, 0.6],
        ],
      },
    ];
    const renamedRegions = regions.map((region) => ({
      ...region,
      label: "目标色块改名",
    }));
    let referenceImageId = "";
    let imageCalls = 0;
    let agentCalls = 0;
    let previewReceipt: any;
    const toolCallIds: string[] = [];
    const requestBodies: any[] = [];
    const callbackErrors: unknown[] = [];

    const toolReply = (body: any, callIndex: number) =>
      body.messages.findLast(
        (message: any) =>
          message.role === "tool" &&
          message.tool_call_id === toolCallIds[callIndex],
      );
    const imageCallsRecorded = async () =>
      (await usageSummary(db, userId)).calls.filter(
        (call) => call.callKind === "image",
      );

    app = await createApp(db, {
      origin,
      storage: { ...storageRuntime(), root },
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        imageFetch: (async (url, init) => {
          imageCalls++;
          expect(String(url)).toBe("https://mock.invalid/v1/images/edits");
          const form = init?.body as FormData;
          expect(form.get("image")).toBeInstanceOf(File);
          expect(form.get("mask")).toBeInstanceOf(File);
          const image = form.get("image") as File;
          const mask = form.get("mask") as File;
          const imageSize = await sharp(
            Buffer.from(await image.arrayBuffer()),
          ).metadata();
          const maskSize = await sharp(
            Buffer.from(await mask.arrayBuffer()),
          ).metadata();
          expect(maskSize).toMatchObject({
            width: imageSize.width,
            height: imageSize.height,
          });
          return Response.json({
            data: [
              {
                b64_json: (
                  await sharp({
                    create: {
                      width: 1024,
                      height: 1024,
                      channels: 3,
                      background: "#be2525",
                    },
                  })
                    .png()
                    .toBuffer()
                ).toString("base64"),
              },
            ],
            usage: { input_tokens: 12, output_tokens: 30, input_images: 1 },
          });
        }) as typeof fetch,
        fetch: (async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          requestBodies.push(body);
          agentCalls++;
          let name: string | undefined;
          let args: unknown;
          try {
            if (agentCalls === 1) {
              name = "image_edit";
              args = {
                prompt: "把目标色块改为红色，保留其他像素",
                sourceImageId: referenceImageId,
                editRegions: regions,
              };
            } else if (agentCalls === 2) {
              expect(imageCalls).toBe(0);
              expect(await imageCallsRecorded()).toHaveLength(0);
              previewRequired(
                toolReply(body, 0).content,
                referenceImageId,
                regions,
              );
              expect(
                await db
                  .selectFrom("ai_operations")
                  .select("id")
                  .where("result", "like", '%"image_generation"%')
                  .execute(),
              ).toHaveLength(0);
              name = "image_edit_preview";
              args = { referenceImageId, editRegions: regions };
            } else if (agentCalls === 3) {
              expect(imageCalls).toBe(0);
              expect(await imageCallsRecorded()).toHaveLength(0);
              previewRequired(
                toolReply(body, 2).content,
                referenceImageId,
                regions,
              );
              const reply = toolReply(body, 1);
              expect(reply).toBeDefined();
              expect(reply.content).not.toContain("base64");
              expect(reply.content).not.toContain("data:image/");
              expect(reply.content.length).toBeLessThan(12000);
              const previewMetadata = JSON.parse(reply.content);
              expect(previewMetadata).toHaveLength(4);
              expect(
                JSON.parse(previewMetadata[3].text).visualInput,
              ).toMatchObject({
                originalImageCount: 2,
                transmittedImageCount: 2,
                untransmitted: [],
              });
              previewReceipt = JSON.parse(previewMetadata[0].text);
              expect(previewReceipt).toMatchObject({
                referenceImageId,
                editRegions: regions,
                source: { width: 2048, height: 1536 },
              });
              expect(previewReceipt.coverage.editablePixels).toBeGreaterThan(0);
              expect(previewReceipt.coverage.protectedPixels).toBeGreaterThan(
                0,
              );
              const parts = body.messages.flatMap((message: any) =>
                Array.isArray(message.content) ? message.content : [],
              );
              const images = parts.filter(
                (part: any) => part.type === "image_url",
              );
              expect(images).toHaveLength(2);
              for (const [index, part] of images.entries()) {
                const preceding = parts[parts.indexOf(part) - 1];
                expect(preceding.type).toBe("text");
                const caption = JSON.parse(preceding.text);
                const coordinates = JSON.parse(previewMetadata[index + 1].text);
                expect(caption).toMatchObject({
                  image: index + 1,
                  toolName: "image_edit_preview",
                  toolCallId: toolCallIds[1],
                  toolImage: index + 1,
                  referenceImageId,
                  sourceRect: coordinates.sourceRect,
                  contentRect: coordinates.contentRect,
                });
                expect(part.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
                const pixels = Buffer.from(
                  part.image_url.url.split(",")[1],
                  "base64",
                );
                const decoded = await sharp(pixels)
                  .raw()
                  .toBuffer({ resolveWithObject: true });
                expect(
                  Math.max(decoded.info.width, decoded.info.height),
                ).toBeLessThanOrEqual(1600);
                let green = 0,
                  blue = 0;
                for (
                  let offset = 0;
                  offset < decoded.data.length;
                  offset += decoded.info.channels
                ) {
                  const red = decoded.data[offset]!,
                    g = decoded.data[offset + 1]!,
                    b = decoded.data[offset + 2]!;
                  if (g > red + 10 && g > b + 10) green++;
                  if (b > red + 10 && b > g + 10) blue++;
                }
                expect(green).toBeGreaterThan(100);
                expect(blue).toBeGreaterThan(100);
              }
              expect(JSON.parse(previewMetadata[1].text).view).toBe(
                "原页完整覆盖预览",
              );
              expect(JSON.parse(previewMetadata[2].text).view).toBe(
                "编辑窗口覆盖预览",
              );
              name = "image_edit";
              args = {
                prompt: "把目标色块改为红色，保留其他像素",
                sourceImageId: referenceImageId,
                editRegions: regions,
              };
            } else if (agentCalls === 4) {
              expect(imageCalls).toBe(1);
              expect(await imageCallsRecorded()).toEqual([
                expect.objectContaining({
                  images: 1,
                  state: "confirmed",
                  image: 250,
                }),
              ]);
              const saved = JSON.parse(
                JSON.parse(toolReply(body, 3).content)[0].text,
              );
              expect(saved.state).toBe("saved");
              expect(saved).not.toHaveProperty("paidAttempt");
              expect(saved.inspection).not.toContain("宿主请求上限提醒");
              name = "image_edit";
              args = {
                prompt: "使用相同点位但改名的轮廓",
                sourceImageId: referenceImageId,
                editRegions: renamedRegions,
              };
            } else if (agentCalls === 5) {
              expect(imageCalls).toBe(1);
              expect(await imageCallsRecorded()).toHaveLength(1);
              expect(
                previewRequired(
                  toolReply(body, 4).content,
                  referenceImageId,
                  renamedRegions,
                ).reason,
              ).toBe("parameters_not_viewed");
              expect(renamedRegions[0]!.points).toEqual(regions[0]!.points);
              name = "image_edit";
              args = {
                prompt: "按扩大后的目标轮廓再改为红色",
                sourceImageId: referenceImageId,
                editRegions: changedRegions,
              };
            } else if (agentCalls === 6) {
              expect(imageCalls).toBe(1);
              expect(await imageCallsRecorded()).toHaveLength(1);
              previewRequired(
                toolReply(body, 5).content,
                referenceImageId,
                changedRegions,
              );
            } else {
              throw Error(`Unexpected additional agent call: ${agentCalls}`);
            }
          } catch (error) {
            callbackErrors.push(error);
            throw error;
          }
          let message: object;
          if (name) {
            const callId = randomUUID();
            toolCallIds.push(callId);
            const calls = [
              {
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ];
            if (agentCalls === 2) {
              const uninspectedEditId = randomUUID();
              toolCallIds.push(uninspectedEditId);
              calls.push({
                id: uninspectedEditId,
                type: "function",
                function: {
                  name: "image_edit",
                  arguments: JSON.stringify({
                    prompt: "把目标色块改为红色，保留其他像素",
                    sourceImageId: referenceImageId,
                    editRegions: regions,
                  }),
                },
              });
              if (sameRoundOrder === "edit-first") calls.reverse();
            }
            message = {
              role: "assistant",
              content: null,
              tool_calls: calls,
            };
          } else {
            message = {
              role: "assistant",
              content: "已保存一次候选，仍待视觉验收；新轮廓尚未执行。",
            };
          }
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
                  finish_reason: name ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 40,
                total_tokens: 140,
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
      headers: { origin, host: "localhost:39319" },
      payload: { login: "preview-owner", password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const headers = {
      origin,
      host: "localhost:39319",
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/ai/sessions",
      headers,
      payload: { modelId: "chat", resourceIds: [] },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(200);
    const sessionId = sessionResponse.json().id;
    const original = await sharp({
      create: { width: 2048, height: 1536, channels: 3, background: "#c0b8ad" },
    })
      .png()
      .toBuffer();
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/assets?purpose=ai_attachment&filename=source.png",
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: original,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    referenceImageId = upload.json().id;
    const jobId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionId}/messages`,
      headers,
      payload: {
        id: jobId,
        modelId: "chat",
        scope: "all",
        text: "使用覆盖预览核对色块轮廓，再只修改这个色块，保留背景。",
        attachments: [referenceImageId],
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
    expect(agentCalls).toBe(6);
    expect(requestBodies).toHaveLength(6);
    expect(imageCalls).toBe(1);
    const operations = (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("job_id", "=", jobId)
        .where("result", "like", '%"image_generation"%')
        .execute()
    ).map((row) => JSON.parse(row.result));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      state: "saved",
      generation: {
        referenceImageIds: [referenceImageId],
        editRegions: regions,
      },
      providerImageUsage: { inputImages: 1 },
      preservation: { protectedPixelsChanged: 0 },
    });
    expect(
      await db
        .selectFrom("assets")
        .select("id")
        .where("id", "=", operations[0].assetId)
        .executeTakeFirst(),
    ).toBeDefined();
    expect(await imageCallsRecorded()).toEqual([
      expect.objectContaining({ images: 1, state: "confirmed", image: 250 }),
    ]);
  },
  30000,
);

it("does not grant exact preview proof from one budgeted frame, then permits editing only after a new complete two-frame preview", async () => {
  const regions: EditRegions = [
    {
      label: "fixture target",
      points: [
        [0.2, 0.2],
        [0.7, 0.2],
        [0.7, 0.7],
        [0.2, 0.7],
      ],
    },
  ];
  let referenceImageId = "",
    imageCalls = 0,
    step = 0;
  const errors: unknown[] = [];
  const initialPreview = randomUUID(),
    failedEdit = randomUUID(),
    newPreview = randomUUID(),
    actualEdit = randomUUID();
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async () => {
        imageCalls++;
        const pixels = await sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: "#dc6830",
          },
        })
          .png()
          .toBuffer();
        return Response.json({
          data: [{ b64_json: pixels.toString("base64") }],
          usage: { input_images: 1, input_tokens: 12, output_tokens: 30 },
        });
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        step++;
        try {
          if (step === 1)
            return modelReply(body, [
              ...Array.from({ length: 3 }, () => ({
                id: randomUUID(),
                name: "image_view",
                args: { referenceImageIds: [referenceImageId] },
              })),
              {
                id: initialPreview,
                name: "image_edit_preview",
                args: { referenceImageId, editRegions: regions },
              },
            ]);
          if (step === 2) {
            const metadata = JSON.parse(reply(body, initialPreview));
            const visual = JSON.parse(metadata.at(-1).text).visualInput;
            expect(visual).toMatchObject({
              originalImageCount: 2,
              transmittedImageCount: 1,
            });
            expect(visual.untransmitted).toHaveLength(1);
            expect(imageCalls).toBe(0);
            return modelReply(body, [
              {
                id: failedEdit,
                name: "image_edit",
                args: {
                  prompt: "局部改为橙色",
                  sourceImageId: referenceImageId,
                  editRegions: regions,
                },
              },
            ]);
          }
          if (step === 3) {
            expect(
              previewRequired(
                reply(body, failedEdit),
                referenceImageId,
                regions,
              ).reason,
            ).toBe("parameters_not_viewed");
            expect(imageCalls).toBe(0);
            expect(
              (await usageSummary(db, userId)).calls.filter(
                (c) => c.callKind === "image",
              ),
            ).toHaveLength(0);
            return modelReply(body, [
              {
                id: newPreview,
                name: "image_edit_preview",
                args: { referenceImageId, editRegions: regions },
              },
            ]);
          }
          if (step === 4) {
            const metadata = JSON.parse(reply(body, newPreview));
            expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
              originalImageCount: 2,
              transmittedImageCount: 2,
              untransmitted: [],
            });
            expect(imageCalls).toBe(0);
            return modelReply(body, [
              {
                id: actualEdit,
                name: "image_edit",
                args: {
                  prompt: "局部改为橙色",
                  sourceImageId: referenceImageId,
                  editRegions: regions,
                },
              },
            ]);
          }
          if (step === 5) {
            expect(imageCalls).toBe(1);
            expect(
              JSON.parse(JSON.parse(reply(body, actualEdit))[0].text).state,
            ).toBe("saved");
            return modelReply(body, []);
          }
          throw Error("Unexpected fixture request");
        } catch (error) {
          errors.push(error);
          throw error;
        }
      }) as typeof fetch,
    },
  });
  const fixture = await inputFixture();
  referenceImageId = fixture.referenceImageId;
  await executeFixture(fixture, errors);
  expect(step).toBe(5);
  expect(imageCalls).toBe(1);
  expect(
    (await usageSummary(db, userId)).calls.filter(
      (c) => c.callKind === "image",
    ),
  ).toEqual([expect.objectContaining({ state: "confirmed", images: 1 })]);
}, 30000);

it("rejects renamed eight-point recompose parameters and a same-request retry, then saves locally after the renamed exact preview completes with no extra image call", async () => {
  const regions: EditRegions = [
    {
      label: "dad hands",
      points: [
        [0.2, 0.2],
        [0.5, 0.2],
        [0.6, 0.3],
        [0.7, 0.4],
        [0.7, 0.6],
        [0.5, 0.7],
        [0.3, 0.7],
        [0.2, 0.5],
      ],
    },
  ];
  const renamed = regions.map((region) => ({
    ...region,
    label: "dad hands clapping",
  }));
  let referenceImageId = "",
    generationOperationId = "",
    step = 0,
    imageCalls = 0;
  const errors: unknown[] = [];
  const oldPreview = randomUUID(),
    renamedFailure = randomUUID(),
    newPreview = randomUUID(),
    sameRequestFailure = randomUUID(),
    actualCompose = randomUUID();
  const composeArgs = () => ({
    referenceImageId,
    generationOperationId,
    editRegions: renamed,
    filename: "fixed.png",
  });
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async () => {
        imageCalls++;
        throw Error("Recomposition must not call an image provider");
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        step++;
        try {
          if (step === 1)
            return modelReply(body, [
              {
                id: oldPreview,
                name: "image_edit_preview",
                args: { referenceImageId, editRegions: regions },
              },
            ]);
          if (step === 2) {
            const metadata = JSON.parse(reply(body, oldPreview));
            expect(JSON.parse(metadata[0].text).editRegions).toEqual(regions);
            expect(
              JSON.parse(metadata.at(-1).text).visualInput
                .transmittedImageCount,
            ).toBe(2);
            expect(renamed[0]!.points).toEqual(regions[0]!.points);
            return modelReply(body, [
              {
                id: renamedFailure,
                name: "image_recompose",
                args: composeArgs(),
              },
            ]);
          }
          if (step === 3) {
            expect(
              previewRequired(
                reply(body, renamedFailure),
                referenceImageId,
                renamed,
              ).reason,
            ).toBe("parameters_not_viewed");
            expect(imageCalls).toBe(0);
            return modelReply(body, [
              {
                id: newPreview,
                name: "image_edit_preview",
                args: { referenceImageId, editRegions: renamed },
              },
              {
                id: sameRequestFailure,
                name: "image_recompose",
                args: composeArgs(),
              },
            ]);
          }
          if (step === 4) {
            previewRequired(
              reply(body, sameRequestFailure),
              referenceImageId,
              renamed,
            );
            expect(imageCalls).toBe(0);
            const metadata = JSON.parse(reply(body, newPreview));
            expect(JSON.parse(metadata[0].text).editRegions).toEqual(renamed);
            expect(JSON.parse(metadata.at(-1).text).visualInput).toMatchObject({
              transmittedImageCount: 2,
              untransmitted: [],
            });
            return modelReply(body, [
              {
                id: actualCompose,
                name: "image_recompose",
                args: composeArgs(),
              },
            ]);
          }
          if (step === 5) {
            const actual = JSON.parse(
              JSON.parse(reply(body, actualCompose))[0].text,
            );
            expect(actual).toMatchObject({
              state: "saved",
              origin: "local-recomposition",
              generationOperationId,
              preservation: { protectedPixelsChanged: 0 },
            });
            expect(imageCalls).toBe(0);
            return modelReply(body, []);
          }
          throw Error("Unexpected fixture request");
        } catch (error) {
          errors.push(error);
          throw error;
        }
      }) as typeof fetch,
    },
  });
  const fixture = await inputFixture();
  referenceImageId = fixture.referenceImageId;
  const seedId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id: seedId,
      session_id: fixture.sessionId,
      user_id: userId,
      model_id: "chat",
      status: "running",
      input: JSON.stringify({ attachments: [referenceImageId] }),
      digest: seedId,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120_000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  generationOperationId = randomUUID();
  let seedCalls = 0;
  const generated = await sharp({
    create: { width: 128, height: 96, channels: 3, background: "#dc6830" },
  })
    .png()
    .toBuffer();
  await generateTestImageAsset(
    db,
    { actor, jobId: seedId, lease, writable: true },
    { prompt: "isolated retained raw", referenceImageIds: [referenceImageId] },
    generationOperationId,
    {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        seedCalls++;
        return Response.json({
          data: [{ b64_json: generated.toString("base64") }],
          usage: { input_images: 1, input_tokens: 12, output_tokens: 30 },
        });
      }) as typeof fetch,
    },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", seedId)
    .execute();
  const paidBefore = (await usageSummary(db, userId)).calls.filter(
    (c) => c.callKind === "image",
  );
  expect(paidBefore).toHaveLength(1);
  await executeFixture(fixture, errors);
  expect(step).toBe(5);
  expect(imageCalls).toBe(0);
  expect(seedCalls).toBe(1);
  expect(
    (await usageSummary(db, userId)).calls.filter(
      (c) => c.callKind === "image",
    ),
  ).toEqual(paidBefore);
  const operations = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("result", "like", '%"local-recomposition"%')
      .execute()
  ).map((row) => JSON.parse(row.result));
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    origin: "local-recomposition",
    generation: { editRegions: renamed },
    preservation: { protectedPixelsChanged: 0 },
  });
}, 30000);

it.each(["image_edit", "image_recompose"] as const)(
  "clears only the failed %s recipe after its exact two-frame preview reaches EOF, so a later cleared preview does not inherit two old failures",
  async (toolName) => {
    let referenceImageId = "",
      generationOperationId = "",
      sourceSha256 = "";
    const calls = Array.from({ length: 8 }, () => randomUUID());
    const recipe = () =>
      toolName === "image_edit"
        ? {
            prompt: "  Exact preview target becomes orange  ",
            sourceImageId: referenceImageId,
            editRegions: recoveryRegions,
          }
        : {
            generationOperationId,
            referenceImageId,
            editRegions: recoveryRegions,
            filename: "  recovered.png  ",
          };
    const recipeCall = (index: number): FixtureCall => ({
      id: calls[index]!,
      name: toolName,
      args: recipe(),
    });
    const nextPreview = (
      body: any,
      failedIndex: number,
      previewIndex: number,
    ) => {
      const required = previewRequired(
        reply(body, calls[failedIndex]!),
        referenceImageId,
        recoveryRegions,
      );
      expect(required.reason).toBe("parameters_not_viewed");
      return {
        id: calls[previewIndex]!,
        name: required.next.toolName,
        args: required.next.input,
      };
    };
    const executor = await recoveryExecutor((body, step) => {
      expect(executor.imageCalls()).toBe(
        step === 9 && toolName === "image_edit" ? 1 : 0,
      );
      if (step === 1) return [recipeCall(0)];
      if (step === 2) {
        previewRequired(
          reply(body, calls[0]!),
          referenceImageId,
          recoveryRegions,
        );
        return [recipeCall(1)];
      }
      if (step === 3) return [nextPreview(body, 1, 2)];
      if (step === 4) {
        expect(
          receivedPreview(body, calls[2]!, referenceImageId).source.digest,
        ).toBe(sourceSha256);
        return [
          {
            id: calls[3]!,
            name: "image_candidate_view",
            args: { generationOperationId },
          },
        ];
      }
      if (step === 5) {
        expect(receivedToolFrames(body, calls[3]!)).toHaveLength(3);
        return [recipeCall(4)];
      }
      if (step === 6) {
        previewRequired(
          reply(body, calls[4]!),
          referenceImageId,
          recoveryRegions,
        );
        return [recipeCall(5)];
      }
      if (step === 7) return [nextPreview(body, 5, 6)];
      if (step === 8) {
        expect(
          receivedPreview(body, calls[6]!, referenceImageId).source.digest,
        ).toBe(sourceSha256);
        return [recipeCall(7)];
      }
      expect(step).toBe(9);
      const saved = JSON.parse(JSON.parse(reply(body, calls[7]!))[0].text);
      expect(saved).toMatchObject({
        state: "saved",
        generation: { editRegions: recoveryRegions },
        preservation: { protectedPixelsChanged: 0 },
      });
      if (toolName === "image_recompose")
        expect(saved).toMatchObject({
          origin: "local-recomposition",
          generationOperationId,
        });
      return [];
    });
    const fixture = await inputFixture();
    referenceImageId = fixture.referenceImageId;
    sourceSha256 = createHash("sha256").update(fixture.source).digest("hex");
    const seed = await seedRawCandidate(fixture);
    generationOperationId = seed.generationOperationId;
    const paidBefore = (await usageSummary(db, userId)).calls.filter(
      (call) => call.callKind === "image",
    );
    expect(paidBefore).toHaveLength(1);
    const seedReceipt = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", generationOperationId)
      .executeTakeFirstOrThrow();
    const jobId = await executeFixture(fixture, executor.errors);
    expect(executor.steps()).toBe(9);
    expect(executor.imageCalls()).toBe(toolName === "image_edit" ? 1 : 0);
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", generationOperationId)
        .executeTakeFirstOrThrow(),
    ).toEqual(seedReceipt);
    const paidAfter = (await usageSummary(db, userId)).calls.filter(
      (call) => call.callKind === "image",
    );
    if (toolName === "image_recompose") expect(paidAfter).toEqual(paidBefore);
    else {
      expect(paidAfter).toHaveLength(2);
      expect(paidAfter).toEqual(expect.arrayContaining(paidBefore));
      expect(
        paidAfter.every(
          (call) =>
            call.state === "confirmed" &&
            call.images === 1 &&
            call.image === 250,
        ),
      ).toBe(true);
    }
    const saved = (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("job_id", "=", jobId)
        .where("result", "like", '%"image_generation"%')
        .execute()
    ).map((row) => JSON.parse(row.result));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      state: "saved",
      generation: {
        referenceImageIds: [referenceImageId],
        editRegions: recoveryRegions,
      },
      preservation: { protectedPixelsChanged: 0 },
    });
  },
  30000,
);

it.each(["ignored", 0, 1] as const)(
  "keeps the three-identical-failure stop unbilled when the exact next preview is %s",
  async (preview) => {
    if (preview !== "ignored") limitPreviewFrames(preview);
    let referenceImageId = "";
    let previousEdit = "",
      previousPreview = "";
    const recipe = () => ({
      prompt: "  Exact preview target becomes orange  ",
      sourceImageId: referenceImageId,
      editRegions: recoveryRegions,
    });
    const executor = await recoveryExecutor((body, step) => {
      expect(executor.imageCalls()).toBe(0);
      if (previousPreview && step % 2 === 1)
        receivedPreview(
          body,
          previousPreview,
          referenceImageId,
          Number(preview),
        );
      if (step > 1 && (preview === "ignored" || step % 2 === 0)) {
        const required = previewRequired(
          reply(body, previousEdit),
          referenceImageId,
          recoveryRegions,
        );
        expect(required.reason).toBe("parameters_not_viewed");
        if (preview !== "ignored") {
          previousPreview = randomUUID();
          return [
            {
              id: previousPreview,
              name: required.next.toolName,
              args: required.next.input,
            },
          ];
        }
      }
      expect(step).toBeLessThanOrEqual(preview === "ignored" ? 3 : 5);
      previousEdit = randomUUID();
      return [{ id: previousEdit, name: "image_edit", args: recipe() }];
    });
    const fixture = await inputFixture();
    referenceImageId = fixture.referenceImageId;
    const beforeAssets = await db
      .selectFrom("assets")
      .selectAll()
      .orderBy("id")
      .execute();
    const jobId = await executeFixture(fixture, executor.errors, "failed");
    const job = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    expect(job.error).toContain("连续三次以相同参数失败");
    expect(executor.steps()).toBe(preview === "ignored" ? 3 : 5);
    expect(executor.imageCalls()).toBe(0);
    expect(
      (await usageSummary(db, userId)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toHaveLength(0);
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(beforeAssets);
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("job_id", "=", jobId)
        .where("result", "like", '%"image_generation"%')
        .execute(),
    ).toHaveLength(0);
  },
  30000,
);

it.each(["before-preview", "after-preview-eof"] as const)(
  "refuses to reuse or reset an old source binding when source bytes change %s, without saving or billing",
  async (changeAt) => {
    let referenceImageId = "",
      previousEdit = "",
      previewId = "",
      previewSource: Buffer = Buffer.alloc(0);
    const recipe = () => ({
      prompt: "  Exact preview target becomes orange  ",
      sourceImageId: referenceImageId,
      editRegions: recoveryRegions,
    });
    const executor = await recoveryExecutor(async (body, step) => {
      expect(executor.imageCalls()).toBe(0);
      if (step === 2 || step === 3 || step > 4) {
        const required = previewRequired(
          reply(body, previousEdit),
          referenceImageId,
          recoveryRegions,
        );
        expect(required.reason).toBe("parameters_not_viewed");
        if (step === 3) {
          if (changeAt === "before-preview")
            previewSource = await changeIsolatedSource(referenceImageId);
          previewId = randomUUID();
          return [
            {
              id: previewId,
              name: required.next.toolName,
              args: required.next.input,
            },
          ];
        }
      }
      if (step === 4) {
        expect(
          receivedPreview(body, previewId, referenceImageId).source.digest,
        ).toBe(createHash("sha256").update(previewSource).digest("hex"));
        await changeIsolatedSource(
          referenceImageId,
          changeAt === "before-preview" ? "#135da8" : "#673a9c",
        );
      }
      expect(step).toBeLessThanOrEqual(changeAt === "before-preview" ? 4 : 6);
      previousEdit = randomUUID();
      return [{ id: previousEdit, name: "image_edit", args: recipe() }];
    });
    const fixture = await inputFixture();
    referenceImageId = fixture.referenceImageId;
    previewSource = fixture.source;
    const jobId = await executeFixture(fixture, executor.errors, "failed");
    const job = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    expect(job.error).toContain("连续三次以相同参数失败");
    expect(executor.steps()).toBe(changeAt === "before-preview" ? 4 : 6);
    expect(executor.imageCalls()).toBe(0);
    expect(
      (await usageSummary(db, userId)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("job_id", "=", jobId)
        .where("result", "like", '%"image_generation"%')
        .execute(),
    ).toHaveLength(0);
    expect(await db.selectFrom("assets").select("id").execute()).toEqual([
      { id: referenceImageId },
    ]);
  },
  30000,
);

it.each(["preview-first", "edit-first"] as const)(
  "does not clear two identical failures for a %s preview and edit issued in the same model request before preview EOF",
  async (order) => {
    let referenceImageId = "",
      previousEdit = "";
    const recipe = () => ({
      prompt: "  Exact preview target becomes orange  ",
      sourceImageId: referenceImageId,
      editRegions: recoveryRegions,
    });
    const executor = await recoveryExecutor((body, step) => {
      expect(executor.imageCalls()).toBe(0);
      const required =
        step > 1
          ? previewRequired(
              reply(body, previousEdit),
              referenceImageId,
              recoveryRegions,
            )
          : undefined;
      previousEdit = randomUUID();
      const edit = { id: previousEdit, name: "image_edit", args: recipe() };
      if (step < 3) return [edit];
      expect(step).toBe(3);
      const preview = {
        id: randomUUID(),
        name: required!.next.toolName,
        args: required!.next.input,
      };
      return order === "preview-first" ? [preview, edit] : [edit, preview];
    });
    const fixture = await inputFixture();
    referenceImageId = fixture.referenceImageId;
    const jobId = await executeFixture(fixture, executor.errors, "failed");
    const job = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    expect(job.error).toContain("连续三次以相同参数失败");
    expect(executor.steps()).toBe(3);
    expect(executor.imageCalls()).toBe(0);
    expect(
      (await usageSummary(db, userId)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("job_id", "=", jobId)
        .where("result", "like", '%"image_generation"%')
        .execute(),
    ).toHaveLength(0);
  },
  30000,
);
