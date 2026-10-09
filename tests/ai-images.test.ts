import { createHistory } from "@core/modules/history/service.js";
import { systemErrorReason, systemErrorText } from "@core/shared/errors.js";
import { createTranslator, systemErrorMessage } from "@doca/i18n";
import { afterEach, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { aiDefaults, aiConfig, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary, beginCall, settleCall } from "@core/modules/ai/usage.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  testAIImageModel,
  availableImageReferences,
  imageInputSchema,
  generateImageAsset as executeImageOperation,
  readRawImageCandidate,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  insertGeneratedImage,
  generatedImageStatus,
  showGeneratedImage,
  imageInsertSchema,
  spreadsheetImagePlacement,
} from "../apps/server/src/services/ai/image-insert.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
} from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { completionResponse } from "./ai-mock.js";
import {
  fetchWebFile,
  type PageTransport,
} from "../apps/server/src/services/ai/web-fetch.js";
import {
  editAIDocument,
  readAIDocument,
} from "@core/workflows/ai-documents.js";
let db: DB, user: Actor, other: Actor, root: string, doc: string;
const prompt = "为测试文档画一株竹子";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  user = {
    ...(await createUser(
      db,
      {
        login: "image-owner",
        displayName: "图片测试",
        password: "image-test-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      {
        login: "image-other",
        displayName: "其他用户",
        password: "image-test-2026",
      },
      { actor: user },
    )),
    admin: 0,
  };
  root = await mkdtemp(join(tmpdir(), "doca-image-test-"));
  doc = (
    await createContent(db).create(user, {
      title: "图片测试",
      kind: "document",
      format: "markdown",
      markdown: "# 图片测试",
    })
  ).id;
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      imageModel: "image",
      vendors: [
        {
          id: "image-vendor",
          name: "图片厂商",
          provider: "openai",
          baseUrl: "https://images.example.test/v1",
          apiKey: "test-secret",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "image-vendor",
          model: "gpt-image-test",
          alias: "生图",
          enabled: true,
          tools: false,
          maxInput: 32000,
          maxOutput: 1000,
          imageGeneration: true, imageProfile: "gpt-image-2",
          imageRate: 250,
        },
      ],
    },
    0,
  );
});
afterEach(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
const imageResponse = async () =>
  Response.json({
    data: [
      {
        b64_json: (
          await sharp({
            create: {
              width: 32,
              height: 24,
              channels: 3,
              background: "#248a66",
            },
          })
            .png()
            .toBuffer()
        ).toString("base64"),
      },
    ],
    usage: { input_tokens: 12, output_tokens: 30 },
  });
const args = () => ({ resourceId: doc, prompt, size: "1024x1024" as const });

async function referenceImage(
  ctx: { jobId: string },
  options: { owner?: Actor; mime?: string; data?: Buffer } = {},
) {
  const data =
    options.data ??
    (await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#8764c0" },
    })
      .png()
      .toBuffer());
  const id = randomUUID();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const key = objectKey(id, "image/png");
  const runtime = { ...storageRuntime(), root };
  await createStorage(runtime).put(
    storageConfigForProfile(runtime, profile),
    key,
    data,
    "image/png",
    `${id}.png`,
  );
  await db
    .insertInto("assets")
    .values({
      id,
      owner_id: (options.owner ?? user).id,
      uploaded_by: (options.owner ?? user).id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: key,
      filename: `${id}.png`,
      mime: options.mime ?? "image/png",
      size: data.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    })
    .execute();
  const job = await db
    .selectFrom("ai_jobs")
    .select("input")
    .where("id", "=", ctx.jobId)
    .executeTakeFirstOrThrow();
  const input = JSON.parse(job.input);
  await db
    .updateTable("ai_jobs")
    .set({
      input: JSON.stringify({
        ...input,
        attachments: [...(input.attachments ?? []), id],
      }),
    })
    .where("id", "=", ctx.jobId)
    .execute();
  return { id, data };
}

it.each(["gpt-image-test", "compatible-image-model", "doubao-seedream-5.0-pro"])(
  "sends complete bounded reference previews to the %s edits endpoint without another generation",
  async (model) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      { ...config, models: config.models.map((m) => ({ ...m, model, imageProfile: "gpt-image-2" as const })) },
      revision,
    );
    const { ctx } = await imageJob();
    const reference = await referenceImage(ctx);
    let calls = 0;
    const input = { prompt, referenceImageIds: [reference.id] };
    const operation = randomUUID();
    const options = {
      storage: { ...storageRuntime(), root },
      fetch: (async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://images.example.test/v1/images/edits");
        expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
        const body = init?.body as FormData;
        expect(body).toBeInstanceOf(FormData);
        expect(body.get("prompt")).toBe(prompt);
        expect(body.get("n")).toBe("1");
        expect(body.has("watermark")).toBe(false);
        expect(body.has("output_format")).toBe(false);
        expect(body.get("size")).toBe("1200x896");
        expect(body.get("response_format")).toBeNull();
        const file = body.get("image") as File;
        expect(file.type).toBe("image/jpeg");
        const { modelImage } = await import("../apps/server/src/services/ai/model-image.js");
        expect(Buffer.from(await file.arrayBuffer())).toEqual((await modelImage(reference.data)).data);
        return imageResponse();
      }) as typeof fetch,
    };
    const result = await generateImageAsset(db, ctx, input, operation, options);
    expect(result.state).toBe("saved");
    expect(
      (await generateImageAsset(db, ctx, input, operation, options)).assetId,
    ).toBe(result.assetId);
    expect(calls).toBe(1);
    expect((await usageSummary(db, user.id)).calls).toEqual([
      expect.objectContaining({ images: 1, state: "confirmed" }),
    ]);
  },
);

it("preserves multi-image order and treats different references as different generation requests", async () => {
  const { ctx } = await imageJob();
  const first = await referenceImage(ctx),
    second = await referenceImage(ctx);
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: (async (_url, init) => {
      const form = init?.body as FormData;
      if (++calls === 1) {
        expect(form.get("image")).toBeNull();
        const files = form.getAll("image[]") as File[];
        expect(files.map((file) => file.name)).toEqual([
          `${second.id}.jpg`,
          `${first.id}.jpg`,
        ]);
      }
      return imageResponse();
    }) as typeof fetch,
  };
  await generateImageAsset(
    db,
    ctx,
    { prompt, referenceImageIds: [second.id, first.id] },
    randomUUID(),
    options,
  );
  await generateImageAsset(
    db,
    ctx,
    { prompt, referenceImageIds: [first.id] },
    randomUUID(),
    options,
  );
  expect(calls).toBe(2);
});

it.each(["doubao-seedream-4-5", "doubao-seedream-5-0-lite"])(
  "passes complete JPEG reference previews to %s generations while preserving original source pixels",
  async (model) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      { ...config, vendors:config.vendors.map(v=>({...v,provider:"doubao" as const})), models: config.models.map((m) => ({ ...m, model, imageProfile: model.includes("4-5") ? "doubao-seedream-4-5-251128" : "doubao-seedream-5-0-lite-260128" })) },
      revision,
    );
    const { ctx } = await imageJob();
    const first = await referenceImage(ctx),
      second = await referenceImage(ctx);
    await generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [second.id, first.id] },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (url, init) => {
          expect(String(url)).toBe(
            "https://images.example.test/v1/images/generations",
          );
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model,
            size: "2366x1774",
            response_format: "b64_json",
            sequential_image_generation: "disabled",
            watermark: false,
            image: await Promise.all([second, first].map(async ref => {
              const {modelImage}=await import("../apps/server/src/services/ai/model-image.js");
              return `data:image/jpeg;base64,${(await modelImage(ref.data)).data.toString("base64")}`;
            })),
          });
          expect(JSON.parse(String(init?.body)).output_format).toBe(
            model.includes("seedream-5-0") ? "png" : undefined,
          );
          return imageResponse();
        }) as typeof fetch,
      },
    );
  },
);

it("makes historical attachments and images generated in the same session available as references", async () => {
  const historical = await imageJob();
  const uploaded = await referenceImage(historical.ctx);
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: imageResponse as typeof fetch,
  };
  const generated = await generateImageAsset(
    db,
    historical.ctx,
    { prompt },
    randomUUID(),
    options,
  );
  const current = await imageJob(historical.sessionId);
  expect(
    (await availableImageReferences(db, current.ctx)).map((image) => image.id),
  ).toEqual(expect.arrayContaining([uploaded.id, generated.assetId]));
  await generateImageAsset(
    db,
    current.ctx,
    { prompt, referenceImageIds: [generated.assetId] },
    randomUUID(),
    {
      ...options,
      fetch: (async (url) => {
        expect(String(url)).toContain("/images/edits");
        return imageResponse();
      }) as typeof fetch,
    },
  );
});

it.each(["another-user", "another-session", "future-turn", "deleted"])(
  "rejects a %s reference before calling the provider or recording usage",
  async (kind) => {
    const { ctx, sessionId } = await imageJob();
    const referenceJob =
      kind === "another-session"
        ? await imageJob()
        : kind === "future-turn"
          ? await imageJob(sessionId)
          : { ctx };
    if (kind === "future-turn")
      await db
        .updateTable("ai_jobs")
        .set({ created_at: new Date(Date.now() + 1000).toISOString() })
        .where("id", "=", referenceJob.ctx.jobId)
        .execute();
    const reference = await referenceImage(referenceJob.ctx, {
      owner: kind === "another-user" ? other : user,
    });
    if (kind === "deleted")
      await db
        .updateTable("assets")
        .set({ deleted_at: new Date().toISOString() })
        .where("id", "=", reference.id)
        .execute();
    let calls = 0;
    await expect(
      generateImageAsset(
        db,
        ctx,
        { prompt, referenceImageIds: [reference.id] },
        randomUUID(),
        {
          storage: { ...storageRuntime(), root },
          fetch: (async () => {
            calls++;
            return imageResponse();
          }) as typeof fetch,
        },
      ),
    ).rejects.toThrow("不属于当前会话");
    expect(calls).toBe(0);
    expect((await usageSummary(db, user.id)).calls).toHaveLength(0);
  },
);

