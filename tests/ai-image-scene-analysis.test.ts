import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import {
  aiConfig,
  aiDefaults,
  saveAIConfig,
  type AIModel,
} from "@core/modules/ai/config.js";
import { digest, type ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
} from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import { registerVisualReferences } from "../apps/server/src/services/ai/session-attachments.js";
import {
  bindImageBatchClarifications,
  createImageBatchRequirements,
} from "../apps/server/src/services/ai/image-batch-requirements.js";
import { registerImageBatchAttemptScope } from "../apps/server/src/services/ai/image-batch-attempts.js";
import {
  requireImageBatch,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import { PARSER_VERSION } from "../apps/server/src/services/ai/file-extract.js";
import { analyzeImageScene } from "../apps/server/src/services/ai/image-scene-analysis.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  actor: Actor,
  ctx: ToolContext,
  batch: ImageBatch,
  model: AIModel,
  current: string,
  sessionId: string;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const runtime = () => ({ ...storageRuntime(), root });
const request =
  "In first.pdf replace the visible parent with Dad. Preserve the original words. Ask if the cropped body cannot be assigned. Accept natural fusion; illustrated bodies are allowed.";
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-scene-analysis-"));
  actor = {
    ...(await createUser(
      db,
      {
        login: "scene-owner",
        displayName: "Scene",
        password: "isolated-scene-analysis-2026",
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
          id: "scene",
          name: "Scene",
          provider: "openai",
          baseUrl: "https://scene.invalid/v1",
          apiKey: "unit-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "vision",
          vendorId: "scene",
          model: "mock-vision",
          alias: "Scene",
          enabled: true,
          apiMode: "chat",
          vision: true,
          tools: false,
          maxInput: 64000,
          maxOutput: 8000,
        },
      ],
    },
    0,
  );
  model = (await aiConfig(db)).models[0]!;
  const now = new Date().toISOString(),
    jobId = randomUUID(),
    lease = randomUUID();
  sessionId = randomUUID();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: actor.id,
      title: "Scene",
      model_id: "vision",
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
      user_id: actor.id,
      model_id: "vision",
      status: "running",
      input: "{}",
      digest: jobId,
      result: "",
      error: "",
      lease,
      lease_until: new Date(Date.now() + 600000).toISOString(),
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { actor, jobId, lease, writable: true };
  const profile = await db
    .selectFrom("storage_profiles")
    .selectAll()
    .where("active", "=", 1)
    .executeTakeFirstOrThrow();
  const store = createStorage(runtime()),
    config = storageConfigForProfile(runtime(), profile),
    books: any[] = [],
    sources: { assetId: string }[] = [];
  for (const [bookIndex, name] of ["first.pdf", "second.pdf"].entries()) {
    const assetId = randomUUID(),
      objectId = randomUUID(),
      bytes = Buffer.from(`%PDF-scene-fixture-${bookIndex}`),
      key = objectKey(assetId, "application/pdf");
    await store.put(config, key, bytes, "application/pdf", name);
    await db
      .insertInto("file_storage_objects")
      .values({
        id: objectId,
        profile_id: profile.id,
        object_key: key,
        sha256: hash(bytes),
        size: bytes.length,
        mime: "application/pdf",
        created_at: now,
      })
      .execute();
    await db
      .insertInto("assets")
      .values({
        id: assetId,
        owner_id: actor.id,
        uploaded_by: actor.id,
        resource_id: null,
        purpose: "ai_attachment",
        profile_id: profile.id,
        object_key: key,
        filename: name,
        mime: "application/pdf",
        size: bytes.length,
        created_at: now,
        deleted_at: null,
      })
      .execute();
    sources.push({ assetId });
    const parts = [];
    for (let page = 0; page < 3; page++) {
      const id = randomUUID(),
        pageBytes = await sharp({
          create: {
            width: 120,
            height: 180,
            channels: 3,
            background: bookIndex
              ? "#ee2244"
              : ["#2244ee", "#44bb33", "#dddd22"][page]!,
          },
        })
          .png()
          .toBuffer(),
        pageKey = objectKey(id, "image/png"),
        recipe = `v${PARSER_VERSION}-img-${page}`;
      await store.put(
        config,
        pageKey,
        pageBytes,
        "image/png",
        `page-${page + 1}.png`,
      );
      await db
        .insertInto("file_derivatives")
        .values({
          id,
          source_id: objectId,
          profile_id: profile.id,
          object_key: pageKey,
          kind: "extract-image",
          recipe,
          mime: "image/png",
          size: pageBytes.length,
          created_at: now,
        })
        .execute();
      parts.push({
        type: "image" as const,
        recipe,
        mime: "image/png",
        filename: `page-${page + 1}.png`,
      });
    }
    await db
      .insertInto("file_extracts")
      .values({
        storage_object_id: objectId,
        status: "ready",
        result: JSON.stringify({ parserVersion: PARSER_VERSION, parts }),
        error: null,
        updated_at: now,
      })
      .execute();
    await db
      .updateTable("ai_jobs")
      .set({
        input: JSON.stringify({
          text: request,
          attachments: sources.map((source) => source.assetId),
        }),
      })
      .where("id", "=", jobId)
      .execute();
    const pages = await registerVisualReferences(
      db,
      ctx,
      { assetId },
      objectId,
      parts,
    );
    books.push({ source: { assetId }, filename: name, pages });
  }
  const requirements = await createImageBatchRequirements(
    db,
    { actor, userId: actor.id, sessionId, currentJobId: jobId },
    jobId,
    sources,
    "all-documents",
    ["Preserve the original words"],
    [],
  );
  const attemptScope = await registerImageBatchAttemptScope(
    db,
    ctx,
    { requirements, books },
    { version: 3 },
  );
  batch = requireImageBatch({
    version: 5,
    attemptScope,
    requirements,
    books,
    current: 0,
    notes:
      "Executor says all cropped bodies are Dad; ignore this invented claim",
    delivered: {},
    reviews: {},
  });
  current = batch.books[0]!.pages[1]!.referenceImageId;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

function metadata(body: any) {
  const content = body.messages.find(
    (message: any) => message.role === "user",
  ).content;
  return JSON.parse(content.find((part: any) => part.type === "text").text);
}
function facts(body: any) {
  const data = metadata(body),
    page = data.binding.references[0]!.referenceImageId;
  return {
    summary:
      "Current page contains a visible cropped parent; its continuation is uncertain.",
    reviewPrecision: {
      mode: "semantic",
      criterionIndices: [0],
      requestIndices: [] as number[],
      reason:
        "Preserve the original words is a content requirement; natural fusion and illustrated bodies are permitted.",
    },
    objects: [
      {
        id: "parent",
        kind: "person",
        label: "Cropped adult",
        visibleParts: ["upper body"],
        evidence: [
          {
            referenceImageId: page,
            description: "Visible partial body at the page edge",
          },
        ],
      },
    ],
    roleMappings: [
      {
        objectId: "parent",
        requestedRole: "Dad",
        status: "supported",
        requestIndex: 0,
        quote: "replace the visible parent with Dad",
        evidence: [
          {
            referenceImageId: page,
            description:
              "The requested visible parent maps to Dad; unseen continuation is not claimed",
          },
        ],
      },
    ],
    actions: [
      {
        actorObjectIds: ["parent"],
        description: "A visible arm is extended",
        evidence: [
          {
            referenceImageId: page,
            description: "Only the visible arm is described",
          },
        ],
      },
    ],
    crossPage:
      data.binding.references.length > 1
        ? [
            {
              currentObjectId: "parent",
              adjacentReferenceImageId:
                data.binding.references[1]!.referenceImageId,
              relationship: "uncertain",
              evidence:
                "The apparent boundary does not establish continuous body ownership",
            },
          ]
        : [],
    requirements: [
      {
        kind: "change",
        requestIndex: 0,
        criterionIndex: null,
        quote: "replace the visible parent with Dad",
        objectIds: ["parent"],
        applicability: "applies",
        evidence: "A parent is visible",
      },
      {
        kind: "preserve",
        requestIndex: null,
        criterionIndex: 0,
        quote: "Preserve the original words",
        objectIds: [],
        applicability: "applies",
        evidence: "Preserve the words under the formal criterion",
      },
    ],
    uncertainties: [
      {
        topic: "Cross-page ownership",
        objectIds: ["parent"],
        referenceImageIds: [page],
        evidence: "The invisible remainder cannot be inferred",
        question: "Does this cropped body belong to the requested parent?",
      },
    ],
  };
}
function reply(body: any, value: any, finish = "stop") {
  return Response.json({
    id: "scene",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof value === "string" ? value : JSON.stringify(value),
        },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 },
  });
}
async function analyze(
  fetcher: typeof fetch,
  page = current,
  supplied = batch,
) {
  return analyzeImageScene(
    db,
    ctx,
    { batch: supplied, referenceImageId: page },
    { model, storage: runtime(), fetch: fetcher },
  );
}

