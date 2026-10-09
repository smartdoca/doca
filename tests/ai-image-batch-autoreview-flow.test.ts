import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Agent } from "@mastra/core/agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import { createImageBatchRequirements } from "../apps/server/src/services/ai/image-batch-requirements.js";
import { registerImageBatchAttemptScope } from "../apps/server/src/services/ai/image-batch-attempts.js";
import {
  imageBatchSchema,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import { generateTestImageAsset } from "./fixtures/ai-image-operation.js";
import * as modelImages from "../apps/server/src/services/ai/model-image.js";
import * as imageIO from "../apps/server/src/services/ai/images.js";
import { decodeSystemError } from "@doca/i18n";
import { PARSER_VERSION } from "../apps/server/src/services/ai/file-extract.js";

const originalText =
  "处理全部书册：alpha.pdf物理第1页替换目标人物，第2页保持原样；beta.pdf之后处理。目标正确，背景和文字按原要求保留，背景逐像素一致，全部最新页验收通过后才推进。";
const criteria = [
  "本页目标正确且背景内容逐像素一致",
  "全部书页均保存并独立验收后再推进",
];
const sourceColor = [51, 102, 153],
  candidateColor = [192, 112, 64];
const png = (color = "#336699") =>
  sharp({ create: { width: 80, height: 60, channels: 3, background: color } })
    .png()
    .toBuffer();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let db: Awaited<ReturnType<typeof openTestDatabase>>,
  owner: Actor,
  root: string;
let sessionId: string,
  ctx: ToolContext,
  originalJobId: string,
  batch: ImageBatch;
let obsoleteAssetId: string;
const runtime = () => ({ ...storage.storageRuntime(), root });
const page = (index = 0) => batch.books[0]!.pages[index]!.referenceImageId;
type Action = { name: string; args: object };
const resume = (): Action => ({
  name: "image_batch",
  args: { action: "resume", jobId: originalJobId },
});
const status = (): Action => ({
  name: "image_batch",
  args: { action: "status" },
});
const clarify = (): Action => ({
  name: "ask_user",
  args: {
    title: "Fixture identity clarification is required",
    options: ["Use confirmed identity", "Wait for identity"],
  },
});
const exportPage = (index = 0): Action => ({
  name: "image_export",
  args: {
    referenceImageId: page(index),
    filename: `latest-alpha-${index + 1}.png`,
  },
});
const generate = (): Action => ({
  name: "image_edit",
  args: {
    sourceImageId: page(),
    prompt: "按原请求修改alpha物理第1页目标人物，保留背景文字",
  },
});
const positiveReview = (assetId: string, index = 0): Action => ({
  name: "image_batch",
  args: {
    action: "review",
    review: {
      referenceImageId: page(index),
      assetId,
      passed: true,
      evidence: "Executor requests acceptance after the host actual verdict",
    },
  },
});
function scopedBatchStatus(body: any): any {
  const text = body.messages
    .flatMap((message: any) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
        : typeof message.content === "string"
          ? [message.content]
          : [],
    )
    .find((text: string) => text.startsWith("【服务端持久批次任务来源】"));
  expect(text).toBeDefined();
  return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
}
function lastTool(body: any, name: string): string {
  const call = body.messages
    .flatMap((message: any) =>
      message.role === "assistant" ? (message.tool_calls ?? []) : [],
    )
    .findLast((call: any) => call.function?.name === name);
  return (
    body.messages.findLast(
      (message: any) =>
        message.role === "tool" && message.tool_call_id === call?.id,
    )?.content ?? ""
  );
}
function initialReviewRecovery(body: any): any {
  const text = body.messages
    .flatMap((message: any) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
        : typeof message.content === "string"
          ? [message.content]
          : [],
    )
    .findLast((text: string) => text.startsWith("【宿主独立验收恢复状态；"));
  expect(text).toBeDefined();
  return JSON.parse(text.slice(text.indexOf("\n") + 1))[0];
}
function contentReviewFailures(body: any): any[] {
  const text = body.messages
    .flatMap((message: any) =>
      Array.isArray(message.content)
        ? message.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
        : typeof message.content === "string"
          ? [message.content]
          : [],
    )
    .findLast((text: string) =>
      text.startsWith("【当前最新图片的内容失败与返修下一步；"),
    );
  return text ? JSON.parse(text.slice(text.indexOf("\n") + 1)) : [];
}
const mediaToolFacts = (body: any, name: string) =>
  JSON.parse(JSON.parse(lastTool(body, name))[0].text);
function freshReviewToolFacts(body: any) {
  const facts = mediaToolFacts(body, "image_batch");
  expect(facts.code).toBe("image_review_requires_fresh_view");
  expect(facts.reviewUnchanged).toBe(true);
  return facts;
}
const storedBatch = async (id: string) =>
  imageBatchSchema.parse(
    JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).result,
    ).checkpoint.imageBatch,
  );
const storedImageCalls = async () =>
  (await db.selectFrom("ai_calls").selectAll().orderBy("id").execute()).filter(
    (call) => JSON.parse(call.model_snapshot).callKind === "image",
  );
async function attach() {
  await db
    .updateTable("ai_jobs")
    .set({ result: JSON.stringify({ checkpoint: { imageBatch: batch } }) })
    .where("id", "=", originalJobId)
    .execute();
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-autoreview-flow-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "autoreview-owner",
        displayName: "Fixture",
        password: "autoreview-isolated-2026",
      },
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
          provider: "openai",
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
          imageRate: 1,
          maxInput: 32000,
          maxOutput: 1000,
        },
      ],
    },
    0,
  );
  const now = new Date().toISOString(),
    lease = randomUUID();
  sessionId = randomUUID();
  originalJobId = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: owner.id,
      title: "Isolated auto review",
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
      id: originalJobId,
      user_id: owner.id,
      session_id: sessionId,
      model_id: "chat",
      status: "running",
      input: "{}",
      result: "{}",
      digest: originalJobId,
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      cancelled: 0,
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { actor: owner, jobId: originalJobId, lease } as ToolContext;
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const sourceIds: string[] = [],
    books: ImageBatch["books"] = [];
  for (const [bookIndex, filename, count] of [
    [0, "alpha.pdf", 2],
    [1, "beta.pdf", 1],
  ] as const) {
    const assetId = randomUUID(),
      objectId = randomUUID(),
      key = objectKey(assetId, "application/pdf"),
      sourceBytes = Buffer.from(`%PDF-autoreview-fixture-${bookIndex}`);
    await storage.createStorage(runtime()).put(storage.storageConfigForProfile(runtime(), profile),
      key, sourceBytes, "application/pdf", filename);
    sourceIds.push(assetId);
    await db
      .insertInto("file_storage_objects")
      .values({
        id: objectId,
        profile_id: profile.id,
        object_key: key,
        sha256: sha(sourceBytes),
        size: sourceBytes.length,
        mime: "application/pdf",
        created_at: now,
      })
      .execute();
    await db
      .insertInto("assets")
      .values({
        id: assetId,
        owner_id: owner.id,
        uploaded_by: owner.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename,
        mime: "application/pdf",
        size: sourceBytes.length,
        created_at: now,
        deleted_at: null,
      })
      .execute();
    const parts = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID(),
        data = await png(bookIndex ? "#aa5522" : undefined),
        derivativeKey = objectKey(id, "image/png"),
        recipe = `v${PARSER_VERSION}-img-${index}`;
      await storage
        .createStorage(runtime())
        .put(
          storage.storageConfigForProfile(runtime(), profile),
          derivativeKey,
          data,
          "image/png",
          `page-${index + 1}.png`,
        );
      await db
        .insertInto("file_derivatives")
        .values({
          id,
          source_id: objectId,
          profile_id: profile.id,
          object_key: derivativeKey,
          kind: "extract-image",
          recipe,
          mime: "image/png",
          size: data.length,
          created_at: now,
        })
        .execute();
      parts.push({
        type: "image" as const,
        recipe,
        filename: `page-${index + 1}.png`,
        mime: "image/png",
      });
    }
    await db.insertInto("file_extracts").values({
      storage_object_id: objectId, status: "ready",
      result: JSON.stringify({ parserVersion: PARSER_VERSION, parts }), error: null, updated_at: now,
    }).execute();
    await db
      .updateTable("ai_jobs")
      .set({
        input: JSON.stringify({ text: originalText, attachments: sourceIds }),
      })
      .where("id", "=", originalJobId)
      .execute();
    const source = { assetId },
      pages = await registerVisualReferences(db, ctx, source, objectId, parts);
    books.push({ source, filename, pages });
  }
  const sources = books.map((book) => book.source);
  const requirements = await createImageBatchRequirements(
    db,
    { userId: owner.id, actor: owner, sessionId, currentJobId: originalJobId },
    originalJobId,
    sources,
    "all-documents",
    criteria,
    [],
  );
  const attemptScope = await registerImageBatchAttemptScope(
    db,
    ctx,
    {
      requirements,
      books,
    },
    { version: 1 },
  );
  batch = imageBatchSchema.parse({
    version: 3,
    attemptScope,
    requirements,
    books,
    current: 0,
    notes: "Executor notes claim every image passed; do not trust this claim",
    delivered: {},
    reviews: {},
  });
  await attach();
  for (const index of [0, 1]) {
    const saved = await generateTestImageAsset(
      db,
      ctx,
      {
        referenceImageIds: [page(index)],
        prompt: "Original page export fixture",
        filename: `earlier-alpha-${index + 1}.png`,
      },
      randomUUID(),
      {
        storage: runtime(),
        exportOnly: true,
        operation: "edit",
        batchAttemptScope: batch.attemptScope,
        fetch: (async () => {
          throw Error("Original export cannot call provider");
        }) as typeof fetch,
      },
    );
    batch.delivered[page(index)] = saved.assetId;
    batch.reviews[page(index)] = {
      assetId: saved.assetId,
      passed: index === 1,
      evidence:
        index === 1
          ? "Earlier second page passed"
          : "Obsolete first asset failed",
    };
    if (index === 0) obsoleteAssetId = saved.assetId;
  }
  await attach();
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