it.each(["corrupt", "unsupported", "oversized", "duplicate", "too-many"])(
  "rejects %s references before provider dispatch",
  async (kind) => {
    const { ctx } = await imageJob();
    const reference = await referenceImage(ctx, {
      ...(kind === "corrupt" ? { data: Buffer.from("not an image") } : {}),
      ...(kind === "unsupported" ? { mime: "image/gif" } : {}),
    });
    if (kind === "oversized")
      await db
        .updateTable("assets")
        .set({ size: 26 * 1024 * 1024 })
        .where("id", "=", reference.id)
        .execute();
    const refs =
      kind === "duplicate"
        ? [reference.id, reference.id]
        : kind === "too-many"
          ? Array.from({ length: 9 }, () => randomUUID())
          : [reference.id];
    await expect(
      generateImageAsset(
        db,
        ctx,
        { prompt, referenceImageIds: refs },
        randomUUID(),
        {
          storage: { ...storageRuntime(), root },
          fetch: (async () => {
            throw new Error("Provider must not be called");
          }) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/参考图片|附件/);
    expect((await usageSummary(db, user.id)).calls).toHaveLength(0);
  },
);

it("does not fall back to text generation when a provider rejects image edits", async () => {
  const { ctx } = await imageJob();
  const reference = await referenceImage(ctx);
  let calls = 0;
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [reference.id] },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (url) => {
          calls++;
          expect(String(url)).toContain("/images/edits");
          return Response.json({ error: "unsupported" }, { status: 404 });
        }) as typeof fetch,
      },
    ).catch(error => {
      expect(systemErrorReason(error)).toEqual({ code: "image_edit_failed", data: { status: 404 } });
      expect(systemErrorMessage(systemErrorText(error), createTranslator("en"))).toContain("image-to-image request failed (HTTP 404)");
      expect(error.message).toContain("不会自动改为文生图");
      throw error;
    }),
  ).rejects.toThrow("图生图调用失败");
  expect(calls).toBe(1);
  expect((await usageSummary(db, user.id)).calls[0]).toMatchObject({
    images: 0,
    state: "failed",
  });
});

it("rechecks withdrawn reference access after generation while preserving actual image usage", async () => {
  const { ctx } = await imageJob();
  const reference = await referenceImage(ctx);
  await expect(
    generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [reference.id] },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async () => {
          await db
            .updateTable("assets")
            .set({ deleted_at: new Date().toISOString() })
            .where("id", "=", reference.id)
            .execute();
          return imageResponse();
        }) as typeof fetch,
      },
    ),
  ).rejects.toThrow("参考图片不存在");
  expect(await db.selectFrom("assets").select("id").execute()).toEqual([
    { id: reference.id },
  ]);
  expect((await usageSummary(db, user.id)).calls[0]).toMatchObject({
    images: 1,
    state: "confirmed",
  });
});

it("advertises optional schema-valid image references without changing text-only inputs", () => {
  expect(imageInputSchema.parse({ prompt })).toEqual({ prompt });
  expect(
    imageInputSchema.parse({ prompt, referenceImageIds: [randomUUID()] })
      .referenceImageIds,
  ).toHaveLength(1);
  expect(
    imageInputSchema.safeParse({ prompt, referenceImageIds: [] }).success,
  ).toBe(false);
});

it("keeps PDF page reference IDs usable in later jobs and checks the original source on every use", async () => {
  const { uploadAIAttachment } =
    await import("../apps/server/src/services/ai/upload-attachment.js");
  const { prepareFileRecognition } =
    await import("../apps/server/src/services/ai/file-recognition.js");
  const { registerVisualReferences, visualSourceAccess } =
    await import("../apps/server/src/services/ai/session-attachments.js");
  const runtime = { ...storageRuntime(), root };
  const first = await imageJob();
  const asset = await uploadAIAttachment(
    db,
    user.id,
    "book.pdf",
    await readFile(
      new URL("./fixtures/ai-recognition/text.pdf", import.meta.url),
    ),
    runtime,
  );
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ attachments: [asset.id] }) })
    .where("id", "=", first.ctx.jobId)
    .execute();
  const prepared = await prepareFileRecognition(db, {
    objectId: asset.id,
    storage: runtime,
    imageLimit: 1,
  });
  const [page] = await registerVisualReferences(
    db,
    first.ctx,
    { assetId: asset.id },
    asset.id,
    prepared.images.map((image) => image.part),
  );
  const later = await imageJob(first.sessionId);
  expect(
    (await availableImageReferences(db, later.ctx)).map((row) => row.id),
  ).toContain(page!.referenceImageId);
  let dispatched = false;
  await generateImageAsset(
    db,
    later.ctx,
    {
      prompt: "保留书页构图，替换妈妈",
      referenceImageIds: [page!.referenceImageId],
    },
    randomUUID(),
    {
      storage: runtime,
      fetch: (async (_url: any, init: any) => {
        const image = init.body.get("image[]") ?? init.body.get("image");
        const { modelImage } = await import("../apps/server/src/services/ai/model-image.js");
        expect(Buffer.from(await image.arrayBuffer())).toEqual(
          (await modelImage(prepared.images[0]!.data)).data,
        );
        dispatched = true;
        return imageResponse();
      }) as typeof fetch,
    },
  );
  expect(dispatched).toBe(true);
  const unrelated = await imageJob();
  expect(
    (await availableImageReferences(db, unrelated.ctx)).map((row) => row.id),
  ).not.toContain(page!.referenceImageId);
  await expect(
    visualSourceAccess(
      db,
      { ...later.ctx, actor: other },
      { assetId: asset.id },
    ),
  ).rejects.toThrow();
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date().toISOString() })
    .where("id", "=", asset.id)
    .execute();
  expect(
    (await availableImageReferences(db, later.ctx)).map((row) => row.id),
  ).not.toContain(page!.referenceImageId);
});

it("routes an uploaded reference and a later generated-image edit through the chat agent", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      vendors: [
        ...config.vendors,
        {
          id: "chat-vendor",
          name: "对话测试",
          provider: "compatible",
          baseUrl: "https://chat.example.test/v1",
          apiKey: "chat-test-secret",
          enabled: true,
        },
      ],
      models: [
        ...config.models,
        {
          id: "chat",
          vendorId: "chat-vendor",
          model: "mock-chat",
          alias: "对话",
          enabled: true,
          tools: true,
          vision: true,
          maxInput: 64000,
          maxOutput: 2000,
        },
      ],
    },
    revision,
  );
  let selectedReference = "",
    imageCalls = 0;
  const referenceMimes: string[] = [];
  const origin = "http://localhost:39249";
  const app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      imageFetch: (async (url, init) => {
        imageCalls++;
        expect(String(url)).toBe("https://images.example.test/v1/images/edits");
        referenceMimes.push(
          (init?.body as FormData).get("image") instanceof File
            ? ((init?.body as FormData).get("image") as File).type
            : "missing",
        );
        return imageResponse();
      }) as typeof fetch,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const messages = body.messages ?? [];
        const lastUser = messages.findLastIndex(
          (message: any) => message.role === "user",
        );
        const finished = messages
          .slice(lastUser + 1)
          .some((message: any) => message.role === "tool");
        const imageTool = body.tools?.find(
          (tool: any) => tool.function?.name === "image_edit",
        );
        let message: object;
        if (imageTool && !finished) {
          expect(imageTool.function.parameters.properties).toHaveProperty(
            "referenceImageIds",
          );
          expect(JSON.stringify(messages[lastUser])).toContain(
            "当前会话可用参考图片",
          );
          expect(JSON.stringify(messages[lastUser])).toContain(
            selectedReference,
          );
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: "image_edit",
                  arguments: JSON.stringify({
                    prompt: "保留参考图中的主体，将背景改成竹林",
                    sourceImageId: selectedReference,
                  }),
                },
              },
            ],
          };
        } else message = { role: "assistant", content: "图片已生成。" };
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
                finish_reason: imageTool && !finished ? "tool_calls" : "stop",
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
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin, host: "localhost:39249" },
      payload: { login: "image-owner", password: "image-test-2026" },
    });
    const headers = {
      origin,
      host: "localhost:39249",
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    };
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/v1/ai/sessions",
        headers,
        payload: { modelId: "chat", resourceIds: [] },
      })
    ).json().id;
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#248a66" },
    })
      .png()
      .toBuffer();
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/assets?purpose=ai_attachment&filename=reference.png",
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: png,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    selectedReference = upload.json().id;
    for (const turn of [0, 1]) {
      const id = randomUUID();
      const send = await app.inject({
        method: "POST",
        url: `/api/v1/ai/sessions/${session}/messages`,
        headers,
        payload: {
          id,
          modelId: "chat",
          scope: "all",
          text: turn ? "继续修改刚才生成的图片" : "参考附件生成一张图片",
          attachments: turn ? [] : [selectedReference],
        },
      });
      expect(send.statusCode, send.body).toBe(200);
      let job: any;
      for (let attempt = 0; attempt < 150; attempt++) {
        const state = (
          await app.inject({ url: `/api/v1/ai/sessions/${session}`, headers })
        ).json();
        job = state.jobs.find((item: any) => item.id === id);
        if (job && !["queued", "running"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(job?.status, job?.error).toBe("completed");
      const operation = await db
        .selectFrom("ai_operations")
        .select("result")
        .where("job_id", "=", id)
        .where("result", "like", '%"image_generation"%')
        .executeTakeFirstOrThrow();
      selectedReference = JSON.parse(operation.result).assetId;
    }
    expect(imageCalls).toBe(2);
    expect(referenceMimes).toEqual(["image/jpeg", "image/jpeg"]);
  } finally {
    await app.close();
  }
});
it.each([
  ["1:1", "2048x2048"],
  ["16:9", "2731x1536"],
  ["9:16", "1537x2731"],
  ["4:3", "2366x1774"],
  ["3:4", "1774x2365"],
  ["3:2", "2510x1673"],
  ["2:3", "1673x2509"],
] as const)(
  "uses a supported Seedream size for aspect ratio %s",
  async (aspectRatio, size) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })),
        models: config.models.map((model) => ({
          ...model,
          model: "doubao-seedream-4-5", imageProfile: "doubao-seedream-4-5-251128",
        })),
      },
      revision,
    );
    const result = await generateImageAsset(
      db,
      { actor: user },
      { prompt, aspectRatio },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            size,
            response_format: "b64_json",
          });
          return imageResponse();
        }) as typeof fetch,
      },
    );
    expect(result.state).toBe("saved");
  },
);