async function whiteOriginal(mode: "opaque-white" | "one-dark-pixel" | "near-white" | "transparent") {
  const pixels = Buffer.alloc(120 * 180 * 4, 255);
  if (mode === "one-dark-pixel") pixels[0] = 0;
  if (mode === "near-white") pixels[0] = 254;
  if (mode === "transparent") pixels[3] = 0;
  const bytes = await sharp(pixels, { raw: { width: 120, height: 180, channels: 4 } }).png().toBuffer();
  const derivative = await db.selectFrom("file_derivatives").selectAll().where("id", "=", current).executeTakeFirstOrThrow();
  const profile = await db.selectFrom("storage_profiles").selectAll().where("id", "=", derivative.profile_id).executeTakeFirstOrThrow();
  const key = objectKey(randomUUID(), "image/png");
  await createStorage(runtime()).put(storageConfigForProfile(runtime(), profile), key, bytes, "image/png", "isolated-original.png");
  await db.updateTable("file_derivatives").set({ object_key: key, size: bytes.length }).where("id", "=", current).execute();
}

it.each(["opaque-white", "one-dark-pixel", "near-white", "transparent"] as const)(
  "omits unrelated neighboring scenes only for exact opaque-white original pixels (%s)", async mode => {
    await whiteOriginal(mode);
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const blank = mode === "opaque-white";
      expect(metadata(body).currentOriginalPixels).toEqual({ exactlyOpaqueWhite: blank, nonCitable: true });
      expect(metadata(body).binding.references).toHaveLength(blank ? 1 : 3);
      const output = facts(body);
      if (blank) {
        output.summary = "The original page is opaque white.";
        output.objects = []; output.roleMappings = []; output.actions = []; output.crossPage = []; output.uncertainties = [];
        output.requirements[0] = { ...output.requirements[0]!, objectIds: [], applicability: "not-applicable", evidence: "The original has no visible parent." };
      }
      return reply(body, output);
    }) as unknown as typeof fetch;
    const result = await analyze(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.references).toHaveLength(mode === "opaque-white" ? 1 : 3);
    await result.verify();
  },
);

