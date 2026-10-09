import { createHash, randomUUID } from "node:crypto";
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
import { fixtureSolidScenePlan } from "./fixtures/ai-solid-scene-plan.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import {
  availableImageReferences,
  } from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  imageCandidateViewModelOutput,
  viewImageCandidate,
} from "../apps/server/src/services/ai/image-candidate-view.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import { PARSER_VERSION } from "../apps/server/src/services/ai/file-extract.js";
import { bindImageReviewSceneContext } from "../apps/server/src/services/ai/image-review.js";
import { createImageBatchRequirements } from "../apps/server/src/services/ai/image-batch-requirements.js";
import { registerImageBatchAttemptScope } from "../apps/server/src/services/ai/image-batch-attempts.js";
import { imageBatchSchema } from "../apps/server/src/services/ai/image-batch.js";

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
    create: { width: 2048, height: 1536, channels: 3, background: "#1452a1" },
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
async function generate(window = true, references = [sourceId]) {
  const pixels = await sharp({
    create: { width: 640, height: 960, channels: 3, background: "#d22814" },
  })
    .png()
    .toBuffer();
  return generateImageAsset(
    db,
    ctx,
    {
      prompt: "修改目标",
      referenceImageIds: references,
      ...(window
        ? {
            editRegions: [
              {
                label: "目标",
                points: [
                  [0.25, 0.2],
                  [0.6, 0.2],
                  [0.6, 0.7],
                  [0.25, 0.7],
                ],
              },
            ],
          }
        : {}),
    },
    operationId,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: pixels.toString("base64") }],
          usage: { input_images: 1, note: nativeMarker },
        })) as typeof fetch,
    },
  );
}