it("preserves the configured Seedream default and rejects explicit unsupported sizes before billing", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })),
      models: config.models.map((model) => ({
        ...model,
        model: "doubao-seedream-4-5", imageProfile: "doubao-seedream-4-5-251128",
        imageSize: "4096x4096",
      })),
    },
    revision,
  );
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: (async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init?.body)).size).toBe("4096x4096");
      return imageResponse();
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(
      db,
      { actor: user },
      { prompt, size: "1024x1024" },
      randomUUID(),
      options,
    ),
  ).rejects.toThrow("不支持该图片尺寸");
  expect(calls).toBe(0);
  expect((await usageSummary(db, user.id)).calls).toHaveLength(0);
  await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    options,
  );
  expect(calls).toBe(1);
});

it.each([
  { width: 1500, height: 2000, orientation: 1 },
  { width: 2000, height: 1500, orientation: 1 },
  { width: 2000, height: 1500, orientation: 6 },
  { width: 1800, height: 2400, orientation: 1 },
])(
  "chooses native Seedream whole-page dimensions from oriented source $width x $height rather than a square configuration (orientation $orientation)",
  async ({ width, height, orientation }) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })),
        models: config.models.map((model) => ({
          ...model,
          model: "doubao-seedream-5.0-pro",
          imageProfile: "doubao-seedream-5-0-pro-260628" as const,
          imageSize: "2048x2048",
        })),
      },
      revision,
    );
    const { ctx } = await imageJob();
    const source = await sharp({
      create: { width, height, channels: 3, background: "#8764c0" },
    })
      .withMetadata({ orientation })
      .png()
      .toBuffer();
    const reference = await referenceImage(ctx, { data: source });
    const oriented = (await sharp(source).metadata()).autoOrient;
    let requested: number[] = [],
      calls = 0;
    const result = await generateImageAsset(
      db,
      ctx,
      {
        prompt:
          "Modify the action while preserving the complete page composition",
        referenceImageIds: [reference.id],
      },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          requested = body.size.split("x").map(Number);
          expect(requested).toEqual([oriented.width, oriented.height]);
          expect(
            Math.abs(
              requested[0]! / requested[1]! - oriented.width / oriented.height,
            ),
          ).toBeLessThan(0.001);
          expect(requested[0]! * requested[1]!).toBeGreaterThanOrEqual(921600);
          expect(requested[0]! * requested[1]!).toBeLessThanOrEqual(4624220);
          const transport = Buffer.from(body.image.split(",")[1], "base64");
          const preview = await sharp(transport).metadata();
          expect(
            Math.abs(
              preview.width! / preview.height! -
                oriented.width / oriented.height,
            ),
          ).toBeLessThan(0.001);
          const pixels = await sharp({
            create: {
              width: requested[0]!,
              height: requested[1]!,
              channels: 3,
              background: "#248a66",
            },
          })
            .png()
            .toBuffer();
          return Response.json({
            data: [{ b64_json: pixels.toString("base64") }],
            usage: { input_images: 1, generated_images: 1 },
          });
        }) as typeof fetch,
      },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      state: "saved",
      width: requested[0],
      height: requested[1],
    });
    const saved = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", result.assetId)
      .executeTakeFirstOrThrow();
    expect(
      await sharp(await readFile(join(root, saved.object_key))).metadata(),
    ).toMatchObject({
      format: "png",
      width: requested[0],
      height: requested[1],
    });
    expect((await usageSummary(db, user.id)).calls).toEqual([
      expect.objectContaining({ images: 1, state: "confirmed" }),
    ]);
  },
);

it.each([
  { size: "2048x2048", expected: "2048x2048", regions: false },
  { aspectRatio: "16:9" as const, expected: "2731x1536", regions: false },
  { size: "2048x2048", expected: "2048x2048", regions: true },
  { aspectRatio: "16:9" as const, expected: "2731x1536", regions: true },
])(
  "keeps explicit native output size/aspectRatio ahead of source or viewport inference: $expected, regions $regions",
  async ({ size, aspectRatio, expected, regions }) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })),
        models: config.models.map((model) => ({
          ...model,
          model: "doubao-seedream-5.0-pro",
          imageProfile: "doubao-seedream-5-0-pro-260628" as const,
          imageSize: "2048x2048",
        })),
      },
      revision,
    );
    const { ctx } = await imageJob();
    const reference = await referenceImage(ctx, {
      data: await sharp({
        create: {
          width: 1500,
          height: 2000,
          channels: 3,
          background: "#8764c0",
        },
      })
        .png()
        .toBuffer(),
    });
    let calls = 0;
    await generateImageAsset(
      db,
      ctx,
      {
        prompt,
        referenceImageIds: [reference.id],
        ...(size ? { size } : { aspectRatio }),
        ...(regions
          ? {
              editRegions: [
                {
                  label: "target",
                  points: [
                    [0.2, 0.2],
                    [0.8, 0.2],
                    [0.8, 0.8],
                    [0.2, 0.8],
                  ] as [number, number][],
                },
              ],
            }
          : {}),
      },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async (_url, init) => {
          calls++;
          expect(JSON.parse(String(init?.body)).size).toBe(expected);
          return imageResponse();
        }) as typeof fetch,
      },
    );
    expect(calls).toBe(1);
  },
);

it.each([
  { width: 3000, height: 4000 },
  { width: 2000, height: 100 },
])(
  "rejects unsupported native source geometry $width x $height before reserving an operation or paying",
  async ({ width, height }) => {
    const { revision, ...config } = await aiConfig(db);
    await saveAIConfig(
      db,
      {
        ...config,
        vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })),
        models: config.models.map((model) => ({
          ...model,
          model: "doubao-seedream-5.0-pro",
          imageProfile: "doubao-seedream-5-0-pro-260628" as const,
          imageSize: "2048x2048",
        })),
      },
      revision,
    );
    const { ctx } = await imageJob();
    const reference = await referenceImage(ctx, {
      data: await sharp({
        create: { width, height, channels: 3, background: "#8764c0" },
      })
        .png()
        .toBuffer(),
    });
    let calls = 0;
    const operationId = randomUUID();
    const error = await generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [reference.id] },
      operationId,
      {
        storage: { ...storageRuntime(), root },
        fetch: (async () => {
          calls++;
          return imageResponse();
        }) as typeof fetch,
      },
    ).catch((error) => error);
    expect(error).toMatchObject({ status: 400 });
    expect(systemErrorReason(error)).toEqual({
      code: "image_reference_size_unsupported",
    });
    expect(calls).toBe(0);
    expect((await usageSummary(db, user.id)).calls).toHaveLength(0);
    expect(
      await db
        .selectFrom("ai_operations")
        .select("id")
        .where("id", "=", operationId)
        .executeTakeFirst(),
    ).toBeUndefined();
  },
);

it("reports a local save failure separately from uncertain provider usage and prevents duplicate billing", async () => {
  const { ctx, sessionId } = await imageJob();
  const invalidRoot = join(root, "not-a-directory");
  await writeFile(invalidRoot, "occupied");
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root: invalidRoot },
    fetch: (async () => {
      calls++;
      return imageResponse();
    }) as typeof fetch,
  };
  const operation = randomUUID();
  await expect(
    generateImageAsset(db, ctx, { prompt }, operation, options),
  ).rejects.toThrow("图片保存失败");
  const row = await db
    .selectFrom("ai_operations")
    .select("result")
    .where("id", "=", operation)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.result).state).toBe("save_failed");
  expect((await usageSummary(db, user.id)).calls[0]).toMatchObject({
    images: 1,
    state: "confirmed",
  });
  await expect(
    generateImageAsset(db, ctx, { prompt }, operation, options),
  ).rejects.toThrow("已生成但保存失败");
  const retry = await imageJob(sessionId);
  await expect(
    generateImageAsset(db, retry.ctx, { prompt }, randomUUID(), {
      ...options,
      relatedJobIds: [ctx.jobId, retry.ctx.jobId],
    }),
  ).rejects.toThrow("不能重复提交");
  expect(calls).toBe(1);
  expect(await db.selectFrom("assets").selectAll().execute()).toHaveLength(0);
});