it("preserves an applicable request to add content to an exact blank original without inventing visible objects", async () => {
  await whiteOriginal("opaque-white");
  await replaceFormalOriginal("Add a small red star on every page, including blank pages. Preserve the original words.");
  const result = await analyze(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    output.summary = "The source is blank and the user still requests a red star.";
    output.objects = []; output.roleMappings = []; output.actions = []; output.crossPage = []; output.uncertainties = [];
    output.requirements[0] = { ...output.requirements[0]!, quote: "Add a small red star on every page, including blank pages.", objectIds: [], applicability: "applies", evidence: "The formal request includes blank pages." };
    return reply(body, output);
  });
  expect(result.facts.requirements[0]!.applicability).toBe("applies");
  expect(result.facts.objects).toEqual([]);
});

it("rejects visible people hallucinated onto exact opaque-white original pixels", async () => {
  await whiteOriginal("opaque-white");
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return reply(body, facts(body));
  }) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow("currentOriginalPixels");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

async function replaceFormalOriginal(text: string) {
  const row = await db
    .selectFrom("ai_jobs")
    .selectAll()
    .where("id", "=", batch.requirements.original.jobId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("ai_jobs")
    .set({ input: JSON.stringify({ ...JSON.parse(row.input), text }) })
    .where("id", "=", row.id)
    .execute();
  batch.requirements.original.text = text;
}

async function useCurrentArkStrictProfile() {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config,
    vendors: config.vendors.map(vendor => ({ ...vendor, provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" })),
    models: config.models.map(entry => ({ ...entry, model: "doubao-seed-2.1-pro" })),
  }, revision);
  model = (await aiConfig(db)).models[0]!;
}

it("leaves room for compulsory reasoning before the complete scene plan without retrying or losing usage", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(db, { ...config,
    models: config.models.map(entry => ({ ...entry, maxOutput: 32768 })),
  }, revision);
  model = (await aiConfig(db)).models[0]!;
  let requests = 0;
  const analysis = await analyze((async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    // Reproduce a provider that spends more than the old 8k stage cap on
    // compulsory thinking before it can return the strictly validated JSON.
    if (body.max_tokens < 12000) return reply(body, "", "length");
    const response = await reply(body, facts(body)).json();
    response.choices[0]!.message.reasoning_content = "Source reasoning";
    response.usage = { prompt_tokens: 321, completion_tokens: 12000, total_tokens: 12321 };
    return Response.json(response);
  }) as typeof fetch);
  await analysis.verify();
  expect(analysis.facts.roleMappings[0]!.requestedRole).toBe("Dad");
  expect(requests).toBe(1);
  expect(await db.selectFrom("ai_calls").select(["state", "output_tokens"]).execute())
    .toEqual([{ state: "confirmed", output_tokens: 12000 }]);
});

it("uses the existing Ark strict-output transport with actual source and formal index enums while preserving host validation", async () => {
  await useCurrentArkStrictProfile();
  let transportAssertion: unknown;
  const fetcher = vi.fn(async (_url, init) => {
    try {
    const body = JSON.parse(String(init?.body)), meta = metadata(body);
    const format = body.response_format;
    expect(format).toMatchObject({ type: "json_schema", json_schema: { name: "doca_image_scene_plan", strict: true } });
    const props = format.json_schema.schema.properties;
    const actualRefs = meta.binding.references.map((reference: any) => reference.referenceImageId);
    expect(props.objects.items.properties.evidence.items.properties.referenceImageId).toEqual({ type: "string", enum: actualRefs });
    expect(props.crossPage.items.properties.adjacentReferenceImageId.enum).toEqual(actualRefs.slice(1));
    expect(props.requirements.items.properties.applicability).toEqual({ type: "string", enum: ["applies", "not-applicable", "uncertain"] });
    expect(props.roleMappings.items.properties.requestIndex.anyOf[0].enum).toEqual([0]);
    expect(props.reviewPrecision.properties.criterionIndices.items.enum).toEqual([0]);
    const choices = meta.citationChoices.requests[0].quotes;
    expect(choices).toContain("In first.pdf replace the visible parent with Dad.");
    expect(choices.every((quote: string) => request.includes(quote) && quote.length <= 500)).toBe(true);
    expect(props.roleMappings.items.properties.quote.anyOf[0].enum).toEqual(choices);
    expect(props.requirements.items.properties.quote.enum).toEqual([...new Set([...choices, ...meta.criteria])]);
    expect(props.requirements.items.properties.quote.enum).not.toContain("Keep the source words unchanged.");
    expect(props.objects.items.additionalProperties).toBe(false);
    expect(JSON.stringify(format)).not.toMatch(/"(?:minLength|maxLength|minimum|maximum|format|pattern|minItems|maxItems)":/);
    expect(body.thinking).toEqual({ type: "disabled" });
    const output = facts(body);
    output.roleMappings[0]!.quote = choices.find((quote: string) => quote.startsWith("In first.pdf"));
    output.requirements[0]!.quote = output.roleMappings[0]!.quote;
    return reply(body, output);
    } catch (error) { transportAssertion = error; throw error; }
  }) as unknown as typeof fetch;
  let result;
  try { result = await analyze(fetcher); }
  catch (error) { throw transportAssertion ?? error; }
  expect(result.facts.roleMappings[0]!.requestedRole).toBe("Dad");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await db.selectFrom("ai_calls").selectAll().execute()).map(call => call.state)).toEqual(["confirmed"]);
});