async function attachScene() {
  const pdfId = randomUUID(), sceneId = randomUUID(), key = objectKey(pdfId, "application/pdf");
  const bytes = Buffer.from("%PDF-1.7\nIsolated two-page extraction fixture\n%%EOF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const profile = await db.selectFrom("storage_profiles").selectAll().where("active", "=", 1).executeTakeFirstOrThrow();
  const config = storage.storageConfigForProfile(runtime(), profile), store = storage.createStorage(runtime());
  const now = new Date().toISOString();
  await store.put(config, key, bytes, "application/pdf", "frozen.pdf");
  await db.insertInto("file_storage_objects").values({ id: pdfId, profile_id: profile.id, object_key: key, sha256,
    size: bytes.length, mime: "application/pdf", created_at: now }).execute();
  await db.insertInto("assets").values({ id: pdfId, owner_id: owner.id, uploaded_by: owner.id, resource_id: null,
    purpose: "ai_attachment", profile_id: profile.id, object_key: key, filename: "frozen.pdf", mime: "application/pdf",
    size: bytes.length, created_at: now, deleted_at: null }).execute();
  await db.updateTable("ai_jobs").set({ input: JSON.stringify({ text: "正式要求：核对原场景和候选，人物归属须实际看图，不自动生图。", attachments: [pdfId] }) }).where("id", "=", ctx.jobId!).execute();
  const original = await db.selectFrom("assets").selectAll().where("id", "=", sourceId).executeTakeFirstOrThrow();
  const parts = [];
  for (const [index, id] of [sourceId, sceneId].entries()) {
    const data = index === 0 ? await store.read(config, original.object_key, original.size)
      : await sharp({ create: { width: 600, height: 900, channels: 3, background: "#33aa55" } }).png().toBuffer();
    const recipe = `v${PARSER_VERSION}-img-${index}`, pageKey = objectKey(randomUUID(), "image/png");
    await store.put(config, pageKey, data, "image/png", "misleading-title.png");
    await db.insertInto("file_derivatives").values({ id, source_id: pdfId, profile_id: profile.id, object_key: pageKey,
      kind: "extract-image", recipe, mime: "image/png", size: data.length, created_at: now }).execute();
    parts.push({ type: "image" as const, recipe, mime: "image/png", filename: "misleading-title.png" });
  }
  await db.insertInto("file_extracts").values({ storage_object_id: pdfId, status: "ready", error: null,
    result: JSON.stringify({ parserVersion: PARSER_VERSION, parts }), updated_at: now }).execute();
  const source = { assetId: pdfId }, pages = await registerVisualReferences(db, ctx, source, pdfId, parts);
  const book = { source, pages }, manifest = { source, filename: "frozen.pdf", objectId: pdfId, sha256,
    mime: "application/pdf", role: "target" as const, inputReferences: [{ kind: "attachment" as const, id: pdfId }] };
  return { pdfId, sceneId, book, manifest };
}

it.each([false, true])("renders an explicitly declared four-frame scene group for viewport=%s without changing canonical facts or writing", async viewport => {
  const scene = await attachScene();
  await generate(viewport, [sourceId, scene.sceneId]);
  const row = await db.selectFrom("ai_operations").select("result").where("id", "=", operationId).executeTakeFirstOrThrow();
  const sceneContext = await bindImageReviewSceneContext(db, ctx, {
    generation: JSON.parse(row.result).generation, referenceImageId: sourceId, book: scene.book, manifest: scene.manifest,
  }, runtime());
  const before = await factsSnapshot(), options = { storage: runtime(), vision: true, sceneContext };
  const facts = await viewImageCandidate(db, { ...ctx, writable: false }, operationId, options);
  const output = await imageCandidateViewModelOutput(db, { ...ctx, writable: false }, operationId, options);
  expect(JSON.parse(output.value[0]!.text!)).toEqual(facts);
  expect(JSON.parse(output.value[1]!.text!)).toMatchObject({ kind: "image_candidate_view_runtime", frameCount: 4,
    sceneReferenceImageId: scene.sceneId, sceneStatus: "included", reason: null });
  const images = output.value.filter(part => part.type === "media");
  expect(images).toHaveLength(4);
  const caption = JSON.parse(output.value[8]!.text!);
  expect(caption).toMatchObject({ view: "scene-context", coordinateSpace: "scene-source-page", role: "scene-context",
    nonCitable: true, referenceImageId: scene.sceneId, currentReferenceImageId: sourceId,
    physicalPage: 2, currentPhysicalPage: 1, sourceObjectId: scene.pdfId,
    sourceRect: { left: 0, top: 0, width: 600, height: 900 } });
  const pixels = await sharp(Buffer.from(images[3]!.data!, "base64")).resize(1, 1).raw().toBuffer();
  expect(Math.max(...[...pixels].map((value, i) => Math.abs(value - [51, 170, 85][i]!)))).toBeLessThanOrEqual(3);
  expect(facts).not.toHaveProperty("sceneContext");
  expect(await factsSnapshot()).toEqual(before);
});

it.each(["intact", "revoke", "bytes"] as const)("uses the actual SDK four-frame scene proof and revalidates it before a later readonly region: %s", async change => {
  const scene = await attachScene();
  await generate(true, [sourceId, scene.sceneId]);
  const originalJobId = ctx.jobId!;
  const requirements = await createImageBatchRequirements(db, { userId: owner.id, actor: owner, sessionId, currentJobId: originalJobId },
    originalJobId, [scene.book.source], "all-documents", ["实际核对原场景与候选，保留原文字"], []);
  const books = [{ ...scene.book, filename: "frozen.pdf" }];
  const attemptScope = await registerImageBatchAttemptScope(db, ctx, { requirements, books }, {version:1});
  const batch = imageBatchSchema.parse({ version: 3, requirements, attemptScope, books, current: 0, notes: "", delivered: {}, reviews: {} });
  await db.updateTable("ai_jobs").set({ status: "completed", lease: null, lease_until: null,
    result: JSON.stringify({ checkpoint: { imageBatch: batch } }) }).where("id", "=", originalJobId).execute();
  const before = await factsSnapshot(), imageCallsBefore = (await usageSummary(db, owner.id)).calls.filter(call => call.callKind === "image");
  let calls = 0, toolId = "", callbackError: unknown;
  app = await createApp(db, { origin, storage: runtime(), ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    imageFetch: (async () => { throw Error("Readonly scene proof must not generate images"); }) as typeof fetch,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const scenePlan = fixtureSolidScenePlan(body);
      if (scenePlan) return scenePlan;
      calls++;
      try {
        if (calls === 3) {
          const pairs = body.messages.flatMap((message: any) => Array.isArray(message.content)
            ? message.content.flatMap((part: any, index: number) => part.type === "image_url" ? [{ image: part, label: message.content[index - 1] }] : []) : []);
          expect(pairs).toHaveLength(4);
          expect(JSON.parse(pairs[3].label.text)).toMatchObject({ toolName: "image_candidate_view", view: "scene-context",
            referenceImageId: scene.sceneId, currentReferenceImageId: sourceId, sourceSize: { width: 600, height: 900 }, nonCitable: true });
          expect(JSON.parse(pairs[3].label.text)).not.toHaveProperty("generatedWindow");
          if (change === "revoke")
            await db.updateTable("assets").set({ deleted_at: new Date().toISOString() }).where("id", "=", scene.pdfId).execute();
          if (change === "bytes") {
            const derivative = await db.selectFrom("file_derivatives").selectAll().where("id", "=", scene.sceneId).executeTakeFirstOrThrow();
            const profile = await db.selectFrom("storage_profiles").selectAll().where("id", "=", derivative.profile_id).executeTakeFirstOrThrow();
            const bytes = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#ee0055" } }).png().toBuffer();
            await storage.createStorage(runtime()).remove(storage.storageConfigForProfile(runtime(), profile), derivative.object_key);
            await storage.createStorage(runtime()).put(storage.storageConfigForProfile(runtime(), profile), derivative.object_key, bytes, "image/png", "changed.png");
          }
        }
        if (calls === 4) {
          const reply = body.messages.findLast((message: any) => message.role === "tool" && message.tool_call_id === toolId);
          expect(reply).toBeDefined();
          const pairs = body.messages.flatMap((message: any) => Array.isArray(message.content)
            ? message.content.filter((part: any) => part.type === "image_url") : []);
          if (change === "intact") {
            expect(pairs).toHaveLength(2);
            expect(reply.content).toContain("image_candidate_region_view");
            expect(reply.content).not.toContain('"error":true');
          } else {
            expect(reply.content).toBe(change === "revoke" ? "参考图片不存在、已删除或不属于当前会话" : "参考图片内容已改变，请重新上传");
            expect(reply.content).not.toContain('"kind":"image_candidate_region_view"');
            expect(body.messages.flatMap((message: any) => Array.isArray(message.content)
              ? message.content.filter((part: any) => part.type === "text" && part.text.includes('"toolName":"image_candidate_region_view"')) : [])).toHaveLength(0);
          }
        }
        if (calls > 5) throw Error(`Unexpected readonly scene request ${calls}`);
      } catch (error) { callbackError ??= error; throw error; }
      const action = calls === 1 ? { name: "image_batch", args: { action: "resume", jobId: originalJobId } }
        : calls === 2 ? { name: "image_candidate_view", args: { generationOperationId: operationId } }
        : calls === 3 ? { name: "image_candidate_region_view", args: { generationOperationId: operationId,
          region: { left: 0.3, top: 0.3, width: 0.1, height: 0.1 }, points: [[0.35, 0.35]] } }
        : calls === 4 ? { name: "ask_user", args: { title: "诊断已结束，请明确下一步", options: ["继续查看", "保持暂停"] } } : undefined;
      return completionResponse({ id: randomUUID(), object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: action ? { role: "assistant", content: null, tool_calls: [{ id: (toolId = randomUUID()), type: "function",
          function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { role: "assistant", content: "只读诊断结束，未声明交付通过。" },
          finish_reason: action ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }, !!body.stream);
    }) as typeof fetch,
  } });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin, host: "localhost:39321" }, payload: { login: "candidate-owner", password } });
  expect(login.statusCode, login.body).toBe(200);
  const headers = { origin, host: "localhost:39321", cookie: String(login.headers["set-cookie"]).split(";")[0]! }, jobId = randomUUID();
  const sent = await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${sessionId}/messages`, headers,
    payload: { id: jobId, modelId: "chat", scope: "all", text: "仅恢复正式批次并查看候选及原生小框，不生图、不验收或推进。" } });
  expect(sent.statusCode, sent.body).toBe(200);
  let job: any;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    job = (await app.inject({ url: `/api/v1/ai/sessions/${sessionId}`, headers })).json().jobs.find((entry: any) => entry.id === jobId);
    if (job && !["queued", "running"].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (callbackError) throw callbackError;
  expect(job && !["queued", "running"].includes(job.status), job?.error).toBe(true);
  expect(calls).toBe(4);
  const after = await factsSnapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.objects).toEqual(before.objects);
  expect(after.items).toEqual(before.items);
  expect(after.assets).toEqual(before.assets.map(asset => change === "revoke" && asset.id === scene.pdfId ? { ...asset, deleted_at: after.assets.find(row => row.id === scene.pdfId)!.deleted_at } : asset));
  expect((await usageSummary(db, owner.id)).calls.filter(call => call.callKind === "image")).toEqual(imageCallsBefore);
}, 30000);
async function factsSnapshot() {
  const [assets, objects, items, operations, calls] = await Promise.all([
    db.selectFrom("assets").selectAll().execute(),
    db.selectFrom("file_storage_objects").selectAll().execute(),
    db.selectFrom("file_items").selectAll().execute(),
    db.selectFrom("ai_operations").selectAll().execute(),
    db.selectFrom("ai_calls").selectAll().execute(),
  ]);
  return { assets, objects, items, operations, calls };
}

it("returns only bound facts and three bounded diagnostic JPEGs without writes, charges or identity-reference exposure", async () => {
  const generated = await generate(),
    before = await factsSnapshot(),
    usageBefore = await usageSummary(db, owner.id);
  const options = { storage: runtime(), vision: true, sceneContext: null },
    readonly = { ...ctx, writable: false };
  const facts = await viewImageCandidate(db, readonly, operationId, options);
  expect(facts).toMatchObject({
    kind: "image_candidate_view",
    state: "diagnostic-only",
    generationOperationId: operationId,
    referenceImageId: sourceId,
    source: { width: 2048, height: 1536 },
    raw: {
      nativeSize: { width: 640, height: 960 },
      displaySize: { width: 640, height: 960 },
    },
    transform: { kind: "viewport" },
    projectedSize: { width: 2048, height: 1536 },
  });
  expect(facts.generatedWindow).toEqual(
    facts.transform.kind === "viewport" ? facts.transform.rect : null,
  );
  const receipt = JSON.stringify(facts);
  for (const forbidden of [
    "base64",
    "data:image/",
    "objectKey",
    "profileId",
    "nativeUsage",
    nativeMarker,
    generated.rawCandidate!.assetId,
  ])
    expect(receipt).not.toContain(forbidden);
  const output = await imageCandidateViewModelOutput(
    db,
    readonly,
    operationId,
    options,
  );
  const media = output.value.filter((part) => part.type === "media");
  expect(media).toHaveLength(3);
  for (const frame of media) {
    expect(frame.mediaType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(frame.data, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
  }
  const projected = await sharp(Buffer.from(media[2]!.data, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const first = Array.from(projected.data.subarray(0, 3));
  expect(first[2]).toBeGreaterThan(first[0]! + 80);
  const middle =
    Math.floor(projected.info.height * 0.45) * projected.info.width +
    Math.floor(projected.info.width * 0.4);
  expect(projected.data[middle * 3]).toBeGreaterThan(
    projected.data[middle * 3 + 2]! + 100,
  );
  expect(await factsSnapshot()).toEqual(before);
  expect(await usageSummary(db, owner.id)).toEqual(usageBefore);
  expect(
    (await availableImageReferences(db, ctx)).map((ref) => ref.id),
  ).toEqual(expect.arrayContaining([sourceId, generated.assetId]));
  expect(
    (await availableImageReferences(db, ctx)).some(
      (ref) => ref.id === generated.rawCandidate!.assetId,
    ),
  ).toBe(false);
});

it("reauthorizes candidate media and rejects wrong owners/sessions, revoked source, missing raw and models without vision", async () => {
  const options = { storage: runtime(), vision: true, sceneContext: null };
  await expect(
    viewImageCandidate(db, ctx, operationId, options),
  ).rejects.toThrow("没有持久原始候选");
  await generate();
  await expect(
    viewImageCandidate(db, ctx, operationId, { ...options, vision: false }),
  ).rejects.toThrow("视觉模型");
  const other = {
    ...(await createUser(
      db,
      { login: "candidate-other", displayName: "Other", password },
      { actor: owner },
    )),
    admin: 0,
  };
  await expect(
    viewImageCandidate(db, { actor: other }, operationId, options),
  ).rejects.toThrow("没有持久原始候选");
  const otherSession = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: otherSession,
      user_id: owner.id,
      title: "Other",
      model_id: "chat",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await expect(
    viewImageCandidate(db, await newJob(otherSession), operationId, options),
  ).rejects.toThrow("不属于当前会话");
  await viewImageCandidate(db, ctx, operationId, options);
  const before = await factsSnapshot();
  await db
    .updateTable("assets")
    .set({ deleted_at: now })
    .where("id", "=", sourceId)
    .execute();
  await expect(
    imageCandidateViewModelOutput(db, ctx, operationId, options),
  ).rejects.toThrow("参考图片不存在");
  const after = await factsSnapshot();
  expect(after.operations).toEqual(before.operations);
  expect(after.calls).toEqual(before.calls);
});

it.each(["source", "raw"] as const)(
  "keeps missing %s filesystem details out of candidate facts and model output without changing receipts or usage",
  async (missing) => {
    const generated = await generate();
    const asset = await db.selectFrom("assets").selectAll()
      .where("id", "=", missing === "raw" ? generated.rawCandidate!.assetId : sourceId)
      .executeTakeFirstOrThrow();
    const profile = await db.selectFrom("storage_profiles").selectAll().where("id", "=", asset.profile_id).executeTakeFirstOrThrow();
    await storage.createStorage(runtime()).remove(storage.storageConfigForProfile(runtime(), profile), asset.object_key);
    const before = await factsSnapshot(), usageBefore = await usageSummary(db, owner.id);
    for (const read of [viewImageCandidate, imageCandidateViewModelOutput]) {
      const failure = await read(db, ctx, operationId, { storage: runtime(), vision: true, sceneContext: null }).then(() => undefined, error => error);
      expect(failure).toMatchObject({ status: 503 });
      expect(failure.message).toContain("诊断来源暂不可读取");
      expect(failure.message).not.toContain(root);
      expect(failure.message).not.toContain(asset.object_key);
      expect(failure.message).not.toContain("ENOENT");
    }
    expect(await factsSnapshot()).toEqual(before);
    expect(await usageSummary(db, owner.id)).toEqual(usageBefore);
  },
);

it.each([false, true])(
  "routes bounded diagnostic media without checkpoint pixels, and refreshes preview proof when requested: %s",
  async (recheckPreview) => {
    await generate(false);
    await db
      .updateTable("ai_jobs")
      .set({ status: "completed", lease: null, lease_until: null })
      .where("id", "=", ctx.jobId!)
      .execute();
    const usageBefore = (await usageSummary(db, owner.id)).calls.filter(
        (call) => call.callKind === "image",
      ),
      before = await factsSnapshot();
    let calls = 0,
      toolId = "",
      callbackError: unknown;
    const viewCall = recheckPreview ? 2 : 1,
      finalCall = recheckPreview ? 4 : 2;
    const regions = [
      {
        label: "目标",
        points: [
          [0.25, 0.2],
          [0.6, 0.2],
          [0.6, 0.7],
          [0.25, 0.7],
        ],
      },
    ];
    app = await createApp(db, {
      origin,
      storage: runtime(),
      ai: {
        memory: { driver: "sqlite", url: ":memory:" },
        imageFetch: (async () => {
          throw Error("Candidate view must not call an image provider");
        }) as typeof fetch,
        fetch: (async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          calls++;
          try {
            if (calls === 1)
              expect(
                body.tools.some(
                  (tool: any) => tool.function?.name === "image_candidate_view",
                ),
              ).toBe(true);
            if (calls === viewCall + 1) {
              const reply = body.messages.findLast(
                (message: any) =>
                  message.role === "tool" && message.tool_call_id === toolId,
              );
              expect(reply).toBeDefined();
              for (const forbidden of [
                "base64",
                "data:image/",
                "objectKey",
                "profileId",
                "nativeUsage",
                nativeMarker,
              ])
                expect(reply.content).not.toContain(forbidden);
              expect(reply.content).toContain("diagnostic-only");
              const pairs = body.messages.flatMap((message: any) =>
                Array.isArray(message.content)
                  ? message.content.flatMap((part: any, index: number) =>
                      part.type === "image_url"
                        ? [{ image: part, label: message.content[index - 1] }]
                        : [],
                    )
                  : [],
              );
              const images = pairs.map((pair: any) => pair.image);
              expect(images).toHaveLength(3);
              for (const [index, image] of images.entries()) {
                expect(pairs[index].label.type).toBe("text");
                const caption = JSON.parse(pairs[index].label.text);
                expect(caption).toMatchObject({
                  image: index + 1,
                  toolName: "image_candidate_view",
                  toolCallId: toolId,
                  toolImage: index + 1,
                  referenceImageId: sourceId,
                  generationOperationId: operationId,
                  view: ["source", "raw", "source-projection"][index],
                  coordinateSpace:
                    index === 1 ? "generation-workspace" : "source",
                });
                for (const forbidden of [
                  "objectKey",
                  "profileId",
                  "nativeUsage",
                  nativeMarker,
                  "sourceDigest",
                  "frameIndex",
                  "sha256",
                ])
                  expect(pairs[index].label.text).not.toContain(forbidden);
                expect(pairs[index].label.text.length).toBeLessThan(2200);
                expect(image.image_url.url).toMatch(
                  /^data:image\/jpeg;base64,/,
                );
                const meta = await sharp(
                  Buffer.from(image.image_url.url.split(",")[1], "base64"),
                ).metadata();
                expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(
                  1600,
                );
                expect(meta).toMatchObject(
                  index === 1
                    ? { width: 640, height: 960 }
                    : { width: 1600, height: 1200 },
                );
              }
            } else if (recheckPreview && calls === finalCall) {
              const reply = body.messages.findLast(
                (message: any) =>
                  message.role === "tool" && message.tool_call_id === toolId,
              );
              expect(JSON.parse(reply.content)).toMatchObject({
                error: true,
                code: "image_edit_preview_required",
                reason: "parameters_not_viewed",
                next: { toolName: "image_edit_preview" },
              });
            } else if (calls > finalCall)
              throw Error(`Unexpected candidate view request ${calls}`);
          } catch (error) {
            callbackError ??= error;
            throw error;
          }
          const tool =
            calls === viewCall
              ? {
                  name: "image_candidate_view",
                  args: { generationOperationId: operationId },
                }
              : recheckPreview && calls === 1
                ? {
                    name: "image_edit_preview",
                    args: { referenceImageId: sourceId, editRegions: regions },
                  }
                : recheckPreview && calls === viewCall + 1
                  ? {
                      name: "image_recompose",
                      args: {
                        generationOperationId: operationId,
                        referenceImageId: sourceId,
                        editRegions: regions,
                        filename: "not-composed.png",
                      },
                    }
                  : undefined;
          const message = tool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: (toolId = randomUUID()),
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.args),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "已查看诊断图，仍未验收或交付。" };
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
                  finish_reason: tool ? "tool_calls" : "stop",
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
        text: "请诊断候选的完整身体范围，暂时只查看。",
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
    expect(calls).toBe(finalCall);
    const persisted = (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).result;
    for (const forbidden of [
      "base64",
      "data:image/",
      "objectKey",
      "profileId",
      "nativeUsage",
      nativeMarker,
    ])
      expect(persisted).not.toContain(forbidden);
    const after = await factsSnapshot();
    expect(after.assets).toEqual(before.assets);
    expect(after.objects).toEqual(before.objects);
    expect(after.items).toEqual(before.items);
    expect(after.operations).toEqual(before.operations);
    expect(
      (await usageSummary(db, owner.id)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toEqual(usageBefore);
  },
  30000,
);