async function imageJob(sessionId?: string) {
  const now = new Date().toISOString();
  if (!sessionId) {
    sessionId = randomUUID();
    await db
      .insertInto("ai_sessions")
      .values({
        id: sessionId,
        user_id: user.id,
        title: "图片请求测试",
        model_id: "image",
        resource_ids: "[]",
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const jobId = randomUUID(),
    lease = randomUUID();
  await db
    .insertInto("ai_jobs")
    .values({
      id: jobId,
      session_id: sessionId,
      user_id: user.id,
      model_id: "image",
      status: "running",
      input: "{}",
      digest: jobId,
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
  return { ctx: { actor: user, jobId, lease }, sessionId };
}

it.each(["chat", "document"] as const)(
  "generates distinct %s images concurrently while blocking duplicate requests",
  async (target) => {
    const { ctx } = await imageJob();
    const input = target === "chat" ? { prompt } : args();
    let markStarted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const options = {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        calls++;
        if (calls === 1) {
          markStarted();
          await released;
        }
        return imageResponse();
      }) as typeof fetch,
    };
    const operation = randomUUID();
    const first = generateImageAsset(db, ctx, input, operation, options);
    try {
      await started;
      await expect(
        generateImageAsset(db, ctx, input, operation, options),
      ).rejects.toThrow("请勿重复生成");
      await expect(
        generateImageAsset(db, ctx, input, randomUUID(), options),
      ).rejects.toThrow("不能重复提交");
      const second = await generateImageAsset(
        db,
        ctx,
        { ...input, prompt: "画一朵红色的花" },
        randomUUID(),
        options,
      );
      expect(second.state).toBe("saved");
      expect(calls).toBe(2);
    } finally {
      release();
      await first;
    }
    const imageAssets = await db.selectFrom("assets").select(["id", "purpose"]).execute();
    expect(imageAssets.filter(asset => asset.purpose === "ai_attachment")).toHaveLength(2);
    expect(imageAssets.filter(asset => asset.purpose === "ai_image_candidate")).toHaveLength(2);
    expect((await usageSummary(db, user.id)).calls).toHaveLength(2);
  },
);

it("keeps uncertain requests protected across retries without blocking different images or new requests", async () => {
  const { ctx, sessionId } = await imageJob();
  const input = { prompt };
  await expect(
    generateImageAsset(db, ctx, input, randomUUID(), {
      fetch: (async () => {
        throw new Error("Connection lost");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("结果和费用待核对");
  await db
    .updateTable("ai_jobs")
    .set({ status: "failed" })
    .where("id", "=", ctx.jobId)
    .execute();
  const retry = await imageJob(sessionId);
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    relatedJobIds: [retry.ctx.jobId, ctx.jobId],
    fetch: (async () => {
      calls++;
      return imageResponse();
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(db, retry.ctx, input, randomUUID(), options),
  ).rejects.toThrow("不能重复提交");
  expect(calls).toBe(0);
  const different = await generateImageAsset(
    db,
    retry.ctx,
    { prompt: "画一朵红色的花" },
    randomUUID(),
    options,
  );
  expect(different.state).toBe("saved");
  const fresh = await imageJob(sessionId);
  const requested = await generateImageAsset(
    db,
    fresh.ctx,
    input,
    randomUUID(),
    {
      ...options,
      relatedJobIds: undefined,
    },
  );
  expect(requested.state).toBe("saved");
  expect(calls).toBe(2);
  expect(
    (await usageSummary(db, user.id)).calls.filter(
      (c) => c.state === "pending",
    ),
  ).toHaveLength(1);
});

it("tests the configured image endpoint with a real minimal generation request", async () => {
  let requestBody: any;
  const result = await testAIImageModel(
    {
      id: "image",
      vendorId: "image-vendor",
      provider: "openai",
      baseUrl: "https://images.example.test/v1",
      apiKey: "test-secret",
      model: "gpt-image-test",
      alias: "生图",
      enabled: true,
      tools: false,
      maxInput: 32000,
      maxOutput: 1000,
      imageGeneration: true, imageProfile: "gpt-image-2",
    },
    (async (url, init) => {
      expect(String(url)).toBe(
        "https://images.example.test/v1/images/generations",
      );
      requestBody = JSON.parse(String(init?.body));
      return imageResponse();
    }) as typeof fetch,
  );
  expect(requestBody).toMatchObject({
    model: "gpt-image-test",
    n: 1,
    size: "1024x1024",
  });
  expect(result.usage.inputTokens.total).toBe(12);
  expect(result.usage.outputTokens.total).toBe(30);
});
it("generates a private chat image without a document and inserts into five native formats without regenerating or duplicating", async () => {
  const runtime = { ...storageRuntime(), root };
  const image = await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    { storage: runtime, fetch: imageResponse as typeof fetch },
  );
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", image.assetId)
    .executeTakeFirstOrThrow();
  expect(asset).toMatchObject({
    resource_id: null,
    purpose: "ai_attachment",
    owner_id: user.id,
  });
  for (const format of [
    "markdown",
    "rich_text",
    "canvas",
    "presentation",
    "spreadsheet",
  ] as const) {
    const target = await createContent(db).create(user, {
      kind: "document",
      format,
      title: `插入测试 ${format}`,
    });
    const requestId = randomUUID();
    const input = { assetId: image.assetId, resourceId: target.id };
    const saved = await insertGeneratedImage(
      db,
      { actor: user },
      input,
      requestId,
      runtime,
    );
    expect(
      await insertGeneratedImage(
        db,
        { actor: user },
        input,
        requestId,
        runtime,
      ),
    ).toEqual(saved);
    const history = await createHistory(db).versions(user, target.id);
    expect(history.items.some((v) => v.is_ai)).toBe(true);
    const result = await readAIDocument(db, { actor: user }, target.id);
    expect(JSON.stringify(result.value)).toContain(saved.assetId);
    expect(
      await db
        .selectFrom("assets")
        .select("id")
        .where("resource_id", "=", target.id)
        .execute(),
    ).toHaveLength(1);
    if (format === "canvas") {
      const element = (result.value as any).scene.children[0];
      expect(element.id).toBeTruthy();
      expect(element).toMatchObject({
        tag: "Image",
        name: "image",
        lockRatio: true,
        data: {
          resourcePath: saved.assetId,
          naturalWidth: 32,
          naturalHeight: 24,
        },
      });
      await editAIDocument(
        db,
        { actor: user },
        target.id,
        { seq: result.seq, epochId: result.epochId! },
        [
          {
            type: "patch",
            id: element.id,
            patch: { opacity: 0.5, width: 300 },
          },
        ],
        randomUUID(),
      );
      const restored = await readAIDocument(db, { actor: user }, target.id);
      expect((restored.value as any).scene.children[0]).toMatchObject({
        id: element.id,
        name: "image",
        opacity: 0.5,
        width: 300,
        data: { resourcePath: saved.assetId },
      });
    }
    if (format === "presentation")
      expect((result.value as any).slideOrder).toHaveLength(2);
    if (format === "spreadsheet") {
      const raw = (result.value as any).resources?.find(
        (r: any) => r.name === "EXLSX_FLOATING_OBJECTS",
      )?.data;
      const floating = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
      expect(JSON.stringify(floating)).toContain(saved.assetId);
    }
  }
  const physicalObjects = await db
    .selectFrom("file_storage_objects")
    .select(["id", "object_key"])
    .execute();
  const raw = await db.selectFrom("assets").selectAll().where("id", "=", image.rawCandidate!.assetId).executeTakeFirstOrThrow();
  expect(raw.purpose).toBe("ai_image_candidate");
  expect(physicalObjects).toHaveLength(2);
  expect(physicalObjects).toEqual(expect.arrayContaining([
    { id: image.assetId, object_key: asset.object_key },
    { id: raw.id, object_key: raw.object_key },
  ]));
  expect(await db.selectFrom("file_items").select("id").where("storage_object_id", "=", raw.id).execute()).toEqual([]);
  const locations = await db
    .selectFrom("file_items")
    .select(["parent_type", "parent_id", "storage_object_id"])
    .where("storage_object_id", "=", image.assetId)
    .execute();
  expect(locations).toHaveLength(6);
  expect(
    locations.filter((item) => item.parent_type === "system"),
  ).toHaveLength(1);
  expect(
    locations.filter((item) => item.parent_type === "document"),
  ).toHaveLength(5);
  expect(
    new Set(
      (await db.selectFrom("assets").select("object_key").execute()).map(
        (row) => row.object_key,
      ),
    ),
  ).toEqual(new Set([asset.object_key, raw.object_key]));
  expect((await usageSummary(db, user.id)).calls).toHaveLength(1);
  expect(
    await generatedImageStatus(db, { actor: user }, image.assetId),
  ).toEqual({ ready: true, pending: false });
  const otherDoc = await createContent(db).create(other, {
    kind: "document",
    format: "markdown",
    title: "他人的文档",
  });
  await expect(
    insertGeneratedImage(
      db,
      { actor: other },
      { assetId: image.assetId, resourceId: otherDoc.id },
      randomUUID(),
      runtime,
    ),
  ).rejects.toThrow("自己生成");
  await expect(
    insertGeneratedImage(
      db,
      { actor: user },
      { assetId: image.assetId, resourceId: otherDoc.id },
      randomUUID(),
      runtime,
    ),
  ).rejects.toThrow();
});
it("requires an image count for pending image reconciliation and charges the configured per-image price once", async () => {
  const app = await createApp(db, {
    origin: "http://localhost:39249",
    storage: { ...storageRuntime(), root },
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:39249", host: "localhost:39249" },
      payload: { login: "image-owner", password: "image-test-2026" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const call = await beginCall(db, user.id, "image", null, 0, 0, 1);
    await settleCall(db, call.id, null);
    const reconcile = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admin/ai/calls/${call.id}/reconcile`,
        headers: {
          origin: "http://localhost:39249",
          host: "localhost:39249",
          cookie,
        },
        payload,
      });
    expect((await reconcile({ input: 0, output: 0 })).statusCode).toBe(400);
    expect(
      (await reconcile({ input: 12, output: 30, images: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await reconcile({ input: 12, output: 30, images: 1 })).statusCode,
    ).toBe(409);
    const usage = (await usageSummary(db, user.id)).calls.find(
      (c) => c.id === call.id,
    )!;
    expect(usage).toMatchObject({
      callKind: "image",
      images: 1,
      input: 0,
      output: 0,
      image: 250,
      total: 250,
      state: "reconciled",
    });
  } finally {
    await app.close();
  }
});
it("stores an owned asset, inserts through native document tools, and bills once per image with real tokens separate", async () => {
  let calls = 0;
  const options = {
    storage: { ...storageRuntime(), root },
    fetch: (async (url, init) => {
      calls++;
      expect(String(url)).toBe(
        "https://images.example.test/v1/images/generations",
      );
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toMatchObject({ n: 1, prompt });
      return imageResponse();
    }) as typeof fetch,
  };
  const operation = randomUUID();
  const result = await generateImageAsset(
    db,
    { actor: user },
    args(),
    operation,
    options,
  );
  expect(result).toMatchObject({
    width: 32,
    height: 24,
    ready: true,
    resourceId: doc,
  });
  const reused = await generateImageAsset(
    db,
    { actor: user },
    args(),
    operation,
    options,
  );
  expect(reused.assetId).toBe(result.assetId);
  expect(calls).toBe(1);
  const row = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", result.assetId)
    .executeTakeFirstOrThrow();
  expect(row.owner_id).toBe(user.id);
  expect(row.resource_id).toBeNull();
  expect(row.purpose).toBe("ai_attachment");
  expect(
    await db
      .selectFrom("file_items")
      .selectAll()
      .where("storage_object_id", "=", row.id)
      .execute(),
  ).toEqual([
    expect.objectContaining({ parent_type: "system", parent_id: "ai" }),
  ]);
  expect(
    (await sharp(await readFile(join(root, row.object_key))).metadata()).format,
  ).toBe("png");
  expect(row.mime).toBe("image/png");
  expect(row.filename.endsWith(".png")).toBe(true);
  const storedPixels = await sharp(await readFile(join(root, row.object_key))).ensureAlpha().raw().toBuffer();
  const providerPixels = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#248a66" } }).ensureAlpha().raw().toBuffer();
  expect(storedPixels).toEqual(providerPixels);
  const before = await readAIDocument(db, { actor: user }, doc);
  await editAIDocument(
    db,
    { actor: user },
    doc,
    { seq: before.seq, epochId: before.epochId! },
    [{ type: "append", text: `\n\n![竹子](${result.url})` }],
    randomUUID(),
  );
  expect(
    JSON.stringify((await readAIDocument(db, { actor: user }, doc)).value),
  ).toContain(result.assetId);
  const usage = await usageSummary(db, user.id);
  expect(usage.tokens.day).toMatchObject({
    input: 0,
    output: 0,
    image: 250,
    total: 250,
  });
  expect(usage.calls[0]).toMatchObject({
    input: 0,
    output: 0,
    image: 250,
    total: 250,
    images: 1,
    state: "confirmed",
  });
  await expect(
    generateImageAsset(db, { actor: other }, args(), operation, options),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("independently rejects an actual saved image whose identity or blend fails instead of trusting its save receipt", async () => {
  const { revision, ...config }=await aiConfig(db);
  await saveAIConfig(db,{...config,models:[...config.models,{id:"review",vendorId:"image-vendor",model:"mock-vision",alias:"Review",enabled:true,vision:true,tools:false,apiMode:"chat",maxInput:64000,maxOutput:3000}]},revision);
  const {ctx}=await imageJob();
  const userRequest="仅替换目标人物，原图背景不变";
  await db.updateTable("ai_jobs").set({input:JSON.stringify({text:userRequest})}).where("id","=",ctx.jobId).execute();
  const userRequestMetadata={nonCitable:true as const,requests:[{requestIndex:0,kind:"original" as const,
    jobId:ctx.jobId,rootJobId:ctx.jobId,messageId:ctx.jobId,boundToRootJobId:null,question:null}],
    rules:["宿主来源身份只定位正式原文，不是可引用的用户授权。"]};
  const reference=await referenceImage(ctx);
  const result=await generateImageAsset(db,ctx,{prompt:"将人物替换为指定真实人物，背景保持不变",referenceImageIds:[reference.id]},randomUUID(),{storage:{...storageRuntime(),root},fetch:imageResponse as typeof fetch});
  const {reviewImageDelivery,imageReviewSchema}=await import("../apps/server/src/services/ai/image-review.js");
  expect(imageReviewSchema.safeParse({verdict:"pass",summary:"可以",checks:[{id:"integration",passed:false,evidence:"头部错位"}]}).success).toBe(false);
  const review=await reviewImageDelivery(db,ctx,{assetId:result.assetId,referenceImageId:reference.id,taskScope:{kind:"single-image",referenceImageId:reference.id},sceneContext:null,userRequests:[userRequest],userRequestMetadata,criteria:["人物与参考一致、比例自然、没有贴纸边"],notes:""},{ precision: "native",model:(await aiConfig(db)).models.find(m=>m.id==="review")!,storage:{...storageRuntime(),root},fetch:(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    expect(JSON.stringify(body.messages)).toContain("原图背景不变");
    expect(body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((part:any)=>part.type==="image_url")).toHaveLength(2);
    const metadata=JSON.parse(body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).find((part:any)=>part.type==="text" && part.text.startsWith('{"requiredChecks"')).text);
    return Response.json({id:"review",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({verdict:"revise",summary:"头像错位且与指定人物不一致",checks:metadata.requiredChecks.map((check:any)=>({id:check.id,passed:check.id!=="integration",evidence:check.id==="integration"?"原图与结果对照，头部比例过大且有硬边":"原图与结果中的相关内容符合"}))})},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}});
  }) as typeof fetch});
  expect(review.passed).toBe(false);
  expect(review.evidence).toContain("头部比例过大");
});

it("requires a supported profile and rejects a native profile on an OpenAI-compatible connection", async () => {
  const { revision, ...config } = await aiConfig(db);
  await expect(saveAIConfig(db, { ...config, models: config.models.map(m => ({ ...m, imageProfile: undefined })) }, revision)).rejects.toThrow("支持清单");
  await expect(saveAIConfig(db, { ...config, models: config.models.map(m => ({ ...m, imageProfile: "doubao-seedream-5-0-pro-260628" })) }, revision)).rejects.toThrow("支持清单");
  await saveAIConfig(db, { ...config, vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const })), models: config.models.map(m => ({ ...m, model: "ep-deployment-id", imageProfile: "doubao-seedream-5-0-pro-260628", imageSize: "2048x2048" })) }, revision);
  const { ctx } = await imageJob();
  const ref = await referenceImage(ctx);
  let calls = 0;
  await generateImageAsset(db, ctx, { prompt, referenceImageIds: [ref.id] }, randomUUID(), { storage: { ...storageRuntime(), root }, fetch: (async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://images.example.test/v1/images/generations");
    expect(JSON.parse(String(init?.body)).image).toEqual(expect.stringMatching(/^data:image\/jpeg;base64,/));
    expect(JSON.parse(String(init?.body))).toMatchObject({ output_format: "png", watermark: false });
    return imageResponse();
  }) as typeof fetch });
  expect(calls).toBe(1);
});

it.each([0, 2, undefined, -1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1])(
  "retains only an explicitly reported safe provider input-image count (%s)",
  async (inputImages) => {
    const { ctx } = await imageJob();
    const ref = await referenceImage(ctx);
    const result = await generateImageAsset(
      db,
      ctx,
      { prompt, referenceImageIds: [ref.id] },
      randomUUID(),
      {
        storage: { ...storageRuntime(), root },
        fetch: (async () => {
          const body = await (await imageResponse()).json();
          if (inputImages !== undefined) body.usage.input_images = inputImages;
          return Response.json(body);
        }) as typeof fetch,
      },
    );
    const expected = Number.isSafeInteger(inputImages) && Number(inputImages) >= 0
      ? { inputImages }
      : undefined;
    expect(result.providerImageUsage).toEqual(expected);
    const receipt = await db.selectFrom("ai_operations").select("result")
      .where("result", "like", `%"assetId":"${result.assetId}"%`)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(receipt.result).providerImageUsage).toEqual(expected);
    expect(result.generation).toEqual({ prompt, referenceImageIds: [ref.id] });
  },
);

it("bounds paid retries for one source page even when the agent changes prompts and retains all saved receipts", async () => {
  const { ctx } = await imageJob();
  const ref = await referenceImage(ctx);
  let calls = 0;
  const options = { storage: { ...storageRuntime(), root }, fetch: (async () => { calls++; return imageResponse(); }) as typeof fetch };
  const outputs = [];
  for (let n = 0; n < 5; n++) outputs.push(await generateImageAsset(db, ctx, { prompt: `修复 ${n}`, referenceImageIds: [ref.id] }, randomUUID(), options));
  await expect(generateImageAsset(db, ctx, { prompt: "换一个提示继续", referenceImageIds: [ref.id] }, randomUUID(), options)).rejects.toThrow("本页已提交5次");
  expect(calls).toBe(5);
  expect((await availableImageReferences(db, ctx)).map(r => r.id)).toEqual(expect.arrayContaining(outputs.map(r => r.assetId)));
});

it("retains failed request facts so changed prompts cannot bypass the page attempt limit", async () => {
  const { ctx } = await imageJob();
  const ref = await referenceImage(ctx);
  let calls = 0;
  const options = { storage: { ...storageRuntime(), root }, fetch: (async () => { calls++; return Response.json({ error: "bad request" }, { status: 400 }); }) as typeof fetch };
  for (let n = 0; n < 5; n++) {
    const operationId = randomUUID();
    await expect(generateImageAsset(db, ctx, { prompt: `修复 ${n}`, referenceImageIds: [ref.id] }, operationId, options)).rejects.toThrow("图生图调用失败");
    const row = await db.selectFrom("ai_operations").select("result").where("id", "=", operationId).executeTakeFirstOrThrow();
    expect(JSON.parse(row.result)).toMatchObject({ state: "failed", generation: { prompt: `修复 ${n}`, referenceImageIds: [ref.id] } });
  }
  await expect(generateImageAsset(db, ctx, { prompt: "再换提示", referenceImageIds: [ref.id] }, randomUUID(), options)).rejects.toThrow("本页已提交5次");
  expect(calls).toBe(5);
});

it("keeps an explicit content rejection distinct from interface errors and retains its failed call without creating an image", async () => {
  const { ctx } = await imageJob();
  const ref = await referenceImage(ctx);
  let calls = 0;
  const operationId = randomUUID();
  try {
    await generateImageAsset(db, ctx, { prompt: "Edit this family story page", referenceImageIds: [ref.id] }, operationId, {
      operation: "edit", storage: { ...storageRuntime(), root },
      fetch: (async () => {
        calls++;
        return Response.json({ error: { code: "InputTextSensitiveContentDetected", message: "do-not-expose-private-debug" } }, { status: 400 });
      }) as typeof fetch,
    });
    expect.fail("The provider refused this request");
  } catch (error) {
    expect(systemErrorReason(error)).toEqual({ code: "image_content_rejected", data: { status: 400 } });
    expect(String(error)).not.toContain("do-not-expose-private-debug");
  }
  expect(calls).toBe(1);
  const row = await db.selectFrom("ai_operations").select("result").where("id", "=", operationId).executeTakeFirstOrThrow();
  const receipt = JSON.parse(row.result);
  expect(receipt.state).toBe("failed");
  expect(receipt.assetId).toBeUndefined();
  const call = await db.selectFrom("ai_calls").selectAll().where("id", "=", receipt.providerCallId).executeTakeFirstOrThrow();
  expect(call.state).toBe("failed");
  expect(JSON.parse(call.usage).providerMetrics.images).toBe(0);
  expect((await availableImageReferences(db, ctx)).map(r => r.id)).toContain(ref.id);
});

it("does not count unchanged reference exports as paid page attempts", async () => {
  const { ctx } = await imageJob();
  const ref = await referenceImage(ctx);
  const storage = { ...storageRuntime(), root };
  for (let n = 0; n < 6; n++) await generateImageAsset(db, ctx, { prompt: `导出 ${n}`, referenceImageIds: [ref.id] }, randomUUID(), { storage, exportOnly: true });
  let calls = 0;
  await generateImageAsset(db, ctx, { prompt: "编辑人物", referenceImageIds: [ref.id] }, randomUUID(), { storage, fetch: (async () => { calls++; return imageResponse(); }) as typeof fetch });
  expect(calls).toBe(1);
});

it.each(["unavailable", "reference-ignored"])("stops the agent after a %s image request without letting changed tool arguments trigger more requests", async (failure) => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config, models: [...config.models, { id: "chat", vendorId: "image-vendor", model: "mock-chat", apiMode: "chat", alias: "对话", enabled: true, vision: true, tools: true, maxInput: 64000, maxOutput: 2000 }] }, revision);
  const origin = "http://localhost:39249";
  let reference = "", imageCalls = 0, agentCalls = 0;
  const app = await createApp(db, { origin, storage: { ...storageRuntime(), root }, ai: {
    memory: { driver: "sqlite", url: ":memory:" },
    imageFetch: (async () => {
      imageCalls++;
      if (failure === "unavailable") return new Response("Not found", { status: 404 });
      const body = await (await imageResponse()).json();
      body.usage.input_images = 0;
      return Response.json(body);
    }) as typeof fetch,
    fetch: (async (_url, init) => {
      agentCalls++;
      const body = JSON.parse(String(init?.body));
      return completionResponse({ id: randomUUID(), object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name: "image_edit", arguments: JSON.stringify({ prompt: `更换提示 ${agentCalls}`, sourceImageId: reference }) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }, !!body.stream);
    }) as typeof fetch,
  } });
  try {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin, host: "localhost:39249" }, payload: { login: "image-owner", password: "image-test-2026" } });
    const headers = { origin, host: "localhost:39249", cookie: String(login.headers["set-cookie"]).split(";")[0]! };
    const session = (await app.inject({ method: "POST", url: "/api/v1/ai/sessions", headers, payload: { modelId: "chat", resourceIds: [] } })).json().id;
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#248a66" } }).png().toBuffer();
    reference = (await app.inject({ method: "POST", url: "/api/v1/assets?purpose=ai_attachment&filename=reference.png", headers: { ...headers, "content-type": "application/octet-stream" }, payload: png })).json().id;
    const id = randomUUID();
    expect((await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${session}/messages`, headers, payload: { id, modelId: "chat", scope: "all", text: "参考附件生成一张图片", attachments: [reference] } })).statusCode).toBe(200);
    let job: any;
    for (let n = 0; n < 150; n++) {
      job = (await app.inject({ url: `/api/v1/ai/sessions/${session}`, headers })).json().jobs.find((r: any) => r.id === id);
      if (job && !["queued", "running"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(job.status).toBe("failed");
    expect(imageCalls).toBe(1);
    expect(agentCalls).toBe(1);
    expect((await usageSummary(db, user.id)).calls.filter(c => c.callKind === "image")).toEqual([expect.objectContaining(failure === "unavailable" ? { images: 0, state: "failed" } : { images: 1, state: "confirmed" })]);
    if (failure === "reference-ignored") {
      const saved = (await db.selectFrom("ai_operations").select("result").where("job_id", "=", id).execute()).map(row => JSON.parse(row.result)).find(value => value.kind === "image_generation");
      expect(saved).toMatchObject({ state: "saved", providerImageUsage: { inputImages: 0 } });
      expect(await db.selectFrom("assets").select("id").where("id", "=", saved.assetId).executeTakeFirst()).toBeDefined();
      expect(job.progress.events.find((event: any) => event.image?.assetId === saved.assetId)?.image.validation.state).toBe("rejected");
    }
  } finally { await app.close(); }
});
it("rejects private result URLs and keeps confirmed paid usage without repeating generation", async () => {
  let calls = 0;
  const operation = randomUUID();
  const options = {
    fetch: (async () => {
      calls++;
      return Response.json({ data: [{ url: "http://127.0.0.1/private" }] });
    }) as typeof fetch,
  };
  await expect(
    generateImageAsset(db, { actor: user }, args(), operation, options),
  ).rejects.toThrow("内网");
  await expect(
    generateImageAsset(db, { actor: user }, args(), operation, options),
  ).rejects.toThrow("保存失败");
  expect(calls).toBe(1);
  expect((await usageSummary(db, user.id)).calls[0]?.state).toBe("confirmed");
});
it("releases credit reservation on definitive authentication rejection and redacts secrets", async () => {
  await expect(
    generateImageAsset(db, { actor: user }, args(), randomUUID(), {
      fetch: (async () =>
        Response.json(
          { error: "test-secret" },
          { status: 401 },
        )) as typeof fetch,
    }),
  ).rejects.toThrow("图片模型认证失败");
  const quota = await usageSummary(db, user.id);
  expect(quota.tokens.day?.input).toBe(0);
  expect(quota.calls[0]).toMatchObject({ images: 0, state: "failed" });
});
it("rechecks revoked account access after provider returns and never persists the image", async () => {
  await expect(
    generateImageAsset(db, { actor: user }, args(), randomUUID(), {
      storage: { ...storageRuntime(), root },
      fetch: (async () => {
        await db
          .updateTable("users")
          .set({ status: "disabled" })
          .where("id", "=", user.id)
          .execute();
        return imageResponse();
      }) as typeof fetch,
    }),
  ).rejects.toThrow();
  expect(await db.selectFrom("assets").selectAll().execute()).toHaveLength(0);
});

it("does not invent image results or expose another conversation's images", async () => {
  await expect(
    showGeneratedImage(db, { actor: user }, randomUUID()),
  ).rejects.toThrow("没有这张图片");
});

it("keeps flattened spreadsheet placement on image_insert", () => {
  const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const advertised = z.toJSONSchema(imageInsertSchema, {
    unrepresentable: "any",
    io: "input",
  }) as { required?: string[]; properties?: Record<string, unknown> };
  expect(advertised.required).toEqual([
    "assetId",
    "resourceId",
    "sheetId",
    "row",
    "column",
  ]);
  expect(advertised.properties).not.toHaveProperty("spreadsheet");
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({
        assetId: uuid,
        resourceId: uuid,
        sheetId: "sheet-1",
        row: "2",
        column: "3",
      }),
    ),
  ).toEqual({ sheetId: "sheet-1", row: 2, column: 3 });
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({
        assetId: uuid,
        resourceId: uuid,
        spreadsheet: { sheetId: "sheet-2", row: 4, column: 1 },
      }),
    ),
  ).toEqual({ sheetId: "sheet-2", row: 4, column: 1 });
  expect(
    spreadsheetImagePlacement(
      imageInsertSchema.parse({ assetId: uuid, resourceId: uuid }),
    ),
  ).toBeUndefined();
});

it("inserts a spreadsheet image at flattened sheetId/row/column", async () => {
  const runtime = { ...storageRuntime(), root };
  const image = await generateImageAsset(
    db,
    { actor: user },
    { prompt },
    randomUUID(),
    { storage: runtime, fetch: imageResponse as typeof fetch },
  );
  const target = await createContent(db).create(user, {
    kind: "document",
    format: "spreadsheet",
    title: "定位插图",
  });
  const before = await readAIDocument(db, { actor: user }, target.id);
  const sheetId = (before.value as any).sheetOrder[0];
  const saved = await insertGeneratedImage(
    db,
    { actor: user },
    {
      assetId: image.assetId,
      resourceId: target.id,
      sheetId,
      row: 2,
      column: 3,
    },
    randomUUID(),
    runtime,
  );
  const after = await readAIDocument(db, { actor: user }, target.id);
  const raw = (after.value as any).resources?.find(
    (r: any) => r.name === "EXLSX_FLOATING_OBJECTS",
  )?.data;
  const floating = typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
  expect(JSON.stringify(floating)).toContain(saved.assetId);
  expect(JSON.stringify(floating)).toMatch(/"startRow":2/);
  expect(JSON.stringify(floating)).toMatch(/"startColumn":3/);
});

it("exports an unchanged reference as a lossless named image without a provider call or AI charge", async () => {
  const {ctx}=await imageJob();
  const reference=await referenceImage(ctx);
  const asset=await generateImageAsset(db,ctx,{prompt:"导出原始页面",referenceImageIds:[reference.id],filename:"Book-page-03.png"},randomUUID(),{
    storage:{...storageRuntime(),root},exportOnly:true,
    fetch:(async()=>{throw Error("Export must not call a model")}) as typeof fetch,
  });
  expect(asset).toMatchObject({filename:"Book-page-03.png",mime:"image/png",origin:"reference-export"});
  expect((await usageSummary(db,user.id)).calls).toHaveLength(0);
  const row=await db.selectFrom("assets").selectAll().where("id","=",asset.assetId).executeTakeFirstOrThrow();
  const profile=await db.selectFrom("storage_profiles").selectAll().where("id","=",row.profile_id).executeTakeFirstOrThrow();
  const bytes=await createStorage({...storageRuntime(),root}).read(storageConfigForProfile({...storageRuntime(),root},profile),row.object_key,row.size);
  expect(await sharp(bytes).ensureAlpha().raw().toBuffer()).toEqual(await sharp(reference.data).ensureAlpha().raw().toBuffer());
});

it("applies the approved defaults to stored image settings and preserves the deployment ID", async () => {
  const row = await db.selectFrom("account_settings").selectAll().where("id", "=", "ai").executeTakeFirstOrThrow();
  const stored = JSON.parse(row.config);
  stored.models[0].model = "opaque-deployment";
  stored.models[0].imageEditApi = "openai-edits";
  stored.models[0].imageSize = "80x80";
  delete stored.models[0].imageProfile;
  await db.updateTable("account_settings").set({ config: JSON.stringify(stored) }).where("id", "=", "ai").execute();
  const { revision, ...config } = await aiConfig(db);
  expect(config.models[0]).toMatchObject({ model: "opaque-deployment", imageProfile: "gpt-image-2", imageSize: "1024x1024" });
  expect(config.models[0]).not.toHaveProperty("imageEditApi");
  await saveAIConfig(db, config, revision);
  const saved = JSON.parse((await db.selectFrom("account_settings").select("config").where("id", "=", "ai").executeTakeFirstOrThrow()).config);
  expect(saved.models[0].model).toBe("opaque-deployment");
  expect(saved.models[0]).not.toHaveProperty("imageEditApi");
});

it.each(["qwen-image-3.0-pro", "qwen-image-edit-max"])("saves %s URL output, native usage and a durable candidate exactly once", async imageProfile => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config,
    vendors: config.vendors.map(v => ({ ...v, provider: "qwen" as const, baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" })),
    models: config.models.map(m => ({ ...m, model: imageProfile, imageProfile })),
  }, revision);
  const { ctx } = await imageJob(), ref = await referenceImage(ctx), id = randomUUID();
  const pixels = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#5080a0" } }).png().toBuffer();
  const usage = { input_image_count: 1, output_image_count: 1, output_width: 1024, output_height: 1024, vendor_fact: "kept" };
  let submissions = 0, downloads = 0;
  const native = imageProfile === "qwen-image-edit-max";
  const options = { operation: "edit" as const, storage: { ...storageRuntime(), root },
    fetch: (async (url, init) => {
      submissions++;
      const request = JSON.parse(String(init?.body));
      expect(String(url)).toContain(native ? "/api/v1/services/aigc/multimodal-generation/generation" : "/compatible-mode/v1/images/generations");
      expect(native ? request.input.messages[0].content[0].image : request.image).toMatch(/^data:image\/jpeg;base64,/);
      return Response.json({ usage, ...(native
        ? { output: { choices: [{ message: { content: [{ image: "https://outputs.example/result.png" }] } }] }, request_id: "qwen-request-1" }
        : { data: [{ url: "https://outputs.example/result.png" }] }) });
    }) as typeof fetch,
    downloadImage: async (url: string) => { downloads++; expect(url).toBe("https://outputs.example/result.png"); return pixels; },
  };
  const input = { prompt: "修改底图背景", referenceImageIds: [ref.id] };
  const saved = await executeImageOperation(db, ctx, input, id, options);
  expect(saved).toMatchObject({ state: "saved", providerImageUsage: { inputImages: 1 } });
  expect((await executeImageOperation(db, ctx, input, id, options)).assetId).toBe(saved.assetId);
  const raw = await readRawImageCandidate(db, ctx, id, options.storage);
  expect(raw.candidate.request.protocol).toBe(native ? "qwen-native" : "qwen-generations");
  expect(raw.candidate.nativeUsage).toEqual({ state: "reported", value: usage });
  const call = await db.selectFrom("ai_calls").selectAll().where("id", "=", saved.providerCallId!).executeTakeFirstOrThrow();
  expect(call.state).toBe("confirmed");
  expect(JSON.parse(call.usage!)).toMatchObject({ providerMetrics: { images: 1 }, raw: { nativeUsage: usage } });
  expect(submissions).toBe(1); expect(downloads).toBe(1);
});

it("uses a per-tool model override and rejects an unsupported operation before charging", async () => {
  const { revision, ...config } = await aiConfig(db);
  const model = config.models[0]!;
  await saveAIConfig(db, { ...config,
    vendors: config.vendors.map(v => ({ ...v, provider: "qwen" as const, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })),
    models: [ { ...model, imageProfile: "qwen-image-max", model: "qwen-image-max" },
      { ...model, id: "edit-model", alias: "Edit", imageProfile: "qwen-image-edit-max", model: "qwen-image-edit-max" } ],
    imageToolModels: { edit: "edit-model" },
  }, revision);
  const { ctx } = await imageJob(), ref = await referenceImage(ctx);
  let calls = 0;
  const pixels = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "blue" } }).png().toBuffer();
  const options = { operation: "edit" as const, storage: { ...storageRuntime(), root },
    fetch: (async (_url, init) => { calls++; expect(JSON.parse(String(init?.body)).model).toBe("qwen-image-edit-max"); return Response.json({ output: { choices: [{ message: { content: [{ image: "https://outputs.example/image.png" }] } }] } }); }) as typeof fetch,
    downloadImage: async () => pixels,
  };
  await executeImageOperation(db, ctx, { prompt, referenceImageIds: [ref.id] }, randomUUID(), options);
  await expect(executeImageOperation(db, ctx, { prompt, referenceImageIds: [ref.id] }, randomUUID(), { ...options, operation: "reference" })).rejects.toThrow("不支持");
  await expect(executeImageOperation(db, ctx, { prompt, referenceImageIds: [ref.id] }, randomUUID(), { ...options, operation: "generate" })).rejects.toThrow("文生图不能传参考图");
  expect(calls).toBe(1);
  expect((await usageSummary(db, user.id)).calls).toHaveLength(1);
});

it("keeps a completed Qwen call confirmed when the result download fails, and never resubmits it", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config, vendors: config.vendors.map(v => ({ ...v, provider: "qwen" as const, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })), models: config.models.map(m => ({ ...m, imageProfile: "qwen-image-3.0-pro", model: "qwen-image-3.0-pro" })) }, revision);
  let calls = 0, downloads = 0;
  const options = { storage: { ...storageRuntime(), root }, fetch: (async () => { calls++; return Response.json({ data: [{ url: "https://outputs.example/image.png" }], usage: { output_image_count: 1 } }); }) as typeof fetch,
    downloadImage: async () => { downloads++; throw Error("download interrupted"); },
  };
  const id = randomUUID();
  await expect(executeImageOperation(db, { actor: user }, { prompt }, id, options)).rejects.toThrow("图片保存失败");
  await expect(executeImageOperation(db, { actor: user }, { prompt }, id, options)).rejects.toThrow("保存失败");
  expect(calls).toBe(1); expect(downloads).toBe(1);
  expect((await usageSummary(db, user.id)).calls[0]).toMatchObject({ state: "confirmed", images: 1 });
});