it("offers bounded literal citations for long multilingual requests without splitting Unicode pairs or changing formal text", async () => {
  const original = "In first.pdf replace the visible parent with Dad.\n" + "保留".repeat(249) + "家😀" + "景".repeat(530) + "。\nPreserve the original words.";
  await replaceFormalOriginal(original);
  await useCurrentArkStrictProfile();
  let transportAssertion: unknown;
  const fetcher = vi.fn(async (_url, init) => {
    try {
      const body = JSON.parse(String(init?.body)), meta = metadata(body);
      expect(meta.userRequests).toEqual([original]);
      const choices: string[] = meta.citationChoices.requests[0].quotes;
      expect(choices.every(quote => quote.length > 0 && quote.length <= 500 && original.includes(quote))).toBe(true);
      expect(choices.join(" ")).toContain("😀");
      for (const quote of choices) {
        expect(quote).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
      expect(choices).toContain("Preserve the original words.");
      const output = facts(body);
      output.roleMappings[0]!.quote = choices[0]!;
      output.requirements[0]!.quote = choices[0]!;
      return reply(body, output);
    } catch (error) { transportAssertion = error; throw error; }
  }) as unknown as typeof fetch;
  try { await analyze(fetcher); }
  catch (error) { throw transportAssertion ?? error; }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(batch.requirements.original.text).toBe(original);
});

it("does not downgrade or retry a strict-schema provider rejection as a planning format correction", async () => {
  await useCurrentArkStrictProfile();
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.response_format.type).toBe("json_schema");
    return Response.json({ error: { message: "response_format rejected", type: "invalid_request_error" } }, { status: 400 });
  }) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

async function clarify(text: string) {
  const row = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", ctx.jobId!)
      .executeTakeFirstOrThrow(),
    jobId = randomUUID(),
    lease = randomUUID(),
    now = new Date(Date.parse(row.created_at) + 1000).toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      ...row,
      id: jobId,
      input: JSON.stringify({ text }),
      digest: jobId,
      result: "",
      error: "",
      lease,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { ...ctx, jobId, lease };
  batch.requirements = await bindImageBatchClarifications(
    db,
    { actor, userId: actor.id, sessionId, currentJobId: jobId },
    batch.requirements,
    batch.requirements.original.jobId,
    [{ jobId, scope: "batch" }],
  );
}

it("uses actual original+same-book direct neighbors, strict facts and exact transport hashes with real metered usage", async () => {
  const operations = await db.selectFrom("ai_operations").selectAll().execute(),
    assets = await db.selectFrom("assets").selectAll().execute();
  let requestBody: any;
  const fetcher = vi.fn(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return reply(requestBody, facts(requestBody));
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher),
    body = metadata(requestBody);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.readonly).toBe(true);
  expect(result.binding).toMatchObject({
    actorId: actor.id,
    requirementsDigest: digest(batch.requirements),
    modelId: "vision",
    filename: "first.pdf",
    physicalPage: 2,
  });
  expect(
    result.references.map((reference) => reference.referenceImageId),
  ).toEqual([
    current,
    batch.books[0]!.pages[0]!.referenceImageId,
    batch.books[0]!.pages[2]!.referenceImageId,
  ]);
  expect(result.references.map((reference) => reference.role)).toEqual([
    "current-original",
    "previous-original",
    "next-original",
  ]);
  expect(body.userRequests).toEqual([request]);
  expect(body.criteria).toEqual(["Preserve the original words"]);
  expect(JSON.stringify(requestBody)).not.toContain(batch.notes);
  expect(JSON.stringify(requestBody)).not.toContain(
    batch.books[1]!.pages[0]!.referenceImageId,
  );
  const transmitted = requestBody.messages
    .find((message: any) => message.role === "user")
    .content.filter((part: any) => part.type === "image_url");
  expect(transmitted).toHaveLength(3);
  expect(
    transmitted.map((part: any) =>
      hash(Buffer.from(part.image_url.url.split(",")[1], "base64")),
    ),
  ).toEqual(
    result.binding.references.map((reference) => reference.transmittedSHA256),
  );
  expect(result.references.map((reference) => hash(reference.data))).toEqual(
    result.binding.references.map((reference) => reference.transmittedSHA256),
  );
  expect(result.facts.crossPage[0]!.relationship).toBe("uncertain");
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.state).toBe("confirmed");
  expect(JSON.parse(calls[0]!.usage)).toMatchObject({
    known: true,
    providerMetrics: { input: 321, output: 123 },
  });
  expect(JSON.parse(calls[0]!.model_snapshot).callKind).not.toBe("image");
  expect(await db.selectFrom("ai_operations").selectAll().execute()).toEqual(
    operations,
  );
  expect(await db.selectFrom("assets").selectAll().execute()).toEqual(assets);
});

it("does not cross a PDF boundary when analyzing the first physical page", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return reply(body, facts(body));
  }) as unknown as typeof fetch;
  const result = await analyze(
    fetcher,
    batch.books[1]!.pages[0]!.referenceImageId,
  );
  expect(result.binding.filename).toBe("second.pdf");
  expect(
    result.references.map((reference) => reference.referenceImageId),
  ).toEqual(
    batch.books[1]!.pages.slice(0, 2).map((page) => page.referenceImageId),
  );
  expect(result.references.map((reference) => reference.role)).toEqual([
    "current-original",
    "next-original",
  ]);
});

it("accepts an illustrated body under the formal natural-fusion request without adding a realistic-body defect", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      output = facts(body);
    expect(metadata(body).userRequests[0]).toContain(
      "Accept natural fusion; illustrated bodies are allowed.",
    );
    output.objects[0]!.label = "Naturally blended illustrated parent";
    output.objects[0]!.visibleParts = ["illustrated upper body"];
    output.uncertainties = [];
    return reply(body, output);
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher);
  expect(result.facts.objects[0]!.visibleParts).toEqual([
    "illustrated upper body",
  ]);
  expect(result.facts.roleMappings[0]!.status).toBe("supported");
  expect(result.facts.uncertainties).toEqual([]);
  expect(result.facts.reviewPrecision.mode).toBe("semantic");
});