async function run(
  next: (body: any, step: number) => Action[] | Promise<Action[]>,
  options: {
    passed?: boolean;
    reviewVerdicts?: boolean[];
    generated?: boolean;
    unknownPaid?: boolean;
    expectedStatus?: string;
    stripViewPixels?: 0 | 1;
    stripSavedRepairPixels?: 0 | 1;
    stripLocalPreviewPixels?: 0 | 1 | 2;
    localRevision?: boolean;
    stripViewFromReview?: number;
    stripRecoveryPixels?: 0 | 1;
    stripRecoveryFromReview?: number;
    failedReviewOrdinals?: number[];
    invalidReviewOrdinals?: number[];
    invalidReviewKind?: "length" | "json" | "schema";
    incompleteReviewOrdinals?: number[];
    nativeDetailFixture?: boolean;
    onIndependentReview?: (ordinal: number) => void | Promise<void>;
    beforeReviewResponse?: (ordinal: number) => Promise<void>;
    reviewPageIndexes?: number[];
    reviewAssetIds?: string[];
    originalCandidateAssetIds?: string[];
    scenePageIndexes?: number[];
    cancelExecutorAtStep?: number;
  } = {},
) {
  if (options.nativeDetailFixture) {
    const derivative = await db
      .selectFrom("file_derivatives")
      .selectAll()
      .where("id", "=", page(1))
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("id", "=", derivative.profile_id)
      .executeTakeFirstOrThrow();
    const data = await sharp({
      create: { width: 1500, height: 2000, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const nativeKey = objectKey(randomUUID(), "image/png");
    await storage
      .createStorage(runtime())
      .put(
        storage.storageConfigForProfile(runtime(), profile),
        nativeKey,
        data,
        "image/png",
        "native-alpha-page-2.png",
      );
    await db
      .updateTable("file_derivatives")
      .set({ object_key: nativeKey, size: data.length })
      .where("id", "=", derivative.id)
      .execute();
  }
  if (!options.generated) {
    // Export and stop flows begin with page 2 genuinely undelivered. The
    // generated rejection flow keeps its other page's confirmed receipt so
    // advance is refused specifically because the latest target failed.
    delete batch.delivered[page(1)];
    delete batch.reviews[page(1)];
    await attach();
  }
  const origin = "http://localhost:39339";
  let queuedId = "",
    authenticatedHeaders: Record<string, string> = {};
  let calls = 0,
    reviews = 0,
    sceneCalls = 0,
    providerCalls = 0;
  const errors: unknown[] = [],
    bodies: any[] = [],
    reviewedAssets: string[] = [],
    events: string[] = [];
  if (
    options.stripViewPixels !== undefined ||
    options.stripSavedRepairPixels !== undefined ||
    options.stripLocalPreviewPixels !== undefined ||
    options.stripRecoveryPixels !== undefined
  ) {
    const normalize = modelImages.modelPromptImages;
    vi.spyOn(modelImages, "modelPromptImages").mockImplementation(
      async (prompt, preserved) => {
        const value = await normalize(prompt, preserved);
        let retainedView = 0,
          retainedSavedRepair = 0,
          retainedLocalPreview = 0,
          retainedRecovery = 0;
        return value.map((message) =>
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
                  let toolName: string | undefined;
                  try {
                    toolName = JSON.parse(
                      message.content[index - 1]?.text,
                    ).toolName;
                  } catch {
                    return true;
                  }
                  if (
                    toolName === "image_view" &&
                    options.stripViewPixels !== undefined &&
                    reviews >= (options.stripViewFromReview ?? 0)
                  )
                    return retainedView++ < options.stripViewPixels;
                  if (
                    toolName === "image_edit_saved" &&
                    options.stripSavedRepairPixels !== undefined
                  )
                    return (
                      retainedSavedRepair++ < options.stripSavedRepairPixels
                    );
                  if (
                    toolName === "image_edit_saved_local_preview" &&
                    options.stripLocalPreviewPixels !== undefined
                  )
                    return (
                      retainedLocalPreview++ < options.stripLocalPreviewPixels
                    );
                  if (
                    toolName === "image_batch" &&
                    options.stripRecoveryPixels !== undefined &&
                    reviews >= (options.stripRecoveryFromReview ?? 0)
                  )
                    return retainedRecovery++ < options.stripRecoveryPixels;
                  return true;
                }),
              },
        );
      },
    );
  }
  const app = await createApp(db, {
    origin,
    storage: runtime(),
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async (_url, init) => {
        providerCalls++;
        events.push("provider-submit");
        if (options.unknownPaid)
          throw Error("Fixture provider response lost after submission");
        let pixels = await png("#c07040");
        if (options.localRevision) {
          const requestSize =
            init?.body instanceof FormData
              ? init.body.get("size")
              : JSON.parse(String(init?.body)).size;
          const [width, height] = String(requestSize).split("x").map(Number);
          expect(width).toBeGreaterThanOrEqual(80);
          expect(height).toBeGreaterThanOrEqual(60);
          pixels = await sharp({
            create: {
              width: width!,
              height: height!,
              channels: 3,
              background: "#c07040",
            },
          })
            .png()
            .toBuffer();
        }
        return Response.json({
          data: [{ b64_json: pixels.toString("base64") }],
          usage: { input_images: 1, input_tokens: 9, output_tokens: 13 },
        });
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.messages.some((message: any) => message.role === "system" &&
          String(message.content).includes("reviewPrecision所有字段必填"))) {
          sceneCalls++;
          const content = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
          const metadata = JSON.parse(content.find((part: any) => part.type === "text" && part.text.startsWith('{"binding"')).text);
          expect(metadata.criteria).toEqual(criteria);
          expect(metadata.binding.references[0].referenceImageId).toBe(metadata.binding.originalReferenceImageId);
          if (options.scenePageIndexes?.[sceneCalls - 1] !== undefined)
            expect(metadata.binding.originalReferenceImageId).toBe(page(options.scenePageIndexes[sceneCalls - 1]));
          expect(content.filter((part: any) => part.type === "image_url").length).toBe(metadata.binding.references.length);
          const facts = {
            summary: "Solid-color fixture originals have no visible people or props.",
            reviewPrecision: { mode: "native", criterionIndices: [0], requestIndices: [], reason: "Explicit fixture pixel-preservation criterion." },
            objects: [], roleMappings: [], actions: [], crossPage: [], uncertainties: [],
            requirements: metadata.criteria.map((quote: string, criterionIndex: number) => ({
              kind: "preserve", requestIndex: null, criterionIndex, quote, objectIds: [],
              applicability: "applies", evidence: "Fixture original and explicitly supplied formal criterion.",
            })),
          };
          return completionResponse({ id: randomUUID(), object: "chat.completion", created: 1, model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(facts) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 },
          }, !!body.stream);
        }
        if (
          body.messages.some(
            (message: any) =>
              message.role === "system" &&
              String(message.content).includes("Doca image-delivery-verifier"),
          )
        ) {
          const reviewOrdinal = ++reviews;
          await options.onIndependentReview?.(reviewOrdinal);
          if (options.failedReviewOrdinals?.includes(reviewOrdinal))
            throw new TypeError("fetch failed PRIVATE_VERIFIER_HEADER_AND_URL");
          const passed =
            options.reviewVerdicts?.[reviewOrdinal - 1] ??
            options.passed !== false;
          events.push("independent-vision-review");
          try {
            const content = body.messages.flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            );
            const scopeText = content.find(
              (part: any) =>
                part.type === "text" &&
                part.text.startsWith("【宿主确认的当前来源范围】"),
            );
            const scope = JSON.parse(
              scopeText.text.slice(scopeText.text.indexOf("\n") + 1),
            );
            expect(scope.taskScope).toEqual({
              kind: "batch-page",
              bookIndex: 1,
              totalBooks: 2,
              filename: "alpha.pdf",
              physicalPage:
                (options.reviewPageIndexes?.[reviewOrdinal - 1] ??
                  (options.generated ? 0 : 1)) + 1,
              totalPages: 2,
              referenceImageId: page(
                options.reviewPageIndexes?.[reviewOrdinal - 1] ??
                  (options.generated ? 0 : 1),
              ),
            });
            if (options.reviewAssetIds?.[reviewOrdinal - 1])
              expect(scope.candidateAssetId).toBe(
                options.reviewAssetIds[reviewOrdinal - 1],
              );
            else expect(scope.candidateAssetId).not.toBe(obsoleteAssetId);
            reviewedAssets.push(scope.candidateAssetId);
            expect(JSON.stringify(body.messages)).toContain(originalText);
            const metadata = JSON.parse(
              content.find(
                (part: any) =>
                  part.type === "text" &&
                  part.text.startsWith('{"requiredChecks"'),
              ).text,
            );
            expect(metadata.requiredChecks).toHaveLength(6);
            expect(
              metadata.requiredChecks
                .slice(4)
                .map((item: any) => item.requirement),
            ).toEqual(criteria);
            const frames = content.filter(
              (part: any) => part.type === "image_url",
            );
            const native = metadata.reviewMode === "native-detail";
            if (native) expect(metadata.tiles).toHaveLength(1);
            expect(frames).toHaveLength(
              native ? 2 + metadata.tiles.length * 2 : 2,
            );
            for (const [index, frame] of frames.entries()) {
              const data = Buffer.from(
                frame.image_url.url.split(",")[1],
                "base64",
              );
              const size = await sharp(data).metadata();
              if (!options.nativeDetailFixture) {
                expect(size.width).toBe(80);
                expect(size.height).toBe(60);
              } else if (native && index >= 2) {
                const tile = metadata.tiles[Math.floor((index - 2) / 2)],
                  rect = index % 2 === 0 ? tile.sourceRect : tile.candidateRect;
                expect([size.width, size.height]).toEqual([
                  rect.width,
                  rect.height,
                ]);
                expect(frame.image_url.url).toMatch(/^data:image\/png;/);
              } else
                expect(Math.max(size.width!, size.height!)).toBe(
                  native ? 512 : 1600,
                );
              const pixel = await sharp(data)
                .extract({ left: 40, top: 30, width: 1, height: 1 })
                .removeAlpha()
                .raw()
                .toBuffer();
              const expected = index === 1 && options.generated &&
                !options.originalCandidateAssetIds?.includes(scope.candidateAssetId)
                ? candidateColor : sourceColor;
              for (const channel of [0, 1, 2])
                expect(
                  Math.abs(pixel[channel]! - expected[channel]!),
                ).toBeLessThanOrEqual(3);
            }
            const globalReport = {
              verdict: passed ? "pass" : "revise",
              summary: !passed
                ? "Latest target is incomplete"
                : "Latest source and saved pixels checked",
              checks: metadata.requiredChecks.map((check: any) => ({
                id: check.id,
                passed: passed || check.id !== "target",
                evidence:
                  check.id === "target" && !passed
                    ? "Actual latest candidate is missing the required target"
                    : "Actual source and latest saved frame were supplied and checked",
              })),
            };
            const report: any = native
              ? {
                  tiles: metadata.tiles.map((tile: any) => ({
                    ...globalReport,
                    tileId: tile.id,
                    people: {
                      sourceCount: 0,
                      candidateCount: 0,
                      evidence:
                        "Actual native source/candidate crops contain no people",
                    },
                    differences: [],
                  })),
                }
              : globalReport;
            const invalid =
              options.invalidReviewOrdinals?.includes(reviewOrdinal);
            if (invalid && (options.invalidReviewKind ?? "schema") === "schema")
              (native ? report.tiles[0] : report).checks[2].passed_note = "";
            await options.beforeReviewResponse?.(reviewOrdinal);
            return completionResponse(
              {
                id: randomUUID(),
                object: "chat.completion",
                created: 1,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content:
                        invalid && options.invalidReviewKind === "json"
                          ? '{"tiles":['
                          : JSON.stringify(report),
                    },
                    finish_reason: options.incompleteReviewOrdinals?.includes(
                      reviewOrdinal,
                    )
                      ? "content_filter"
                      : invalid && options.invalidReviewKind === "length"
                        ? "length"
                        : "stop",
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
          } catch (error) {
            errors.push(error);
            throw error;
          }
        }
        bodies.push(body);
        calls++;
        events.push(`executor-${calls}`);
        let actions: Action[];
        try {
          actions = await next(body, calls);
        } catch (error) {
          errors.push(error);
          actions = [clarify()];
        }
        // A positive submission requests a host verdict; executor prose never
        // supplies the independent result or authorizes a duplicate judge call.
        for (const action of actions)
          if (
            action.name === "image_batch" &&
            (action.args as any).action === "review" &&
            (action.args as any).review !== undefined
          ) {
            expect(typeof (action.args as any).review.passed).toBe("boolean");
          }
        if (calls === options.cancelExecutorAtStep) {
          const cancelled = await app.inject({
            method: "POST",
            url: `/api/v1/ai/jobs/${queuedId}/cancel`,
            headers: authenticatedHeaders,
          });
          expect(cancelled.statusCode, cancelled.body).toBe(200);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new DOMException(
                    "Fixture cancelled before model EOF",
                    "AbortError",
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
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
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: actions.map((action) => ({
                    id: randomUUID(),
                    type: "function",
                    function: {
                      name: action.name,
                      arguments: JSON.stringify(action.args),
                    },
                  })),
                },
                finish_reason: "tool_calls",
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
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, host: "localhost:39339" },
      payload: {
        login: "autoreview-owner",
        password: "autoreview-isolated-2026",
      },
    });
    expect(login.statusCode).toBe(200);
    const headers = {
        origin,
        host: "localhost:39339",
        cookie: String(login.headers["set-cookie"]),
      },
      id = randomUUID();
    queuedId = id;
    authenticatedHeaders = headers;
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionId}/messages`,
      headers,
      payload: {
        id,
        modelId: "chat",
        scope: "all",
        text: "继续同一批次并核对最新候选，保留全部冻结标准",
      },
    });
    expect(queued.statusCode, queued.body).toBe(200);
    let current: any;
    for (let n = 0; n < 600; n++) {
      current = (
        await app.inject({ url: `/api/v1/ai/sessions/${sessionId}`, headers })
      )
        .json()
        .jobs.find((job: any) => job.id === id);
      if (current && !["queued", "running"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      errors,
      JSON.stringify({
        calls,
        reviews,
        events,
        reviewsSaved: (await storedBatch(id)).reviews,
      }),
    ).toEqual([]);
    expect(
      current.status,
      JSON.stringify({
        error: current.error,
        calls,
        reviews,
        failures: current.progress?.events
          ?.filter(
            (event: any) => event.phase === "failed" || event.kind === "error",
          )
          .map((event: any) => ({
            title: event.title,
            detail: event.detail,
            data: event.data,
          })),
      }),
    ).toBe(options.expectedStatus ?? "completed");
    return {
      id,
      current,
      calls,
      reviews,
      providerCalls,
      reviewedAssets,
      bodies,
      events,
      batch: await storedBatch(id), sceneCalls,
    };
  } finally {
    await app.close();
  }
}

it("lets the executor repair an earlier rejected page before reviewing unrelated historical candidates", async () => {
  const historicalAsset = batch.delivered[page(1)];
  delete batch.reviews[page(1)];
  await attach();
  const result = await run((_body, step) => {
    if (step === 1) return [resume()];
    if (step === 2) return [status()];
    expect(step).toBe(3);
    return [clarify()];
  }, { generated: true, scenePageIndexes: [0] });
  expect(result.reviews).toBe(0);
  expect(result.sceneCalls).toBe(1); // The failed current page still gets repair planning.
  expect(result.providerCalls).toBe(0);
  expect(result.batch.delivered[page(1)]).toBe(historicalAsset);
  expect(result.batch.reviews[page(1)]).toBeUndefined();
  expect(result.batch.reviews[page(0)]).toMatchObject({ assetId: obsoleteAssetId, passed: false });
});

it("stops historical auto-review at its first actual rejection instead of planning the next page", async () => {
  delete batch.reviews[page(0)];
  delete batch.reviews[page(1)];
  await attach();
  const result = await run((_body, step) => {
    if (step === 1) return [resume()];
    if (step === 2) return [status()];
    expect(step).toBe(3);
    return [clarify()];
  }, { generated: true, passed: false, reviewAssetIds: [obsoleteAssetId],
    originalCandidateAssetIds: [obsoleteAssetId] });
  expect(result.reviews).toBe(1);
  expect(result.sceneCalls).toBe(1);
  expect(result.providerCalls).toBe(0);
  expect(result.reviewedAssets).toEqual([obsoleteAssetId]);
  expect(result.batch.reviews[page(0)]).toMatchObject({ assetId: obsoleteAssetId, passed: false });
  expect(result.batch.reviews[page(1)]).toBeUndefined();
});

it("immediately reviews an explicitly shown historical candidate even when an earlier page is rejected", async () => {
  const historicalAsset = batch.delivered[page(1)]!;
  delete batch.reviews[page(1)];
  await attach();
  const result = await run((body, step) => {
    if (step === 1) return [resume()];
    if (step === 2) return [{ name: "image_show", args: { assetId: historicalAsset } }];
    expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject({ assetId: historicalAsset, passed: true });
    expect(step).toBe(3);
    return [clarify()];
  }, { generated: true, reviewPageIndexes: [1], reviewAssetIds: [historicalAsset],
    originalCandidateAssetIds: [historicalAsset] });
  expect(result.reviews).toBe(1);
  expect(result.reviewedAssets).toEqual([historicalAsset]);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.reviews[page(0)]).toMatchObject({ assetId: obsoleteAssetId, passed: false });
});

it("auto-reviews a new export before the next executor request, ignores the old verdict and reuses acceptance for positive review and read-only views", async () => {
  let latest = "";
  const result = await run((body, step) => {
    if (step === 1) return [resume()];
    if (step === 2) return [exportPage(1)];
    if (step === 3) {
      latest = JSON.parse(lastTool(body, "image_export")).assetId;
      expect(latest).not.toBe(obsoleteAssetId);
      expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject(
        {
          assetId: latest,
          passed: true,
        },
      );
      return [status()];
    }
    if (step === 4) {
      const current = JSON.parse(lastTool(body, "image_batch"));
      expect(current.current.pages[1].inspection).toMatchObject({
        assetId: latest,
        passed: true,
      });
      expect(current.current.filename).toBe("alpha.pdf");
      expect(current.books[0].status).toBe("current");
      return [positiveReview(latest, 1)];
    }
    if (step === 5) {
      expect(
        JSON.parse(lastTool(body, "image_batch")).current.pages[1].inspection,
      ).toMatchObject({ assetId: latest, passed: true });
      return [status()];
    }
    if (step === 6) {
      expect(
        JSON.parse(lastTool(body, "image_batch")).current.pages[1].inspection,
      ).toMatchObject({ assetId: latest, passed: true });
      return [{ name: "image_show", args: { assetId: latest } }];
    }
    expect(step).toBe(7);
    return [clarify()];
  });
  expect(result.calls).toBe(7);
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(0);
  expect(result.events.indexOf("independent-vision-review")).toBeLessThan(
    result.events.indexOf("executor-3"),
  );
  expect(result.reviewedAssets).toEqual([latest]);
  expect(result.batch.reviews[page(1)]).toMatchObject({
    assetId: latest,
    passed: true,
  });
  expect(result.batch.current).toBe(0);
  expect(result.batch.requirements).toEqual(batch.requirements);
  const imageEvent = result.current.progress.events.find(
    (event: any) => event.image?.assetId === latest,
  );
  expect(imageEvent.image.validation).toMatchObject({ state: "passed" });
  expect(result.current.progress.phase).toBe("waiting_choice");
});
it("recovers an initial native-detail passed_note rejection through the host's actual pair when the executor only repeats image_batch review, preserving confirmed usage without inventing a false review", async () => {
  let latest = "";
  let invalidUsage: any[] = [];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        const recovery = initialReviewRecovery(body);
        expect(recovery).toMatchObject({
          error: true,
          code: "image_review_requires_fresh_view",
          referenceImageId: page(1),
          assetId: latest,
          reviewUnchanged: true,
          independentReview: "incomplete",
          usageFacts: "preserved",
          invalidReviewAttempts: 1,
          next: {
            toolName: "image_view",
            input: { referenceImageIds: [page(1), latest] },
          },
        });
        expect(recovery.failure.message).toContain(
          "phase=native-detail；kind=schema",
        );
        expect(recovery.failure.message).not.toContain("passed_note");
        expect(
          (
            await storedBatch(
              (
                await db
                  .selectFrom("ai_jobs")
                  .select("id")
                  .where("status", "=", "running")
                  .executeTakeFirstOrThrow()
              ).id,
            )
          ).reviews[page(1)],
        ).toBeUndefined();
        invalidUsage = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "confirmed")
          .orderBy("id")
          .execute();
        expect(
          invalidUsage.filter(
            (row) => row.input_tokens === 100 && row.output_tokens === 40,
          ),
        ).toHaveLength(3);
        return [positiveReview(latest, 1)];
      }
      if (step === 4) {
        expect(freshReviewToolFacts(body)).toMatchObject({
          referenceImageId: page(1),
          assetId: latest,
          invalidReviewAttempts: 1,
          independentReview: "incomplete",
        });
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(2);
        expect(scopedBatchStatus(body).current.pages[1].inspection).toBeNull();
        return [positiveReview(latest, 1)];
      }
      expect(step).toBe(5);
      expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject(
        { assetId: latest, passed: true },
      );
      for (const row of invalidUsage)
        expect(
          await db
            .selectFrom("ai_calls")
            .selectAll()
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow(),
        ).toEqual(row);
      return [clarify()];
    },
    { nativeDetailFixture: true, invalidReviewOrdinals: [2] },
  );
  expect(result.reviews).toBe(6); // Each wave includes its already-sent native sibling, also settled.
  expect(result.providerCalls).toBe(0);
  expect(result.reviewedAssets).toEqual([
    latest,
    latest,
    latest,
    latest,
    latest,
    latest,
  ]);
  expect(result.batch.reviews[page(1)]).toMatchObject({
    assetId: latest,
    passed: true,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
  const executorTools = result.bodies.flatMap((body) =>
    body.messages.flatMap((message: any) =>
      message.role === "assistant"
        ? (message.tool_calls ?? []).map((call: any) => call.function.name)
        : [],
    ),
  );
  expect(executorTools).not.toContain("image_view");
});

it.each([0, 1] as const)(
  "does not authorize a repeat review with only %i normalized host recovery frames, despite intact metadata",
  async (retained) => {
    let latest = "";
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2) return [exportPage(1)];
        if (step === 3) {
          latest = JSON.parse(lastTool(body, "image_export")).assetId;
          expect(initialReviewRecovery(body).invalidReviewAttempts).toBe(1);
          return [positiveReview(latest, 1)];
        }
        const recovery = freshReviewToolFacts(body);
        expect(recovery.independentReview).toBe("incomplete");
        expect(recovery.invalidReviewAttempts).toBe(1);
        expect(recovery.missingFreshViews).toBe(step - 3);
        expect(
          body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url"),
        ).toHaveLength(retained);
        expect(step).toBeLessThanOrEqual(5);
        return [positiveReview(latest, 1)];
      },
      {
        invalidReviewOrdinals: [1],
        stripRecoveryPixels: retained,
        expectedStatus: "failed",
      },
    );
    expect(result.calls).toBe(5);
    expect(result.reviews).toBe(1);
    expect(result.providerCalls).toBe(0);
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(JSON.parse(result.current.error)).toMatchObject({
      code: "image_review_reinspection_loop",
    });
  },
);

it("does not grant host recovery proof when the request with both actual frames is cancelled before EOF, retaining confirmed invalid usage", async () => {
  let latest = "";
  let confirmed: any[] = [];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        confirmed = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "confirmed")
          .where("output_tokens", "=", 40)
          .execute();
        expect(confirmed).toHaveLength(1);
        return [positiveReview(latest, 1)];
      }
      expect(step).toBe(4);
      expect(freshReviewToolFacts(body)).toMatchObject({
        referenceImageId: page(1),
        assetId: latest,
        invalidReviewAttempts: 1,
      });
      expect(
        body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url"),
      ).toHaveLength(2);
      expect(scopedBatchStatus(body).current.pages[1].inspection).toBeNull();
      return [positiveReview(latest, 1)];
    },
    {
      invalidReviewOrdinals: [1],
      cancelExecutorAtStep: 4,
      expectedStatus: "cancelled",
    },
  );
  expect(result.calls).toBe(4);
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.reviews[page(1)]).toBeUndefined();
  expect(result.batch.requirements).toEqual(batch.requirements);
  for (const row of confirmed)
    expect(
      await db
        .selectFrom("ai_calls")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(row);
});

it("rejects source/candidate bytes changed after the host recovery pair reached the model and preserves invalid usage without another judge", async () => {
  let latest = "";
  let savedFacts: any[] = [],
    confirmed: any[] = [];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        return [positiveReview(latest, 1)];
      }
      if (step === 4) {
        expect(freshReviewToolFacts(body).invalidReviewAttempts).toBe(1);
        expect(
          body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url"),
        ).toHaveLength(2);
        savedFacts = await db
          .selectFrom("ai_operations")
          .selectAll()
          .orderBy("id")
          .execute();
        confirmed = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "confirmed")
          .where("output_tokens", "=", 40)
          .execute();
        expect(confirmed).toHaveLength(1);
        const read = imageIO.readReferenceImages,
          changed = await png("#6040c0");
        vi.spyOn(imageIO, "readReferenceImages").mockImplementation(
          async (...args) => {
            const images = await read(...args);
            return images.map((image, index) =>
              args[2][index] === latest ? { ...image, data: changed } : image,
            );
          },
        );
        return [positiveReview(latest, 1)];
      }
      expect(step).toBe(5);
      expect(lastTool(body, "image_batch")).toContain("字节已改变");
      return [clarify()];
    },
    { invalidReviewOrdinals: [1] },
  );
  expect(result.calls).toBe(5);
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.reviews[page(1)]).toBeUndefined();
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(savedFacts);
  for (const row of confirmed)
    expect(
      await db
        .selectFrom("ai_calls")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(row);
});

it.each(["copy", "mutate-asset"] as const)(
  "%s of host recovery DTOs remains ordinary JSON and cannot confer pixels, ACL reads or fresh review proof",
  async (mode) => {
    const originalList = Agent.prototype.listTools;
    const read = vi.spyOn(imageIO, "readReferenceImages");
    const wrapped = new WeakSet<object>();
    const wireDtos: any[] = [];
    let alteredOutputs = 0;
    vi.spyOn(Agent.prototype, "listTools").mockImplementation(async function (
      this: Agent,
      ...args
    ) {
      const tools = await originalList.apply(this, args);
      const tool = (tools as any).image_batch;
      if (tool?.toModelOutput && !wrapped.has(tool)) {
        wrapped.add(tool);
        const originalOutput = tool.toModelOutput;
        vi.spyOn(tool, "toModelOutput").mockImplementation(
          async (output: any) => {
            if (output?.code !== "image_review_requires_fresh_view")
              return originalOutput(output);
            alteredOutputs++;
            const forwarded =
                mode === "copy" ? structuredClone(output) : output,
              beforeReads = read.mock.calls.length;
            if (mode === "mutate-asset") {
              const previous = forwarded.assetId;
              forwarded.assetId = randomUUID();
              expect(forwarded.assetId).not.toBe(previous);
              expect(forwarded).toBe(output);
            } else expect(forwarded).not.toBe(output);
            const rendered = await originalOutput(forwarded);
            expect(rendered).toBeUndefined();
            wireDtos.push(structuredClone(forwarded));
            expect(read.mock.calls).toHaveLength(beforeReads);
            return rendered;
          },
        );
      }
      return tools;
    } as typeof Agent.prototype.listTools);
    let latest = "";
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2) return [exportPage(1)];
        if (step === 3)
          latest = JSON.parse(lastTool(body, "image_export")).assetId;
        else {
          const dto = JSON.parse(lastTool(body, "image_batch"));
          expect(dto).toEqual(wireDtos.at(-1));
          expect(dto).toMatchObject({
            code: "image_review_requires_fresh_view",
            invalidReviewAttempts: 1,
            missingFreshViews: step - 3,
          });
          expect(
            body.messages
              .flatMap((message: any) =>
                Array.isArray(message.content) ? message.content : [],
              )
              .filter((part: any) => part.type === "image_url"),
          ).toHaveLength(0);
        }
        expect(step).toBeLessThanOrEqual(5);
        return [positiveReview(latest, 1)];
      },
      { invalidReviewOrdinals: [1], expectedStatus: "failed" },
    );
    expect(alteredOutputs).toBe(3);
    expect(result.calls).toBe(5);
    expect(result.reviews).toBe(1);
    expect(result.providerCalls).toBe(0);
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(result.batch.requirements).toEqual(batch.requirements);
    expect(decodeSystemError(result.current.error)).toMatchObject({
      code: "image_review_reinspection_loop",
    });
  },
);

it("drops recovery media when a normal legal batch bind changes requirements before the issued DTO is rendered", async () => {
  const clarificationId = randomUUID(),
    now = new Date().toISOString();
  const clarificationText =
    "本批补充确认：保留所有原有标签，不降低人物、背景与文字要求。";
  await db
    .insertInto("ai_jobs")
    .values({
      id: clarificationId,
      user_id: owner.id,
      session_id: sessionId,
      model_id: "chat",
      status: "completed",
      input: JSON.stringify({ text: clarificationText }),
      result: "{}",
      digest: clarificationId,
      error: "",
      lease: null,
      lease_until: null,
      cancelled: 0,
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const list = Agent.prototype.listTools,
    wrapped = new WeakSet<object>();
  const read = vi.spyOn(imageIO, "readReferenceImages");
  let mutated = false,
    latest = "";
  const expectedAssets = ["", obsoleteAssetId, ""];
  vi.spyOn(Agent.prototype, "listTools").mockImplementation(async function (
    this: Agent,
    ...args: Parameters<typeof list>
  ) {
    const tools = await list.apply(this, args),
      tool = (tools as any).image_batch;
    if (tool?.toModelOutput && !wrapped.has(tool)) {
      wrapped.add(tool);
      const render = tool.toModelOutput;
      vi.spyOn(tool, "toModelOutput").mockImplementation(
        async (output: any) => {
          if (output?.code !== "image_review_requires_fresh_view" || mutated)
            return render(output);
          mutated = true;
          const bound = await tool.execute({
            action: "bind",
            taskJobId: originalJobId,
            clarifications: [{ jobId: clarificationId, scope: "batch" }],
          });
          expect(bound.requirements.clarifications[0]).toMatchObject({
            source: { jobId: clarificationId, text: clarificationText },
            scope: "batch",
          });
          const count = read.mock.calls.length,
            imageCalls = await storedImageCalls();
          const rendered = await render(output);
          expect(rendered).toBeUndefined();
          expect(read.mock.calls).toHaveLength(count);
          expect(await storedImageCalls()).toEqual(imageCalls);
          return rendered;
        },
      );
    }
    return tools;
  } as typeof Agent.prototype.listTools);
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        expectedAssets[2] = latest;
        return [positiveReview(latest, 1)];
      }
      expect(step).toBe(4);
      const dto = JSON.parse(lastTool(body, "image_batch"));
      expect(dto).toMatchObject({
        code: "image_review_requires_fresh_view",
        assetId: latest,
      });
      expect(
        body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url"),
      ).toHaveLength(0);
      expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject(
        { assetId: latest, passed: true },
      );
      return [clarify()];
    },
    {
      invalidReviewOrdinals: [1],
      reviewPageIndexes: [1, 0, 1],
      reviewAssetIds: expectedAssets,
    },
  );
  expect(mutated).toBe(true);
  expect(result.reviews).toBe(3);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.requirements.clarifications[0]).toMatchObject({
    source: { jobId: clarificationId, text: clarificationText },
    scope: "batch",
  });
  expect(result.batch.delivered[page(1)]).toBe(latest);
  expect(result.batch.attemptScope).toEqual(batch.attemptScope);
});

it("drops an issued old-candidate recovery after normal select commits a peer with actual earlier EOF proof", async () => {
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const peer = await generateTestImageAsset(
    db,
    ctx,
    { prompt: "同范围的已保存付费候选", referenceImageIds: [page()] },
    randomUUID(),
    {
      operation: "edit",
      storage: runtime(),
      batchAttemptScope: batch.attemptScope,
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: (await png("#c07040")).toString("base64") }],
          usage: { input_images: 1, input_tokens: 9, output_tokens: 13 },
        })) as typeof fetch,
    },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  const list = Agent.prototype.listTools,
    wrapped = new WeakSet<object>();
  const read = vi.spyOn(imageIO, "readReferenceImages");
  let mutated = false,
    latest = "";
  vi.spyOn(Agent.prototype, "listTools").mockImplementation(async function (
    this: Agent,
    ...args: Parameters<typeof list>
  ) {
    const tools = await list.apply(this, args),
      tool = (tools as any).image_batch;
    if (tool?.toModelOutput && !wrapped.has(tool)) {
      wrapped.add(tool);
      const render = tool.toModelOutput;
      vi.spyOn(tool, "toModelOutput").mockImplementation(
        async (output: any) => {
          if (output?.code !== "image_review_requires_fresh_view" || mutated)
            return render(output);
          mutated = true;
          const selected = await tool.execute({
            action: "select",
            candidate: { referenceImageId: page(), assetId: peer.assetId },
          });
          expect(selected.selection).toMatchObject({
            state: "selected",
            assetId: peer.assetId,
          });
          const count = read.mock.calls.length,
            imageCalls = await storedImageCalls();
          expect(imageCalls).toHaveLength(2);
          const rendered = await render(output);
          expect(rendered).toBeUndefined();
          expect(read.mock.calls).toHaveLength(count);
          expect(await storedImageCalls()).toEqual(imageCalls);
          return rendered;
        },
      );
    }
    return tools;
  } as typeof Agent.prototype.listTools);
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          {
            name: "image_batch",
            args: {
              action: "select",
              candidate: { referenceImageId: page(), assetId: peer.assetId },
            },
          },
        ];
      }
      if (step === 4) {
        expect(
          JSON.parse(lastTool(body, "image_batch")).selection,
        ).toMatchObject({ state: "needs-fresh-view", assetId: peer.assetId });
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), peer.assetId] },
          },
        ];
      }
      if (step === 5) {
        expect(
          body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url"),
        ).toHaveLength(2);
        return [positiveReview(latest)];
      }
      expect(step).toBe(6);
      const dto = JSON.parse(lastTool(body, "image_batch"));
      expect(dto).toMatchObject({
        code: "image_review_requires_fresh_view",
        assetId: latest,
      });
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId: peer.assetId, passed: true },
      );
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false, true],
      reviewAssetIds: ["", peer.assetId],
    },
  );
  expect(mutated).toBe(true);
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.delivered[page()]).toBe(peer.assetId);
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(await storedImageCalls()).toHaveLength(2);
});

it.each(["schema", "json", "length"] as const)(
  "keeps the three invalid-judge budget (%s) across every complete fresh pair instead of clearing it on view",
  async (invalidReviewKind) => {
    let latest = "";
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2) return [exportPage(1)];
        if (step === 3) {
          latest = JSON.parse(lastTool(body, "image_export")).assetId;
          const recovery = initialReviewRecovery(body);
          expect(recovery.invalidReviewAttempts).toBe(1);
          return [positiveReview(latest, 1)];
        }
        expect(step).toBeLessThanOrEqual(5);
        expect(freshReviewToolFacts(body).invalidReviewAttempts).toBe(step - 3);
        expect(
          body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url"),
        ).toHaveLength(2);
        return [positiveReview(latest, 1)];
      },
      {
        invalidReviewKind,
        invalidReviewOrdinals: [1, 2, 3],
        expectedStatus: "failed",
      },
    );
    expect(result.calls).toBe(5);
    expect(result.reviews).toBe(3);
    expect(result.providerCalls).toBe(0);
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(decodeSystemError(result.current.error)).toEqual({
      code: "image_review_result_invalid",
    });
  },
);

it.each([false, true])(
  "keeps an initial connection failure (native phase=%s) terminal and its pending usage intact without validation recovery or another judge request",
  async (nativePhase) => {
    const actualGenerate = Agent.prototype.generate;
    const finishes: object[] = [];
    vi.spyOn(Agent.prototype, "generate").mockImplementation(async function (
      this: Agent,
      ...args: [any, any]
    ) {
      try {
        const result = await (
          actualGenerate as (...values: any[]) => Promise<any>
        ).apply(this, args);
        finishes.push({
          id: this.id,
          finishReason: result.finishReason,
          error: !!result.error,
        });
        return result;
      } catch (error) {
        finishes.push({ id: this.id, thrown: true });
        throw error;
      }
    } as typeof Agent.prototype.generate);
    const result = await run(
      (_body, step) => (step === 1 ? [resume()] : [exportPage(1)]),
      {
        nativeDetailFixture: nativePhase,
        failedReviewOrdinals: [nativePhase ? 2 : 1],
        expectedStatus: "failed",
      },
    );
    expect(
      result.calls,
      JSON.stringify({
        reviews: result.reviews,
        finishes,
        events: result.events.slice(0, 10),
        error: result.current.error,
      }),
    ).toBe(2);
    expect(result.reviews).toBe(nativePhase ? 3 : 1);
    expect(result.providerCalls).toBe(0);
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(JSON.stringify(result.bodies)).not.toContain("宿主独立验收恢复状态");
    expect(
      await db
        .selectFrom("ai_calls")
        .select("id")
        .where("state", "=", "pending")
        .execute(),
    ).toHaveLength(1);
  },
);

it.each([false, true])(
  "does not treat a completed non-stop reply (native phase=%s) as a JSON-validation recovery, even when its JSON is complete",
  async (nativePhase) => {
    const ordinal = nativePhase ? 2 : 1;
    const result = await run(
      (_body, step) => (step === 1 ? [resume()] : [exportPage(1)]),
      {
        nativeDetailFixture: nativePhase,
        incompleteReviewOrdinals: [ordinal],
        expectedStatus: "failed",
      },
    );
    expect(result.calls).toBe(2);
    expect(result.reviews).toBe(nativePhase ? 3 : 1);
    expect(decodeSystemError(result.current.error)).toEqual({
      code: "ai_workflow_incomplete",
    });
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(JSON.stringify(result.bodies)).not.toContain("宿主独立验收恢复状态");
    const usage = await db
      .selectFrom("ai_calls")
      .selectAll()
      .where("state", "=", "confirmed")
      .execute();
    expect(
      usage.filter(
        (row) => row.input_tokens === 100 && row.output_tokens === 40,
      ),
    ).toHaveLength(nativePhase ? 3 : 1);
    expect(result.providerCalls).toBe(0);
  },
);

it("requires a later actual model round after viewing an initially invalid delivery instead of accepting a same-round parallel positive", async () => {
  let latest = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        const recovery = initialReviewRecovery(body);
        return [
          { name: recovery.next.toolName, args: recovery.next.input },
          positiveReview(latest, 1),
        ];
      }
      if (step === 4) {
        expect(freshReviewToolFacts(body)).toMatchObject({
          error: true,
          independentReview: "incomplete",
          invalidReviewAttempts: 1,
          missingFreshViews: 1,
        });
        return [positiveReview(latest, 1)];
      }
      expect(step).toBe(5);
      expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject(
        { assetId: latest, passed: true },
      );
      return [clarify()];
    },
    { invalidReviewOrdinals: [1] },
  );
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(0);
});

it("persists actual rejection, refuses advance and a positive request without a fresh source/candidate view without another judge call", async () => {
  let latest = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        expect(latest).not.toBe(obsoleteAssetId);
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({
          assetId: latest,
          passed: false,
        });
        expect(
          contentReviewFailures(body).find(
            (feedback) => feedback.assetId === latest,
          ),
        ).toMatchObject({
          code: "image_review_content_failed",
          referenceImageId: page(),
          actualPassed: false,
          evidence:
            scopedBatchStatus(body).current.pages[0].inspection.evidence,
          next: {
            toolName: "image_candidate_view",
            input: {
              generationOperationId: mediaToolFacts(body, "image_edit")
                .generationOperationId,
            },
          },
        });
        return [{ name: "image_batch", args: { action: "advance" } }];
      }
      if (step === 4) {
        expect(lastTool(body, "image_batch")).toContain("验收");
        return [status()];
      }
      if (step === 5) {
        expect(
          JSON.parse(lastTool(body, "image_batch")).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: false });
        return [positiveReview(latest)];
      }
      if (step === 6) {
        const blocked = freshReviewToolFacts(body);
        expect(blocked.instruction).toContain("先单独 image_view");
        expect(blocked.instruction).not.toContain(
          "下一轮再 image_batch review passed:true",
        );
        expect(blocked.currentInspection).toMatchObject({
          assetId: latest,
          actualPassed: false,
          evidence:
            scopedBatchStatus(body).current.pages[0].inspection.evidence,
        });
        return [status()];
      }
      if (step === 7) {
        expect(
          JSON.parse(lastTool(body, "image_batch")).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: false });
        return [clarify()];
      }
      throw Error(`Unexpected continuation ${step}`);
    },
    { passed: false, generated: true },
  );
  expect(result.calls).toBe(7);
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(1);
  expect(result.reviewedAssets).toEqual([latest]);
  expect(result.events.indexOf("independent-vision-review")).toBeLessThan(
    result.events.indexOf("executor-3"),
  );
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: false,
    evidence: expect.stringContaining("Actual latest candidate is missing"),
  });
  expect(result.batch.current).toBe(0);
  expect(result.batch.delivered[page()]).toBe(latest);
  const imageEvent = result.current.progress.events.find(
    (event: any) => event.image?.assetId === latest,
  );
  expect(imageEvent.image.validation).toMatchObject({ state: "rejected" });
});
it("rechecks the actual current image in a fresh resumed job instead of returning an executor's cached false, and reuses the new true idempotently", async () => {
  let latest = "";
  const wrongOldEvidence =
    "Copied older asset defect: three unrelated additional people";
  const first = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: true });
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(),
                assetId: latest,
                passed: false,
                evidence: wrongOldEvidence,
              },
            },
          },
        ];
      }
      expect(step).toBe(4);
      return [clarify()];
    },
    { generated: true },
  );
  const priorResult = (
    await db
      .selectFrom("ai_jobs")
      .select("result")
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow()
  ).result;
  const priorCalls = await db
    .selectFrom("ai_calls")
    .selectAll()
    .where("job_id", "=", first.id)
    .orderBy("id")
    .execute();
  expect(first.batch.reviews[page()]).toEqual({
    assetId: latest,
    passed: false,
    evidence: wrongOldEvidence,
  });
  originalJobId = first.id;
  batch = first.batch;
  const second = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      if (step === 3) {
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(2);
        const text = JSON.stringify(body.messages);
        expect(text).toContain(page());
        expect(text).toContain(latest);
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({
          assetId: latest,
          passed: false,
          evidence: wrongOldEvidence,
        });
        return [positiveReview(latest)];
      }
      if (step === 4) {
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: true });
        expect(
          JSON.parse(lastTool(body, "image_batch")).reviewOutcome,
        ).toMatchObject({
          referenceImageId: page(),
          assetId: latest,
          actualPassed: true,
        });
        expect(
          contentReviewFailures(body).some(
            (feedback) => feedback.assetId === latest,
          ),
        ).toBe(false);
        return [positiveReview(latest)];
      }
      expect(step).toBe(5);
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId: latest, passed: true },
      );
      return [clarify()];
    },
    { generated: true },
  );
  expect(second.reviews).toBe(1);
  expect(second.providerCalls).toBe(0);
  expect(second.reviewedAssets).toEqual([latest]);
  expect(second.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: true,
    evidence: expect.stringContaining("Actual source and latest"),
  });
  expect(second.batch.requirements).toEqual(first.batch.requirements);
  expect(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(priorResult);
  expect(
    await db
      .selectFrom("ai_calls")
      .selectAll()
      .where("job_id", "=", first.id)
      .orderBy("id")
      .execute(),
  ).toEqual(priorCalls);
});
it("does not authorize a same-response view/positive or repeat a failed paid recheck using the same delivered inspection", async () => {
  const list = Agent.prototype.listTools;
  const wrapped = new WeakSet<object>();
  const rendererErrors: { message: string; status?: number }[] = [];
  let unmappedRecoveryOutputs = 0;
  vi.spyOn(Agent.prototype, "listTools").mockImplementation(async function (
    this: Agent,
    ...args: Parameters<typeof list>
  ) {
    const tools = await list.apply(this, args);
    const tool = (tools as any).image_batch;
    if (tool?.toModelOutput && !wrapped.has(tool)) {
      wrapped.add(tool);
      const render = tool.toModelOutput;
      vi.spyOn(tool, "toModelOutput").mockImplementation(
        async (output: any) => {
          try {
            const rendered = await render(output);
            if (
              output?.code === "image_review_requires_fresh_view" &&
              rendered === undefined
            ) {
              unmappedRecoveryOutputs++;
            }
            return rendered;
          } catch (error) {
            const failure = error as Error & { status?: number };
            rendererErrors.push({
              message: failure.message,
              status: failure.status,
            });
            throw error;
          }
        },
      );
    }
    return tools;
  } as typeof Agent.prototype.listTools);
  let latest = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
          positiveReview(latest),
        ];
      }
      if (step === 4) {
        expect(lastTool(body, "image_batch")).toContain("先单独 image_view");
        return [positiveReview(latest), positiveReview(latest)];
      }
      if (step === 5) {
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: false });
        return [positiveReview(latest)];
      }
      expect(step).toBe(6);
      expect(lastTool(body, "image_batch")).toContain("先单独 image_view");
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false, false],
      stripRecoveryPixels: 0,
      stripRecoveryFromReview: 2,
    },
  );
  expect(rendererErrors).toEqual([]);
  expect(unmappedRecoveryOutputs).toBeGreaterThanOrEqual(1);
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(1);
  expect(result.reviewedAssets).toEqual([latest, latest]);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: false,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
});
it("exposes the exact current source/candidate recovery after a failed independent recheck and retries only after the attached pair reaches model EOF", async () => {
  let latest = "";
  let pendingCall: any;
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      }
      if (step === 4) return [positiveReview(latest)];
      if (step === 5) {
        const recovery = freshReviewToolFacts(body);
        expect(recovery).toMatchObject({
          error: true,
          code: "image_review_requires_fresh_view",
          reviewUnchanged: true,
          proofConsumed: true,
          independentReview: "incomplete",
          usageFacts: "preserved",
          missingFreshViews: 0,
          next: {
            toolName: "image_view",
            input: { referenceImageIds: [page(), latest] },
          },
        });
        expect(JSON.stringify(body.messages)).not.toContain(
          "PRIVATE_VERIFIER_HEADER_AND_URL",
        );
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: false });
        const pending = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "pending")
          .execute();
        expect(pending).toHaveLength(1);
        pendingCall = pending[0];
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(2);
        expect(JSON.stringify(body.messages)).toContain(page());
        expect(JSON.stringify(body.messages)).toContain(latest);
        return [positiveReview(latest)];
      }
      expect(step).toBe(6);
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        {
          assetId: latest,
          passed: true,
        },
      );
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false, true, true],
      failedReviewOrdinals: [2],
    },
  );
  expect(result.reviews).toBe(3);
  expect(result.calls).toBe(6);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: true,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(
    await db
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", pendingCall.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(pendingCall);
});

it("resets the unproven-recheck limit only after a newly delivered complete pair, without releasing either failed judge's pending usage", async () => {
  let latest = "";
  let firstPending: any;
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      }
      if (step === 4) return [positiveReview(latest)];
      if (step === 5) {
        expect(freshReviewToolFacts(body).missingFreshViews).toBe(0);
        firstPending = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "pending")
          .executeTakeFirstOrThrow();
        return [positiveReview(latest)];
      }
      if (step === 6) {
        expect(freshReviewToolFacts(body).missingFreshViews).toBe(1);
        return [positiveReview(latest)];
      }
      if (step === 7) {
        const recovery = freshReviewToolFacts(body);
        expect(recovery.missingFreshViews).toBe(2);
        return [{ name: recovery.next.toolName, args: recovery.next.input }];
      }
      if (step === 8) {
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(2);
        return [positiveReview(latest)];
      }
      if (step === 9) {
        const recovery = freshReviewToolFacts(body);
        expect(recovery.missingFreshViews).toBe(0);
        expect(recovery.proofConsumed).toBe(true);
        return [positiveReview(latest)];
      }
      expect(step).toBe(10);
      expect(freshReviewToolFacts(body).missingFreshViews).toBe(1);
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false],
      failedReviewOrdinals: [2, 3],
      stripRecoveryPixels: 0,
    },
  );
  expect(result.reviews).toBe(3);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: false,
  });
  const pending = await db
    .selectFrom("ai_calls")
    .selectAll()
    .where("state", "=", "pending")
    .execute();
  expect(pending).toHaveLength(2);
  expect(pending.find((call) => call.id === firstPending.id)).toEqual(
    firstPending,
  );
});

it("stops three unproven rechecks despite changed evidence, status calls and a partial new view, retaining the failed judge's pending usage and original verdict", async () => {
  let latest = "";
  let pendingCall: any;
  const changedPositive = (evidence: string): Action => ({
    name: "image_batch",
    args: {
      action: "review",
      review: {
        referenceImageId: page(),
        assetId: latest,
        passed: true,
        evidence,
      },
    },
  });
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      }
      if (step === 4) return [positiveReview(latest)];
      if (step === 5) {
        const recovery = freshReviewToolFacts(body);
        expect(recovery.proofConsumed).toBe(true);
        expect(recovery.missingFreshViews).toBe(0);
        const pending = await db
          .selectFrom("ai_calls")
          .selectAll()
          .where("state", "=", "pending")
          .execute();
        expect(pending).toHaveLength(1);
        pendingCall = pending[0];
        return [changedPositive("Changed prose A supplies no new pixels")];
      }
      if (step === 6) {
        expect(freshReviewToolFacts(body).missingFreshViews).toBe(1);
        return [status()];
      }
      if (step === 7)
        return [changedPositive("Changed prose B after a status lookup")];
      if (step === 8) {
        const recovery = freshReviewToolFacts(body);
        expect(recovery.missingFreshViews).toBe(2);
        return [{ name: recovery.next.toolName, args: recovery.next.input }];
      }
      expect(step).toBe(9);
      const frames = body.messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url");
      expect(frames).toHaveLength(1);
      const facts = mediaToolFacts(body, "image_view");
      expect(facts.images.map((image: any) => image.referenceImageId)).toEqual([
        page(),
        latest,
      ]);
      return [
        changedPositive("Changed prose C with metadata but missing pixels"),
      ];
    },
    {
      generated: true,
      reviewVerdicts: [false, true],
      failedReviewOrdinals: [2],
      stripViewPixels: 1,
      stripViewFromReview: 2,
      stripRecoveryPixels: 0,
      stripRecoveryFromReview: 2,
      expectedStatus: "failed",
    },
  );
  expect(result.calls).toBe(9);
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: false,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(
    await db
      .selectFrom("ai_calls")
      .selectAll()
      .where("id", "=", pendingCall.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(pendingCall);
  const failed = await db
    .selectFrom("ai_jobs")
    .select("error")
    .where("id", "=", result.id)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(failed.error)).toMatchObject({
    type: "system_error",
    version: 1,
    code: "image_review_reinspection_loop",
    data: { referenceImageId: page(), assetId: latest },
  });
});
it.each([0, 1] as const)(
  "does not grant a recheck when only %i actual source/candidate frames remain, even with intact receipt metadata and labels",
  async (retained) => {
    let latest = "";
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2) return [generate()];
        if (step === 3) {
          latest = mediaToolFacts(body, "image_edit").assetId;
          return [
            {
              name: "image_view",
              args: { referenceImageIds: [page(), latest] },
            },
          ];
        }
        if (step === 4) {
          const parts = body.messages.flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          );
          expect(
            parts.filter((part: any) => part.type === "image_url"),
          ).toHaveLength(retained);
          const metadata = JSON.stringify(body.messages);
          expect(metadata).toContain(page());
          expect(metadata).toContain(latest);
          return [positiveReview(latest)];
        }
        expect(step).toBe(5);
        expect(lastTool(body, "image_batch")).toContain("先单独 image_view");
        return [clarify()];
      },
      { generated: true, passed: false, stripViewPixels: retained },
    );
    expect(result.reviews).toBe(1);
    expect(result.providerCalls).toBe(1);
    expect(result.batch.reviews[page()]).toMatchObject({
      assetId: latest,
      passed: false,
    });
  },
);
it("rejects candidate bytes changed after the exact source/candidate view and preserves the false and all paid facts without another judge call", async () => {
  let latest = "";
  let savedFacts: unknown[] = [];
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      }
      if (step === 4) {
        savedFacts = await db
          .selectFrom("ai_operations")
          .selectAll()
          .orderBy("id")
          .execute();
        const read = imageIO.readReferenceImages,
          changed = await png("#6040c0");
        // Run normal session/ACL/storage loading first, then inject changed
        // asset bytes at the read boundary. No persisted row is modified.
        vi.spyOn(imageIO, "readReferenceImages").mockImplementation(
          async (...args) => {
            const images = await read(...args);
            return images.map((image, index) =>
              args[2][index] === latest ? { ...image, data: changed } : image,
            );
          },
        );
        return [positiveReview(latest)];
      }
      expect(step).toBe(5);
      expect(lastTool(body, "image_batch")).toContain("字节已改变");
      return [clarify()];
    },
    { generated: true, passed: false },
  );
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(1);
  expect(result.reviewedAssets).toEqual([latest]);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: false,
  });
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(savedFacts);
});
it.each([false, true])(
  "preserves a newer parallel false even when its evidence is repeated=%s and retains the already-started judge call",
  async (repeatEvidence) => {
    let latest = "",
      negativeEvidence = "",
      publishedBeforeNegative = "",
      startJudge!: () => void;
    const initialEvidence =
      "Current actual candidate still has one unresolved target defect";
    const judgeStarted = new Promise<void>((resolve) => {
      startJudge = resolve;
    });
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2) return [generate()];
        if (step === 3) {
          latest = mediaToolFacts(body, "image_edit").assetId;
          negativeEvidence = repeatEvidence
            ? initialEvidence
            : "New latest-asset defect explicitly submitted while the independent recheck is pending";
          return [
            {
              name: "image_batch",
              args: {
                action: "review",
                review: {
                  referenceImageId: page(),
                  assetId: latest,
                  passed: false,
                  evidence: initialEvidence,
                },
              },
            },
          ];
        }
        if (step === 4) {
          return [
            {
              name: "image_view",
              args: { referenceImageIds: [page(), latest] },
            },
          ];
        }
        if (step === 5) {
          const read = imageIO.readReferenceImages;
          let initialReads = 0;
          vi.spyOn(imageIO, "readReferenceImages").mockImplementation(
            async (...args) => {
              if (
                args[2].length === 1 &&
                args[2][0] === latest &&
                ++initialReads === 2
              )
                await judgeStarted;
              return read(...args);
            },
          );
          return [
            positiveReview(latest),
            {
              name: "image_batch",
              args: {
                action: "review",
                review: {
                  referenceImageId: page(),
                  assetId: latest,
                  passed: false,
                  evidence: negativeEvidence,
                },
              },
            },
          ];
        }
        expect(step).toBe(6);
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({
          assetId: latest,
          passed: false,
          evidence: negativeEvidence,
        });
        expect(JSON.stringify(body.messages)).toContain("保留较新的反馈");
        return [clarify()];
      },
      {
        generated: true,
        reviewVerdicts: [false, true],
        onIndependentReview: async (ordinal) => {
          if (ordinal !== 2) return;
          publishedBeforeNegative = (
            await db
              .selectFrom("ai_jobs")
              .select("updated_at")
              .where("session_id", "=", sessionId)
              .where("status", "=", "running")
              .executeTakeFirstOrThrow()
          ).updated_at;
          // Hold the negative's read until the second judge is definitely
          // submitted, then wait for a later forced publication below.
          await new Promise((resolve) => setTimeout(resolve, 2));
          startJudge();
        },
        beforeReviewResponse: async (ordinal) => {
          if (ordinal !== 2) return;
          for (let attempt = 0; attempt < 300; attempt++) {
            const jobs = await db
              .selectFrom("ai_jobs")
              .select(["result", "updated_at"])
              .where("session_id", "=", sessionId)
              .where("status", "=", "running")
              .execute();
            if (
              jobs.some(
                (job) =>
                  JSON.parse(job.result).checkpoint?.imageBatch?.reviews?.[
                    page()
                  ]?.evidence === negativeEvidence &&
                  job.updated_at !== publishedBeforeNegative,
              )
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw Error(
            "The parallel newer rejection was not published while the judge was pending",
          );
        },
      },
    );
    expect(result.reviews).toBe(2);
    expect(result.providerCalls).toBe(1);
    expect(result.batch.reviews[page()]).toEqual({
      assetId: latest,
      passed: false,
      evidence: negativeEvidence,
    });
    expect(result.batch.requirements).toEqual(batch.requirements);
    const completedJudges = await db
      .selectFrom("ai_calls")
      .select(["state", "input_tokens", "output_tokens"])
      .where("job_id", "=", result.id)
      .where("model_id", "=", "chat")
      .execute();
    expect(
      completedJudges.filter(
        (call) =>
          call.state === "confirmed" &&
          call.input_tokens > 0 &&
          call.output_tokens > 0,
      ),
    ).toHaveLength(result.calls + result.reviews + result.sceneCalls);
  },
);
it("does not discard this page's independent recheck merely because another page receives a parallel negative review", async () => {
  let latest = "",
    startJudge!: () => void;
  const otherAsset = batch.delivered[page(1)]!,
    otherEvidence =
      "A separately viewed latest page has its own unresolved defect",
    judgeStarted = new Promise<void>((resolve) => {
      startJudge = resolve;
    });
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        latest = mediaToolFacts(body, "image_edit").assetId;
        return [
          { name: "image_view", args: { referenceImageIds: [page(), latest] } },
        ];
      }
      if (step === 4) {
        const read = imageIO.readReferenceImages;
        vi.spyOn(imageIO, "readReferenceImages").mockImplementation(
          async (...args) => {
            if (args[2].length === 1 && args[2][0] === otherAsset)
              await judgeStarted;
            return read(...args);
          },
        );
        return [
          positiveReview(latest),
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(1),
                assetId: otherAsset,
                passed: false,
                evidence: otherEvidence,
              },
            },
          },
        ];
      }
      expect(step).toBe(5);
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId: latest, passed: true },
      );
      expect(scopedBatchStatus(body).current.pages[1].inspection).toMatchObject(
        { assetId: otherAsset, passed: false, evidence: otherEvidence },
      );
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false, true],
      onIndependentReview: (ordinal) => {
        if (ordinal === 2) startJudge();
      },
      beforeReviewResponse: async (ordinal) => {
        if (ordinal !== 2) return;
        for (let attempt = 0; attempt < 300; attempt++) {
          const jobs = await db
            .selectFrom("ai_jobs")
            .select("result")
            .where("session_id", "=", sessionId)
            .where("status", "=", "running")
            .execute();
          if (
            jobs.some(
              (job) =>
                JSON.parse(job.result).checkpoint?.imageBatch?.reviews?.[
                  page(1)
                ]?.evidence === otherEvidence,
            )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw Error(
          "The other page's negative review was not published while this page's judge was pending",
        );
      },
    },
  );
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.reviews[page()]).toMatchObject({
    assetId: latest,
    passed: true,
  });
  expect(result.batch.reviews[page(1)]).toEqual({
    assetId: otherAsset,
    passed: false,
    evidence: otherEvidence,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
});
it("refuses to return an old passed image as a new edit and accepts an actual latest-asset defect without changing requirements", async () => {
  let latest = "",
    generationOperationId = "";
  const evidence = "Actual latest candidate contains three additional people";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        const generated = mediaToolFacts(body, "image_edit");
        latest = generated.assetId;
        generationOperationId = generated.generationOperationId;
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: true });
        return [generate()];
      }
      if (step === 4) {
        const failure = lastTool(body, "image_edit");
        expect(failure).toContain("本次修改未执行、未计费");
        expect(failure).toContain(latest);
        expect(failure).toContain("passed=false");
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(),
                assetId: latest,
                passed: false,
                evidence,
              },
            },
          },
        ];
      }
      if (step === 5) {
        const output = JSON.parse(lastTool(body, "image_batch"));
        expect(output.reviewOutcome).toEqual({
          referenceImageId: page(),
          assetId: latest,
          actualPassed: false,
          evidence,
        });
        expect(output.repair).toMatchObject({
          referenceImageId: page(),
          assetId: latest,
          actualPassed: false,
          evidence,
          next: {
            toolName: "image_candidate_view",
            input: {
              generationOperationId,
            },
          },
        });
        expect(
          contentReviewFailures(body).find(
            (feedback) => feedback.assetId === latest,
          ),
        ).toEqual(output.repair);
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: false, evidence });
        return [generate()];
      }
      if (step === 6) {
        expect(lastTool(body, "image_edit")).toContain("image_candidate_view");
        return [status()];
      }
      expect(step).toBe(7);
      return [clarify()];
    },
    { generated: true },
  );
  expect(result.calls).toBe(7);
  expect(result.reviews).toBe(1);
  expect(result.providerCalls).toBe(1);
  expect(result.batch.delivered[page()]).toBe(latest);
  expect(result.batch.reviews[page()]).toEqual({
    assetId: latest,
    passed: false,
    evidence,
  });
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(
    result.current.progress.events.find(
      (event: any) => event.image?.assetId === latest,
    ).image.validation,
  ).toEqual({ state: "rejected", evidence });
});
it("exposes auto and manually rechecked rejection without fabricated raw or automatic paid repair, retaining the three no-fresh stop", async () => {
  let latest = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [exportPage(1)];
      if (step === 3) {
        latest = JSON.parse(lastTool(body, "image_export")).assetId;
        const failure = contentReviewFailures(body).find(
          (feedback) => feedback.assetId === latest,
        );
        expect(failure).toMatchObject({
          referenceImageId: page(1),
          actualPassed: false,
          next: {
            toolName: "image_view",
            input: { referenceImageIds: [page(1), latest] },
          },
        });
        return [{ name: failure.next.toolName, args: failure.next.input }];
      }
      if (step === 4) return [positiveReview(latest, 1)];
      if (step === 5) {
        const output = JSON.parse(lastTool(body, "image_batch"));
        expect(output.reviewOutcome).toMatchObject({
          referenceImageId: page(1),
          assetId: latest,
          actualPassed: false,
        });
        expect(output.repair).toMatchObject({
          referenceImageId: page(1),
          assetId: latest,
          actualPassed: false,
          evidence: output.reviewOutcome.evidence,
          next: { toolName: "image_view" },
        });
      } else {
        expect(step).toBeLessThanOrEqual(7);
        const blocked = freshReviewToolFacts(body);
        expect(blocked.missingFreshViews).toBe(step - 5);
        expect(blocked.currentInspection).toMatchObject({
          referenceImageId: page(1),
          assetId: latest,
          actualPassed: false,
        });
        expect(blocked.independentReview).toBe("not_requested");
      }
      return [positiveReview(latest, 1)];
    },
    { passed: false, expectedStatus: "failed", stripRecoveryPixels: 0 },
  );
  expect(result.reviews).toBe(2);
  expect(result.calls).toBe(7);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.reviews[page(1)]).toMatchObject({
    assetId: latest,
    passed: false,
  });
  expect(decodeSystemError(result.current.error)).toMatchObject({
    code: "image_review_reinspection_loop",
    data: { referenceImageId: page(1), assetId: latest },
  });
});

it("removes an old asset's repair feedback while independently reviewing a real newly saved repair instead of inheriting a pass", async () => {
  let rejected = "",
    repaired = "",
    newAssetWasUnreviewed = false;
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2) return [generate()];
      if (step === 3) {
        rejected = mediaToolFacts(body, "image_edit").assetId;
        const feedback = contentReviewFailures(body).find(
          (item) => item.assetId === rejected,
        );
        expect(feedback.actualPassed).toBe(false);
        return [{ name: feedback.next.toolName, args: feedback.next.input }];
      }
      if (step === 4) {
        expect(
          contentReviewFailures(body).some((item) => item.assetId === rejected),
        ).toBe(true);
        const action = generate();
        return [
          {
            ...action,
            args: {
              ...action.args,
              prompt: "修正当前原请求中缺漏的目标，保留冻结要求及非目标内容",
            },
          },
        ];
      }
      expect(step).toBe(5);
      repaired = mediaToolFacts(body, "image_edit").assetId;
      expect(repaired).not.toBe(rejected);
      expect(
        contentReviewFailures(body).some(
          (item) => item.assetId === rejected || item.assetId === repaired,
        ),
      ).toBe(false);
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId: repaired, passed: true },
      );
      return [clarify()];
    },
    {
      generated: true,
      reviewVerdicts: [false, true],
      onIndependentReview: async (ordinal) => {
        if (ordinal !== 2) return;
        const job = await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("session_id", "=", sessionId)
          .where("status", "=", "running")
          .executeTakeFirstOrThrow();
        const current = JSON.parse(job.result).checkpoint.imageBatch;
        expect(current.delivered[page()]).not.toBe(rejected);
        expect(current.reviews[page()]?.assetId).not.toBe(
          current.delivered[page()],
        );
        newAssetWasUnreviewed = true;
      },
    },
  );
  expect(newAssetWasUnreviewed).toBe(true);
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(2);
  expect(result.reviewedAssets).toEqual([rejected, repaired]);
  expect(result.batch.requirements).toEqual(batch.requirements);
});

it("rejects top-level review placement with a bound nested template and advances after the legal schema without changing actual reviews or paying", async () => {
  let latest = "",
    actualReviews: ImageBatch["reviews"] | undefined;
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), obsoleteAssetId] },
          },
        ];
      if (step === 3) return [positiveReview(obsoleteAssetId)];
      if (step === 4) return [exportPage(1)];
      if (step === 5) {
        latest = scopedBatchStatus(body).current.pages[0].assetId;
        expect(
          scopedBatchStatus(body).current.pages.every(
            (item: any) =>
              item.inspection?.passed === true &&
              item.inspection.assetId === item.assetId,
          ),
        ).toBe(true);
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              referenceImageId: page(),
              assetId: latest,
              passed: false,
              evidence: "Top-level false must not become a persisted rejection",
            },
          },
        ];
      }
      if (step === 6 || step === 7) {
        const rejected = JSON.parse(lastTool(body, "image_batch"));
        expect(rejected).toMatchObject({
          error: true,
          status: 400,
          code: "image_batch_review_input_required",
          readyToAdvance: true,
          reviewInput: {
            action: "review",
            review: { referenceImageId: page(), assetId: latest },
          },
          needsActualValues: ["review.passed", "review.evidence"],
          next: { toolName: "image_batch", input: { action: "advance" } },
        });
        expect(rejected.reviewInput.review).not.toHaveProperty("passed");
        expect(rejected.reviewInput.review).not.toHaveProperty("evidence");
        expect(rejected.bindings).toContainEqual({
          referenceImageId: page(),
          assetId: latest,
          actualPassed: true,
        });
        expect(
          scopedBatchStatus(body).current.pages[0].inspection,
        ).toMatchObject({ assetId: latest, passed: true });
        expect(JSON.stringify(rejected)).not.toContain(
          "Top-level false must not become",
        );
        return step === 6
          ? [{ name: "image_batch", args: { action: "review" } }]
          : [positiveReview(latest)];
      }
      if (step === 8) {
        const reviewed = JSON.parse(lastTool(body, "image_batch"));
        expect(reviewed.reviewOutcome).toMatchObject({
          referenceImageId: page(),
          assetId: latest,
          actualPassed: true,
        });
        actualReviews = Object.fromEntries(
          reviewed.current.pages.map((item: any) => [
            item.referenceImageId,
            item.inspection,
          ]),
        );
        return [{ name: "image_batch", args: { action: "advance" } }];
      }
      expect(step).toBe(9);
      expect(scopedBatchStatus(body).current.filename).toBe("beta.pdf");
      return [clarify()];
    },
    { reviewPageIndexes: [0, 1], reviewAssetIds: [obsoleteAssetId] },
  );
  expect(result.reviews).toBe(2);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.current).toBe(1);
  expect(result.batch.reviews).toEqual(actualReviews);
  expect(result.batch.requirements).toEqual(batch.requirements);
});

it("keeps three identical missing-review error returns terminal without any review, provider call or persistent change", async () => {
  let originalReviews: ImageBatch["reviews"] | undefined;
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        originalReviews = Object.fromEntries(
          scopedBatchStatus(body)
            .current.pages.filter((item: any) => item.inspection)
            .map((item: any) => [item.referenceImageId, item.inspection]),
        );
      if (step >= 3) {
        const error = JSON.parse(lastTool(body, "image_batch"));
        expect(error).toMatchObject({
          error: true,
          status: 400,
          code: "image_batch_review_input_required",
          readyToAdvance: false,
        });
        expect(error.reviewInput.review).not.toHaveProperty("passed");
        expect(error.reviewInput.review).not.toHaveProperty("evidence");
      }
      expect(step).toBeLessThanOrEqual(4);
      return [{ name: "image_batch", args: { action: "review" } }];
    },
    { expectedStatus: "failed" },
  );
  expect(result.calls).toBe(4);
  expect(result.reviews).toBe(0);
  expect(result.providerCalls).toBe(0);
  expect(result.batch.reviews).toEqual(originalReviews);
  expect(result.current.error).toContain("连续三次以相同参数失败");
});

it.each(["clarify", "unknown-paid"] as const)(
  "stops %s before auto-draining pending saved images or making a new executor request",
  async (stop) => {
    const result = await run(
      (_body, step) => {
        if (step === 1) return [resume()];
        expect(step).toBe(2);
        return stop === "clarify"
          ? [exportPage(1), clarify()]
          : [generate(), exportPage(1)];
      },
      {
        unknownPaid: stop === "unknown-paid",
        expectedStatus: stop === "unknown-paid" ? "failed" : "completed",
      },
    );
    expect(result.calls).toBe(2);
    expect(result.reviews).toBe(0);
    expect(result.batch.current).toBe(0);
    expect(result.batch.delivered[page(1)]).toBeDefined();
    expect(result.batch.delivered[page(1)]).not.toBe(obsoleteAssetId);
    expect(result.batch.reviews[page(1)]).toBeUndefined();
    expect(result.providerCalls).toBe(stop === "unknown-paid" ? 1 : 0);
    if (stop === "clarify")
      expect(result.current.progress.phase).toBe("waiting_choice");
    else
      expect(JSON.parse(result.current.error)).toMatchObject({
        code: "image_result_uncertain",
      });
  },
);

it("explicitly upgrades a continuation and executes saved-base revision with complete independent review", async () => {
  let currentAsset = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) {
        expect(scopedBatchStatus(body).version).toBe(4);
        expect(scopedBatchStatus(body).attemptScope.version).toBe(2);
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), obsoleteAssetId] },
          },
        ];
      }
      if (step === 4)
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: "Correct target; retain all current correct changes",
            },
          },
        ];
      expect(step).toBe(5);
      const media = JSON.parse(lastTool(body, "image_edit_saved"));
      const saved = Array.isArray(media)
        ? JSON.parse(media.find((part: any) => part.type === "text").text)
        : media;
      expect(saved).toMatchObject({
        kind: "image_revision",
        version: 1,
        originalReferenceImageId: page(),
        providerReferenceImageIds: [obsoleteAssetId],
      });
      expect(saved.paidAttempt).toMatchObject({ version: 2, ordinal: 1 });
      currentAsset = saved.assetId;
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId: currentAsset, passed: true },
      );
      return [clarify()];
    },
    { generated: true },
  );
  expect(result.calls).toBe(5);
  expect(result.providerCalls).toBe(1);
  expect(result.reviews).toBe(1);
  expect(result.batch.version).toBe(4);
  expect(result.batch.delivered[page()]).toBe(currentAsset);
  expect(result.batch.reviews[page()]!.passed).toBe(true);
  expect(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", originalJobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toContain('"version":3');
});

it("saved-base revision without a complete fresh view is rejected before an image call", async () => {
  const result = await run((body, step) => {
    if (step === 1) return [resume()];
    if (step === 2)
      return [{ name: "image_batch", args: { action: "upgrade" } }];
    if (step === 3)
      return [
        {
          name: "image_edit_saved",
          args: {
            originalReferenceImageId: page(),
            baseAssetId: obsoleteAssetId,
            prompt: "Correct target",
          },
        },
      ];
    expect(step).toBe(4);
    expect(mediaToolFacts(body, "image_edit_saved")).toMatchObject({
      error: true,
      code: "image_revision_view_required",
      paid: false,
    });
    return [clarify()];
  });
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
});

it.each([false, true])("stops a third repeated paid repair and independently reviews the chosen earlier candidate: passed=%s", async (acceptEarlier) => {
  let current = obsoleteAssetId, first = "", second = "";
  const savedRevision = (body: any) => {
    const value = JSON.parse(lastTool(body, "image_edit_saved"));
    return Array.isArray(value) ? JSON.parse(value.find((part: any) => part.type === "text").text) : value;
  };
  const view = (): Action => ({ name: "image_view", args: { referenceImageIds: [page(), current] } });
  const edit = (): Action => ({ name: "image_edit_saved", args: {
    originalReferenceImageId: page(), baseAssetId: current, prompt: "Repair the actual target while retaining correct content",
  } });
  const result = await run((body, step) => {
    if (step === 1) return [resume()];
    if (step === 2) return [{ name: "image_batch", args: { action: "upgrade" } }];
    if (step === 3) return [{ name: "image_batch", args: { action: "review", review: {
      referenceImageId: page(), assetId: current, passed: false, evidence: "Current target is incomplete",
    } } }];
    if (step === 4) return [view()];
    if (step === 5 || step === 7 || step === 9) return [edit()];
    if (step === 6) {
      first = current = savedRevision(body).assetId;
      expect(scopedBatchStatus(body).current.pages[0].inspection.passed).toBe(false);
      return [view()];
    }
    if (step === 8) {
      second = current = savedRevision(body).assetId;
      return [view()];
    }
    if (step === 10) {
      expect(savedRevision(body)).toMatchObject({ kind: "image_repair_compare_required", imageGenerationPaid: false });
      return [{ name: "image_saved_candidates", args: { referenceImageId: page(), offset: 0, order: "oldest" } }];
    }
    if (step === 11) {
      const candidates = JSON.parse(lastTool(body, "image_saved_candidates"));
      expect(candidates.candidates.map((item: any) => item.assetId)).toEqual([first, second]);
      return [{ name: "image_batch", args: { action: "select", candidate: { referenceImageId: page(), assetId: first } } }];
    }
    if (step === 12) return [{ name: "image_view", args: { referenceImageIds: [page(), first] } }];
    if (step === 13) return [{ name: "image_batch", args: { action: "select", candidate: { referenceImageId: page(), assetId: first } } }];
    expect(step).toBe(14);
    expect(scopedBatchStatus(body).current.pages[0].assetId).toBe(first);
    expect(scopedBatchStatus(body).current.pages[0].inspection.passed).toBe(acceptEarlier);
    return [clarify()];
  }, { generated: true, passed: false, ...(acceptEarlier ? {reviewVerdicts:[false,false,true]} : {}) });
  expect(result.providerCalls).toBe(2);
  expect(result.batch.delivered[page()]).toBe(first);
  expect(result.batch.reviews[page()]?.passed).toBe(acceptEarlier);
  expect(result.reviewedAssets).toEqual([first, second, first]);
  const paid = (await storedImageCalls()).filter(call => call.job_id === result.id);
  expect(paid).toHaveLength(2);
  expect(paid.every(call => call.state === "confirmed")).toBe(true);
});

it("retains actual repair view after reporting a defect without granting a review appeal", async () => {
  let currentAsset = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3)
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), obsoleteAssetId] },
          },
        ];
      if (step === 4)
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(),
                assetId: obsoleteAssetId,
                passed: false,
                evidence: "Newly observed current target defect",
              },
            },
          },
        ];
      if (step === 5)
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: "Correct target; preserve all other content",
            },
          },
        ];
      expect(step).toBe(6);
      const media = JSON.parse(lastTool(body, "image_edit_saved")),
        saved = Array.isArray(media)
          ? JSON.parse(media.find((p: any) => p.type === "text").text)
          : media;
      expect(saved.kind).toBe("image_revision");
      currentAsset = saved.assetId;
      return [clarify()];
    },
    { generated: true },
  );
  expect(result.providerCalls).toBe(1);
  expect(result.reviews).toBe(1);
  expect(result.batch.delivered[page()]).toBe(currentAsset);
});

it("recovers a missing saved-base view with actual readonly frames and pays only on a later call", async () => {
  let currentAsset = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3)
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: "Correct target",
            },
          },
        ];
      if (step === 4) {
        const facts = mediaToolFacts(body, "image_edit_saved");
        expect(facts).toMatchObject({
          error: true,
          paid: false,
          code: "image_revision_view_required",
        });
        expect(
          facts.images.map((image: any) => image.referenceImageId),
        ).toEqual([page(), obsoleteAssetId]);
        expect(facts.next.toolName).toBe("image_edit_saved");
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(2);
        return [{ name: "image_edit_saved", args: facts.next.input }];
      }
      expect(step).toBe(5);
      const saved = mediaToolFacts(body, "image_edit_saved");
      expect(saved.kind).toBe("image_revision");
      currentAsset = saved.assetId;
      return [clarify()];
    },
    { generated: true },
  );
  expect(result.providerCalls).toBe(1);
  expect(result.reviews).toBe(1);
  expect(result.batch.delivered[page()]).toBe(currentAsset);
});

it.each([0, 1] as const)(
  "never pays from %s of two normalized readonly saved-repair frames and bounds recovery by base even with changing prompts",
  async (count) => {
    const result = await run(
      (_body, step) => {
        if (step === 1) return [resume()];
        if (step === 2)
          return [{ name: "image_batch", args: { action: "upgrade" } }];
        expect(step).toBeLessThanOrEqual(6);
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: `Varying words ${step} cannot create visual permission`,
            },
          },
        ];
      },
      { stripSavedRepairPixels: count, expectedStatus: "failed" },
    );
    expect(result.providerCalls).toBe(0);
    expect(result.reviews).toBe(0);
    expect(result.calls).toBe(6);
    expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
  },
);

it("does not pay or authorize saved repair when its complete readonly view is cancelled before EOF", async () => {
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3)
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: "Correct target",
            },
          },
        ];
      expect(step).toBe(4);
      expect(mediaToolFacts(body, "image_edit_saved")).toMatchObject({
        paid: false,
        code: "image_revision_view_required",
      });
      const frames = body.messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url");
      expect(frames).toHaveLength(2);
      return [
        {
          name: "image_edit_saved",
          args: {
            originalReferenceImageId: page(),
            baseAssetId: obsoleteAssetId,
            prompt: "Correct target",
          },
        },
      ];
    },
    { cancelExecutorAtStep: 4, expectedStatus: "cancelled" },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
});

it("uses actual repair proof after negative feedback when rebuilding a failed revision from the original", async () => {
  let revisionAsset = "",
    rebuiltAsset = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3)
        return [
          {
            name: "image_edit_saved",
            args: {
              originalReferenceImageId: page(),
              baseAssetId: obsoleteAssetId,
              prompt: "Correct target",
            },
          },
        ];
      if (step === 4)
        return [
          {
            name: "image_edit_saved",
            args: mediaToolFacts(body, "image_edit_saved").next.input,
          },
        ];
      if (step === 5) {
        revisionAsset = mediaToolFacts(body, "image_edit_saved").assetId;
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), revisionAsset] },
          },
        ];
      }
      if (step === 6)
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(),
                assetId: revisionAsset,
                passed: false,
                evidence:
                  "Latest revision changed the original story action; rebuild all requirements",
              },
            },
          },
        ];
      if (step === 7)
        return [
          {
            name: "image_edit",
            args: {
              sourceImageId: page(),
              prompt:
                "Rebuild all original changes and preserve the original story action",
            },
          },
        ];
      expect(step).toBe(8);
      const rebuilt = mediaToolFacts(body, "image_edit");
      expect(rebuilt.kind).toBe("image_generation");
      rebuiltAsset = rebuilt.assetId;
      return [clarify()];
    },
    { generated: true },
  );
  expect(result.providerCalls).toBe(2);
  expect(result.batch.delivered[page()]).toBe(rebuiltAsset);
  expect(rebuiltAsset).not.toBe(revisionAsset);
});

it.each([0, 1] as const)(
  "does not grant repair permission from only %s of two actual view frames",
  async (count) => {
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2)
          return [{ name: "image_batch", args: { action: "upgrade" } }];
        if (step === 3)
          return [
            {
              name: "image_view",
              args: { referenceImageIds: [page(), obsoleteAssetId] },
            },
          ];
        if (step === 4)
          return [
            {
              name: "image_batch",
              args: {
                action: "review",
                review: {
                  referenceImageId: page(),
                  assetId: obsoleteAssetId,
                  passed: false,
                  evidence: "Defect cannot create missing-frame proof",
                },
              },
            },
          ];
        if (step === 5)
          return [
            {
              name: "image_edit_saved",
              args: {
                originalReferenceImageId: page(),
                baseAssetId: obsoleteAssetId,
                prompt: "Correct target",
              },
            },
          ];
        expect(step).toBe(6);
        expect(mediaToolFacts(body, "image_edit_saved")).toMatchObject({
          error: true,
          code: "image_revision_view_required",
          paid: false,
        });
        return [clarify()];
      },
      { stripViewPixels: count },
    );
    expect(result.providerCalls).toBe(0);
    expect(result.reviews).toBe(0);
    expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
  },
);

const localRevisionInput = (patch: Record<string, unknown> = {}) => ({
  originalReferenceImageId: page(),
  baseAssetId: obsoleteAssetId,
  prompt:
    "Correct only the selected current target; retain every other current pixel and all original task requirements",
  region: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 },
  contextPaddingPixels: 0,
  ...patch,
});
const localPreview = (patch: Record<string, unknown> = {}): Action => ({
  name: "image_edit_saved_local_preview",
  args: localRevisionInput(patch),
});
const localPaid = (patch: Record<string, unknown> = {}): Action => ({
  name: "image_edit_saved_local",
  args: localRevisionInput(patch),
});
const localUpgrade = (): Action => ({
  name: "image_batch",
  args: { action: "upgrade_local" },
});
async function seedPriorPaidCandidate() {
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 60000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const saved = await generateTestImageAsset(
    db,
    ctx,
    {
      referenceImageIds: [page()],
      prompt: "Earlier paid candidate metadata stays immutable",
      filename: "earlier-paid-target.png",
    },
    randomUUID(),
    {
      storage: runtime(),
      operation: "edit",
      batchAttemptScope: batch.attemptScope,
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: (await png("#c07040")).toString("base64") }],
          usage: { input_images: 1, input_tokens: 4, output_tokens: 5 },
        })) as typeof fetch,
    },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  return saved;
}
async function fixtureAssetRGBA(assetId: string) {
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", assetId)
    .where("owner_id", "=", owner.id)
    .executeTakeFirstOrThrow();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const bytes = await storage
    .createStorage(runtime())
    .read(
      storage.storageConfigForProfile(runtime(), profile),
      asset.object_key,
      asset.size,
    );
  return sharp(bytes)
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
function localPreviewFacts(body: any) {
  const facts = mediaToolFacts(body, "image_edit_saved_local_preview");
  expect(facts).toMatchObject({
    kind: "image_revision_local_preview",
    version: 1,
    paid: false,
  });
  expect(facts.images).toHaveLength(3);
  return facts;
}

it("runs explicit local upgrade and three actual preview frames before later paid3, preserves historical fees/checkpoints and independently reviews the complete original criteria", async () => {
  await seedPriorPaidCandidate();
  const original = await db
    .selectFrom("ai_jobs")
    .select("result")
    .where("id", "=", originalJobId)
    .executeTakeFirstOrThrow();
  const originalImageCalls = await storedImageCalls();
  let assetId = "",
    saved: any;
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) {
        expect(scopedBatchStatus(body)).toMatchObject({ version: 5 });
        return [localPreview()];
      }
      if (step === 5) {
        const facts = localPreviewFacts(body);
        expect(facts.binding.attemptScope.version).toBe(3);
        expect(facts.images.map((item: any) => item.referenceImageId)).toEqual([
          page(),
          obsoleteAssetId,
          obsoleteAssetId,
        ]);
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(3);
        return [localPaid()];
      }
      expect(step).toBe(6);
      saved = mediaToolFacts(body, "image_edit_saved_local");
      assetId = saved.assetId;
      expect(saved).toMatchObject({
        kind: "image_revision",
        version: 2,
        mode: "local",
        paidAttempt: { version: 3, ordinal: 2 },
      });
      expect(saved.providerReferences.map((item: any) => item.role)).toEqual([
        "base-viewport",
        "original-context",
      ]);
      expect(saved.rawCandidate).toMatchObject({
        kind: "image_revision_raw",
        version: 2,
      });
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId, passed: true },
      );
      return [clarify()];
    },
    { generated: true, localRevision: true },
  );
  expect(result.providerCalls).toBe(1);
  expect(result.reviews).toBe(1);
  expect(result.batch.version).toBe(5);
  expect(result.batch.delivered[page()]).toBe(assetId);
  expect(result.batch.requirements).toEqual(batch.requirements);
  expect(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", originalJobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(original.result);
  const imageCalls = await storedImageCalls();
  expect(imageCalls).toHaveLength(originalImageCalls.length + 1);
  for (const old of originalImageCalls)
    expect(imageCalls.find((item) => item.id === old.id)).toEqual(old);
  const base = await fixtureAssetRGBA(obsoleteAssetId),
    actual = await fixtureAssetRGBA(assetId);
  expect(actual.info).toMatchObject({
    width: base.info.width,
    height: base.info.height,
    channels: 4,
  });
  const rect = saved.binding.localFacts.nativeRect;
  let edited = 0;
  for (let y = 0; y < actual.info.height; y++)
    for (let x = 0; x < actual.info.width; x++) {
      const index = (y * actual.info.width + x) * 4;
      if (
        x < rect.left ||
        x >= rect.left + rect.width ||
        y < rect.top ||
        y >= rect.top + rect.height
      )
        expect(actual.data.subarray(index, index + 4)).toEqual(
          base.data.subarray(index, index + 4),
        );
      else if (
        !actual.data
          .subarray(index, index + 4)
          .equals(base.data.subarray(index, index + 4))
      )
        edited++;
    }
  expect(edited).toBe(rect.width * rect.height);
});

it.each([0, 1, 2] as const)(
  "never posts a local paid request after only %s of three actual normalized preview frames",
  async (count) => {
    const result = await run(
      (body, step) => {
        if (step === 1) return [resume()];
        if (step === 2)
          return [{ name: "image_batch", args: { action: "upgrade" } }];
        if (step === 3) return [localUpgrade()];
        if (step === 4) return [localPreview()];
        if (step === 5) return [localPaid()];
        expect(step).toBe(6);
        expect(
          JSON.parse(lastTool(body, "image_edit_saved_local")),
        ).toMatchObject({
          error: true,
          paid: false,
          code: "image_revision_view_required",
        });
        return [clarify()];
      },
      { generated: true, localRevision: true, stripLocalPreviewPixels: count },
    );
    expect(result.providerCalls).toBe(0);
    expect(result.reviews).toBe(0);
    expect(await storedImageCalls()).toHaveLength(0);
    expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
  },
);

it("does not post for preview and local edit emitted in the same model round", async () => {
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview(), localPaid()];
      expect(step).toBe(5);
      expect(
        JSON.parse(lastTool(body, "image_edit_saved_local")),
      ).toMatchObject({ error: true, paid: false });
      return [clarify()];
    },
    { generated: true, localRevision: true },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(await storedImageCalls()).toHaveLength(0);
});

it("does not authorize a local paid edit after three preview frames whose model stream is interrupted before EOF", async () => {
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      expect(step).toBe(5);
      localPreviewFacts(body);
      return [localPaid()];
    },
    {
      generated: true,
      localRevision: true,
      cancelExecutorAtStep: 5,
      expectedStatus: "cancelled",
    },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(await storedImageCalls()).toHaveLength(0);
});

it("does not inherit a local edit's acceptance and retains a fresh independent failure against all original criteria", async () => {
  let assetId = "";
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      if (step === 5) return [localPaid()];
      expect(step).toBe(6);
      assetId = mediaToolFacts(body, "image_edit_saved_local").assetId;
      expect(scopedBatchStatus(body).current.pages[0].inspection).toMatchObject(
        { assetId, passed: false },
      );
      return [clarify()];
    },
    { generated: true, localRevision: true, passed: false },
  );
  expect(result.providerCalls).toBe(1);
  expect(result.reviews).toBe(1);
  expect(result.batch.reviews[page()]!.passed).toBe(false);
  expect(result.batch.reviews[page()]!.evidence).toContain(
    "missing the required target",
  );
  expect(result.batch.requirements.criteria).toEqual(criteria);
  expect(result.batch.reviews[page(1)]).toEqual(batch.reviews[page(1)]);
});

it("requires a new actual local preview when the requested pixel region changes", async () => {
  const changedRegion = { left: 0.125, top: 0.25, width: 0.5, height: 0.5 };
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      if (step === 5) {
        localPreviewFacts(body);
        return [localPaid({ region: changedRegion })];
      }
      expect(step).toBe(6);
      const rejected = JSON.parse(lastTool(body, "image_edit_saved_local"));
      expect(rejected).toMatchObject({
        error: true,
        paid: false,
        code: "image_revision_view_required",
        next: {
          toolName: "image_edit_saved_local_preview",
          input: { region: changedRegion },
        },
      });
      return [clarify()];
    },
    { generated: true, localRevision: true },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(await storedImageCalls()).toHaveLength(0);
  expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
});

it("rejects a local paid edit when the selected image model changes after the real preview", async () => {
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      if (step === 5) {
        localPreviewFacts(body);
        const { revision, ...config } = await aiConfig(db),
          image = config.models.find((model) => model.id === "image")!;
        await saveAIConfig(
          db,
          {
            ...config,
            models: [
              ...config.models,
              {
                ...image,
                id: "other-image",
                alias: "Other isolated image model",
              },
            ],
            imageToolModels: { ...config.imageToolModels, edit: "other-image" },
          },
          revision,
        );
        return [localPaid()];
      }
      expect(step).toBe(6);
      expect(lastTool(body, "image_edit_saved_local")).toContain(
        "已查看局部预览已失效",
      );
      return [clarify()];
    },
    { generated: true, localRevision: true },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(await storedImageCalls()).toHaveLength(0);
  expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
});

it("does not use local preview proof after the canonical scope binding has changed", async () => {
  const result = await run(
    async (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      if (step === 6) {
        expect(lastTool(body, "image_edit_saved_local")).toContain(
          "attemptScope 记录缺失或不一致",
        );
        return [clarify()];
      }
      expect(step).toBe(5);
      const preview = localPreviewFacts(body),
        scopeId = preview.binding.attemptScope.operationId;
      const scope = await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", scopeId)
        .executeTakeFirstOrThrow();
      const changed = JSON.parse(scope.result!);
      changed.manifestDigest = "f".repeat(64);
      await db
        .updateTable("ai_operations")
        .set({ result: JSON.stringify(changed), digest: digest(changed) })
        .where("id", "=", scopeId)
        .execute();
      return [localPaid()];
    },
    { generated: true, localRevision: true, expectedStatus: "failed" },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(0);
  expect(await storedImageCalls()).toHaveLength(0);
  expect(result.batch.delivered[page()]).toBe(obsoleteAssetId);
});

it("invalidates an old local preview after actual view and selection changes the current saved base", async () => {
  const candidate = await seedPriorPaidCandidate(),
    historicalCalls = await storedImageCalls();
  const select = (): Action => ({
    name: "image_batch",
    args: {
      action: "select",
      candidate: { referenceImageId: page(), assetId: candidate.assetId },
    },
  });
  const result = await run(
    (body, step) => {
      if (step === 1) return [resume()];
      if (step === 2)
        return [{ name: "image_batch", args: { action: "upgrade" } }];
      if (step === 3) return [localUpgrade()];
      if (step === 4) return [localPreview()];
      if (step === 5) {
        localPreviewFacts(body);
        return [select()];
      }
      if (step === 6)
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(), candidate.assetId] },
          },
        ];
      if (step === 7) return [select()];
      if (step === 8) {
        expect(scopedBatchStatus(body).current.pages[0]).toMatchObject({
          assetId: candidate.assetId,
          inspection: { assetId: candidate.assetId, passed: false },
        });
        return [localPaid()];
      }
      expect(step).toBe(9);
      expect(lastTool(body, "image_edit_saved_local")).toContain(
        "局部续改期间成品、要求或范围已变",
      );
      return [clarify()];
    },
    { generated: true, localRevision: true, passed: false },
  );
  expect(result.providerCalls).toBe(0);
  expect(result.reviews).toBe(1);
  expect(await storedImageCalls()).toEqual(historicalCalls);
  expect(result.batch.delivered[page()]).toBe(candidate.assetId);
  expect(result.batch.reviews[page()]!.passed).toBe(false);
});