async function qwenDownloadFixture(
  request: PageTransport,
  signal?: AbortSignal,
) {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      vendors: config.vendors.map((vendor) => ({
        ...vendor,
        provider: "qwen" as const,
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })),
      models: config.models.map((model) => ({
        ...model,
        imageProfile: "qwen-image-3.0-pro" as const,
        model: "qwen-image-3.0-pro",
      })),
    },
    revision,
  );
  const { ctx } = await imageJob(),
    reference = await referenceImage(ctx),
    id = randomUUID(),
    resultUrl = "https://outputs.example/result.png?signature=isolated-fixture",
    nativeUsage = {
      input_image_count: 1,
      output_image_count: 1,
      output_width: 1024,
      output_height: 1024,
      retained_provider_fact: "original URL result",
    };
  const urls: string[] = [],
    transportUrls: string[] = [],
    resolvedHosts: string[] = [];
  const ledgerRows = () =>
    db.selectFrom("ai_calls").selectAll().orderBy("id").execute();
  const confirmedLedgers: Awaited<ReturnType<typeof ledgerRows>>[] = [];
  let submissions = 0;
  const input = {
    prompt: "修改真实底图并保留同一次生成的结果",
    referenceImageIds: [reference.id],
  };
  const options = {
    operation: "edit" as const,
    storage: { ...storageRuntime(), root },
    signal,
    fetch: (async (url, init) => {
      submissions++;
      expect(String(url)).toBe(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
      );
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen-image-3.0-pro");
      expect(body.image).toMatch(/^data:image\/jpeg;base64,/);
      return Response.json({ data: [{ url: resultUrl }], usage: nativeUsage });
    }) as typeof fetch,
    downloadImage: async (url: string, abort?: AbortSignal) => {
      urls.push(url);
      expect(url).toBe(resultUrl);
      const calls = (await usageSummary(db, user.id)).calls;
      expect(calls).toEqual([
        expect.objectContaining({
          state: "confirmed",
          images: 1,
          image: 250,
        }),
      ]);
      confirmedLedgers.push(await ledgerRows());
      return (
        await fetchWebFile(url, abort, {
          resolve: async (host) => {
            resolvedHosts.push(host);
            expect(host).toBe("outputs.example");
            return [{ address: "93.184.216.34", family: 4 }];
          },
          request: async (target, address, requestSignal) => {
            transportUrls.push(target.href);
            expect(target.href).toBe(resultUrl);
            expect(address).toEqual({ address: "93.184.216.34", family: 4 });
            return request(target, address, requestSignal);
          },
        })
      ).body;
    },
  };
  const run = (runOptions = options) =>
    executeImageOperation(db, ctx, input, id, runOptions);
  return {
    ctx,
    id,
    input,
    options,
    nativeUsage,
    resultUrl,
    urls,
    transportUrls,
    resolvedHosts,
    confirmedLedgers,
    ledgerRows,
    run,
    submissions: () => submissions,
  };
}