it("keeps planning compact without requiring all frozen criteria to be repeated", async () => {
  batch.requirements.criteria.push("Preserve scene layout and every non-target character");
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    expect(metadata(body).criteria).toEqual(batch.requirements.criteria);
    output.requirements = [];
    output.reviewPrecision.requestIndices = [0];
    return reply(body, output);
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher);
  expect(result.facts.reviewPrecision.mode).toBe("semantic");
  expect(result.facts.requirements).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("corrects one completed malformed plan using the same original bytes, with both real chat usages retained", async () => {
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const output = facts(body);
    if (requests.length === 1) output.actions[0]!.actorObjectIds = ["undeclared"];
    return reply(body, output);
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.facts.actions[0]!.actorObjectIds).toEqual(["parent"]);
  const contents = requests.map(body => body.messages.find((m: any) => m.role === "user").content);
  expect(contents[0].filter((p: any) => p.type === "image_url"))
    .toEqual(contents[1].filter((p: any) => p.type === "image_url"));
  expect(JSON.stringify(contents[1])).toContain("planningOutputCorrection");
  const correction = contents[1].filter((part: any) => part.type === "text")
    .map((part: any) => JSON.parse(part.text)).find((part: any) => part.planningOutputCorrection);
  expect(JSON.parse(correction.rejectedDraft).actions[0].actorObjectIds).toEqual(["undeclared"]);
  expect(correction.instruction).toContain("未经验证");
  expect(result.facts.actions[0]!.actorObjectIds).not.toContain("undeclared");
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.state).toBe("confirmed");
    expect(JSON.parse(call.usage).providerMetrics).toMatchObject({ input: 321, output: 123 });
    expect(JSON.parse(call.model_snapshot).callKind).not.toBe("image");
  }
  expect(await db.selectFrom("assets").selectAll().where("purpose", "=", "ai_generated").execute()).toEqual([]);
});

it("corrects an object-shaped evidence followed by a wrong role key without repairing rejected facts or changing the input", async () => {
  await useCurrentArkStrictProfile();
  const requests: any[] = [];
  const originalRequirements = structuredClone(batch.requirements);
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    expect(body.response_format.json_schema.strict).toBe(true);
    const output: any = facts(body);
    if (requests.length === 1) output.objects[0].evidence = output.objects[0].evidence[0];
    if (requests.length === 2) {
      output.roleMappings[0].id = output.roleMappings[0].objectId;
      delete output.roleMappings[0].objectId;
    }
    return reply(body, output);
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(Array.isArray(result.facts.objects[0]!.evidence)).toBe(true);
  expect(result.facts.roleMappings[0]!.objectId).toBe("parent");
  expect(result.facts.roleMappings[0]).not.toHaveProperty("id");
  expect(batch.requirements).toEqual(originalRequirements);
  const contents = requests.map(body => body.messages.find((m: any) => m.role === "user").content);
  const images = contents.map(content => content.filter((part: any) => part.type === "image_url"));
  expect(images[1]).toEqual(images[0]);
  expect(images[2]).toEqual(images[0]);
  const correction = (content: any[]) => content.filter(part => part.type === "text")
    .map(part => JSON.parse(part.text)).find(part => part.planningOutputCorrection).planningOutputCorrection;
  expect(correction(contents[1]).join("\n")).toContain("objects.0.evidence");
  expect(correction(contents[2]).join("\n")).toContain("roleMappings.0.objectId");
  expect(metadata(requests[1])).toEqual(metadata(requests[0]));
  expect(metadata(requests[2])).toEqual(metadata(requests[0]));
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.state).toBe("confirmed");
    expect(JSON.parse(call.usage).providerMetrics).toMatchObject({ input: 321, output: 123 });
    expect(JSON.parse(call.model_snapshot).callKind).not.toBe("image");
  }
  expect(await db.selectFrom("assets").selectAll().where("purpose", "=", "ai_generated").execute()).toEqual([]);
});

it("plans a cropped cross-page subject from actual neighboring originals without inventing edit geometry or duplicate neighbor objects", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    output.crossPage[0]!.evidence = "The neighboring original shows an adult at the same table; the cropped arm's ownership is still uncertain.";
    return reply(body, output);
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher);
  expect(result.facts.objects).toHaveLength(1);
  expect(result.facts.crossPage[0]).toMatchObject({
    currentObjectId: "parent", relationship: "uncertain",
    adjacentReferenceImageId: batch.books[0]!.pages[0]!.referenceImageId,
  });
  expect(result.references).toHaveLength(3);
  await expect(result.verify()).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await db.selectFrom("assets").selectAll().where("purpose", "=", "ai_generated").execute()).toEqual([]);
});

it.each(["source-graph", "formal-quotes"])(
  "returns actionable field diagnostics for %s and corrects only the planning reply",
  async (defect) => {
    let calls = 0;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), output = facts(body);
      if (++calls === 1) {
        if (defect === "source-graph") {
          output.actions[0]!.actorObjectIds = ["undeclared"];
          output.crossPage[0]!.currentObjectId = "undeclared-current";
        } else {
          output.roleMappings[0]!.quote = "Dad → photographic Dad";
          output.requirements[0]!.quote = "Dad → photographic Dad";
        }
      } else {
        const content = body.messages.find((message: any) => message.role === "user").content;
        const correction = content.filter((part: any) => part.type === "text")
          .map((part: any) => JSON.parse(part.text)).find((part: any) => part.planningOutputCorrection)
          .planningOutputCorrection.join("\n");
        if (defect === "source-graph") {
          expect(correction).toContain("actions.0.actorObjectIds.0");
          expect(correction).toContain("crossPage.0.currentObjectId");
          expect(correction).not.toContain("undeclared");
        } else {
          expect(correction).toContain("roleMappings.0.quote");
          expect(correction).toContain("requirements.0.quote");
          expect(correction).toContain("userRequests[0]");
          expect(correction).not.toContain("photographic Dad");
        }
      }
      return reply(body, output);
    }) as unknown as typeof fetch;
    expect((await analyze(fetcher)).facts.roleMappings[0]!.status).toBe("supported");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const usage = await db.selectFrom("ai_calls").selectAll().execute();
    expect(usage).toHaveLength(2);
    expect(usage.every(call => call.state === "confirmed")).toBe(true);
    expect(await db.selectFrom("assets").selectAll().where("purpose", "=", "ai_generated").execute()).toEqual([]);
  },
);

