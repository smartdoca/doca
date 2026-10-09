import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { Agent } from "@mastra/core/agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { completionResponse } from "./ai-mock.js";
import { fixtureSolidPagePDF, fixtureSolidScenePlan } from "./fixtures/ai-solid-scene-plan.js";
import { PARSER_VERSION } from "../apps/server/src/services/ai/file-extract.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import type { EditRegions } from "../apps/server/src/services/ai/image-edit-regions.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { databaseDriver } from "@db/transactions.js";
import { aiConfig, aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import * as usageModule from "@core/modules/ai/usage.js";
import * as sessionResourcesModule from "@core/modules/ai/session-resources.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { createImageBatchRequirements } from "../apps/server/src/services/ai/image-batch-requirements.js";
import {
  imageBatchSchema,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import {
  registerImageBatchAttemptScope,
  verifyImageBatchAttemptScope,
} from "../apps/server/src/services/ai/image-batch-attempts.js";
import { inspectImageBatchSelection } from "../apps/server/src/services/ai/image-batch-selection.js";
import {
  imageInputSchema,
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import { recomposeImageAsset } from "../apps/server/src/services/ai/image-recompose.js";
import { prepareImageEditMask } from "../apps/server/src/services/ai/image-edit-mask.js";
import * as storageModule from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import * as segmentationModule from "../apps/server/src/services/ai/image-mask-segment.js";
import type { SegmentationProfileStatus } from "../apps/server/src/services/ai/segmentation-profile.js";
import {
  fixtureSegmentationProfile,
  fixtureSegmentationWorker,
} from "./fixtures/ai-mask-segment-fixture.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  owner: Actor,
  other: Actor,
  root: string,
  sessionId: string,
  ctx: ToolContext,
  originalJobId: string,
  batch: ImageBatch;
let clock = 0;
const png = () =>
  sharp({
    create: { width: 80, height: 60, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
const runtime = () => ({ ...storageModule.storageRuntime(), root });
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function session(actor = owner) {
  const id = randomUUID(),
    now = new Date((clock += 1000)).toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: actor.id,
      title: "Isolated image attempt scope",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
async function job(
  options: {
    actor?: Actor;
    sessionId?: string;
    input?: object;
    result?: object;
  } = {},
) {
  const actor = options.actor ?? owner,
    id = randomUUID(),
    lease = randomUUID(),
    now = new Date((clock += 1000)).toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: options.sessionId ?? sessionId,
      model_id: "image",
      status: "running",
      input: JSON.stringify({
        text: "Complete the original book",
        ...options.input,
      }),
      result: JSON.stringify(options.result ?? {}),
      digest: id,
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      cancelled: 0,
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { actor, jobId: id, lease };
}
async function attachBatch(target: ToolContext, value: unknown = batch) {
  await db
    .updateTable("ai_jobs")
    .set({ result: JSON.stringify({ checkpoint: { imageBatch: value } }) })
    .where("id", "=", target.jobId!)
    .execute();
}
const page = (index = 0) => batch.books[0]!.pages[index]!.referenceImageId;
const input = (n: number, index = 0) => ({
  prompt: `Edit source page attempt ${n}`,
  referenceImageIds: [page(index)],
});
const settings = (fakeFetch: typeof fetch) => ({
  operation: "edit" as const,
  storage: runtime(),
  fetch: fakeFetch,
  batchAttemptScope: batch.attemptScope,
});
const response = async () =>
  Response.json({
    data: [{ b64_json: (await png()).toString("base64") }],
    usage: { input_tokens: 9, output_tokens: 13 },
  });
async function generation(operationId: string) {
  return JSON.parse(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", operationId)
        .executeTakeFirstOrThrow()
    ).result,
  );
}
async function imageCalls() {
  return (await usageSummary(db, owner.id)).calls;
}

beforeEach(async () => {
  clock = Date.now() - 60000;
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "attempt-owner",
        displayName: "Attempt owner",
        password: "isolated-attempt-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "attempt-other",
        displayName: "Other",
        password: "isolated-attempt-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  root = await mkdtemp(join(tmpdir(), "doca-image-batch-attempts-"));
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
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
  sessionId = await session();
  const sourceId = randomUUID(),
    objectId = randomUUID(),
    sourceKey = objectKey(sourceId, "application/pdf"),
    profile = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow();
  const now = new Date((clock += 1000)).toISOString();
  const sourceBytes = fixtureSolidPagePDF(3);
  await storageModule.createStorage(runtime()).put(
    storageModule.storageConfigForProfile(runtime(), profile), sourceKey, sourceBytes,
    "application/pdf", "fixture.pdf");
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: sourceKey,
      sha256: hash(sourceBytes),
      size: sourceBytes.length,
      mime: "application/pdf",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("assets")
    .values({
      id: sourceId,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: sourceKey,
      filename: "fixture.pdf",
      mime: "application/pdf",
      size: sourceBytes.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  ctx = await job({ input: { attachments: [sourceId] } });
  originalJobId = ctx.jobId!;
  const source = { assetId: sourceId },
    parts: { type: "image"; recipe: string; filename: string; mime: string }[] =
      [];
  for (let index = 0; index < 3; index++) {
    const id = randomUUID(),
      data = await png(),
      key = objectKey(id, "image/png"),
      recipe = `v${PARSER_VERSION}-img-${index}`;
    await storageModule
      .createStorage(runtime())
      .put(
        storageModule.storageConfigForProfile(runtime(), profile),
        key,
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
        object_key: key,
        kind: "extract-image",
        recipe,
        mime: "image/png",
        size: data.length,
        created_at: now,
      })
      .execute();
    parts.push({
      type: "image",
      recipe,
      filename: `page-${index + 1}.png`,
      mime: "image/png",
    });
  }
  await db.insertInto("file_extracts").values({ storage_object_id: objectId,
    status: "ready", result: JSON.stringify({ parserVersion: PARSER_VERSION, parts }),
    error: null, updated_at: now }).execute();
  const pages = await registerVisualReferences(
    db,
    ctx,
    source,
    objectId,
    parts,
  );
  const requirements = await createImageBatchRequirements(
    db,
    { userId: owner.id, actor: owner, sessionId, currentJobId: ctx.jobId! },
    originalJobId,
    [source],
    "all-documents",
    ["Requested visible edit"],
    [],
  );
  const books = [{ source, filename: "fixture.pdf", pages }],
    attemptScope = await registerImageBatchAttemptScope(
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
    notes: "",
    delivered: {},
    reviews: {},
  });
  await attachBatch(ctx);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

it("shares five submitted requests across explicit resume, retry, changed prompts and rebuilt batches without rewriting the first three", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  const operations: string[] = [];
  let firstThree: unknown[] = [];
  for (let n = 1; n <= 5; n++) {
    if (n > 1) {
      ctx = await job({ input: n === 3 ? { retryOf: ctx.jobId } : {} });
      await attachBatch(ctx);
      expect(await verifyImageBatchAttemptScope(db, ctx, batch)).toEqual(
        batch.attemptScope,
      );
    }
    const id = randomUUID();
    operations.push(id);
    const result = await generateImageAsset(
      db,
      ctx,
      input(n),
      id,
      settings(fakeFetch),
    );
    expect(result.paidAttempt).toMatchObject({
      referenceImageId: page(),
      ordinal: n,
      scope: batch.attemptScope,
    });
    if (n === 3) firstThree = await Promise.all(operations.map(generation));
  }
  expect(await Promise.all(operations.slice(0, 3).map(generation))).toEqual(
    firstThree,
  );
  const rebuilt = await registerImageBatchAttemptScope(
    db,
    ctx,
    {
      requirements: batch.requirements,
      books: batch.books,
    },
    { version: 1 },
  );
  expect(rebuilt).toEqual(batch.attemptScope);
  const resumed = await job();
  await attachBatch(resumed);
  await expect(
    generateImageAsset(
      db,
      resumed,
      input(6),
      randomUUID(),
      settings(fakeFetch),
    ),
  ).rejects.toThrow(/已提交5次/);
  expect(calls).toBe(5);
  expect(await imageCalls()).toHaveLength(5);
  expect(await generation(operations[0]!)).toMatchObject({
    state: "saved",
    paidAttempt: { ordinal: 1 },
    rawCandidate: { version: 1 },
  });
  // Replaying the fifth scoped receipt does not count as a sixth request.
  expect(
    (
      await generateImageAsset(
        db,
        ctx,
        input(5),
        operations[4]!,
        settings(fakeFetch),
      )
    ).assetId,
  ).toBe((await generation(operations[4]!)).assetId);
  expect(calls).toBe(5);
});

it("uses a higher configured cap, blocks new requests after lowering it, and reads the exact paid historical receipt without charging again", async () => {
  const key = "DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE";
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  const operations: string[] = [];
  const driver = databaseDriver(db);
  try {
    vi.stubEnv(key, "7");
    vi.resetModules();
    (await import("@db/transactions.js")).registerDriver(db, driver);
    const higher = await import("../apps/server/src/services/ai/images.js");
    for (let n = 1; n <= 7; n++) {
      const id = randomUUID();
      operations.push(id);
      const result = await higher.generateImageAsset(
        db,
        ctx,
        input(n),
        id,
        settings(fakeFetch),
      );
      expect(result.paidAttempt?.ordinal).toBe(n);
    }
    await expect(
      higher.generateImageAsset(
        db,
        ctx,
        input(8),
        randomUUID(),
        settings(fakeFetch),
      ),
    ).rejects.toThrow(/已提交7次/);
    const stored = {
      operations: await db
        .selectFrom("ai_operations")
        .selectAll()
        .orderBy("id")
        .execute(),
      assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
      usage: await imageCalls(),
    };
    vi.stubEnv(key, "5");
    vi.resetModules();
    (await import("@db/transactions.js")).registerDriver(db, driver);
    const lowered = await import("../apps/server/src/services/ai/images.js");
    await expect(
      lowered.generateImageAsset(
        db,
        ctx,
        input(8),
        randomUUID(),
        settings(fakeFetch),
      ),
    ).rejects.toThrow(/已提交5次/);
    const reused = await lowered.generateImageAsset(
      db,
      ctx,
      input(7),
      operations[6]!,
      settings(fakeFetch),
    );
    expect(reused).toEqual(await generation(operations[6]!));
    expect(reused.paidAttempt).toMatchObject({
      version: 1,
      ordinal: 7,
      scope: batch.attemptScope,
    });
    expect(calls).toBe(7);
    expect(
      await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
    ).toEqual(stored.operations);
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(stored.assets);
    expect(await imageCalls()).toEqual(stored.usage);
    expect(stored.usage).toHaveLength(7);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

it("counts each source page independently and leaves real export/recomposition free even after the cap", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  const id = randomUUID();
  await generateImageAsset(db, ctx, input(1), id, settings(fakeFetch));
  for (let n = 2; n <= 5; n++)
    await generateImageAsset(
      db,
      ctx,
      input(n),
      randomUUID(),
      settings(fakeFetch),
    );
  const local = await recomposeImageAsset(
    db,
    ctx,
    {
      generationOperationId: id,
      referenceImageId: page(),
      filename: "local.png",
      editRegions: [
        {
          label: "color area",
          points: [
            [0.2, 0.2],
            [0.4, 0.2],
            [0.4, 0.4],
            [0.2, 0.4],
          ],
        },
      ],
    },
    randomUUID(),
    { storage: runtime() },
  );
  expect(local.origin).toBe("local-recomposition");
  const exported = await generateImageAsset(
    db,
    ctx,
    { prompt: "Export original page", referenceImageIds: [page()] },
    randomUUID(),
    { ...settings(fakeFetch), exportOnly: true },
  );
  expect(exported.origin).toBe("reference-export");
  expect(exported.paidAttempt).toBeUndefined();
  const nextPage = await generateImageAsset(
    db,
    ctx,
    input(6, 1),
    randomUUID(),
    settings(fakeFetch),
  );
  expect(nextPage.paidAttempt?.ordinal).toBe(1);
  await expect(
    generateImageAsset(db, ctx, input(7), randomUUID(), settings(fakeFetch)),
  ).rejects.toThrow(/已提交5次/);
  expect(calls).toBe(6);
  expect(await imageCalls()).toHaveLength(6);
});

it("retains rejected and uncertain submissions across jobs without assuming unreturned requests were free", async () => {
  let calls = 0;
  const rejectedId = randomUUID(),
    uncertainId = randomUUID();
  await expect(
    generateImageAsset(
      db,
      ctx,
      input(1),
      rejectedId,
      settings((async () => {
        calls++;
        return new Response("Invalid edit", { status: 422 });
      }) as typeof fetch),
    ),
  ).rejects.toThrow(/HTTP 422/);
  const resumed = await job();
  await attachBatch(resumed);
  await expect(
    generateImageAsset(
      db,
      resumed,
      input(2),
      uncertainId,
      settings((async () => {
        calls++;
        throw Error("Connection lost after submission");
      }) as typeof fetch),
    ),
  ).rejects.toThrow(/费用待核对/);
  await generateImageAsset(
    db,
    resumed,
    input(3),
    randomUUID(),
    settings((async () => {
      calls++;
      return response();
    }) as typeof fetch),
  );
  for (let n = 4; n <= 5; n++)
    await generateImageAsset(
      db,
      resumed,
      input(n),
      randomUUID(),
      settings((async () => {
        calls++;
        return response();
      }) as typeof fetch),
    );
  await expect(
    generateImageAsset(
      db,
      resumed,
      input(6),
      randomUUID(),
      settings((async () => {
        calls++;
        return response();
      }) as typeof fetch),
    ),
  ).rejects.toThrow(/已提交5次/);
  expect(await generation(rejectedId)).toMatchObject({
    state: "failed",
    paidAttempt: { ordinal: 1 },
  });
  expect(await generation(uncertainId)).toMatchObject({
    state: "generating",
    paidAttempt: { ordinal: 2 },
  });
  expect(calls).toBe(5);
  expect((await imageCalls()).map((call) => call.state).sort()).toEqual([
    "confirmed",
    "confirmed",
    "confirmed",
    "failed",
    "pending",
  ]);
});

it("retains the paid attempt and committed raw if final persistence fails", async () => {
  const original = storageModule.createStorage;
  let writes = 0,
    calls = 0;
  vi.spyOn(storageModule, "createStorage").mockImplementation((value) => {
    const storage = original(value);
    return {
      ...storage,
      put: async (...args) => {
        if (++writes === 2) throw Error("Final write failed");
        await storage.put(...args);
      },
    };
  });
  const id = randomUUID();
  await expect(
    generateImageAsset(
      db,
      ctx,
      input(1),
      id,
      settings((async () => {
        calls++;
        return response();
      }) as typeof fetch),
    ),
  ).rejects.toThrow(/图片保存失败/);
  expect(await generation(id)).toMatchObject({
    state: "save_failed",
    paidAttempt: { ordinal: 1, scope: batch.attemptScope },
    rawCandidate: { version: 1 },
  });
  expect(hash((await readRawImageCandidate(db, ctx, id, runtime())).data)).toBe(
    hash(await png()),
  );
  vi.restoreAllMocks();
  const resumed = await job();
  await attachBatch(resumed);
  await expect(
    generateImageAsset(
      db,
      resumed,
      input(1),
      randomUUID(),
      settings((async () => {
        calls++;
        return response();
      }) as typeof fetch),
    ),
  ).rejects.toThrow(new RegExp(`原始候选已保留.*${id}`));
  expect(calls).toBe(1);
  const result = await generateImageAsset(
    db,
    resumed,
    input(2),
    randomUUID(),
    settings((async () => {
      calls++;
      return response();
    }) as typeof fetch),
  );
  expect(result.paidAttempt?.ordinal).toBe(2);
  expect(calls).toBe(2);
});

it("blocks an in-flight same-scope request on a fresh resume job outside the retry chain", async () => {
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = generateImageAsset(
    db,
    ctx,
    input(1),
    randomUUID(),
    settings((async () => {
      calls++;
      started();
      await waiting;
      return response();
    }) as typeof fetch),
  );
  await reached;
  try {
    const resumed = await job();
    await attachBatch(resumed);
    await expect(
      generateImageAsset(
        db,
        resumed,
        input(1),
        randomUUID(),
        settings((async () => {
          calls++;
          return response();
        }) as typeof fetch),
      ),
    ).rejects.toThrow(/相同的图片请求正在生成/);
    expect(calls).toBe(1);
  } finally {
    release();
  }
  await running;
  expect(await imageCalls()).toHaveLength(1);
});

it("retains the initial attempt if beginCall commits but its response is lost, and does not label that request free", async () => {
  const begin = usageModule.beginCall;
  vi.spyOn(usageModule, "beginCall").mockImplementationOnce(async (...args) => {
    await begin(...args);
    throw Error("Call registration response lost");
  });
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  const id = randomUUID();
  await expect(
    generateImageAsset(db, ctx, input(1), id, settings(fakeFetch)),
  ).rejects.toThrow(/response lost/);
  expect(await generation(id)).toMatchObject({
    state: "generating",
    paidAttempt: { ordinal: 1, scope: batch.attemptScope },
  });
  expect(calls).toBe(0);
  expect((await imageCalls())[0]).toMatchObject({ state: "reserved" });
  const resumed = await job();
  await attachBatch(resumed);
  await expect(
    generateImageAsset(
      db,
      resumed,
      input(1),
      randomUUID(),
      settings(fakeFetch),
    ),
  ).rejects.toThrow(/相同的图片请求正在生成/);
  expect(
    (
      await generateImageAsset(
        db,
        resumed,
        input(2),
        randomUUID(),
        settings(fakeFetch),
      )
    ).paidAttempt?.ordinal,
  ).toBe(2);
  expect(calls).toBe(1);
  expect(await imageCalls()).toHaveLength(2);
});

it("rejects omitted, forged or unpersisted host scopes and model-supplied scope fields before any image call", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  expect(
    imageInputSchema.safeParse({
      ...input(1),
      batchAttemptScope: batch.attemptScope,
    }).success,
  ).toBe(false);
  for (const supplied of [
    undefined,
    { ...batch.attemptScope, operationId: randomUUID() },
    { ...batch.attemptScope, taskRootJobId: randomUUID() },
    { ...batch.attemptScope, manifestDigest: "b".repeat(64) },
  ]) {
    await expect(
      generateImageAsset(db, ctx, input(1), randomUUID(), {
        storage: runtime(),
        fetch: fakeFetch,
        batchAttemptScope: supplied,
      }),
    ).rejects.toThrow(/attemptScope/);
  }
  await db
    .deleteFrom("ai_operations")
    .where("id", "=", batch.attemptScope.operationId)
    .execute();
  await expect(
    generateImageAsset(db, ctx, input(1), randomUUID(), settings(fakeFetch)),
  ).rejects.toThrow(/记录缺失/);
  expect(calls).toBe(0);
  expect(await imageCalls()).toHaveLength(0);
});

it("rejects old batches, revoked source permission, cross-session and cross-account scope reuse", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  const { attemptScope: _scope, ...withoutScope } = batch;
  for (const old of [{ ...batch, version: 2 }, withoutScope]) {
    await attachBatch(ctx, old);
    await expect(
      generateImageAsset(db, ctx, input(1), randomUUID(), settings(fakeFetch)),
    ).rejects.toThrow(/version:3/);
  }
  await attachBatch(ctx);
  const foreignSession = await job({ sessionId: await session() });
  await attachBatch(foreignSession);
  await expect(
    verifyImageBatchAttemptScope(db, foreignSession, batch),
  ).rejects.toThrow(/当前账号、会话/);
  const foreign = await job({ actor: other, sessionId: await session(other) });
  await attachBatch(foreign);
  await expect(
    verifyImageBatchAttemptScope(db, foreign, batch),
  ).rejects.toThrow(/当前账号、会话/);
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", batch.books[0]!.source.assetId!)
    .execute();
  await expect(verifyImageBatchAttemptScope(db, ctx, batch)).rejects.toThrow(
    /附件缺失/,
  );
  expect(calls).toBe(0);
  expect(await imageCalls()).toHaveLength(0);
});

type RunnerTool = { name: string; args: object };
const repairRegions: EditRegions = [
  {
    label: "Corrected coverage",
    points: [
      [0.2, 0.2],
      [0.6, 0.2],
      [0.6, 0.7],
      [0.2, 0.7],
    ],
  },
];

async function seedFailedDelivery(
  origin: "provider" | "reference-export" | "local-recomposition" = "provider",
  candidateColor?: string,
) {
  const providerOperationId = randomUUID();
  let paid = 0;
  const imageFetch = (async () => {
    paid++;
    if (candidateColor) return Response.json({
      data: [{ b64_json: (await sharp({ create: {
        width: 80, height: 60, channels: 3, background: candidateColor,
      } }).png().toBuffer()).toString("base64") }],
      usage: { input_tokens: 9, output_tokens: 13 },
    });
    return response();
  }) as typeof fetch;
  let saved = await generateImageAsset(db, ctx, input(1), providerOperationId, {
    ...settings(imageFetch),
    exportOnly: origin === "reference-export",
  });
  let localOperationId: string | undefined;
  if (origin === "local-recomposition") {
    localOperationId = randomUUID();
    saved = await recomposeImageAsset(
      db,
      ctx,
      {
        generationOperationId: providerOperationId,
        referenceImageId: page(),
        editRegions: structuredClone(repairRegions),
        filename: "local-first.png",
      },
      localOperationId,
      { storage: runtime() },
    );
  }
  batch.delivered[page()] = saved.assetId;
  batch.reviews[page()] = {
    assetId: saved.assetId,
    passed: false,
    evidence: "Actual candidate is not an acceptable edit",
  };
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", ctx.jobId!)
    .execute();
  return {
    saved,
    providerOperationId,
    localOperationId,
    imageFetch,
    paid: () => paid,
  };
}

async function seedCompletedBatch() {
  const seed = await seedFailedDelivery("reference-export");
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  for (let index = 1; index < batch.books[0]!.pages.length; index++) {
    if (index === 1)
      await generateImageAsset(
        db,
        ctx,
        { ...input(1, index), filename: "obsolete-page-2.png" },
        randomUUID(),
        { ...settings(seed.imageFetch), exportOnly: true },
      );
    const saved = await generateImageAsset(
      db,
      ctx,
      { ...input(1, index), filename: `latest-page-${index + 1}.png` },
      randomUUID(),
      { ...settings(seed.imageFetch), exportOnly: true },
    );
    batch.delivered[page(index)] = saved.assetId;
  }
  for (const referenceImageId of batch.books[0]!.pages.map(
    (item) => item.referenceImageId,
  ))
    batch.reviews[referenceImageId] = {
      assetId: batch.delivered[referenceImageId]!,
      passed: true,
      evidence: "Isolated fixture's latest page was accepted",
    };
  batch.current = batch.books.length;
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  expect(seed.paid()).toBe(0);
  return seed;
}

async function seedSelectablePriorDelivery(
  origin: "provider" | "local-recomposition" = "provider",
) {
  const seed = await seedFailedDelivery(origin);
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const latest = await generateImageAsset(
    db,
    ctx,
    input(2),
    randomUUID(),
    settings(seed.imageFetch),
  );
  const otherPage = await generateImageAsset(
    db,
    ctx,
    input(1, 1),
    randomUUID(),
    { ...settings(seed.imageFetch), exportOnly: true },
  );
  batch.delivered[page()] = latest.assetId;
  batch.reviews[page()] = {
    assetId: latest.assetId,
    passed: false,
    evidence: "The newer candidate remains unacceptable",
  };
  batch.delivered[page(1)] = otherPage.assetId;
  batch.reviews[page(1)] = {
    assetId: otherPage.assetId,
    passed: true,
    evidence: "Other page's independent inspection is unchanged",
  };
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  return { seed, latest, otherPage };
}

async function storedBatch(jobId: string): Promise<ImageBatch> {
  const row = await db
    .selectFrom("ai_jobs")
    .select("result")
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.result).checkpoint.imageBatch;
}

const selectPriorCandidate = (assetId: string): RunnerTool => ({
  name: "image_batch",
  args: {
    action: "select",
    candidate: { referenceImageId: page(), assetId },
  },
});
const viewSourceAndSaved = (assetId: string, index = 0): RunnerTool => ({
  name: "image_view",
  args: { referenceImageIds: [page(index), assetId] },
});
const actualImageFrames = (body: any) =>
  body.messages
    .flatMap((message: any) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part: any) => part.type === "image_url");

async function expectActualFixtureFrames(body: any, count: number) {
  const frames = actualImageFrames(body);
  expect(frames).toHaveLength(count);
  for (const frame of frames) {
    const actual = await sharp(
      Buffer.from(frame.image_url.url.split(",")[1], "base64"),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([actual.info.width, actual.info.height]).toEqual([80, 60]);
    expect(actual.data.length).toBe(80 * 60 * 4);
    // image_view transports complete JPEG previews; persisted PNG/raw facts
    // are checked independently and are never reconstructed from this preview.
    for (let pixel = 0; pixel < actual.data.length; pixel += 4) {
      for (let channel = 0; channel < 3; channel++)
        expect(
          Math.abs(actual.data[pixel + channel]! - [51, 102, 153][channel]!),
        ).toBeLessThanOrEqual(3);
      expect(actual.data[pixel + 3]).toBe(255);
    }
  }
}

async function unchangedSelectionFacts() {
  return {
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    imageCalls: (await imageCalls()).filter(
      (call) => call.callKind === "image",
    ),
    requirements: structuredClone(batch.requirements),
    attemptScope: structuredClone(batch.attemptScope),
    otherDelivery: batch.delivered[page(1)],
    otherReview: structuredClone(batch.reviews[page(1)]),
  };
}

async function expectSelectionFactsPreserved(
  jobId: string,
  before: Awaited<ReturnType<typeof unchangedSelectionFacts>>,
) {
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(before.operations);
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(before.assets);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toEqual(before.imageCalls);
  const current = await storedBatch(jobId);
  expect(current.requirements).toEqual(before.requirements);
  expect(current.attemptScope).toEqual(before.attemptScope);
  expect(current.delivered[page(1)]).toBe(before.otherDelivery);
  expect(current.reviews[page(1)]).toEqual(before.otherReview);
  return current;
}

/** Exercise the real queued runner, streamed model steps, tool media and metering. */
async function runFailedBatch(
  seed: Awaited<ReturnType<typeof seedFailedDelivery>>,
  next: (
    body: any,
    step: number,
    signal?: AbortSignal | null,
  ) => Promise<RunnerTool[]> | RunnerTool[],
  options: {
    maxSteps?: number;
    emptyText?: string;
    expectedStatus?: "completed" | "failed" | "cancelled";
    expectedQuestions?: number;
    independentImageReview?: boolean;
    reviewExpectedCriteria?: string[];
    segmentationProfile?: SegmentationProfileStatus;
    appFactory?: typeof createApp;
    terminalDeadlineMs?: number;
    request?: { text: string; attachments: string[] };
    imageTaskRoute?: "all-document-pages" | "ordinary" | "uncertain";
    onQueued?: (context: {
      app: Awaited<ReturnType<typeof createApp>>;
      headers: Record<string, string>;
      jobId: string;
    }) => Promise<void>;
  } = {},
) {
  if (options.maxSteps) {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(db, { ...config, maxSteps: options.maxSteps }, revision);
  }
  const origin = "http://localhost:39327";
  let calls = 0,
    imageReviews = 0;
  const errors: unknown[] = [],
    bodies: any[] = [],
    imageReviewBodies: any[] = [];
  const app = await (options.appFactory ?? createApp)(db, {
    origin,
    storage: runtime(),
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      segmentationProfile: options.segmentationProfile,
      imageFetch: seed.imageFetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.messages.some((message: any) => message.role === "system"
          && String(message.content).includes("Doca image-task-route"))) {
          const message = body.messages.find((message: any) => message.role === "user");
          const content = typeof message.content === "string" ? message.content
            : message.content.find((part: any) => part.type === "text").text;
          const input = JSON.parse(content);
          return completionResponse({ id: randomUUID(), object: "chat.completion", created: 1,
            model: body.model, choices: [{ index: 0, message: { role: "assistant",
              content: JSON.stringify({ route: options.imageTaskRoute ?? "ordinary", quote: input.userText.slice(0, 500) }) },
              finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }, !!body.stream);
        }
        const scenePlan = fixtureSolidScenePlan(body);
        if (scenePlan) return scenePlan;
        if (
          body.messages.some(
            (message: any) =>
              message.role === "system" &&
              String(message.content).includes("Doca image-delivery-verifier"),
          )
        ) {
          imageReviews++;
          imageReviewBodies.push(body);
          const content = body.messages.flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          );
          const text = content.find(
            (part: any) =>
              part.type === "text" && part.text.startsWith('{"requiredChecks"'),
          );
          const metadata = JSON.parse(text.text);
          if (options.reviewExpectedCriteria === undefined)
            expect(metadata.requiredChecks).toHaveLength(5);
          else {
            expect(
              metadata.requiredChecks.map((check: any) => check.id),
            ).toEqual([
              "target",
              "non-target",
              "integration",
              "text",
              ...options.reviewExpectedCriteria.map(
                (_, index) => `criterion-${index}`,
              ),
            ]);
            expect(metadata.requiredChecks.slice(4)).toEqual(
              options.reviewExpectedCriteria.map(
                (requirement, criterionIndex) => ({
                  id: `criterion-${criterionIndex}`,
                  requirement,
                  criterionIndex,
                }),
              ),
            );
          }
          expect(JSON.stringify(body.messages)).toContain(
            "Complete the original book",
          );
          const frames = content.filter(
            (part: any) => part.type === "image_url",
          );
          const native = metadata.reviewMode === "native-detail";
          expect(frames).toHaveLength(
            native
              ? 2 + metadata.tiles.length * 2
              : (metadata.detailCoveragePlan.tileCount ? 4 : 2) +
                  metadata.referenceMapping.length,
          );
          for (const [index, frame] of frames.entries()) {
            const bytes = Buffer.from(
              frame.image_url.url.split(",")[1],
              "base64",
            );
            const size = await sharp(bytes).metadata();
            expect(size.width).toBeGreaterThan(0);
            expect(size.height).toBeGreaterThan(0);
            if (native) {
              expect(frame.image_url.url).toMatch(/^data:image\/png;/);
              if (index >= 2) {
                const tile = metadata.tiles[Math.floor((index - 2) / 2)],
                  rect = index % 2 === 0 ? tile.sourceRect : tile.candidateRect;
                expect([size.width, size.height]).toEqual([
                  rect.width,
                  rect.height,
                ]);
              }
            }
            const pixel = await sharp(bytes).removeAlpha().raw().toBuffer();
            expect(
              [...pixel.subarray(0, 3)].every(
                (value, channel) =>
                  Math.abs(value - [51, 102, 153][channel]!) <= 3,
              ),
            ).toBe(true);
          }
          // Most tests diagnose a deliberately rejected fixture. Only explicit
          // acceptance/drain fixtures provide a passing independent verdict;
          // executor tool prose never controls the result.
          const passed = options.independentImageReview === true;
          const report = {
            verdict: passed ? "pass" : "revise",
            summary: passed
              ? "Isolated image pixels reviewed"
              : "Fixture target remains unaccepted",
            checks: metadata.requiredChecks.map((check: any) => ({
              id: check.id,
              passed: passed || check.id !== "target",
              evidence:
                !passed && check.id === "target"
                  ? "Independent fixture judge still rejects the requested edit"
                  : "Actual fixture source and saved pixels were supplied",
            })),
          };
          const response = native
            ? {
                tiles: metadata.tiles.map((tile: any) => ({
                  ...report,
                  tileId: tile.id,
                  people: {
                    sourceCount: 0,
                    candidateCount: 0,
                    evidence: "Actual native fixture crop has no people",
                  },
                  differences: [],
                })),
              }
            : report;
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
                    content: JSON.stringify(response),
                  },
                  finish_reason: "stop",
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
        }
        bodies.push(body);
        calls++;
        let actions: RunnerTool[];
        try {
          actions = await next(body, calls, init?.signal);
        } catch (error) {
          if (init?.signal?.aborted) throw error;
          errors.push(error);
          actions = [];
        }
        if (!actions.length && !options.emptyText)
          actions = [
            {
              name: "ask_user",
              args: {
                title:
                  "The diagnostic is complete; the page remains unaccepted",
                options: ["Keep original criteria", "Stop diagnostic"],
              },
            },
          ];
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
                  content: actions.length ? null : options.emptyText,
                  ...(actions.length
                    ? {
                        tool_calls: actions.map((action) => ({
                          id: randomUUID(),
                          type: "function",
                          function: {
                            name: action.name,
                            arguments: JSON.stringify(action.args),
                          },
                        })),
                      }
                    : {}),
                },
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
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, host: "localhost:39327" },
      payload: { login: "attempt-owner", password: "isolated-attempt-2026" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string,
      headers = { origin, host: "localhost:39327", cookie },
      id = randomUUID();
    const queued = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionId}/messages`,
      headers,
      payload: {
        id,
        modelId: "chat",
        scope: "all",
        text: "继续同一批次，诊断并修复最新失败候选",
        ...options.request,
      },
    });
    expect(queued.statusCode).toBe(200);
    await options.onQueued?.({ app, headers, jobId: id });
    let current: any;
    const terminalDeadline =
      options.terminalDeadlineMs === undefined
        ? undefined
        : performance.now() + options.terminalDeadlineMs;
    // Keep other fixtures' original 300 polls; heavy cases opt into elapsed time.
    for (
      let n = 0;
      terminalDeadline === undefined
        ? n < 300
        : performance.now() < terminalDeadline;
      n++
    ) {
      current = (
        await app.inject({ url: `/api/v1/ai/sessions/${sessionId}`, headers })
      )
        .json()
        .jobs.find((item: any) => item.id === id);
      if (current && !["queued", "running"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(errors).toEqual([]);
    expect(current.status, current.error).toBe(
      options.expectedStatus ?? "completed",
    );
    expect(current.progress.questions?.length ?? 0).toBe(
      options.expectedQuestions ?? 1,
    );
    return {
      jobId: id,
      current,
      bodies,
      calls,
      imageReviews,
      imageReviewBodies,
    };
  } finally {
    await app.close();
  }
}
const resumeFailedBatch = (): RunnerTool => ({
  name: "image_batch",
  args: { action: "resume", jobId: originalJobId },
});
const regenerate = (attempt: number, index = 0): RunnerTool => ({
  name: "image_edit",
  args: {
    ...input(attempt, index),
    sourceImageId: page(index),
    referenceImageIds: undefined,
  },
});
const inspectScene = (index = 0): RunnerTool => ({
  name: "image_scene_inspect",
  args: { referenceImageId: page(index) },
});
const candidateView = (id: string): RunnerTool => ({
  name: "image_candidate_view",
  args: { generationOperationId: id },
});
const lastTool = (body: any, name: string) => {
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
};
const mediaToolFacts = (body: any, name: string) =>
  JSON.parse(JSON.parse(lastTool(body, name))[0].text);

it.each(["nonempty", "empty"] as const)(
  "keeps the %s v3 batch criteria frozen while real task_plan goals, steps and mode change, and an actual revised judgment still prevents advance",
  async (criteriaShape) => {
    if (criteriaShape === "empty") {
      const requirements = await createImageBatchRequirements(
        db,
        { userId: owner.id, actor: owner, sessionId, currentJobId: ctx.jobId! },
        originalJobId,
        batch.books.map((book) => book.source),
        "all-documents",
        [],
      );
      const attemptScope = await registerImageBatchAttemptScope(
        db,
        ctx,
        {
          requirements,
          books: batch.books,
        },
        { version: 1 },
      );
      batch = imageBatchSchema.parse({ ...batch, requirements, attemptScope });
      await attachBatch(ctx);
    }
    const frozen = structuredClone(batch.requirements.criteria),
      requirementsBefore = structuredClone(batch.requirements),
      attemptScopeBefore = structuredClone(batch.attemptScope);
    expect(frozen).toEqual(
      criteriaShape === "empty" ? [] : ["Requested visible edit"],
    );
    const seed = await seedFailedDelivery();
    // All other pages really have saved receipts and accepted fixture records,
    // so the later advance refusal is caused by this page's actual false review.
    await db
      .updateTable("ai_jobs")
      .set({
        status: "running",
        lease: ctx.lease!,
        lease_until: new Date(Date.now() + 120000).toISOString(),
      })
      .where("id", "=", originalJobId)
      .execute();
    for (let index = 1; index < batch.books[0]!.pages.length; index++) {
      const saved = await generateImageAsset(
        db,
        ctx,
        input(1, index),
        randomUUID(),
        {
          ...settings(seed.imageFetch),
          exportOnly: true,
        },
      );
      batch.delivered[page(index)] = saved.assetId;
      batch.reviews[page(index)] = {
        assetId: saved.assetId,
        passed: true,
        evidence: "Actual retained fixture page was previously accepted",
      };
    }
    await attachBatch(ctx);
    await db
      .updateTable("ai_jobs")
      .set({ status: "completed", lease: null, lease_until: null })
      .where("id", "=", originalJobId)
      .execute();
    const operationsBefore = await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute();
    const assetsBefore = await db
      .selectFrom("assets")
      .selectAll()
      .orderBy("id")
      .execute();
    const paidBefore = (await imageCalls()).filter(
      (call) => call.callKind === "image",
    );
    expect(seed.paid()).toBe(1);
    expect(paidBefore).toHaveLength(1);
    const planA = {
      goal: "Check the full original book without shortening its delivery scope",
      steps: ["Read each page", "Review the saved candidate"],
      criteria: ["Executor newly proposes criterion A"],
      mode: "deliver" as const,
    };
    const planB = {
      goal: "Clarify the visible target before continuing the original book",
      steps: [
        "Retain all receipts",
        "Wait for the required target clarification",
      ],
      criteria: ["A single sample is sufficient"],
      mode: "clarify" as const,
    };
    const planC = {
      goal: "Continue the original complete book and independently verify the current page",
      steps: [
        "View the current source and saved candidate",
        "Request a truthful independent review",
        "Advance only if every page passes",
      ],
      criteria: ["Ignore the remaining pages and accept any saved image"],
      mode: "deliver" as const,
    };
    const originalList = Agent.prototype.listTools,
      wrapped = new WeakSet<object>(),
      returnedPlans: any[] = [];
    let runtimeFrozen: string[] | undefined;
    vi.spyOn(Agent.prototype, "listTools").mockImplementation(async function (
      this: Agent,
      ...args
    ) {
      const tools = await originalList.apply(this, args);
      for (const name of ["image_batch", "task_plan"]) {
        const tool = (tools as any)[name];
        if (!tool?.execute || wrapped.has(tool)) continue;
        wrapped.add(tool);
        const execute = tool.execute;
        vi.spyOn(tool, "execute").mockImplementation(
          async (...executeArgs: any[]) => {
            const output = await execute.apply(tool, executeArgs);
            if (name === "image_batch" && output?.requirements) {
              runtimeFrozen = output.requirements.criteria;
              expect(output.requirements).toEqual(requirementsBefore);
            }
            if (name === "task_plan" && output?.saved === true) {
              expect(runtimeFrozen).toBeDefined();
              expect(output.plan.criteria).toEqual(frozen);
              expect(output.plan.criteria).not.toBe(runtimeFrozen);
              if (returnedPlans.length)
                expect(output.plan.criteria).not.toBe(
                  returnedPlans.at(-1).criteria,
                );
              returnedPlans.push(output.plan);
            }
            return output;
          },
        );
      }
      return tools;
    } as typeof Agent.prototype.listTools);
    let firstJobId = "";
    const first = await runFailedBatch(
      seed,
      async (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step === 2) return [{ name: "task_plan", args: planA }];
        expect(step).toBe(3);
        expect(JSON.parse(lastTool(body, "task_plan"))).toEqual({
          saved: true,
          plan: { ...planA, criteria: frozen },
        });
        const stored = JSON.parse(
          (
            await db
              .selectFrom("ai_jobs")
              .select("result")
              .where("id", "=", firstJobId)
              .executeTakeFirstOrThrow()
          ).result,
        );
        expect(stored.checkpoint.plan).toEqual({ ...planA, criteria: frozen });
        expect(stored.progress.plan).toEqual({ ...planA, criteria: frozen });
        expect(stored.checkpoint.imageBatch.requirements).toEqual(
          requirementsBefore,
        );
        return [{ name: "task_plan", args: planB }];
      },
      {
        maxSteps: 100,
        expectedQuestions: 0,
        reviewExpectedCriteria: frozen,
        onQueued: async ({ jobId }) => {
          firstJobId = jobId;
        },
      },
    );
    expect(first.calls).toBe(3);
    expect(first.imageReviews).toBe(0);
    expect(first.current.progress.phase).toBe("waiting_requirements");
    expect(first.current.progress.plan).toEqual({ ...planB, criteria: frozen });
    const paused = JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("id", "=", first.jobId)
          .executeTakeFirstOrThrow()
      ).result,
    );
    expect(paused.checkpoint.plan).toEqual({ ...planB, criteria: frozen });
    expect(returnedPlans).toHaveLength(2);
    let secondJobId = "";
    const second = await runFailedBatch(
      seed,
      async (body, step) => {
        if (step === 1)
          return [
            {
              name: "image_batch",
              args: { action: "resume", jobId: first.jobId },
            },
          ];
        if (step === 2) return [{ name: "task_plan", args: planC }];
        if (step === 3) {
          expect(JSON.parse(lastTool(body, "task_plan"))).toEqual({
            saved: true,
            plan: { ...planC, criteria: frozen },
          });
          return [viewSourceAndSaved(seed.saved.assetId)];
        }
        if (step === 4) {
          await expectActualFixtureFrames(body, 2);
          return [
            {
              name: "image_batch",
              args: {
                action: "review",
                review: {
                  referenceImageId: page(),
                  assetId: seed.saved.assetId,
                  passed: true,
                  evidence:
                    "The actual source and saved candidate pair was viewed; request independent verification",
                },
              },
            },
          ];
        }
        if (step === 5) {
          expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
            reviewOutcome: {
              referenceImageId: page(),
              assetId: seed.saved.assetId,
              actualPassed: false,
            },
          });
          const current = await storedBatch(secondJobId);
          expect(current.reviews[page()]).toMatchObject({
            assetId: seed.saved.assetId,
            passed: false,
          });
          expect(current.reviews[page()]!.evidence).toContain(
            "Independent fixture judge still rejects the requested edit",
          );
          return [{ name: "image_batch", args: { action: "advance" } }];
        }
        expect(step).toBe(6);
        expect(lastTool(body, "image_batch")).toContain(
          "当前书册还有 1 页未通过验收",
        );
        expect((await storedBatch(secondJobId)).current).toBe(0);
        return [];
      },
      {
        maxSteps: 100,
        reviewExpectedCriteria: frozen,
        onQueued: async ({ jobId }) => {
          secondJobId = jobId;
        },
      },
    );
    expect(second.calls).toBe(6);
    expect(second.imageReviews).toBe(1);
    expect(returnedPlans).toHaveLength(3);
    const current = await storedBatch(second.jobId);
    expect(current.requirements).toEqual(requirementsBefore);
    expect(current.attemptScope).toEqual(attemptScopeBefore);
    expect(current.current).toBe(0);
    expect(current.reviews[page()]).toMatchObject({
      assetId: seed.saved.assetId,
      passed: false,
    });
    expect(second.current.progress.plan).toEqual({
      ...planC,
      criteria: frozen,
    });
    const saved = JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("id", "=", second.jobId)
          .executeTakeFirstOrThrow()
      ).result,
    );
    expect(saved.checkpoint.plan).toEqual({ ...planC, criteria: frozen });
    for (const body of second.imageReviewBodies) {
      const parts = body.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const source = parts.find(
        (part: any) =>
          part.type === "text" &&
          part.text.startsWith(
            "【最高验收依据：用户原始要求及亲自确认的澄清】\n",
          ),
      );
      expect(JSON.parse(source.text.split("\n").slice(1).join("\n"))).toEqual([
        requirementsBefore.original.text,
      ]);
      const reviewText = JSON.stringify(body.messages);
      for (const plan of [planA, planB, planC])
        for (const criterion of plan.criteria)
          expect(reviewText).not.toContain(criterion);
    }
    expect(seed.paid()).toBe(1);
    expect(
      (await imageCalls()).filter((call) => call.callKind === "image"),
    ).toEqual(paidBefore);
    expect(
      await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
    ).toEqual(operationsBefore);
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(assetsBefore);
  },
);

it("rejects a missing requests source as a repairable tool parameter and queries explicit authorized sources without asking the user or generating", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const before = await db.selectFrom("ai_operations").selectAll().orderBy("id").execute();
  const run = await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [{ name: "image_batch", args: { action: "requests" } }];
    if (step === 2) {
      const feedback = lastTool(body, "image_batch");
      expect(feedback).toContain("缺少必填sources参数");
      expect(feedback).toContain("不是用户尚未授权");
      expect(feedback).toContain("session_attachments");
      return [{ name: "image_batch", args: { action: "requests", sources: batch.books.map(book => book.source) } }];
    }
    const listing = JSON.parse(lastTool(body, "image_batch"));
    expect(listing.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: originalJobId, allDocuments: expect.objectContaining({
        available: true, targetSources: [expect.objectContaining({ source: batch.books[0]!.source })],
      }) }),
    ]));
    return [];
  }, { emptyText: "Only the explicit original request was queried.", expectedQuestions: 0 });
  expect(run.calls).toBe(3);
  expect(seed.paid()).toBe(0);
  expect(run.current.progress.questions?.length ?? 0).toBe(0);
  expect(await db.selectFrom("ai_operations").selectAll().orderBy("id").execute()).toEqual(before);
});

it("keeps a failed all-document start from bypassing its ledger, then accepts the corrected original request without fake clarification", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const original = structuredClone(await storedBatch(originalJobId));
  const source = batch.books[0]!.source;
  sessionId = await session();
  let currentJobId = "";
  const run = await runFailedBatch(seed, (body, step) => {
    const start = { action: "start", taskJobId: currentJobId, scope: "all-documents", sources: [source] };
    if (step === 1) return [{ name: "task_plan", args: {
      goal: "Complete every page of the attached book", steps: ["Process every page and verify every saved result"],
      criteria: ["Every page is saved and independently accepted"], mode: "deliver",
    } }];
    if (step === 2) return [{ name: "image_batch", args: { ...start, clarifications: [{ jobId: currentJobId, scope: "batch" }] } }];
    if (step === 3) {
      expect(lastTool(body, "image_batch")).toContain("原始taskJobId不能同时作为后续澄清jobId");
      return [regenerate(1)];
    }
    if (step === 4) {
      expect(lastTool(body, "image_edit")).toContain("不能绕过失败改用普通图片工具交付单页");
      return [{ name: "image_batch", args: start }];
    }
    if (step === 5) expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
      version: 5, complete: false, current: expect.objectContaining({ filename: "fixture.pdf" }),
    });
    return [];
  }, {
    request: { text: "Complete every page of the attached PDF.", attachments: [source.assetId!] },
    emptyText: "The full scope is bound; no unfinished page is claimed as delivered.",
    expectedQuestions: 0, expectedStatus: "failed",
    onQueued: async ({ jobId }) => { currentJobId = jobId; },
  });
  expect(seed.paid()).toBe(0);
  expect(await storedBatch(originalJobId)).toEqual(original);
  const corrected = await storedBatch(run.jobId);
  expect(corrected.version).toBe(5);
  expect(corrected.requirements.original.jobId).toBe(currentJobId);
  expect(corrected.requirements.clarifications).toEqual([]);
  expect(corrected.delivered).toEqual({});
  expect(run.current.error).toContain("没有新增交付");
});

it.each([false, true])("host binds every original document before an executor can bypass a missing or failed batch start (failedStart=%s)", async (failedStart) => {
  const seed = await seedFailedDelivery("reference-export");
  const source = batch.books[0]!.source;
  const original = structuredClone(await storedBatch(originalJobId));
  sessionId = await session();
  let receivedBoundBatch = false;
  let currentJobId = "";
  const run = await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [regenerate(1)];
    if (step === 2) {
      expect(lastTool(body, "image_edit")).toContain("先用task_plan");
      return [{ name: "task_plan", args: {
        goal: "Complete every page of the attached book", steps: ["Edit or export every page, then verify"],
        criteria: ["Every original page is delivered and independently accepted"], mode: "deliver",
      } }];
    }
    if (step === 3) return failedStart ? [{ name: "image_batch", args: {
      action: "start", taskJobId: currentJobId, scope: "all-documents",
      sources: [{ fileId: randomUUID() }],
    } }] : [regenerate(1)];
    if (step === 4 && failedStart) {
      expect(lastTool(body, "image_batch")).toBe("文件不存在");
      return [regenerate(1)];
    }
    if (step === (failedStart ? 5 : 4)) {
      expect(JSON.parse(lastTool(body, "image_edit"))).toMatchObject({
        kind: "image_batch_started", imageGenerationPaid: false,
        batch: { version: 5, complete: false },
      });
      receivedBoundBatch = true;
    }
    return [];
  }, { request: { text: "Complete every page of the attached PDF.", attachments: [source.assetId!] },
    imageTaskRoute: "all-document-pages", expectedQuestions: 0, expectedStatus: "failed",
    emptyText: "No partial sample is claimed as the completed book.",
    onQueued: async ({ jobId }) => { currentJobId = jobId; },
  });
  expect(receivedBoundBatch).toBe(true);
  expect(run.calls).toBeGreaterThanOrEqual(failedStart ? 5 : 4);
  expect(run.current.error).toContain("没有新增交付");
  expect(seed.paid()).toBe(0);
  expect(await storedBatch(originalJobId)).toEqual(original);
  const bound = await storedBatch(run.jobId);
  expect(bound.books.map(book => book.source)).toEqual([source]);
  expect(bound.requirements.original.jobId).toBe(run.jobId);
  expect(bound.delivered).toEqual({});
});

it("an explicitly selected page remains an ordinary task and can export without registering all document pages", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const source = batch.books[0]!.source;
  const original = structuredClone(await storedBatch(originalJobId));
  const run = await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [{ name: "image_export", args: {
      referenceImageId: page(), filename: "selected-page.png",
    } }];
    if (step === 2) expect(JSON.parse(lastTool(body, "image_export"))).toMatchObject({
      ready: true, filename: "selected-page.png",
    });
    return [];
  }, { request: { text: "Export only the selected first page, using the PDF as source.", attachments: [source.assetId!] },
    imageTaskRoute: "ordinary", emptyText: "The selected page was exported.", expectedQuestions: 0 });
  expect(run.calls).toBe(2);
  expect(seed.paid()).toBe(0);
  expect(run.current.checkpoint?.imageBatch).toBeUndefined();
  expect(await storedBatch(originalJobId)).toEqual(original);
});

it("retains the ordinary non-batch task_plan guard and permits only step updates with the original criteria", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const originalSessionId = sessionId;
  sessionId = await session();
  expect(sessionId).not.toBe(originalSessionId);
  const planA = {
    goal: "Inspect the requested ordinary task",
    steps: ["Read the request", "Verify every requested result"],
    criteria: ["Preserve every originally requested result"],
    mode: "deliver" as const,
  };
  const weaker = {
    ...planA,
    goal: "Return a sample instead",
    steps: ["Return any sample"],
    criteria: ["A sample is sufficient"],
  };
  const updated = {
    ...planA,
    goal: "Verify the ordinary task in its original full scope",
    steps: ["Inspect each saved result", "Report the actual remaining work"],
  };
  let activeJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [{ name: "task_plan", args: planA }];
      if (step === 2) {
        expect(JSON.parse(lastTool(body, "task_plan"))).toEqual({
          saved: true,
          plan: planA,
        });
        return [{ name: "task_plan", args: weaker }];
      }
      if (step === 3) {
        expect(JSON.parse(lastTool(body, "task_plan"))).toEqual({
          error:
            "本轮验收标准已记录，不能自行放宽。请保留原标准，只更新执行步骤。",
        });
        const saved = JSON.parse(
          (
            await db
              .selectFrom("ai_jobs")
              .select("result")
              .where("id", "=", activeJobId)
              .executeTakeFirstOrThrow()
          ).result,
        );
        expect(saved.progress.plan).toEqual(planA);
        expect(saved.checkpoint.plan).toEqual(planA);
        expect(saved.checkpoint.imageBatch).toBeUndefined();
        return [{ name: "task_plan", args: updated }];
      }
      expect(step).toBe(4);
      expect(JSON.parse(lastTool(body, "task_plan"))).toEqual({
        saved: true,
        plan: updated,
      });
      return [];
    },
    {
      onQueued: async ({ jobId }) => {
        activeJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(4);
  expect(run.imageReviews).toBe(0);
  expect(run.current.progress.plan).toEqual(updated);
  expect(seed.paid()).toBe(0);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(0);
});
const segmentPart = (
  label: string,
): segmentationModule.ImageMaskSegmentInput => ({
  source: { kind: "reference", referenceImageId: page() },
  targets: [
    {
      label,
      box: [0, 0, 1, 1],
      positivePoints: [[0.25, 0.25]],
      negativePoints: [[0, 0]],
    },
  ],
  exclusions: [],
});
function segmentationPixels(right = 40) {
  const pixels = Buffer.alloc(80 * 60);
  for (let y = 12; y < 36; y++)
    for (let x = 16; x < right; x++) pixels[y * 80 + x] = 255;
  return pixels;
}
async function isolatedSegmentation(
  pixels: (input: segmentationModule.ImageMaskSegmentInput) => Buffer = () =>
    segmentationPixels(),
): Promise<SegmentationProfileStatus> {
  const profile = await fixtureSegmentationProfile(root);
  const prepare = segmentationModule.prepareImageMaskSegment;
  vi.spyOn(segmentationModule, "prepareImageMaskSegment").mockImplementation(
    (database, context, input, operationId, options) =>
      prepare(database, context, input, operationId, {
        ...options,
        worker: fixtureSegmentationWorker(pixels(input)),
      }),
  );
  return { status: "ready", profile };
}

async function seedSegmentProposals(
  inputs: segmentationModule.ImageMaskSegmentInput[],
) {
  const profile = await isolatedSegmentation();
  if (profile.status !== "ready")
    throw Error("Fixture segmentation must be ready");
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const receipts = [];
  for (const input of inputs)
    receipts.push(
      await segmentationModule.prepareImageMaskSegment(
        db,
        ctx,
        input,
        randomUUID(),
        { profile: profile.profile, storage: runtime() },
      ),
    );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  return { profile, receipts };
}

const segmentView = (proposalReceiptId: string): RunnerTool => ({
  name: "image_mask_segment_view",
  args: { proposalReceiptId },
});
const maskFromProposals = (
  generationOperationId: string,
  source: string[],
  generated: string[] = [],
): RunnerTool => {
  const selection = (proposalIds: string[] = []) => ({
    proposalIds,
    include: [],
    exclude: [],
  });
  return {
    name: "image_mask_prepare",
    args: {
      generationOperationId,
      referenceImageId: page(),
      sourceTarget: selection(source),
      generatedTarget: selection(generated),
      protected: selection(),
      allowedOcclusion: selection(),
      textEdits: selection(),
    },
  };
};

it("reads old-job source and raw proposals as two actual frames without a worker, then prepares and composes in later one-step fragments", async () => {
  const seed = await seedFailedDelivery();
  const prepared = await seedSegmentProposals([
    segmentPart("persisted source"),
    {
      ...segmentPart("persisted raw"),
      source: { kind: "raw", generationOperationId: seed.providerOperationId },
    },
  ]);
  const [source, raw] = prepared.receipts;
  const worker = vi.mocked(segmentationModule.prepareImageMaskSegment);
  expect(worker).toHaveBeenCalledTimes(2);
  let maskReceiptId = "";
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [segmentView(raw!.receiptId)];
      if (step === 3) {
        expect(lastTool(body, "image_mask_segment_view")).toContain(
          "先单独 image_candidate_view",
        );
        return [candidateView(seed.providerOperationId)];
      }
      if (step === 4) return [segmentView(source!.receiptId)];
      if (step === 5) {
        expect(mediaToolFacts(body, "image_mask_segment_view")).toMatchObject({
          proposalReceiptId: source!.receiptId,
          usable: true,
          generationOperationId: null,
        });
        return [
          segmentView(raw!.receiptId),
          maskFromProposals(
            seed.providerOperationId,
            [source!.receiptId],
            [raw!.receiptId],
          ),
        ];
      }
      if (step === 6) {
        expect(lastTool(body, "image_mask_prepare")).toContain("后续模型轮次");
        expect(mediaToolFacts(body, "image_mask_segment_view")).toMatchObject({
          proposalReceiptId: raw!.receiptId,
          usable: true,
          generationOperationId: seed.providerOperationId,
        });
        return [
          maskFromProposals(
            seed.providerOperationId,
            [source!.receiptId],
            [raw!.receiptId],
          ),
        ];
      }
      if (step === 7) {
        maskReceiptId = mediaToolFacts(
          body,
          "image_mask_prepare",
        ).maskReceiptId;
        return [
          {
            name: "image_mask_compose",
            args: {
              maskReceiptId,
              generationOperationId: seed.providerOperationId,
              referenceImageId: page(),
              filename: "reread-existing-proposals.png",
            },
          },
        ];
      }
      expect(step).toBe(8);
      expect(mediaToolFacts(body, "image_mask_compose")).toMatchObject({
        ready: true,
      });
      return [];
    },
    { maxSteps: 1, segmentationProfile: prepared.profile },
  );
  expect(worker).toHaveBeenCalledTimes(2);
  expect(seed.paid()).toBe(1);
  const operations = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  ).map((row) => JSON.parse(row.result));
  expect(operations.some((row) => row.kind === "image_mask_segment")).toBe(
    false,
  );
  expect(
    operations.find((row) => row.origin === "local-recomposition").editMask
      .receiptId,
  ).toBe(maskReceiptId);
  for (const index of [4, 5, 6])
    expect(
      run.bodies[index]!.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      ).filter((part: any) => part.type === "image_url"),
    ).toHaveLength(2);
});

it("withholds both frames of a third parallel segment viewer and rejects its mask until a complete later read", async () => {
  const seed = await seedFailedDelivery();
  const prepared = await seedSegmentProposals([
    segmentPart("A"),
    segmentPart("B"),
    segmentPart("C"),
  ]);
  const third = prepared.receipts[2]!;
  const worker = vi.mocked(segmentationModule.prepareImageMaskSegment);
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [candidateView(seed.providerOperationId)];
      if (step === 3)
        return prepared.receipts.map((receipt) =>
          segmentView(receipt.receiptId),
        );
      if (step === 4) {
        expect(
          mediaToolFacts(body, "image_mask_segment_view").proposalReceiptId,
        ).toBe(third.receiptId);
        expect(lastTool(body, "image_mask_segment_view")).toContain(
          "尚未传入本轮视觉输入",
        );
        expect(
          body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url"),
        ).toHaveLength(4);
        return [maskFromProposals(seed.providerOperationId, [third.receiptId])];
      }
      if (step === 5) {
        expect(lastTool(body, "image_mask_prepare")).toContain("实际完整查看");
        return [segmentView(third.receiptId)];
      }
      if (step === 6)
        return [maskFromProposals(seed.providerOperationId, [third.receiptId])];
      expect(step).toBe(7);
      expect(
        mediaToolFacts(body, "image_mask_prepare").diagnostics.safeToCompose,
      ).toBe(true);
      return [];
    },
    { maxSteps: 1, segmentationProfile: prepared.profile },
  );
  expect(run.calls).toBe(7);
  expect(worker).toHaveBeenCalledTimes(3);
  expect(seed.paid()).toBe(1);
  const operations = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  ).map((row) => JSON.parse(row.result));
  expect(
    operations.filter((row) => row.kind === "image_edit_mask"),
  ).toHaveLength(1);
  expect(operations.some((row) => row.kind === "image_mask_segment")).toBe(
    false,
  );
});

it(
  "repeated read-only views of the same proposal cannot extend three stagnant batch fragments or create segmentation receipts",
  { timeout: 60_000 },
  async () => {
    const seed = await seedFailedDelivery("reference-export");
    const prepared = await seedSegmentProposals([
      segmentPart("persisted selection"),
    ]);
    const worker = vi.mocked(segmentationModule.prepareImageMaskSegment);
    const run = await runFailedBatch(
      seed,
      (_body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        expect(step).toBeLessThanOrEqual(49);
        return [segmentView(prepared.receipts[0]!.receiptId)];
      },
      {
        maxSteps: 100,
        segmentationProfile: prepared.profile,
        expectedStatus: "failed",
        expectedQuestions: 0,
        terminalDeadlineMs: 30_000,
      },
    );
    expect(run.current.error).toContain("连续三个执行分片");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(run.calls).toBeGreaterThan(12);
    expect(run.calls).toBeLessThanOrEqual(49);
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("job_id", "=", run.jobId)
        .execute(),
    ).toHaveLength(0);
    expect(seed.paid()).toBe(0);
  },
);

it("repeated complete views of an existing safe mask stop after three stagnant fragments without new operations, segmentation or image fees", async () => {
  const seed = await seedFailedDelivery();
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const empty = () => ({ proposalIds: [], include: [], exclude: [] });
  const mask = await prepareImageEditMask(
    db,
    ctx,
    {
      referenceImageId: page(),
      generationOperationId: seed.providerOperationId,
      sourceTarget: { ...empty(), include: repairRegions },
      generatedTarget: empty(),
      protected: empty(),
      allowedOcclusion: empty(),
      textEdits: empty(),
    },
    randomUUID(),
    { storage: runtime() },
  );
  expect(mask.diagnostics.safeToCompose).toBe(true);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  const before = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const assets = await db
    .selectFrom("assets")
    .selectAll()
    .orderBy("id")
    .execute();
  const workers = vi.spyOn(segmentationModule, "prepareImageMaskSegment");
  const imageFetch = vi.fn(async () => {
    throw Error("Read-only mask views must not submit images");
  });
  const run = await runFailedBatch(
    { ...seed, imageFetch },
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [candidateView(seed.providerOperationId)];
      const frames = body.messages
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((part: any) => part.type === "image_url");
      if (step === 3) expect(frames).toHaveLength(3);
      else {
        expect(frames).toHaveLength(2);
        expect(mediaToolFacts(body, "image_mask_view")).toMatchObject({
          maskReceiptId: mask.receiptId,
          digest: mask.digest,
          version: 2,
          readonly: true,
          diagnostics: { safeToCompose: true },
        });
      }
      expect(step).toBeLessThanOrEqual(7);
      return [
        { name: "image_mask_view", args: { maskReceiptId: mask.receiptId } },
      ];
    },
    { maxSteps: 1, expectedStatus: "failed", expectedQuestions: 0 },
  );
  expect(run.calls).toBe(7);
  expect(run.current.error).toContain("连续三个执行分片");
  expect(imageFetch).not.toHaveBeenCalled();
  expect(workers).not.toHaveBeenCalled();
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(before);
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(assets);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(1);
  const checkpoint = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  expect(checkpoint.round).toBe(0);
  expect(checkpoint.imageBatch.attemptScope).toEqual(batch.attemptScope);
  expect(checkpoint.imageBatch.delivered).toEqual(batch.delivered);
});

it("runner exposes only reads for a completed batch and returns latest real file nodes with full session links", async () => {
  const seed = await seedCompletedBatch();
  const resourceWrites = vi.spyOn(
    sessionResourcesModule,
    "recordSessionResource",
  );
  let latestDeliveries: any[] = [];
  const latestAssetIds = Object.values(batch.delivered);
  const actualFiles = await db
    .selectFrom("file_items")
    .select(["id", "storage_object_id", "name", "mime"])
    .where("owner_id", "=", owner.id)
    .where("parent_type", "=", "system")
    .where("parent_id", "=", "ai")
    .where("storage_object_id", "in", latestAssetIds)
    .execute();
  expect(actualFiles).toHaveLength(3);
  const operationsBefore = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const result = await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    const names = body.tools.map((tool: any) => tool.function.name);
    for (const name of [
      "image_generate",
      "image_reference_generate",
      "image_edit",
      "image_recompose",
      "image_mask_prepare",
      "image_mask_compose",
      "image_mask_segment",
      "image_mask_segment_view",
      "image_export",
      "image_candidate_view",
      "image_edit_preview",
    ])
      expect(names).not.toContain(name);
    for (const name of [
      "image_batch",
      "image_show",
      "file_read",
      "file_browse",
    ])
      expect(names).toContain(name);
    const status = JSON.parse(lastTool(body, "image_batch"));
    expect(status.complete).toBe(true);
    expect(status.current).toBeNull();
    expect(status.deliveries).toHaveLength(3);
    expect(status.deliveryPresentation).toMatchObject({
      kind: "native-file-cards",
      count: 3,
      instruction: expect.stringContaining("无需复述"),
    });
    latestDeliveries = status.deliveries;
    for (const [index, item] of status.deliveries.entries()) {
      const referenceImageId = page(index);
      const file = actualFiles.find(
        (file) => file.storage_object_id === batch.delivered[referenceImageId],
      )!;
      expect(item).toMatchObject({
        bookIndex: 1,
        physicalPage: index + 1,
        referenceImageId,
        assetId: batch.delivered[referenceImageId],
        sourcePageFilename: `page-${index + 1}.png`,
        fileId: file.id,
        name: file.name,
        mime: file.mime,
        reviewPassed: true,
        contentUrl: `/api/v1/files/items/${file.id}/content`,
        downloadUrl: `/api/v1/files/items/${file.id}/content?download=1`,
      });
      const url = new URL(item.href.slice(1), "https://doca.invalid");
      expect(url.pathname).toBe("/files");
      expect(url.searchParams.get("focus")).toBe(file.id);
      expect(url.searchParams.get("session")).toBe(sessionId);
      expect(JSON.parse(url.searchParams.get("path")!)).toEqual([
        { type: "system", id: "ai", name: "AI 助手" },
        {
          type: "system",
          id: `ai-session:${sessionId}`,
          name: "Isolated image attempt scope",
        },
      ]);
      expect(item.href).not.toContain("#/r/");
      expect(item).not.toHaveProperty("url");
      expect(item).not.toHaveProperty("filename");
    }
    expect(status.deliveries[1].name).toBe("latest-page-2.png");
    expect(JSON.stringify(status.deliveries)).not.toContain(
      "obsolete-page-2.png",
    );
    if (step === 2)
      return [{ name: "image_batch", args: { action: "status" } }];
    expect(step).toBe(3);
    return [];
  });
  expect(result.calls).toBe(3);
  const cards = result.current.progress.events.filter(
    (event: any) => event.file,
  );
  expect(cards).toHaveLength(3);
  for (const [index, card] of cards.entries()) {
    const delivery = latestDeliveries[index]!;
    expect(card.id).toBe(`file-${delivery.fileId}`);
    expect(card.status).toBe("success");
    expect(card.file).toEqual({
      id: delivery.fileId,
      name: delivery.name,
      path: delivery.path,
      href: delivery.href,
      downloadUrl: delivery.downloadUrl,
      mime: delivery.mime,
    });
  }
  expect(JSON.stringify(cards)).not.toContain("obsolete-page-2.png");
  expect(
    resourceWrites.mock.calls.filter((call) => call[3].kind === "file"),
  ).toHaveLength(3);
  expect(seed.paid()).toBe(0);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(0);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(operationsBefore);
});

it("completed native cards update changed real file names and folder links but identical repeated status performs no additional file publications", async () => {
  const seed = await seedCompletedBatch();
  const changedFile = await db
    .selectFrom("file_items")
    .select("id")
    .where("storage_object_id", "=", batch.delivered[page(1)]!)
    .executeTakeFirstOrThrow();
  const operationsBefore = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const resourceWrites = vi.spyOn(
    sessionResourcesModule,
    "recordSessionResource",
  );
  let deliveries: any[] = [];
  const result = await runFailedBatch(seed, async (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    const status = JSON.parse(lastTool(body, "image_batch"));
    expect(status.complete).toBe(true);
    expect(status.deliveryPresentation.count).toBe(3);
    if (step === 2) {
      expect(
        resourceWrites.mock.calls.filter((call) => call[3].kind === "file"),
      ).toHaveLength(3);
      await db
        .updateTable("file_items")
        .set({ name: "renamed-latest-page-2.png" })
        .where("id", "=", changedFile.id)
        .execute();
      await db
        .updateTable("ai_sessions")
        .set({ title: "Renamed delivery session" })
        .where("id", "=", sessionId)
        .execute();
      return [{ name: "image_batch", args: { action: "status" } }];
    }
    deliveries = status.deliveries;
    expect(deliveries[1].name).toBe("renamed-latest-page-2.png");
    for (const delivery of deliveries) {
      expect(delivery.path).toContain("Renamed delivery session");
      const url = new URL(delivery.href.slice(1), "https://doca.invalid");
      expect(JSON.parse(url.searchParams.get("path")!).at(-1).name).toBe(
        "Renamed delivery session",
      );
    }
    expect(
      resourceWrites.mock.calls.filter((call) => call[3].kind === "file"),
    ).toHaveLength(6);
    if (step === 3)
      return [{ name: "image_batch", args: { action: "status" } }];
    expect(step).toBe(4);
    return [];
  });
  expect(result.calls).toBe(4);
  const cards = result.current.progress.events.filter(
    (event: any) => event.file,
  );
  expect(cards).toHaveLength(3);
  expect(cards.map((event: any) => event.file)).toEqual(
    deliveries.map((delivery) => ({
      id: delivery.fileId,
      name: delivery.name,
      path: delivery.path,
      href: delivery.href,
      downloadUrl: delivery.downloadUrl,
      mime: delivery.mime,
    })),
  );
  expect(cards.every((event: any) => event.status === "success")).toBe(true);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(operationsBefore);
  expect(seed.paid()).toBe(0);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(0);
});

it.each(["review-first", "edit-first"])(
  "runner blocks a hidden paid edit emitted with a completed-batch negative review in %s order and permits repair only in a later request",
  async (order) => {
    const seed = await seedCompletedBatch();
    const negativeReview: RunnerTool = {
      name: "image_batch",
      args: {
        action: "review",
        review: {
          referenceImageId: page(),
          assetId: seed.saved.assetId,
          passed: false,
          evidence: "A newly identified visible defect requires repair",
        },
      },
    };
    const operationsBefore = await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute();
    const run = await runFailedBatch(seed, async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      const names = body.tools.map((tool: any) => tool.function.name);
      if (step === 2) {
        expect(names).not.toContain("image_edit");
        expect(JSON.parse(lastTool(body, "image_batch")).complete).toBe(true);
        const parallel = [negativeReview, regenerate(2)];
        return order === "review-first" ? parallel : parallel.reverse();
      }
      if (step === 3) {
        expect(names).toContain("image_edit");
        expect(seed.paid()).toBe(0);
        expect(
          (await imageCalls()).filter((call) => call.callKind === "image"),
        ).toHaveLength(0);
        expect(lastTool(body, "image_edit")).toContain(
          "该模型请求开始时整批已完成",
        );
        const reopened = JSON.parse(lastTool(body, "image_batch"));
        expect(reopened.complete).toBe(false);
        expect(reopened.current.filename).toBe("fixture.pdf");
        expect(reopened.delivered[page()]).toBe(seed.saved.assetId);
        expect(
          await db
            .selectFrom("ai_operations")
            .selectAll()
            .orderBy("id")
            .execute(),
        ).toEqual(operationsBefore);
        return [regenerate(3)];
      }
      if (step === 4) {
        expect(seed.paid()).toBe(0);
        expect(JSON.parse(lastTool(body, "image_edit")).kind).toBe("image_scene_analysis");
        return [regenerate(4)];
      }
      expect(step).toBe(5);
      expect(seed.paid()).toBe(1);
      expect(lastTool(body, "image_edit")).not.toContain(
        "该模型请求开始时整批已完成",
      );
      return [];
    });
    expect(run.calls).toBe(5);
    expect(seed.paid()).toBe(1);
    expect(
      (await imageCalls()).filter((call) => call.callKind === "image"),
    ).toHaveLength(1);
    const stored = JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("id", "=", run.jobId)
          .executeTakeFirstOrThrow()
      ).result,
    ).checkpoint.imageBatch;
    expect(stored.current).toBe(0);
    expect(stored.attemptScope).toEqual(batch.attemptScope);
    expect(stored.delivered[page()]).not.toBe(seed.saved.assetId);
    expect(stored.delivered[page(1)]).toBe(batch.delivered[page(1)]);
    expect(stored.delivered[page(2)]).toBe(batch.delivered[page(2)]);
  },
);

it("runner closes a completed scope restored in the same request before a negative review and hidden edit, then permits the later repair", async () => {
  const seed = await seedCompletedBatch();
  const negativeReview: RunnerTool = {
    name: "image_batch",
    args: {
      action: "review",
      review: {
        referenceImageId: page(),
        assetId: seed.saved.assetId,
        passed: false,
        evidence: "Newly reported defect in the latest delivery",
      },
    },
  };
  const before = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const run = await runFailedBatch(seed, async (body, step) => {
    if (step === 1) return [resumeFailedBatch(), negativeReview, regenerate(2)];
    if (step === 2) {
      expect(seed.paid()).toBe(0);
      expect(lastTool(body, "image_edit")).toContain(
        "该模型请求开始时整批已完成",
      );
      expect(
        await db
          .selectFrom("ai_operations")
          .selectAll()
          .orderBy("id")
          .execute(),
      ).toEqual(before);
      const status = JSON.parse(lastTool(body, "image_batch"));
      expect(status.complete).toBe(false);
      expect(status.attemptScope).toEqual(batch.attemptScope);
      expect(body.tools.map((tool: any) => tool.function.name)).toContain(
        "image_edit",
      );
      return [regenerate(3)];
    }
    if (step === 3) {
      expect(seed.paid()).toBe(0);
      expect(JSON.parse(lastTool(body, "image_edit")).kind).toBe("image_scene_analysis");
      return [regenerate(4)];
    }
    expect(step).toBe(4);
    expect(seed.paid()).toBe(1);
    return [];
  });
  expect(run.calls).toBe(4);
  expect(seed.paid()).toBe(1);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(1);
});

it.each([false, true])("exports the exact original over a rejected mistaken edit but retains an accepted current result (accepted=%s)", async (accepted) => {
  const seed = await seedFailedDelivery("provider", "#dd0000");
  if (accepted) {
    batch.reviews[page()]!.passed = true;
    await attachBatch(ctx);
  }
  const callsBefore = (await imageCalls()).filter(call => call.callKind === "image");
  const operationsBefore = await db.selectFrom("ai_operations").selectAll().execute();
  const run = await runFailedBatch(seed, (_body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [{ name: "image_export", args: {
      referenceImageId: page(), filename: "unchanged-original.png",
    } }];
    expect(step).toBe(3);
    return [];
  }, { independentImageReview: true });
  const current = await storedBatch(run.jobId);
  const chosen = current.delivered[page()]!;
  expect(seed.paid()).toBe(1);
  expect((await imageCalls()).filter(call => call.callKind === "image")).toEqual(callsBefore);
  expect(current.attemptScope).toEqual(batch.attemptScope);
  expect(current.reviews[page()]!.passed).toBe(true);
  for (const before of operationsBefore)
    expect(await db.selectFrom("ai_operations").selectAll().where("id", "=", before.id).executeTakeFirstOrThrow()).toEqual(before);
  expect(chosen === seed.saved.assetId).toBe(accepted);
  const asset = await db.selectFrom("assets").selectAll().where("id", "=", chosen).executeTakeFirstOrThrow();
  const profile = await db.selectFrom("storage_profiles").selectAll().where("id", "=", asset.profile_id).executeTakeFirstOrThrow();
  const savedBytes = await storageModule.createStorage(runtime()).read(
    storageModule.storageConfigForProfile(runtime(), profile), asset.object_key,
  );
  const pixels = await sharp(Buffer.from(savedBytes)).removeAlpha().raw().toBuffer();
  const expected = accepted ? [221, 0, 0] : [51, 102, 153];
  for (let i = 0; i < pixels.length; i++) expect(pixels[i]).toBe(expected[i % 3]);
  expect(run.imageReviews).toBe(accepted ? 0 : 1);
  expect((await db.selectFrom("assets").selectAll().where("id", "=", seed.saved.assetId).executeTakeFirstOrThrow()).deleted_at).toBeNull();
});

it("one queued message completes more than three maxSteps=1 execution fragments with real exports, views and independent per-page reviews in the original scope", async () => {
  const seed = await seedFailedDelivery("reference-export");
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const obsolete = await generateImageAsset(
    db,
    ctx,
    { ...input(1, 1), filename: "obsolete-before-drain.png" },
    randomUUID(),
    { ...settings(seed.imageFetch), exportOnly: true },
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  const resourceWrites = vi.spyOn(
    sessionResourcesModule,
    "recordSessionResource",
  );
  const originalScope = structuredClone(batch.attemptScope);
  const savedByPage: string[] = [seed.saved.assetId];
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      const request = JSON.stringify(body.messages);
      expect(request).toContain("Complete the original book");
      expect(request).toContain("Requested visible edit");
      expect(request).toContain("继续同一批次，诊断并修复最新失败候选");
      if (step === 2) return []; // Premature text completion is not delivery.
      if ([3, 6, 9].includes(step)) {
        const index = [3, 6, 9].indexOf(step);
        if (index)
          savedByPage[index] = JSON.parse(
            lastTool(body, "image_export"),
          ).assetId;
        return [
          {
            name: "image_view",
            args: { referenceImageIds: [page(index), savedByPage[index]] },
          },
        ];
      }
      if ([4, 7, 10].includes(step)) {
        const index = [4, 7, 10].indexOf(step);
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(index),
                assetId: savedByPage[index],
                passed: true,
                evidence: "Source and latest saved pixels were actually viewed",
              },
            },
          },
        ];
      }
      if ([5, 8].includes(step)) {
        const index = step === 5 ? 1 : 2;
        return [
          {
            name: "image_export",
            args: {
              referenceImageId: page(index),
              filename: `drained-${index + 1}.png`,
            },
          },
        ];
      }
      if (step === 11)
        return [{ name: "image_batch", args: { action: "advance" } }];
      if (step === 12) {
        expect(body.tools.map((tool: any) => tool.function.name)).not.toContain(
          "image_edit",
        );
        return [{ name: "image_batch", args: { action: "status" } }];
      }
      expect(step).toBe(13);
      expect(JSON.parse(lastTool(body, "image_batch")).complete).toBe(true);
      expect(
        JSON.parse(lastTool(body, "image_batch")).deliveryPresentation.count,
      ).toBe(3);
      return [];
    },
    {
      maxSteps: 1,
      emptyText: "三页成果已完成，请读取实际文件链接。",
      independentImageReview: true,
      expectedQuestions: 0,
    },
  );
  expect(run.calls).toBe(13);
  expect(run.imageReviews).toBe(3);
  expect(seed.paid()).toBe(0);
  const checkpoint = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  expect(checkpoint.round).toBe(0);
  expect(checkpoint.imageBatch.current).toBe(1);
  expect(checkpoint.imageBatch.attemptScope).toEqual(originalScope);
  expect(Object.values(checkpoint.imageBatch.delivered)).toEqual(savedByPage);
  expect(
    Object.values(checkpoint.imageBatch.reviews).every(
      (review: any) => review.passed,
    ),
  ).toBe(true);
  expect(
    await db
      .selectFrom("file_items")
      .select("id")
      .where("owner_id", "=", owner.id)
      .where("parent_id", "=", "ai")
      .execute(),
  ).toHaveLength(4); // Keep the obsolete file; publish only the three latest nodes.
  const latestFiles = await db
    .selectFrom("file_items")
    .select(["id", "name", "storage_object_id"])
    .where("storage_object_id", "in", savedByPage)
    .execute();
  const cards = run.current.progress.events.filter((event: any) => event.file);
  expect(cards).toHaveLength(3);
  expect(cards.map((event: any) => event.file.id).sort()).toEqual(
    latestFiles.map((file) => file.id).sort(),
  );
  for (const card of cards) {
    const file = latestFiles.find((file) => file.id === card.file.id)!;
    expect(card.status).toBe("success");
    expect(card.file.name).toBe(file.name);
    expect(
      new URL(card.file.href.slice(1), "https://doca.invalid").searchParams.get(
        "focus",
      ),
    ).toBe(file.id);
    expect(card.file.downloadUrl).toBe(
      `/api/v1/files/items/${file.id}/content?download=1`,
    );
  }
  expect(JSON.stringify(cards)).not.toContain("obsolete-before-drain.png");
  expect(savedByPage).not.toContain(obsolete.assetId);
  expect(
    resourceWrites.mock.calls.filter((call) => call[3].kind === "file"),
  ).toHaveLength(3);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(0);
});

it("a maxSteps=100 batch dynamically cuts at twelve completed steps after resume and drains over four fragments to real complete delivery", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const originalScope = structuredClone(batch.attemptScope);
  const saved = [seed.saved.assetId];
  let queuedJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if ([14, 26, 38].includes(step)) {
        const snapshot = JSON.parse(
          (
            await db
              .selectFrom("ai_jobs")
              .select("result")
              .where("id", "=", queuedJobId)
              .executeTakeFirstOrThrow()
          ).result,
        );
        expect(snapshot.checkpoint.round).toBe(0);
        expect(snapshot.checkpoint.imageBatch.attemptScope).toEqual(
          originalScope,
        );
        expect(
          snapshot.progress.events.filter(
            (event: any) => event.code === "shrinking_batch",
          ).length,
        ).toBeGreaterThanOrEqual([14, 26, 38].indexOf(step) + 2);
        if ([26, 38].includes(step)) {
          const index = step === 26 ? 1 : 2;
          // The prior tool exchange may have been fitted out of a new
          // fragment. Recover from the published durable checkpoint, then
          // prove its pointer is the actual saved export for this source.
          expect(
            snapshot.checkpoint.imageBatch.books[0].pages[index]
              .referenceImageId,
          ).toBe(page(index));
          saved[index] = snapshot.checkpoint.imageBatch.delivered[page(index)];
          expect(saved[index]).toEqual(expect.any(String));
          const exports = (
            await db
              .selectFrom("ai_operations")
              .select("result")
              .where("job_id", "=", queuedJobId)
              .where("user_id", "=", owner.id)
              .execute()
          )
            .map((row) => JSON.parse(row.result))
            .filter((result) => result.assetId === saved[index]);
          expect(exports).toHaveLength(1);
          expect(exports[0]).toMatchObject({
            kind: "image_generation",
            state: "saved",
            origin: "reference-export",
            assetId: saved[index],
            filename: `fragment-latest-${step - 1}.png`,
            generation: { referenceImageIds: [page(index)] },
          });
          expect(
            await db
              .selectFrom("assets")
              .select("id")
              .where("id", "=", saved[index]!)
              .where("owner_id", "=", owner.id)
              .executeTakeFirst(),
          ).toEqual({ id: saved[index] });
        }
      }
      if (step === 13)
        return [{ name: "image_view", args: { referenceImageIds: [page()] } }];
      if ([25, 37].includes(step))
        return [
          {
            name: "image_export",
            args: {
              referenceImageId: page(step === 25 ? 1 : 2),
              filename: `fragment-latest-${step}.png`,
            },
          },
        ];
      if (step < 38)
        return [{ name: "image_batch", args: { action: "status" } }];
      if ([38, 40, 42].includes(step))
        return [
          {
            name: "image_view",
            args: {
              referenceImageIds: [
                page((step - 38) / 2),
                saved[(step - 38) / 2],
              ],
            },
          },
        ];
      if ([39, 41, 43].includes(step)) {
        const index = (step - 39) / 2;
        return [
          {
            name: "image_batch",
            args: {
              action: "review",
              review: {
                referenceImageId: page(index),
                assetId: saved[index],
                passed: true,
                evidence: "Actual source and latest saved result were viewed",
              },
            },
          },
        ];
      }
      if (step === 44)
        return [{ name: "image_batch", args: { action: "advance" } }];
      if (step === 45)
        return [{ name: "image_batch", args: { action: "status" } }];
      expect(step).toBe(46);
      expect(JSON.parse(lastTool(body, "image_batch")).complete).toBe(true);
      return [];
    },
    {
      maxSteps: 100,
      emptyText: "完整成果已显示为文件卡片。",
      expectedQuestions: 0,
      independentImageReview: true,
      onQueued: async ({ jobId }) => {
        queuedJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(46);
  expect(run.imageReviews).toBe(3);
  const final = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  expect(final.round).toBe(0);
  expect(final.imageBatch.attemptScope).toEqual(originalScope);
  expect(final.imageBatch.current).toBe(1);
  expect(Object.values(final.imageBatch.delivered)).toEqual(saved);
  expect(
    run.current.progress.events.filter((event: any) => event.file),
  ).toHaveLength(3);
  expect(seed.paid()).toBe(0);
});

it(
  "new segmentation labels and receipt ids with identical validated bitmaps cannot extend three stagnant twelve-step batch fragments",
  { timeout: 60_000 },
  async () => {
    const seed = await seedFailedDelivery("reference-export");
    const profile = await isolatedSegmentation();
    const run = await runFailedBatch(
      seed,
      (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step > 2) {
          const frames = body.messages
            .filter((message: any) => message.role === "user")
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url");
          expect(frames.length).toBeLessThanOrEqual(2);
          if (step === 3) {
            expect(mediaToolFacts(body, "image_mask_segment")).toMatchObject({
              usable: true,
            });
            expect(frames).toHaveLength(2);
          }
        }
        expect(step).toBeLessThanOrEqual(49);
        return [
          {
            name: "image_mask_segment",
            args: segmentPart(`new label ${step}`),
          },
        ];
      },
      {
        maxSteps: 100,
        segmentationProfile: profile,
        expectedStatus: "failed",
        expectedQuestions: 0,
        terminalDeadlineMs: 30_000,
      },
    );
    expect(run.current.error).toContain("连续三个执行分片");
    expect(run.calls).toBeGreaterThan(12);
    expect(run.calls).toBeLessThanOrEqual(49);
    const operations = (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("job_id", "=", run.jobId)
        .execute()
    )
      .map((row) => JSON.parse(row.result))
      .filter((row) => row.kind === "image_mask_segment");
    expect(operations).toHaveLength(run.calls - 1);
    expect(new Set(operations.map((row) => row.receiptId)).size).toBe(
      run.calls - 1,
    );
    expect(new Set(operations.map((row) => row.selectionSha256)).size).toBe(1);
    expect(operations.every((row) => row.usable)).toBe(true);
    expect(seed.paid()).toBe(0);
    const checkpoint = JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("result")
          .where("id", "=", run.jobId)
          .executeTakeFirstOrThrow()
      ).result,
    ).checkpoint;
    expect(checkpoint.round).toBe(0);
    expect(checkpoint.imageBatch.attemptScope).toEqual(batch.attemptScope);
  },
);

it("reestablishing actual two-frame proof for a new same-bitmap proposal still permits its later prepare and free compose", async () => {
  const seed = await seedFailedDelivery();
  const profile = await isolatedSegmentation();
  let maskReceiptId = "";
  const empty = () => ({ proposalIds: [], include: [], exclude: [] });
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step >= 3) {
        const frames = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
        expect(frames).toHaveLength(
          ({ 3: 3, 4: 2, 5: 2, 6: 2, 7: 1 } as Record<number, number>)[step]!,
        );
      }
      if (step === 2) return [candidateView(seed.providerOperationId)];
      if (step === 3 || step === 4)
        return [
          {
            name: "image_mask_segment",
            args: segmentPart(`new proof ${step}`),
          },
        ];
      if (step === 5) {
        const proposal = mediaToolFacts(body, "image_mask_segment");
        expect(proposal.usable).toBe(true);
        return [
          {
            name: "image_mask_prepare",
            args: {
              generationOperationId: seed.providerOperationId,
              referenceImageId: page(),
              sourceTarget: {
                ...empty(),
                proposalIds: [proposal.proposalReceiptId],
              },
              generatedTarget: empty(),
              protected: empty(),
              allowedOcclusion: empty(),
              textEdits: empty(),
            },
          },
        ];
      }
      if (step === 6) {
        const mask = mediaToolFacts(body, "image_mask_prepare");
        expect(mask.diagnostics.protectionConflictPixels).toBe(0);
        maskReceiptId = mask.maskReceiptId;
        return [
          {
            name: "image_mask_compose",
            args: {
              maskReceiptId,
              generationOperationId: seed.providerOperationId,
              referenceImageId: page(),
              filename: "same-pixels-new-proof.png",
            },
          },
        ];
      }
      expect(step).toBe(7);
      expect(mediaToolFacts(body, "image_mask_compose").ready).toBe(true);
      return []; // Real ask_user pauses before any further normal drain.
    },
    { maxSteps: 1, segmentationProfile: profile },
  );
  expect(run.calls).toBe(7);
  const operations = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  ).map((row) => JSON.parse(row.result));
  const proposals = operations.filter(
    (row) => row.kind === "image_mask_segment",
  );
  expect(proposals).toHaveLength(2);
  expect(proposals[0].receiptId).not.toBe(proposals[1].receiptId);
  expect(proposals[0].selectionSha256).toBe(proposals[1].selectionSha256);
  expect(
    operations.find((row) => row.origin === "local-recomposition").editMask
      .receiptId,
  ).toBe(maskReceiptId);
  expect(seed.paid()).toBe(1);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(1);
  const checkpoint = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  const serialized = JSON.stringify(checkpoint.messages);
  expect(serialized).not.toContain('"type":"media"');
  expect(serialized).not.toContain('"type":"file"');
  expect(checkpoint.round).toBe(0);
  expect(checkpoint.imageBatch.attemptScope).toEqual(batch.attemptScope);
});

it("a genuinely changed usable bitmap with actual complete frames continues normal one-step batch fragments", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const profile = await isolatedSegmentation((input) =>
    segmentationPixels(32 + Number(input.targets[0]!.label)),
  );
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step < 9)
        return [
          { name: "image_mask_segment", args: segmentPart(String(step)) },
        ];
      expect(step).toBe(9);
      expect(mediaToolFacts(body, "image_mask_segment").usable).toBe(true);
      return [];
    },
    { maxSteps: 1, segmentationProfile: profile },
  );
  expect(run.calls).toBe(9);
  const proposals = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  )
    .map((row) => JSON.parse(row.result))
    .filter((row) => row.kind === "image_mask_segment");
  expect(proposals).toHaveLength(7);
  expect(new Set(proposals.map((row) => row.selectionSha256)).size).toBe(7);
  expect(seed.paid()).toBe(0);
});

it("halts three unfinished plain-text or status-only fragments without turning them into three acceptance-repair rounds", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const before = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const run = await runFailedBatch(
    seed,
    (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      expect(step).toBeLessThanOrEqual(4);
      if (step === 3)
        return [
          {
            name: "image_batch",
            args: { action: "status", notes: "new wording is not progress" },
          },
        ];
      return [];
    },
    {
      maxSteps: 1,
      emptyText: "已经全部处理完成。",
      expectedStatus: "failed",
      expectedQuestions: 0,
    },
  );
  expect(run.calls).toBe(4);
  expect(run.current.error).toContain("连续三个执行分片");
  expect(seed.paid()).toBe(0);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(before);
  const checkpoint = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  expect(checkpoint.round).toBe(0);
  expect(checkpoint.imageBatch.current).toBe(0);
  expect(checkpoint.imageBatch.attemptScope).toEqual(batch.attemptScope);
});

it("a real ask_user on the third stagnant fragment pauses before the no-progress stop and does not keep draining", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const run = await runFailedBatch(
    seed,
    (_body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step < 4)
        return [{ name: "image_batch", args: { action: "status" } }];
      expect(step).toBe(4);
      return [
        {
          name: "ask_user",
          args: {
            title: "A real identity choice is missing",
            options: ["Use confirmed person", "Wait for identity"],
          },
        },
      ];
    },
    { maxSteps: 1 },
  );
  expect(run.calls).toBe(4);
  expect(run.current.progress.phase).toBe("waiting_choice");
  expect(seed.paid()).toBe(0);
});

it("clearing and reestablishing the same candidate and preview proofs cannot manufacture new batch progress", async () => {
  const seed = await seedFailedDelivery();
  const run = await runFailedBatch(
    seed,
    (_body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      expect(step).toBeLessThanOrEqual(8);
      return step % 2 === 0
        ? [candidateView(seed.providerOperationId)]
        : [
            {
              name: "image_edit_preview",
              args: {
                referenceImageId: page(),
                editRegions: structuredClone(repairRegions),
              },
            },
          ];
    },
    { maxSteps: 1, expectedStatus: "failed", expectedQuestions: 0 },
  );
  expect(run.calls).toBeGreaterThan(3);
  expect(run.calls).toBeLessThanOrEqual(8);
  expect(run.current.error).toContain("连续三个执行分片");
  expect(seed.paid()).toBe(1);
});

it("an uncertain paid image failure stops the normal drain without submitting a second provider request", async () => {
  const seed = await seedFailedDelivery("reference-export");
  let submitted = 0;
  const failed = {
    ...seed,
    imageFetch: (async () => {
      submitted++;
      throw new TypeError("Fixture connection closed after submission");
    }) as typeof fetch,
    paid: () => submitted,
  };
  const run = await runFailedBatch(
    failed,
    (_body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      expect(step).toBe(2);
      return [regenerate(2)];
    },
    { maxSteps: 100, expectedStatus: "failed", expectedQuestions: 0 },
  );
  expect(run.calls).toBe(2);
  expect(submitted).toBe(1);
  expect(JSON.parse(run.current.error)).toMatchObject({
    type: "system_error",
    code: "image_result_uncertain",
  });
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toEqual([expect.objectContaining({ state: "pending" })]);
  const uncertain = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  )
    .map((row) => JSON.parse(row.result))
    .filter((row) => row.kind === "image_generation");
  expect(uncertain).toHaveLength(1);
  expect(uncertain[0]).toMatchObject({
    state: "generating",
    paidAttempt: { ordinal: 1, scope: batch.attemptScope },
  });
  expect(uncertain[0].rawCandidate).toBeUndefined();
  const stored = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint.imageBatch;
  expect(stored.attemptScope).toEqual(batch.attemptScope);
  expect(stored.delivered[page()]).toBe(seed.saved.assetId);
});

it("stops after an uncertain parallel image request even when another already-submitted provider request returns successfully", async () => {
  const seed = await seedFailedDelivery("reference-export");
  let submitted = 0;
  const failed = {
    ...seed,
    imageFetch: (async () => {
      const ordinal = ++submitted;
      if (ordinal === 1) throw Error("Fixture provider connection lost");
      await new Promise((resolve) => setTimeout(resolve, 30));
      return response();
    }) as typeof fetch,
  };
  const run = await runFailedBatch(
    failed,
    (_body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [inspectScene(0), inspectScene(1)];
      expect(step).toBe(3); // No request after these already-authorized submissions may retry.
      return [regenerate(2, 0), regenerate(2, 1)];
    },
    { maxSteps: 100, expectedStatus: "failed", expectedQuestions: 0 },
  );
  expect(run.calls).toBe(3);
  expect(submitted).toBe(2);
  expect(JSON.parse(run.current.error)).toMatchObject({
    code: "image_result_uncertain",
  });
  const operations = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  )
    .map((row) => JSON.parse(row.result))
    .filter((row) => row.kind === "image_generation");
  expect(operations).toHaveLength(2);
  expect(operations.every((row) => row.paidAttempt?.ordinal === 1)).toBe(true);
  expect(operations.some((row) => row.state === "generating")).toBe(true);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toHaveLength(2);
});

it("cancelling an unfinished batch during a normal fragment stops the drain and preserves scope and existing deliveries", async () => {
  const seed = await seedFailedDelivery("reference-export");
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = await runFailedBatch(
    seed,
    async (_body, step, signal) => {
      if (step === 1) return [resumeFailedBatch()];
      expect(step).toBe(2);
      started();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      });
      return [];
    },
    {
      maxSteps: 1,
      expectedStatus: "cancelled",
      expectedQuestions: 0,
      onQueued: async ({ app, headers, jobId }) => {
        await waiting;
        const cancelled = await app.inject({
          method: "POST",
          url: `/api/v1/ai/jobs/${jobId}/cancel`,
          headers,
        });
        expect(cancelled.statusCode).toBe(200);
      },
    },
  );
  expect(run.calls).toBe(2);
  expect(seed.paid()).toBe(0);
  const checkpoint = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  ).checkpoint;
  expect(checkpoint.imageBatch.attemptScope).toEqual(batch.attemptScope);
  expect(checkpoint.imageBatch.delivered[page()]).toBe(seed.saved.assetId);
});

it("runner does not grant raw-view proof to the second parallel candidate whose raw was omitted by the four-frame transport budget", async () => {
  const seed = await seedFailedDelivery(),
    secondOperation = randomUUID();
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const second = await generateImageAsset(
    db,
    ctx,
    input(2, 1),
    secondOperation,
    settings(seed.imageFetch),
  );
  batch.delivered[page(1)] = second.assetId;
  batch.reviews[page(1)] = {
    assetId: second.assetId,
    passed: false,
    evidence: "Second raw is unsuitable",
  };
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  await runFailedBatch(
    seed,
    (body, request) => {
      if (request === 1) return [resumeFailedBatch()];
      if (request === 2) return [inspectScene(0), inspectScene(1)];
      const step = request - 1;
      if (step === 2)
        return [
          candidateView(seed.providerOperationId),
          candidateView(secondOperation),
        ];
      if (step === 3) {
        expect(
          body.messages
            .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
            .filter((p: any) => p.type === "image_url"),
        ).toHaveLength(3);
        return [regenerate(3, 1)];
      }
      if (step === 4) {
        expect(seed.paid()).toBe(2);
        expect(lastTool(body, "image_edit")).toContain("image_candidate_view");
        return [candidateView(secondOperation)];
      }
      if (step === 5) return [regenerate(4, 1)];
      expect(step).toBe(6);
      expect(seed.paid()).toBe(3);
      return [];
    },
    { maxSteps: 1 },
  );
});

it("runner refuses paid generation for the third parallel preview until both of its frames actually reach a later request", async () => {
  const seed = await seedFailedDelivery("reference-export");
  const preview = (index: number): RunnerTool => ({
    name: "image_edit_preview",
    args: {
      referenceImageId: page(index),
      editRegions: structuredClone(repairRegions),
    },
  });
  const edit = (): RunnerTool => ({
    name: "image_edit",
    args: {
      ...input(4, 2),
      sourceImageId: page(2),
      referenceImageIds: undefined,
      editRegions: structuredClone(repairRegions),
      filename: "third-page.png",
    },
  });
  await runFailedBatch(
    seed,
    (body, request) => {
      if (request === 1) return [resumeFailedBatch()];
      if (request === 2) return [inspectScene(2)];
      const step = request - 1;
      if (step === 2) return [preview(0), preview(1), preview(2)];
      if (step === 3) return [edit()];
      if (step === 4) {
        expect(seed.paid()).toBe(0);
        expect(JSON.parse(lastTool(body, "image_edit"))).toMatchObject({
          error: true,
          code: "image_edit_preview_required",
          referenceImageId: page(2),
          reason: "parameters_not_viewed",
          next: {
            toolName: "image_edit_preview",
            input: { referenceImageId: page(2), editRegions: repairRegions },
          },
        });
        return [preview(2)];
      }
      if (step === 5) return [edit()];
      expect(step).toBe(6);
      expect(seed.paid()).toBe(1);
      return [];
    },
    { maxSteps: 1 },
  );
});

it("runner also blocks free recomposition when that page's parallel preview was not transmitted", async () => {
  const seed = await seedFailedDelivery("reference-export"),
    operation = randomUUID();
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const candidate = await generateImageAsset(
    db,
    ctx,
    input(2, 2),
    operation,
    settings(seed.imageFetch),
  );
  batch.delivered[page(2)] = candidate.assetId;
  batch.reviews[page(2)] = {
    assetId: candidate.assetId,
    passed: false,
    evidence: "Coverage needs local correction",
  };
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  const preview = (index: number): RunnerTool => ({
    name: "image_edit_preview",
    args: {
      referenceImageId: page(index),
      editRegions: structuredClone(repairRegions),
    },
  });
  const recompose: RunnerTool = {
    name: "image_recompose",
    args: {
      generationOperationId: operation,
      referenceImageId: page(2),
      editRegions: structuredClone(repairRegions),
      filename: "third-recomposed.png",
    },
  };
  await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [preview(0), preview(1), preview(2)];
    if (step === 3) return [recompose];
    if (step === 4) {
      expect(JSON.parse(lastTool(body, "image_recompose"))).toMatchObject({
        error: true,
        code: "image_edit_preview_required",
        referenceImageId: page(2),
        reason: "parameters_not_viewed",
        next: {
          toolName: "image_edit_preview",
          input: { referenceImageId: page(2), editRegions: repairRegions },
        },
      });
      return [preview(2)];
    }
    if (step === 5) return [recompose];
    expect(step).toBe(6);
    expect(lastTool(body, "image_recompose")).toContain("local-recomposition");
    return [];
  });
  expect(seed.paid()).toBe(1);
});

it.each(["view-first", "generate-first"])(
  "runner requires viewing the current failed raw in an earlier model round for %s parallel order, then permits a real bad-raw retry",
  async (order) => {
    const seed = await seedFailedDelivery();
    const run = await runFailedBatch(
      seed,
      (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step === 2) return [regenerate(2)];
        if (step === 3) {
          expect(seed.paid()).toBe(1);
          expect(lastTool(body, "image_edit")).toContain(
            "image_candidate_view",
          );
          const parallel = [
            candidateView(seed.providerOperationId),
            regenerate(3),
          ];
          return order === "view-first" ? parallel : parallel.reverse();
        }
        if (step === 4) {
          expect(seed.paid()).toBe(1);
          expect(lastTool(body, "image_edit")).toContain("后续模型轮次");
          expect(lastTool(body, "image_candidate_view")).toContain(
            seed.providerOperationId,
          );
          const media = body.messages
            .flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            )
            .filter((part: any) => part.type === "image_url");
          expect(media.length).toBeGreaterThanOrEqual(3);
          return [regenerate(4)];
        }
        expect(step).toBe(5);
        expect(seed.paid()).toBe(2);
        return [];
      },
      { maxSteps: 1 },
    );
    expect(run.calls).toBe(5);
    expect(
      (await usageSummary(db, owner.id)).calls.filter(
        (call) => call.callKind === "image",
      ),
    ).toHaveLength(2);
  },
);

it("runner cannot substitute another page's viewed raw for the latest delivered candidate", async () => {
  const seed = await seedFailedDelivery(),
    otherOperation = randomUUID();
  // A real retained raw from another page in the same book is authorized to view,
  // but it cannot prove that the current page's raw has been inspected.
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", ctx.jobId!)
    .execute();
  await generateImageAsset(
    db,
    ctx,
    input(2, 1),
    otherOperation,
    settings(seed.imageFetch),
  );
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", ctx.jobId!)
    .execute();
  await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [candidateView(otherOperation)];
    if (step === 3) return [regenerate(3)];
    expect(step).toBe(4);
    expect(seed.paid()).toBe(2);
    expect(lastTool(body, "image_edit")).toContain(seed.providerOperationId);
    return [];
  });
  expect(seed.paid()).toBe(2);
});

it.each(["view-first", "generate-first"])(
  "runner does not reuse older visual proof when a fresh raw view is parallel with generation in %s order",
  async (order) => {
    const seed = await seedFailedDelivery();
    await runFailedBatch(seed, (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [candidateView(seed.providerOperationId)];
      if (step === 3) {
        const parallel = [
          candidateView(seed.providerOperationId),
          regenerate(2),
        ];
        return order === "view-first" ? parallel : parallel.reverse();
      }
      if (step === 4) {
        expect(seed.paid()).toBe(1);
        expect(lastTool(body, "image_edit")).toContain("后续模型轮次");
        return [regenerate(3)];
      }
      expect(step).toBe(5);
      expect(seed.paid()).toBe(2);
      return [];
    });
  },
);

it("runner requires the latest same-page raw rather than an earlier paid candidate", async () => {
  const seed = await seedFailedDelivery(),
    latestOperation = randomUUID();
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", ctx.jobId!)
    .execute();
  const latest = await generateImageAsset(
    db,
    ctx,
    input(2),
    latestOperation,
    settings(seed.imageFetch),
  );
  batch.delivered[page()] = latest.assetId;
  batch.reviews[page()] = {
    assetId: latest.assetId,
    passed: false,
    evidence: "Latest raw still has a wrong action",
  };
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", ctx.jobId!)
    .execute();
  await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [candidateView(seed.providerOperationId)];
    if (step === 3) return [regenerate(3)];
    expect(step).toBe(4);
    expect(seed.paid()).toBe(2);
    expect(lastTool(body, "image_edit")).toContain(latestOperation);
    return [];
  });
});

it.each([
  ["provider", true],
  ["provider", false],
  ["local-recomposition", true],
] as const)(
  "runner selects an older %s only after complete source/candidate EOF and a later round, then records the actual independent verdict %s",
  async (origin, independentPassed) => {
    const { seed, latest } = await seedSelectablePriorDelivery(origin);
    const before = await unchangedSelectionFacts();
    let activeJobId = "";
    const run = await runFailedBatch(
      seed,
      async (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
        if (step === 3) {
          expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
            selection: {
              state: "needs-fresh-view",
              referenceImageId: page(),
              assetId: seed.saved.assetId,
            },
            next: {
              toolName: "image_view",
              input: { referenceImageIds: [page(), seed.saved.assetId] },
            },
          });
          const current = await storedBatch(activeJobId);
          expect(current.delivered[page()]).toBe(latest.assetId);
          expect(current.reviews[page()]?.assetId).toBe(latest.assetId);
          return [viewSourceAndSaved(seed.saved.assetId)];
        }
        if (step === 4) {
          await expectActualFixtureFrames(body, 2);
          expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
            latest.assetId,
          );
          return [selectPriorCandidate(seed.saved.assetId)];
        }
        expect(step).toBe(5);
        expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
          selection: {
            state: "selected",
            referenceImageId: page(),
            assetId: seed.saved.assetId,
          },
        });
        const current = await storedBatch(activeJobId);
        expect(current.delivered[page()]).toBe(seed.saved.assetId);
        expect(current.reviews[page()]).toMatchObject({
          assetId: seed.saved.assetId,
          passed: independentPassed,
        });
        return [];
      },
      {
        maxSteps: 1,
        independentImageReview: independentPassed,
        onQueued: async ({ jobId }) => {
          activeJobId = jobId;
        },
      },
    );
    expect(run.calls).toBe(5);
    expect(run.imageReviews).toBe(1);
    expect(
      run.imageReviewBodies.map((body) => {
        const text = body.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .find(
            (part: any) =>
              part.type === "text" && part.text.startsWith('{"requiredChecks"'),
          );
        return JSON.parse(text.text).reviewMode ?? "global";
      }),
    ).toEqual(["global"]);
    expect(seed.paid()).toBe(2);
    const current = await expectSelectionFactsPreserved(run.jobId, before);
    expect(current.delivered[page()]).toBe(seed.saved.assetId);
    expect(current.reviews[page()]).toMatchObject({
      assetId: seed.saved.assetId,
      passed: independentPassed,
    });
    if (!independentPassed)
      expect(current.reviews[page()]!.evidence).toContain(
        "Independent fixture judge still rejects the requested edit",
      );
    const currentImageOperations = await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .where("result", "like", '%"kind":"image_generation"%')
      .execute();
    expect(currentImageOperations).toHaveLength(0);
  },
);

it("concludes a three-candidate comparison by keeping the current best only after its complete later-round view, then permits a bounded new repair", async () => {
  const seed = await seedFailedDelivery();
  let activeJobId = "", latestAssetId = "", latestOperationId = seed.providerOperationId;
  const run = await runFailedBatch(seed, async (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [
      { name: "image_batch", args: { action: "review", review: {
        referenceImageId: page(), assetId: seed.saved.assetId, passed: false,
        evidence: "The actual current fixture candidate still lacks the requested edit.",
      } } },
      candidateView(latestOperationId),
    ];
    if (step === 3) return [regenerate(2)];
    if (step === 4) {
      expect(seed.paid()).toBe(2);
      latestOperationId = mediaToolFacts(body, "image_edit").generationOperationId;
      return [candidateView(latestOperationId)];
    }
    if (step === 5) return [regenerate(3)];
    if (step === 6) {
      expect(seed.paid()).toBe(3);
      latestOperationId = mediaToolFacts(body, "image_edit").generationOperationId;
      latestAssetId = (await storedBatch(activeJobId)).delivered[page()]!;
      return [selectPriorCandidate(latestAssetId)];
    }
    if (step === 7) {
      expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
        selection: { state: "needs-fresh-view", assetId: latestAssetId },
      });
      expect((await storedBatch(activeJobId)).reviews[page()]!.passed).toBe(false);
      expect(seed.paid()).toBe(3);
      return [viewSourceAndSaved(latestAssetId)];
    }
    if (step === 8) {
      await expectActualFixtureFrames(body, 2);
      return [selectPriorCandidate(latestAssetId)];
    }
    if (step === 9) {
      expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
        selection: { state: "selected", assetId: latestAssetId },
      });
      expect((await storedBatch(activeJobId)).reviews[page()]!.passed).toBe(false);
      expect(seed.paid()).toBe(3);
      return [candidateView(latestOperationId)];
    }
    if (step === 10) return [regenerate(4)];
    expect(step).toBe(11);
    expect(seed.paid()).toBe(4);
    return [];
  }, { maxSteps: 1, onQueued: async ({ jobId }) => { activeJobId = jobId; } });
  expect(run.calls).toBe(11);
  expect((await imageCalls()).filter(call => call.callKind === "image")).toHaveLength(4);
  expect((await storedBatch(run.jobId)).attemptScope).toEqual(batch.attemptScope);
  expect((await storedBatch(run.jobId)).reviews[page()]!.passed).toBe(false);
});

it.each(["view-first", "select-first"])(
  "runner refuses a selection parallel with its required view in %s order without changing the delivery, then permits a later selection",
  async (order) => {
    const { seed, latest } = await seedSelectablePriorDelivery();
    const before = await unchangedSelectionFacts();
    let activeJobId = "";
    const run = await runFailedBatch(
      seed,
      async (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
        if (step === 3) {
          const parallel = [
            viewSourceAndSaved(seed.saved.assetId),
            selectPriorCandidate(seed.saved.assetId),
          ];
          return order === "view-first" ? parallel : parallel.reverse();
        }
        if (step === 4) {
          expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
            selection: { state: "needs-fresh-view" },
          });
          expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
            latest.assetId,
          );
          await expectActualFixtureFrames(body, 2);
          return [selectPriorCandidate(seed.saved.assetId)];
        }
        expect(step).toBe(5);
        expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
          selection: { state: "selected", assetId: seed.saved.assetId },
        });
        return [];
      },
      {
        maxSteps: 1,
        onQueued: async ({ jobId }) => {
          activeJobId = jobId;
        },
      },
    );
    expect(run.calls).toBe(5);
    expect(run.imageReviews).toBe(1);
    expect(seed.paid()).toBe(2);
    const current = await expectSelectionFactsPreserved(run.jobId, before);
    expect(current.delivered[page()]).toBe(seed.saved.assetId);
    expect(current.reviews[page()]).toMatchObject({
      assetId: seed.saved.assetId,
      passed: false,
    });
  },
);

it("runner withholds selection proof for an old candidate pair omitted by the four-frame budget and requires a complete later view", async () => {
  const { seed, latest, otherPage } = await seedSelectablePriorDelivery();
  const before = await unchangedSelectionFacts();
  let activeJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
      if (step === 3)
        return [
          viewSourceAndSaved(latest.assetId),
          viewSourceAndSaved(otherPage.assetId, 1),
          viewSourceAndSaved(seed.saved.assetId),
        ];
      if (step === 4) {
        await expectActualFixtureFrames(body, 4);
        return [selectPriorCandidate(seed.saved.assetId)];
      }
      if (step === 5) {
        expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
          selection: { state: "needs-fresh-view", assetId: seed.saved.assetId },
        });
        expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
          latest.assetId,
        );
        return [viewSourceAndSaved(seed.saved.assetId)];
      }
      if (step === 6) {
        await expectActualFixtureFrames(body, 2);
        return [selectPriorCandidate(seed.saved.assetId)];
      }
      expect(step).toBe(7);
      expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
        selection: { state: "selected", assetId: seed.saved.assetId },
      });
      return [];
    },
    {
      maxSteps: 100,
      onQueued: async ({ jobId }) => {
        activeJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(7);
  expect(run.imageReviews).toBe(1);
  expect(seed.paid()).toBe(2);
  const current = await expectSelectionFactsPreserved(run.jobId, before);
  expect(current.delivered[page()]).toBe(seed.saved.assetId);
  expect(current.reviews[page()]).toMatchObject({
    assetId: seed.saved.assetId,
    passed: false,
  });
});

it("runner selecting an older paid candidate at cap ten preserves all ten real image submissions and refuses an eleventh edit", async () => {
  const { seed } = await seedSelectablePriorDelivery();
  const driver = databaseDriver(db);
  try {
    vi.stubEnv("DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE", "10");
    vi.resetModules();
    (await import("@db/transactions.js")).registerDriver(db, driver);
    const freshImages =
      await import("../apps/server/src/services/ai/images.js");
    const freshApp = await import("../apps/server/src/app/create-app.js");
    await db
      .updateTable("ai_jobs")
      .set({
        status: "running",
        lease: ctx.lease!,
        lease_until: new Date(Date.now() + 120000).toISOString(),
      })
      .where("id", "=", originalJobId)
      .execute();
    for (let n = 3; n <= 10; n++) {
      const saved = await freshImages.generateImageAsset(
        db,
        ctx,
        input(n),
        randomUUID(),
        settings(seed.imageFetch),
      );
      expect(saved.paidAttempt?.ordinal).toBe(n);
      batch.delivered[page()] = saved.assetId;
      batch.reviews[page()] = {
        assetId: saved.assetId,
        passed: false,
        evidence: `Paid candidate ${n} remains unacceptable`,
      };
    }
    await attachBatch(ctx);
    await db
      .updateTable("ai_jobs")
      .set({ status: "completed", lease: null, lease_until: null })
      .where("id", "=", originalJobId)
      .execute();
    const before = await unchangedSelectionFacts();
    expect(before.imageCalls).toHaveLength(10);
    expect(seed.paid()).toBe(10);
    const paidOrdinals = before.operations
      .map((row) => JSON.parse(row.result))
      .filter(
        (receipt) => receipt.kind === "image_generation" && receipt.paidAttempt,
      )
      .map((receipt) => receipt.paidAttempt.ordinal)
      .sort((a, b) => a - b);
    expect(paidOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const run = await runFailedBatch(
      seed,
      async (body, step) => {
        if (step === 1) return [resumeFailedBatch()];
        if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
        if (step === 3) return [viewSourceAndSaved(seed.saved.assetId)];
        if (step === 4) {
          await expectActualFixtureFrames(body, 2);
          return [selectPriorCandidate(seed.saved.assetId)];
        }
        if (step === 5) {
          expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
            selection: { state: "selected", assetId: seed.saved.assetId },
          });
          return [candidateView(seed.providerOperationId)];
        }
        if (step === 6) {
          await expectActualFixtureFrames(body, 3);
          return [regenerate(11)];
        }
        throw Error(
          "The page cap must stop this executor before a seventh model request",
        );
      },
      {
        maxSteps: 1,
        appFactory: freshApp.createApp,
        expectedStatus: "failed",
        expectedQuestions: 0,
      },
    );
    expect(run.calls).toBe(6);
    expect(JSON.parse(run.current.error)).toMatchObject({
      code: "image_page_attempt_limit",
    });
    expect(run.imageReviews).toBe(1);
    expect(seed.paid()).toBe(10);
    const current = await expectSelectionFactsPreserved(run.jobId, before);
    expect(current.delivered[page()]).toBe(seed.saved.assetId);
    expect(current.reviews[page()]).toMatchObject({
      assetId: seed.saved.assetId,
      passed: false,
    });
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

it.each([
  "other-actor",
  "different-session",
  "other-real-scope",
  "different-page",
])(
  "selection helper rejects %s without changing saved receipts, raw or image fees",
  async (scenario) => {
    const { seed } = await seedSelectablePriorDelivery();
    let active: ToolContext;
    let target = structuredClone(batch);
    const candidate = { referenceImageId: page(), assetId: seed.saved.assetId };
    if (scenario === "other-actor")
      active = await job({ actor: other, sessionId: await session(other) });
    else if (scenario === "different-session")
      active = await job({ sessionId: await session() });
    else if (scenario === "other-real-scope") {
      active = await job({
        input: { attachments: [batch.books[0]!.source.assetId] },
      });
      const requirements = await createImageBatchRequirements(
        db,
        {
          userId: owner.id,
          actor: owner,
          sessionId,
          currentJobId: active.jobId!,
        },
        active.jobId!,
        [batch.books[0]!.source],
        "all-documents",
        ["Requested visible edit"],
        [],
      );
      const attemptScope = await registerImageBatchAttemptScope(
        db,
        active,
        {
          requirements,
          books: batch.books,
        },
        { version: 1 },
      );
      expect(attemptScope.operationId).not.toBe(batch.attemptScope.operationId);
      target = imageBatchSchema.parse({ ...batch, requirements, attemptScope });
    } else {
      active = await job();
      candidate.referenceImageId = page(1);
    }
    await attachBatch(active, target);
    const before = await unchangedSelectionFacts();
    const previous = await storedBatch(active.jobId!);
    await expect(
      inspectImageBatchSelection(db, active, target, candidate, runtime()),
    ).rejects.toThrow();
    expect(await storedBatch(active.jobId!)).toEqual(previous);
    expect(
      await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
    ).toEqual(before.operations);
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(before.assets);
    expect(
      (await imageCalls()).filter((call) => call.callKind === "image"),
    ).toEqual(before.imageCalls);
    expect(seed.paid()).toBe(2);
  },
);

it("runner rejects changed authorized candidate bytes after the actual pair was viewed and keeps the newer delivery and all paid receipts", async () => {
  const { seed, latest } = await seedSelectablePriorDelivery();
  const before = await unchangedSelectionFacts();
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", seed.saved.assetId)
    .executeTakeFirstOrThrow();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const replacement = await sharp(await png())
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(replacement.equals(await png())).toBe(false);
  const changedPath = join(
    storageModule.storageConfigForProfile(runtime(), profile).root ?? root,
    asset.object_key,
  );
  expect(changedPath.startsWith(`${root}/`)).toBe(true);
  let activeJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
      if (step === 3) return [viewSourceAndSaved(seed.saved.assetId)];
      if (step === 4) {
        await expectActualFixtureFrames(body, 2);
        await writeFile(changedPath, replacement);
        await db
          .updateTable("assets")
          .set({ size: replacement.length })
          .where("id", "=", asset.id)
          .execute();
        return [selectPriorCandidate(seed.saved.assetId)];
      }
      expect(step).toBe(5);
      expect(lastTool(body, "image_batch")).toContain(
        "待选候选、原页或当前交付绑定已改变，请重新 select 后实际查看",
      );
      expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
        latest.assetId,
      );
      return [];
    },
    {
      maxSteps: 100,
      onQueued: async ({ jobId }) => {
        activeJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(5);
  expect(run.imageReviews).toBe(0);
  expect(seed.paid()).toBe(2);
  const current = await storedBatch(run.jobId);
  expect(current.delivered[page()]).toBe(latest.assetId);
  expect(current.reviews[page()]).toEqual(batch.reviews[page()]);
  expect(current.delivered[page(1)]).toBe(before.otherDelivery);
  expect(current.reviews[page(1)]).toEqual(before.otherReview);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(before.operations);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toEqual(before.imageCalls);
  expect(
    (
      await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", asset.id)
        .executeTakeFirstOrThrow()
    ).owner_id,
  ).toBe(owner.id);
});

it("runner invalidates an old selection proof after normally binding a new formal batch clarification and retains the newer delivery", async () => {
  const { seed, latest } = await seedSelectablePriorDelivery();
  const clarificationText =
    "Supplement the current batch: preserve every original label as well as the requested visible edit.";
  const clarification = await job({ input: { text: clarificationText } });
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", clarification.jobId!)
    .execute();
  const before = await unchangedSelectionFacts();
  let activeJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
      if (step === 3) return [viewSourceAndSaved(seed.saved.assetId)];
      if (step === 4) {
        await expectActualFixtureFrames(body, 2);
        return [
          {
            name: "image_batch",
            args: {
              action: "bind",
              taskJobId: originalJobId,
              clarifications: [{ jobId: clarification.jobId!, scope: "batch" }],
            },
          },
        ];
      }
      if (step === 5) {
        const current = await storedBatch(activeJobId);
        expect(current.requirements.clarifications).toHaveLength(1);
        expect(current.requirements.clarifications[0]).toMatchObject({
          source: { jobId: clarification.jobId!, text: clarificationText },
          scope: "batch",
          boundToRootJobId: batch.requirements.original.rootJobId,
        });
        expect(current.delivered[page()]).toBe(latest.assetId);
        return [selectPriorCandidate(seed.saved.assetId)];
      }
      expect(step).toBe(6);
      expect(lastTool(body, "image_batch")).toContain(
        "待选候选、原页或当前交付绑定已改变，请重新 select 后实际查看",
      );
      expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
        latest.assetId,
      );
      return [];
    },
    {
      maxSteps: 100,
      onQueued: async ({ jobId }) => {
        activeJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(6);
  expect(run.imageReviews).toBe(1);
  expect(JSON.stringify(run.imageReviewBodies)).toContain(clarificationText);
  expect(seed.paid()).toBe(2);
  const current = await storedBatch(run.jobId);
  expect(current.delivered[page()]).toBe(latest.assetId);
  expect(current.delivered[page(1)]).toBe(before.otherDelivery);
  expect(current.attemptScope).toEqual(before.attemptScope);
  expect(current.requirements.original).toEqual(before.requirements.original);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(before.operations);
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(before.assets);
  expect(
    (await imageCalls()).filter((call) => call.callKind === "image"),
  ).toEqual(before.imageCalls);
});

it("runner cannot reuse candidate A's old proof after normally selecting and independently reviewing candidate B for the same page", async () => {
  const { seed, latest } = await seedSelectablePriorDelivery();
  await db
    .updateTable("ai_jobs")
    .set({
      status: "running",
      lease: ctx.lease!,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    })
    .where("id", "=", originalJobId)
    .execute();
  const secondChoice = await generateImageAsset(
    db,
    ctx,
    input(3),
    randomUUID(),
    settings(seed.imageFetch),
  );
  expect(secondChoice.paidAttempt?.ordinal).toBe(3);
  await attachBatch(ctx);
  await db
    .updateTable("ai_jobs")
    .set({ status: "completed", lease: null, lease_until: null })
    .where("id", "=", originalJobId)
    .execute();
  const before = await unchangedSelectionFacts();
  let activeJobId = "";
  const run = await runFailedBatch(
    seed,
    async (body, step) => {
      if (step === 1) return [resumeFailedBatch()];
      if (step === 2) return [selectPriorCandidate(seed.saved.assetId)];
      if (step === 3) return [viewSourceAndSaved(seed.saved.assetId)];
      if (step === 4) {
        await expectActualFixtureFrames(body, 2);
        return [selectPriorCandidate(secondChoice.assetId)];
      }
      if (step === 5) {
        expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
          selection: {
            state: "needs-fresh-view",
            assetId: secondChoice.assetId,
          },
        });
        expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
          latest.assetId,
        );
        return [viewSourceAndSaved(secondChoice.assetId)];
      }
      if (step === 6) {
        const frames = actualImageFrames(body);
        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames.length).toBeLessThanOrEqual(4);
        await expectActualFixtureFrames(body, frames.length);
        return [selectPriorCandidate(secondChoice.assetId)];
      }
      if (step === 7) {
        expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
          selection: { state: "selected", assetId: secondChoice.assetId },
        });
        expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
          secondChoice.assetId,
        );
        return [selectPriorCandidate(seed.saved.assetId)];
      }
      expect(step).toBe(8);
      expect(JSON.parse(lastTool(body, "image_batch"))).toMatchObject({
        selection: { state: "needs-fresh-view", assetId: seed.saved.assetId },
        next: {
          toolName: "image_view",
          input: { referenceImageIds: [page(), seed.saved.assetId] },
        },
      });
      expect((await storedBatch(activeJobId)).delivered[page()]).toBe(
        secondChoice.assetId,
      );
      return [];
    },
    {
      maxSteps: 100,
      onQueued: async ({ jobId }) => {
        activeJobId = jobId;
      },
    },
  );
  expect(run.calls).toBe(8);
  expect(run.imageReviews).toBe(1);
  expect(seed.paid()).toBe(3);
  const current = await expectSelectionFactsPreserved(run.jobId, before);
  expect(current.delivered[page()]).toBe(secondChoice.assetId);
  expect(current.reviews[page()]).toMatchObject({
    assetId: secondChoice.assetId,
    passed: false,
  });
});

it("runner permits the first paid edit of a failed explicit reference-export without inventing raw", async () => {
  const seed = await seedFailedDelivery("reference-export");
  expect(seed.paid()).toBe(0);
  await runFailedBatch(seed, (_body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [regenerate(2)];
    expect(step).toBe(3);
    expect(seed.paid()).toBe(1);
    return [];
  });
  expect(seed.paid()).toBe(1);
});

it("runner binds a failed local recomposition to its provider generation ID, rather than its local operation ID", async () => {
  const seed = await seedFailedDelivery("local-recomposition");
  expect(seed.localOperationId).not.toBe(seed.providerOperationId);
  await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [regenerate(2)];
    if (step === 3) {
      const reply = lastTool(body, "image_edit");
      expect(seed.paid()).toBe(1);
      expect(reply).toContain(seed.providerOperationId);
      expect(reply).not.toContain(seed.localOperationId);
      return [candidateView(seed.providerOperationId)];
    }
    if (step === 4) return [regenerate(3)];
    expect(step).toBe(5);
    expect(seed.paid()).toBe(2);
    return [];
  });
});

it("runner repairs coverage with a local recomposition after viewing and previewing without a new image call", async () => {
  const seed = await seedFailedDelivery();
  const run = await runFailedBatch(seed, (_body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [candidateView(seed.providerOperationId)];
    if (step === 3)
      return [
        {
          name: "image_edit_preview",
          args: { referenceImageId: page(), editRegions: repairRegions },
        },
      ];
    if (step === 4)
      return [
        {
          name: "image_recompose",
          args: {
            generationOperationId: seed.providerOperationId,
            referenceImageId: page(),
            editRegions: repairRegions,
            filename: "repaired-locally.png",
          },
        },
      ];
    expect(step).toBe(5);
    expect(seed.paid()).toBe(1);
    return [];
  });
  const result = JSON.parse(
    (
      await db
        .selectFrom("ai_jobs")
        .select("result")
        .where("id", "=", run.jobId)
        .executeTakeFirstOrThrow()
    ).result,
  );
  const saved = result.checkpoint.imageBatch.delivered[page()];
  expect(saved).not.toBe(seed.saved.assetId);
  const receipt = (
    await db
      .selectFrom("ai_operations")
      .select("result")
      .where("job_id", "=", run.jobId)
      .execute()
  )
    .map((row) => JSON.parse(row.result))
    .find((value) => value.assetId === saved);
  expect(receipt).toMatchObject({
    origin: "local-recomposition",
    generationOperationId: seed.providerOperationId,
  });
  expect(
    (await usageSummary(db, owner.id)).calls.filter(
      (call) => call.callKind === "image",
    ),
  ).toHaveLength(1);
});

it("runner preserves a missing-raw receipt and rejects further paid generation instead of backfilling it", async () => {
  const seed = await seedFailedDelivery();
  const receipt = await generation(seed.providerOperationId);
  delete receipt.rawCandidate;
  const preserved = JSON.stringify(receipt);
  await db
    .updateTable("ai_operations")
    .set({ result: preserved })
    .where("id", "=", seed.providerOperationId)
    .execute();
  await runFailedBatch(seed, (body, step) => {
    if (step === 1) return [resumeFailedBatch()];
    if (step === 2) return [candidateView(seed.providerOperationId)];
    if (step === 3) return [regenerate(2)];
    expect(step).toBe(4);
    expect(seed.paid()).toBe(1);
    expect(lastTool(body, "image_edit")).toContain("没有有效的持久 raw 指针");
    return [];
  });
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .select("result")
        .where("id", "=", seed.providerOperationId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(preserved);
});

it("keeps the standalone limit across the actual retry lineage even if callers omit related jobs or change the prompt", async () => {
  await db
    .updateTable("ai_jobs")
    .set({ result: "{}" })
    .where("id", "=", ctx.jobId!)
    .execute();
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return response();
  }) as typeof fetch;
  for (let n = 1; n <= 5; n++) {
    if (n > 1) ctx = await job({ input: { retryOf: ctx.jobId } });
    await generateImageAsset(db, ctx, input(n), randomUUID(), {
      storage: runtime(),
      fetch: fakeFetch,
    });
  }
  const retry = await job({ input: { retryOf: ctx.jobId } });
  await expect(
    generateImageAsset(db, retry, input(6), randomUUID(), {
      storage: runtime(),
      fetch: fakeFetch,
    }),
  ).rejects.toThrow(/已提交5次/);
  const otherJob = await job({ actor: other, sessionId: await session(other) });
  await expect(
    generateImageAsset(db, ctx, input(7, 1), randomUUID(), {
      storage: runtime(),
      fetch: fakeFetch,
      relatedJobIds: [otherJob.jobId!],
    }),
  ).rejects.toThrow(/不属于当前账号或会话/);
  expect(calls).toBe(5);
  expect(await imageCalls()).toHaveLength(5);
});