it("retries only the same paid Qwen result URL after real 503 and 429 downloads, then persists valid raw and final PNGs without another POST or fee", async () => {
  const pixels = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: "#5080a0" },
  })
    .png()
    .toBuffer();
  let gets = 0;
  const fixture = await qwenDownloadFixture(async () => ({
    status: ++gets === 1 ? 503 : gets === 2 ? 429 : 200,
    headers: { "content-type": "image/png" },
    body: gets === 3 ? pixels : Buffer.alloc(0),
  }));
  const saved = await fixture.run();
  expect(saved).toMatchObject({
    state: "saved",
    width: 1024,
    height: 1024,
    mime: "image/png",
    providerImageUsage: { inputImages: 1 },
  });
  expect(fixture.submissions()).toBe(1);
  expect(gets).toBe(3);
  expect(fixture.urls).toEqual(Array(3).fill(fixture.resultUrl));
  expect(fixture.transportUrls).toEqual(fixture.urls);
  expect(fixture.resolvedHosts).toEqual(Array(3).fill("outputs.example"));
  const raw = await readRawImageCandidate(
    db,
    fixture.ctx,
    fixture.id,
    fixture.options.storage,
  );
  expect(raw.data.equals(pixels)).toBe(true);
  expect(raw.candidate).toMatchObject({
    state: "saved",
    mime: "image/png",
    dimensions: { width: 1024, height: 1024 },
    request: { protocol: "qwen-generations" },
    nativeUsage: { state: "reported", value: fixture.nativeUsage },
  });
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", saved.assetId)
    .executeTakeFirstOrThrow();
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("id", "=", asset.profile_id)
    .executeTakeFirstOrThrow();
  const final = await createStorage(fixture.options.storage).read(
    storageConfigForProfile(fixture.options.storage, profile),
    asset.object_key,
    asset.size,
  );
  expect(await sharp(final).metadata()).toMatchObject({
    format: "png",
    width: 1024,
    height: 1024,
  });
  expect(await sharp(final).ensureAlpha().raw().toBuffer()).toEqual(
    await sharp(pixels).ensureAlpha().raw().toBuffer(),
  );
  const ledger = await fixture.ledgerRows();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    id: saved.providerCallId,
    state: "confirmed",
  });
  expect(JSON.parse(ledger[0]!.usage)).toMatchObject({
    providerMetrics: { images: 1 },
    raw: { nativeUsage: fixture.nativeUsage },
  });
  for (const snapshot of fixture.confirmedLedgers)
    expect(snapshot).toEqual(ledger);
  const operations = await db
    .selectFrom("ai_operations")
    .selectAll()
    .orderBy("id")
    .execute();
  const assets = await db
    .selectFrom("assets")
    .selectAll()
    .orderBy("id")
    .execute();
  expect((await fixture.run()).assetId).toBe(saved.assetId);
  expect(fixture.submissions()).toBe(1);
  expect(gets).toBe(3);
  expect(await fixture.ledgerRows()).toEqual(ledger);
  expect(
    await db.selectFrom("ai_operations").selectAll().orderBy("id").execute(),
  ).toEqual(operations);
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(assets);
});