it("does not retry a provider quota rejection as a planning correction", async () => {
  const fetcher = vi.fn(async () => Response.json({ error: {
    message: "Quota unavailable", type: "insufficient_quota", code: "insufficient_quota",
  } }, { status: 429 })) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rechecks access before a planning correction and retains only the completed first chat's usage", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    await db.updateTable("assets").set({deleted_at:new Date().toISOString()})
      .where("id","=",batch.books[0]!.source.assetId!).execute();
    return reply(body, "{broken");
  }) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.state).toBe("confirmed");
  expect(JSON.parse(calls[0]!.usage).providerMetrics).toMatchObject({input:321,output:123});
});

it.each([
  ["Keep the background pixel-for-pixel.", "request"],
  ["71 个原样导出页必须保持源页像素尺寸，解码后的 RGBA 像素逐点一致。", "request"],
  ["解码后的RGBA逐点相同。", "request"],
  ["字体与排版严格保持原样。", "criterion"],
  ["Preserve the exact font and layout.", "criterion"],
])(
  "accepts native precision only with mapped explicit formal basis: %s",
  async (basis, source) => {
    if (source === "request")
      await replaceFormalOriginal(`${request} ${basis}`);
    else batch.requirements.criteria = [basis];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)),
        output = facts(body);
      if (source === "request")
        output.requirements.push({
          kind: "preserve",
          requestIndex: 0,
          criterionIndex: null,
          quote: basis,
          objectIds: [],
          applicability: "applies",
          evidence: "This page contains the expressly protected background",
        });
      else output.requirements[1]!.quote = basis;
      output.reviewPrecision = {
        mode: "native",
        criterionIndices: source === "criterion" ? [0] : [],
        requestIndices: source === "request" ? [0] : [],
        reason: basis,
      };
      return reply(body, output);
    }) as unknown as typeof fetch;
    const result = await analyze(fetcher);
    expect(result.facts.reviewPrecision.mode).toBe("native");
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("accepts explicit decoded-pixel preservation with an accompanying generic export criterion", async () => {
  const precise = "71 个原样导出页必须保持源页像素尺寸，解码后的 RGBA 像素逐点一致。";
  await replaceFormalOriginal(`${request} ${precise}`);
  batch.requirements.criteria = ["未指定页保持源页像素尺寸并原样导出，不重绘。"];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    output.requirements[1]!.quote = batch.requirements.criteria[0]!;
    output.requirements.push({ kind: "preserve", requestIndex: 0, criterionIndex: null,
      quote: precise, objectIds: [], applicability: "applies", evidence: "Current page is explicitly unedited." });
    output.reviewPrecision = { mode: "native", criterionIndices: [0], requestIndices: [0],
      reason: "Explicit decoded RGBA equality supports native review; export criterion supplies scope." };
    return reply(body, output);
  }) as unknown as typeof fetch;
  expect((await analyze(fetcher)).facts.reviewPrecision.mode).toBe("native");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not turn a source pixel-dimension requirement into pixel-equality authorization", async () => {
  const dimensions = "未指定页保持源页像素尺寸。";
  await replaceFormalOriginal(`${request} ${dimensions}`);
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    output.requirements.push({ kind: "preserve", requestIndex: 0, criterionIndex: null,
      quote: dimensions, objectIds: [], applicability: "applies", evidence: "Preserve dimensions only." });
    output.reviewPrecision = { mode: "native", criterionIndices: [], requestIndices: [0], reason: dimensions };
    return reply(body, output);
  }) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow("严格事实");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([
  "missing-shape",
  "unknown-mode",
  "empty-reason",
  "duplicate-index",
  "unknown-criterion",
  "unknown-request",
  "generic-preservation",
  "empty-native-basis",
  "denied-precision",
  "inapplicable-native",
  "change-only-native",
])(
  "rejects %s precision without inventing a default or native authorization",
  async (defect) => {
    if (["inapplicable-native", "change-only-native"].includes(defect))
      batch.requirements.criteria = ["Preserve the exact font and layout."];
    if (defect === "denied-precision")
      await replaceFormalOriginal(
        `${request} No need for pixel-exact preservation.`,
      );
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)),
        output: any = facts(body);
      if (defect === "missing-shape") delete output.reviewPrecision;
      if (defect === "unknown-mode") output.reviewPrecision.mode = "guess";
      if (defect === "empty-reason") output.reviewPrecision.reason = "";
      if (defect === "duplicate-index")
        output.reviewPrecision.criterionIndices = [0, 0];
      if (defect === "unknown-criterion")
        output.reviewPrecision.criterionIndices = [1];
      if (defect === "unknown-request")
        output.reviewPrecision.requestIndices = [1];
      if (
        [
          "generic-preservation",
          "empty-native-basis",
          "inapplicable-native",
          "change-only-native",
        ].includes(defect)
      )
        output.reviewPrecision.mode = "native";
      if (defect === "empty-native-basis")
        output.reviewPrecision.criterionIndices = [];
      if (["inapplicable-native", "change-only-native"].includes(defect)) {
        output.requirements[1].quote = batch.requirements.criteria[0];
        if (defect === "inapplicable-native")
          output.requirements[1].applicability = "not-applicable";
        else output.requirements[1].kind = "change";
      }
      if (defect === "denied-precision") {
        output.requirements.push({
          kind: "preserve",
          requestIndex: 0,
          criterionIndex: null,
          quote: "pixel-exact preservation",
          objectIds: [],
          applicability: "applies",
          evidence: "Executor wrongly cut the negation from a user quote",
        });
        output.reviewPrecision = {
          mode: "native",
          criterionIndices: [],
          requestIndices: [0],
          reason: "pixel-exact preservation",
        };
      }
      return reply(body, output);
    }) as unknown as typeof fetch;
    await expect(analyze(fetcher)).rejects.toThrow("严格事实");
    const calls = await db.selectFrom("ai_calls").selectAll().execute();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.state).toBe("confirmed");
    expect(JSON.parse(calls[0]!.usage).providerMetrics).toMatchObject({
      input: 321,
      output: 123,
    });
  },
);

it.each([false, true])(
  "latest formal natural-fusion clarification supersedes only the old precision basis; stale native=%s",
  async (staleNative) => {
    const oldPrecision = "Keep the background pixel-for-pixel.",
      latest =
        "For this batch, accept natural fusion and illustration. No need for pixel-exact background preservation.";
    await replaceFormalOriginal(`${request} ${oldPrecision}`);
    await clarify(latest);
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)),
        output = facts(body);
      expect(metadata(body).userRequests).toEqual([
        `${request} ${oldPrecision}`,
        latest,
      ]);
      expect(metadata(body).userRequestMetadata.requests[1]).toMatchObject({
        kind: "batch-clarification",
        requestIndex: 1,
      });
      output.requirements.push(
        {
          kind: "preserve",
          requestIndex: 0,
          criterionIndex: null,
          quote: oldPrecision,
          objectIds: [],
          applicability: "not-applicable",
          evidence:
            "The latest batch clarification expressly relaxed background pixel precision",
        },
        {
          kind: "change",
          requestIndex: 1,
          criterionIndex: null,
          quote: "accept natural fusion and illustration",
          objectIds: ["parent"],
          applicability: "applies",
          evidence:
            "Style and related background fusion may be natural while original words remain required",
        },
      );
      output.reviewPrecision = {
        mode: staleNative ? "native" : "semantic",
        criterionIndices: [],
        requestIndices: [staleNative ? 0 : 1],
        reason: staleNative ? oldPrecision : latest,
      };
      return reply(body, output);
    }) as unknown as typeof fetch;
    if (staleNative) await expect(analyze(fetcher)).rejects.toThrow("严格事实");
    else {
      const result = await analyze(fetcher);
      expect(result.facts.reviewPrecision.mode).toBe("semantic");
      expect(
        result.facts.requirements.find((item) => item.criterionIndex === 0)
          ?.applicability,
      ).toBe("applies");
    }
  },
);

it("exposes runtime verification that reuses no provider call, preserves metered facts and resolves void", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return reply(body, facts(body));
  }) as unknown as typeof fetch;
  const result = await analyze(fetcher),
    calls = await db.selectFrom("ai_calls").selectAll().execute();
  await expect(result.verify()).resolves.toBeUndefined();
  await expect(result.verify()).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(calls);
  const checkpoint = JSON.stringify({
    binding: result.binding,
    facts: result.facts,
  });
  expect(checkpoint).not.toContain('"data"');
  expect(checkpoint).not.toContain("verify");
});

it.each([
  "permission",
  "formal-request",
  "scope",
  "source-pdf",
  "original-page",
  "adjacent-page",
])(
  "runtime cached facts reject %s changes without a new call or altered fee facts",
  async (defect) => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return reply(body, facts(body));
    }) as unknown as typeof fetch;
    const result = await analyze(fetcher),
      calls = await db.selectFrom("ai_calls").selectAll().execute();
    if (defect === "permission")
      await db
        .updateTable("assets")
        .set({ deleted_at: new Date().toISOString() })
        .where("id", "=", batch.books[0]!.source.assetId!)
        .execute();
    if (defect === "formal-request")
      await db
        .updateTable("ai_jobs")
        .set({ input: JSON.stringify({ text: "Replaced formal text" }) })
        .where("id", "=", batch.requirements.original.jobId)
        .execute();
    if (defect === "scope")
      await db
        .updateTable("ai_operations")
        .set({ digest: "invalid-scope-digest" })
        .where("id", "=", batch.attemptScope.operationId)
        .execute();
    if (defect === "source-pdf") {
      const row = await db
        .selectFrom("assets")
        .selectAll()
        .where("id", "=", batch.books[0]!.source.assetId!)
        .executeTakeFirstOrThrow();
      await writeFile(join(root, row.object_key), Buffer.alloc(row.size, 19));
    }
    if (["original-page", "adjacent-page"].includes(defect)) {
      const referenceId =
          defect === "original-page"
            ? current
            : batch.books[0]!.pages[0]!.referenceImageId,
        row = await db
          .selectFrom("file_derivatives")
          .selectAll()
          .where("id", "=", referenceId)
          .executeTakeFirstOrThrow(),
        bytes = await sharp({
          create: {
            width: 120,
            height: 180,
            channels: 3,
            background: "#123123",
          },
        })
          .png()
          .toBuffer();
      await writeFile(join(root, row.object_key), bytes);
      await db
        .updateTable("file_derivatives")
        .set({ size: bytes.length })
        .where("id", "=", referenceId)
        .execute();
    }
    await expect(result.verify()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual(
      calls,
    );
  },
);