it("bounds real transient Qwen URL connection resets to three GETs, preserves confirmed save_failed billing, and never repeats the operation", async () => {
  let gets = 0;
  const fixture = await qwenDownloadFixture(async () => {
    gets++;
    throw Object.assign(new Error("Isolated transport connection reset"), {
      code: "ECONNRESET",
    });
  });
  const assetsBefore = await db
    .selectFrom("assets")
    .selectAll()
    .orderBy("id")
    .execute();
  const error = await fixture.run().catch((caught) => caught);
  expect(systemErrorReason(error)).toEqual({ code: "image_save_failed" });
  expect(fixture.submissions()).toBe(1);
  expect(gets).toBe(3);
  expect(fixture.urls).toEqual(Array(3).fill(fixture.resultUrl));
  expect(fixture.transportUrls).toEqual(fixture.urls);
  const row = await db
    .selectFrom("ai_operations")
    .selectAll()
    .where("id", "=", fixture.id)
    .executeTakeFirstOrThrow();
  const receipt = JSON.parse(row.result);
  expect(receipt).toMatchObject({
    kind: "image_generation",
    state: "save_failed",
    generationOperationId: fixture.id,
    providerCallId: expect.any(String),
  });
  expect(receipt).not.toHaveProperty("rawCandidate");
  expect(receipt).not.toHaveProperty("assetId");
  const ledger = await fixture.ledgerRows();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    id: receipt.providerCallId,
    state: "confirmed",
  });
  for (const snapshot of fixture.confirmedLedgers)
    expect(snapshot).toEqual(ledger);
  await expect(fixture.run()).rejects.toThrow("已生成但保存失败");
  expect(fixture.submissions()).toBe(1);
  expect(gets).toBe(3);
  expect(await fixture.ledgerRows()).toEqual(ledger);
  expect(
    await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", fixture.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(row);
  expect(
    await db.selectFrom("assets").selectAll().orderBy("id").execute(),
  ).toEqual(assetsBefore);
  await expect(
    readRawImageCandidate(db, fixture.ctx, fixture.id, fixture.options.storage),
  ).rejects.toThrow("没有持久原始候选");
});