it("rejects a non-vision model before reserving or sending a request", async () => {
  const config = await aiConfig(db);
  const { revision, ...settings } = config;
  await saveAIConfig(
    db,
    {
      ...settings,
      models: config.models.map((item) => ({ ...item, vision: false })),
    },
    revision,
  );
  const fetcher = vi.fn();
  await expect(analyze(fetcher as unknown as typeof fetch)).rejects.toThrow(
    "需要视觉模型",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual([]);
});

it("rejects insufficient context instead of dropping original or adjacent images before reserving usage", async () => {
  const { revision, ...config } = await aiConfig(db);
  await saveAIConfig(
    db,
    {
      ...config,
      models: config.models.map((item) => ({ ...item, maxInput: 1024 })),
    },
    revision,
  );
  const fetcher = vi.fn();
  await expect(analyze(fetcher as unknown as typeof fetch)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual([]);
});

it.each([
  "permission",
  "source-bytes",
  "recipe",
  "formal-request",
  "book-name",
  "unknown-page",
])("rejects %s before a provider call or usage reservation", async (defect) => {
  const fetcher = vi.fn();
  let supplied = batch,
    page = current;
  if (defect === "permission")
    await db
      .updateTable("assets")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", batch.books[0]!.source.assetId!)
      .execute();
  if (defect === "source-bytes") {
    const row = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", batch.books[0]!.source.assetId!)
      .executeTakeFirstOrThrow();
    await writeFile(join(root, row.object_key), Buffer.alloc(row.size, 12));
  }
  if (defect === "recipe")
    await db
      .updateTable("file_derivatives")
      .set({ recipe: `v${PARSER_VERSION}-img-999` })
      .where("id", "=", current)
      .execute();
  if (defect === "formal-request") {
    supplied = structuredClone(batch);
    supplied.requirements.original.text =
      "Executor replaced the actual request";
  }
  if (defect === "book-name") {
    supplied = structuredClone(batch);
    supplied.books[0]!.filename = "second.pdf";
  }
  if (defect === "unknown-page") page = randomUUID();
  await expect(
    analyze(fetcher as unknown as typeof fetch, page, supplied),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual([]);
});

it("rechecks actual original pixels after the metered response and retains its real cost if source bytes changed", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      row = await db
        .selectFrom("file_derivatives")
        .selectAll()
        .where("id", "=", current)
        .executeTakeFirstOrThrow();
    const bytes = await sharp({
      create: { width: 120, height: 180, channels: 3, background: "#111111" },
    })
      .png()
      .toBuffer();
    await writeFile(join(root, row.object_key), bytes);
    await db
      .updateTable("file_derivatives")
      .set({ size: bytes.length })
      .where("id", "=", current)
      .execute();
    return reply(body, facts(body));
  }) as unknown as typeof fetch;
  await expect(analyze(fetcher)).rejects.toThrow("实际字节已改变");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const calls = await db.selectFrom("ai_calls").selectAll().execute();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.state).toBe("confirmed");
  expect(JSON.parse(calls[0]!.usage)).toMatchObject({
    known: true,
    providerMetrics: { input: 321, output: 123 },
  });
});

it.each([
  "wrong-reference",
  "unknown-object",
  "repeated-object",
  "wrong-quote",
  "inferred-role",
  "non-adjacent",
  "unknown-key",
  "truncated",
  "invalid-json",
])(
  "rejects %s facts after at most two metered planning corrections, without acceptance or image calls",
  async (defect) => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)),
        output: any = facts(body);
      if (defect === "wrong-reference")
        output.objects[0].evidence[0].referenceImageId =
          batch.books[1]!.pages[0]!.referenceImageId;
      if (defect === "unknown-object")
        output.actions[0].actorObjectIds = ["invented"];
      if (defect === "repeated-object") output.objects.push(output.objects[0]);
      if (defect === "wrong-quote")
        output.requirements[0].quote = "Permit deleting all background";
      if (defect === "inferred-role") {
        output.roleMappings[0].requestIndex = null;
        output.roleMappings[0].quote = null;
      }
      if (defect === "non-adjacent")
        output.crossPage[0].adjacentReferenceImageId = current;
      if (defect === "unknown-key") output.passed = true;
      return reply(
        body,
        defect === "invalid-json" ? "{broken" : output,
        defect === "truncated" ? "length" : "stop",
      );
    }) as unknown as typeof fetch;
    await expect(analyze(fetcher)).rejects.toThrow("严格事实");
    expect(fetcher).toHaveBeenCalledTimes(defect === "truncated" ? 1 : 3);
    const calls = await db.selectFrom("ai_calls").selectAll().execute();
    expect(calls).toHaveLength(defect === "truncated" ? 1 : 3);
    expect(calls[0]!.state).toBe("confirmed");
    expect(
      await db
        .selectFrom("assets")
        .selectAll()
        .where("purpose", "=", "ai_generated")
        .execute(),
    ).toEqual([]);
  },
);

it("preserves the bounded failed plan's precise host diagnostics without returning rejected model text", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), output = facts(body);
    output.roleMappings[0]!.quote = "Invent a new family and discard the book";
    output.actions[0]!.actorObjectIds = ["untrusted-invented-id"];
    return reply(body, output);
  }) as unknown as typeof fetch;
  let error: unknown;
  try { await analyze(fetcher); } catch (failure) { error = failure; }
  expect(String(error)).toContain("roleMappings.0.quote");
  expect(String(error)).toContain("actions.0.actorObjectIds.0");
  expect(String(error)).not.toContain("Invent a new family");
  expect(String(error)).not.toContain("untrusted-invented-id");
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toHaveLength(3);
});