it.each(["authentication", "abort"] as const)(
  "never retries a paid Qwen URL download after %s and preserves the original confirmed fee and failed receipt",
  async (failure) => {
    let gets = 0;
    const controller = new AbortController();
    const fixture = await qwenDownloadFixture(
      async (_url, _address, signal) => {
        gets++;
        if (failure === "abort") {
          controller.abort(
            new DOMException(
              "Isolated result download cancelled",
              "AbortError",
            ),
          );
          expect(signal.aborted).toBe(true);
        }
        return {
          status: failure === "authentication" ? 401 : 503,
          headers: {},
          body: Buffer.alloc(0),
        };
      },
      failure === "abort" ? controller.signal : undefined,
    );
    const assetsBefore = await db
      .selectFrom("assets")
      .selectAll()
      .orderBy("id")
      .execute();
    const error = await fixture.run().catch((caught) => caught);
    if (failure === "abort")
      expect(error).toMatchObject({ name: "AbortError" });
    else
      expect(systemErrorReason(error)).toEqual({ code: "image_save_failed" });
    expect(fixture.submissions()).toBe(1);
    expect(gets).toBe(1);
    expect(fixture.urls).toEqual([fixture.resultUrl]);
    expect(fixture.transportUrls).toEqual(fixture.urls);
    const row = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", fixture.id)
      .executeTakeFirstOrThrow();
    const receipt = JSON.parse(row.result);
    expect(receipt).toMatchObject({
      state: "save_failed",
      providerCallId: expect.any(String),
    });
    expect(receipt).not.toHaveProperty("rawCandidate");
    expect(receipt).not.toHaveProperty("assetId");
    const ledger = await fixture.ledgerRows();
    expect(ledger).toEqual(fixture.confirmedLedgers[0]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      id: receipt.providerCallId,
      state: "confirmed",
    });
    await expect(
      fixture.run({ ...fixture.options, signal: new AbortController().signal }),
    ).rejects.toThrow("已生成但保存失败");
    expect(fixture.submissions()).toBe(1);
    expect(gets).toBe(1);
    expect(await fixture.ledgerRows()).toEqual(ledger);
    expect(
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", fixture.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(row);
    expect(
      await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    ).toEqual(assetsBefore);
  },
);
it("saves a real multi-MiB Seedream PNG through usage, raw candidate, final file and an idempotent repeat", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config,
    vendors: config.vendors.map(v => ({ ...v, provider: "doubao" as const, baseUrl: "https://ark.example/api/plan/v3" })),
    models: config.models.map(m => ({ ...m, imageProfile: "doubao-seedream-5-0-pro-260628", model: "ep-fixture-seedream" })),
  }, revision);
  const { ctx } = await imageJob();
  const source = await sharp({ create: { width: 1500, height: 2000, channels: 3, background: "#347895" } }).png().toBuffer();
  const ref = await referenceImage(ctx, { data: source });
  const pixels = await sharp(randomBytes(1774 * 2365 * 3), { raw: { width: 1774, height: 2365, channels: 3 } }).png().toBuffer();
  expect(pixels.length).toBeGreaterThan(4 * 1024 * 1024);
  const id = randomUUID();
  let submissions = 0;
  const options = { operation: "edit" as const, storage: { ...storageRuntime(), root }, fetch: (async (_url, init) => {
    submissions++;
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "ep-fixture-seedream", size: "1500x2000" });
    return Response.json({ data: [{ b64_json: pixels.toString("base64") }], usage: { input_tokens: 12, output_tokens: 25, input_images: 1, generated_images: 1 } });
  }) as typeof fetch };
  const input = { prompt: "仅修改本页人物，保留完整构图", referenceImageIds: [ref.id], filename: "full-resolution.png" };
  const saved = await executeImageOperation(db, ctx, input, id, options);
  expect(saved).toMatchObject({ state: "saved", width: 1774, height: 2365, filename: "full-resolution.png", providerImageUsage: { inputImages: 1 } });
  expect((await executeImageOperation(db, ctx, input, id, options)).assetId).toBe(saved.assetId);
  expect(submissions).toBe(1);
  const raw = await readRawImageCandidate(db, ctx, id, options.storage);
  expect(raw.data.equals(pixels)).toBe(true);
  expect(raw.candidate.request.protocol).toBe("seedream-generations");
  expect((await usageSummary(db, user.id)).calls).toEqual([expect.objectContaining({ state: "confirmed", images: 1 })]);
  const file = await db.selectFrom("file_items").selectAll().where("storage_object_id", "=", saved.assetId).executeTakeFirstOrThrow();
  expect(file).toMatchObject({ owner_id: user.id, parent_type: "system", parent_id: "ai", name: "full-resolution.png" });
  const metadata = JSON.parse(file.metadata);
  expect(metadata.assetId).toBe(saved.assetId);
  expect(metadata.aiSessionFolder.sessionId).toBe((await db.selectFrom("ai_jobs").select("session_id").where("id", "=", ctx.jobId).executeTakeFirstOrThrow()).session_id);
  expect((await db.selectFrom("ai_operations").select("result").where("id", "=", id).executeTakeFirstOrThrow()).result).toContain('"state":"saved"');
}, 30000);
