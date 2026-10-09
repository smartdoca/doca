import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUser } from "@core/modules/identity/passwords.js";
import { systemErrorReason } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import { openTestDatabase } from "./database.js";
import * as images from "../apps/server/src/services/ai/images.js";
import * as segments from "../apps/server/src/services/ai/image-mask-segment.js";
import {
  rawImageCandidateSchema,
  type RawImageCandidate,
} from "../apps/server/src/services/ai/image-candidates.js";
import {
  prepareImageEditMask,
  readImageEditMask,
  type ImageEditMaskInput,
} from "../apps/server/src/services/ai/image-edit-mask.js";
import {
  imageMaskRefineInputSchema,
  imageMaskRefineOutputSchema,
  refineImageEditMask,
  type ImageMaskRefineInput,
} from "../apps/server/src/services/ai/image-mask-refine.js";
import { recomposeImageMaskAsset } from "../apps/server/src/services/ai/image-recompose.js";
import type { StorageRuntime } from "../apps/server/src/adapters/storage.js";

const width = 80,
  height = 60;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const empty = () => ({ proposalIds: [], include: [], exclude: [] });
const region = (left: number, top: number, right: number, bottom: number) => ({
  label: "isolated refine fixture",
  points: [
    [left / width, top / height],
    [right / width, top / height],
    [right / width, bottom / height],
    [left / width, bottom / height],
  ] as [number, number][],
});
function set(
  pixels: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  value = 255,
) {
  for (let row = y; row < y + h; row++)
    pixels.fill(value, row * width + x, row * width + x + w);
}
const binary = () => Buffer.alloc(width * height);
let db: Awaited<ReturnType<typeof openTestDatabase>>, ctx: ToolContext;
let sourceId: string,
  generationId: string,
  raw: Awaited<ReturnType<typeof images.readRawImageCandidate>>;
let network: ReturnType<typeof vi.fn>;
const proposals = new Map<
  string,
  Awaited<ReturnType<typeof segments.readUsableImageMaskSegment>>
>();
async function proposal(pixels: Buffer, kind: "reference" | "raw") {
  const id = randomUUID(),
    selectionPNG = await sharp(pixels, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
  const positive = pixels.indexOf(255),
    negative = pixels.indexOf(0);
  if (positive < 0)
    throw new Error("Usable strict proposal fixture requires a selected pixel");
  const pointAt = (index: number): [number, number] => [
    ((index % width) + 0.5) / width,
    (Math.floor(index / width) + 0.5) / height,
  ];
  // Only immutable candidate/proposal I/O is stubbed. Strict v2 preparation,
  // reading, geometry, SVG composition and DB rollback all run unchanged.
  proposals.set(id, {
    selectionPNG,
    receipt: {
      state: "ready",
      usable: true,
      receiptId: id,
      digest: sha(selectionPNG),
      selectionSha256: sha(pixels),
      input: {
        source:
          kind === "reference"
            ? { kind, referenceImageId: sourceId }
            : { kind, generationOperationId: generationId },
        targets: [
          {
            label: "isolated strict proposal target",
            box: [0, 0, 1, 1],
            positivePoints: [pointAt(positive)],
            negativePoints: negative < 0 ? [] : [pointAt(negative)],
          },
        ],
        exclusions: [],
      },
      binding: {
        referenceImageId: sourceId,
        sourceSha256: raw.candidate.references[0]!.sha256,
        sourceSize: raw.sources[0]!.data.length,
        dimensions: { width, height },
        generatedWindow: { left: 0, top: 0, width, height },
        raw:
          kind === "reference"
            ? null
            : {
                generationOperationId: generationId,
                receiptId: raw.receiptId,
                sha256: raw.candidate.sha256,
                transform: raw.candidate.transform,
              },
      },
    },
  } as unknown as Awaited<
    ReturnType<typeof segments.readUsableImageMaskSegment>
  >);
  return id;
}
function baseInput(): ImageEditMaskInput {
  return {
    generationOperationId: generationId,
    referenceImageId: sourceId,
    sourceTarget: { ...empty(), include: [region(10, 10, 30, 35)] },
    generatedTarget: { ...empty(), include: [region(20, 8, 40, 38)] },
    protected: { ...empty(), include: [region(25, 18, 32, 24)] },
    allowedOcclusion: empty(),
    textEdits: { ...empty(), include: [region(29, 20, 31, 22)] },
  };
}
const refineInput = (baseMaskReceiptId: string): ImageMaskRefineInput => ({
  baseMaskReceiptId,
  sourceExclude: [{ selection: "source-protected" }],
  allowedOcclusionAdd: [{ selection: "generated-protected" }],
  sourceInclude: [],
  generatedInclude: [],
  generatedExclude: [],
});
const records = () =>
  db.selectFrom("ai_operations").selectAll().orderBy("id").execute();
async function refused(promise: Promise<unknown>, code: string) {
  await expect(promise.catch(systemErrorReason)).resolves.toMatchObject({
    code,
  });
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const actor = {
    ...(await createUser(
      db,
      {
        login: "refine-fixture",
        displayName: "Fixture",
        password: "refine-isolated-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const sessionId = randomUUID(),
    jobId = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: sessionId,
      user_id: actor.id,
      title: "Isolated refine",
      model_id: "image",
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
      user_id: actor.id,
      session_id: sessionId,
      model_id: "image",
      status: "running",
      input: "{}",
      result: "",
      digest: jobId,
      error: "",
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
      cancelled: 0,
      attempts: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  ctx = { actor, jobId, lease } as ToolContext;
  sourceId = randomUUID();
  generationId = randomUUID();
  const source = await sharp({
    create: { width, height, channels: 4, background: "#426683" },
  })
    .png()
    .toBuffer();
  const data = await sharp({
    create: { width, height, channels: 4, background: "#a87742" },
  })
    .png()
    .toBuffer();
  const candidate: RawImageCandidate = rawImageCandidateSchema.parse({
    kind: "image_raw_candidate",
    version: 1,
    origin: "provider",
    state: "saved",
    generationOperationId: generationId,
    providerCallId: randomUUID(),
    assetId: randomUUID(),
    profileId: "isolated-only",
    objectKey: "isolated.png",
    mime: "image/png",
    size: data.length,
    sha256: sha(data),
    dimensions: { width, height },
    references: [
      {
        referenceImageId: sourceId,
        sha256: sha(source),
        size: source.length,
        width,
        height,
      },
    ],
    scope: { resourceId: null, jobId, sessionId },
    request: {
      modelId: "isolated",
      model: "isolated",
      protocol: "openai-edits",
      prompt: "fixture",
      size: { width, height },
      transportDimensions: [{ width, height }],
    },
    transform: { kind: "full" },
    nativeUsage: { state: "not-reported" },
  });
  raw = {
    candidate,
    receiptId: randomUUID(),
    data,
    sources: [{ data: source, mime: "image/png", filename: "source.png" }],
  } as typeof raw;
  vi.spyOn(images, "readRawImageCandidate").mockImplementation(
    async (_db, _ctx, id) => {
      if (id !== generationId) throw new Error("Wrong retained generation");
      return raw;
    },
  );
  vi.spyOn(segments, "readUsableImageMaskSegment").mockImplementation(
    async (_db, _ctx, id) => {
      const item = proposals.get(id);
      if (!item) throw new Error("Missing strict proposal fixture");
      return item;
    },
  );
  network = vi.fn(() => {
    throw new Error("No provider/API access permitted");
  });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  proposals.clear();
  await db.destroy();
});

it("requires explicit bounded directives, rejects wrong selections/unknown fields, and does not invent missing arrays", () => {
  const valid = refineInput(randomUUID());
  expect(imageMaskRefineInputSchema.safeParse(valid).success).toBe(true);
  for (const key of [
    "sourceExclude",
    "allowedOcclusionAdd",
    "sourceInclude",
    "generatedInclude",
    "generatedExclude",
  ] as const) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[key];
    expect(imageMaskRefineInputSchema.safeParse(missing).success).toBe(false);
  }
  for (const key of ["sourceExclude", "allowedOcclusionAdd"] as const)
    expect(
      imageMaskRefineInputSchema.safeParse({
        ...valid,
        [key]: Array(33).fill(valid[key][0]),
      }).success,
    ).toBe(false);
  for (const key of [
    "sourceInclude",
    "generatedInclude",
    "generatedExclude",
  ] as const)
    expect(
      imageMaskRefineInputSchema.safeParse({
        ...valid,
        [key]: Array(33).fill(region(1, 1, 2, 2)),
      }).success,
    ).toBe(false);
  expect(
    imageMaskRefineInputSchema.safeParse({
      ...valid,
      sourceExclude: [{ selection: "generated-protected" }],
    }).success,
  ).toBe(false);
  expect(
    imageMaskRefineInputSchema.safeParse({
      ...valid,
      allowedOcclusionAdd: [{ selection: "source-protected" }],
    }).success,
  ).toBe(false);
  expect(
    imageMaskRefineInputSchema.safeParse({
      ...valid,
      sourcePath: "/tmp/model-controlled",
    }).success,
  ).toBe(false);
  expect(
    imageMaskRefineInputSchema.safeParse({
      ...valid,
      sourceExclude: [{ selection: "source-protected", clipRegions: [] }],
    }).success,
  ).toBe(false);
});
it("creates a compact standard v2 receipt with exact S subtraction/O addition and retains all original proposals and other layers", async () => {
  const s = binary(),
    g = binary(),
    p = binary(),
    t = binary();
  set(s, 10, 10, 20, 25);
  set(g, 20, 8, 20, 30);
  set(p, 25, 18, 7, 6);
  set(t, 29, 20, 2, 2);
  const input = baseInput();
  for (const [name, pixels, kind] of [
    ["sourceTarget", s, "reference"],
    ["generatedTarget", g, "raw"],
    ["protected", p, "reference"],
    ["textEdits", t, "reference"],
  ] as const)
    input[name] = { ...empty(), proposalIds: [await proposal(pixels, kind)] };
  const base = await prepareImageEditMask(db, ctx, input, randomUUID());
  const before = await records(),
    id = randomUUID();
  const args = refineInput(base.receiptId);
  args.sourceExclude[0]!.clipRegions = [region(26, 19, 29, 24)];
  args.sourceInclude = [region(5, 5, 8, 8)];
  const output = await refineImageEditMask(db, ctx, args, id);
  expect(imageMaskRefineOutputSchema.safeParse(output).success).toBe(true);
  expect(output.maskReceiptId).toBe(id);
  expect(output.refinement.baseMaskReceiptId).toBe(base.receiptId);
  expect(output.refinement.baseMaskReceiptDigest).toBe(base.digest);
  expect(output.refinement.semanticCoverage).toBe("unverified");
  expect(JSON.stringify(output).length).toBeLessThan(4000);
  expect(output).not.toHaveProperty("input");
  expect(output).not.toHaveProperty("geometry");
  const current = await readImageEditMask(db, ctx, id);
  const expectedS = Buffer.from(s),
    expectedO = binary(),
    excluded = binary();
  set(expectedS, 5, 5, 3, 3);
  set(excluded, 26, 19, 3, 5);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === 255 && p[i] === 255 && excluded[i] === 255) expectedS[i] = 0;
    if (g[i] === 255 && p[i] === 255 && t[i] !== 255) expectedO[i] = 255;
  }
  expect(current.computed.s.pixels).toEqual(expectedS);
  expect(current.computed.g.pixels).toEqual(g);
  expect(current.computed.o.pixels).toEqual(expectedO);
  expect(output.refinement.sourceTargetSha256).toBe(sha(expectedS));
  expect(output.refinement.generatedTargetSha256).toBe(sha(g));
  expect(output.refinement.generatedIncludeSha256).toBe(sha(binary()));
  expect(output.refinement.generatedExcludeSha256).toBe(sha(binary()));
  expect(output.refinement.allowedOcclusionSha256).toBe(sha(expectedO));
  expect(output.refinement.allowedOcclusionAdded[0]!.selectedPixels).toBe(38);
  for (const name of [
    "sourceTarget",
    "generatedTarget",
    "protected",
    "allowedOcclusion",
    "textEdits",
  ] as const)
    expect(current.receipt.input[name].proposalIds).toEqual(
      input[name].proposalIds,
    );
  for (const name of ["generatedTarget", "protected", "textEdits"] as const)
    expect(current.receipt.input[name]).toEqual(input[name]);
  expect(current.receipt.proposalBindings).toEqual(base.proposalBindings);
  expect(current.receipt.generatedWindow).toEqual(base.generatedWindow);
  expect(current.receipt.version).toBe(2);
  expect((await records()).find((row) => row.id === base.receiptId)).toEqual(
    before[0],
  );
  expect(await records()).toHaveLength(2);
  const repeated = await refineImageEditMask(db, ctx, args, id);
  expect(repeated).toEqual(output);
  expect(await records()).toHaveLength(2);
});
it("retains baseline S/G/O holes and all five proposals while applying exact full-canvas S/G/O formulas and combined selection", async () => {
  const s = binary(),
    g = binary(),
    p = binary(),
    t = binary(),
    o = binary();
  set(s, 10, 10, 20, 25);
  set(g, 20, 8, 20, 30);
  set(p, 25, 18, 7, 6);
  set(t, 29, 20, 2, 2);
  set(o, 25, 18, 3, 2);
  const input = baseInput();
  for (const [name, pixels, kind] of [
    ["sourceTarget", s, "reference"],
    ["generatedTarget", g, "raw"],
    ["protected", p, "reference"],
    ["allowedOcclusion", o, "raw"],
    ["textEdits", t, "reference"],
  ] as const)
    input[name] = { ...empty(), proposalIds: [await proposal(pixels, kind)] };
  input.sourceTarget.exclude = [region(11, 11, 13, 13)];
  input.generatedTarget.exclude = [region(35, 12, 37, 14)];
  input.allowedOcclusion.exclude = [region(26, 18, 27, 19)];
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    old = await readImageEditMask(db, ctx, base.receiptId),
    before = await records();
  const args = refineInput(base.receiptId);
  args.sourceExclude[0]!.clipRegions = [region(26, 19, 29, 24)];
  args.sourceInclude = [region(11, 11, 13, 13), region(5, 5, 8, 8)];
  args.generatedInclude = [
    region(35, 12, 37, 14),
    region(15, 6, 23, 12),
    region(42, 40, 44, 42),
  ];
  args.generatedExclude = [region(22, 9, 24, 12), region(43, 40, 44, 42)];
  const id = randomUUID(),
    output = await refineImageEditMask(db, ctx, args, id),
    current = await readImageEditMask(db, ctx, id);
  const expectedS = Buffer.from(s),
    expectedG = Buffer.from(g),
    expectedO = Buffer.from(o),
    includedS = binary(),
    includedG = binary(),
    excludedG = binary(),
    clippedSP = binary();
  set(includedS, 11, 11, 2, 2);
  set(includedS, 5, 5, 3, 3);
  set(includedG, 35, 12, 2, 2);
  set(includedG, 15, 6, 8, 6);
  set(includedG, 42, 40, 2, 2);
  set(excludedG, 22, 9, 2, 3);
  set(excludedG, 43, 40, 1, 2);
  set(clippedSP, 26, 19, 3, 5);
  for (let i = 0; i < s.length; i++) {
    if (includedS[i] === 255) expectedS[i] = 255;
    if (includedG[i] === 255) expectedG[i] = 255;
    if (excludedG[i] === 255) expectedG[i] = 0;
    if (
      old.computed.s.pixels[i] === 255 &&
      p[i] === 255 &&
      clippedSP[i] === 255
    )
      expectedS[i] = 0;
    if (old.computed.g.pixels[i] === 255 && p[i] === 255 && t[i] !== 255)
      expectedO[i] = 255;
  }
  set(expectedS, 11, 11, 2, 2, 0);
  set(expectedG, 35, 12, 2, 2, 0);
  set(expectedO, 26, 18, 1, 1, 0);
  const combined = binary();
  for (let i = 0; i < combined.length; i++)
    if (expectedS[i] === 255 || expectedG[i] === 255 || t[i] === 255)
      combined[i] = 255;
  expect(current.computed.s.pixels).toEqual(expectedS);
  expect(current.computed.g.pixels).toEqual(expectedG);
  expect(current.computed.o.pixels).toEqual(expectedO);
  expect(current.computed.p.pixels).toEqual(p);
  expect(current.computed.t.pixels).toEqual(t);
  expect(
    await sharp(current.maskPNG).toColourspace("b-w").raw().toBuffer(),
  ).toEqual(combined);
  expect(current.sourceData).toEqual(old.sourceData);
  expect(current.generatedCanvas).toEqual(old.generatedCanvas);
  expect(output.refinement).toMatchObject({
    sourceIncludeSha256: sha(includedS),
    generatedIncludeSha256: sha(includedG),
    generatedExcludeSha256: sha(excludedG),
    sourceTargetSha256: sha(expectedS),
    generatedTargetSha256: sha(expectedG),
    allowedOcclusionSha256: sha(expectedO),
    roundTripExact: true,
    semanticCoverage: "unverified",
  });
  for (const name of [
    "sourceTarget",
    "generatedTarget",
    "protected",
    "allowedOcclusion",
    "textEdits",
  ] as const)
    expect(current.receipt.input[name].proposalIds).toEqual(
      input[name].proposalIds,
    );
  for (const name of [
    "sourceTarget",
    "generatedTarget",
    "allowedOcclusion",
  ] as const)
    expect(
      current.receipt.input[name].exclude.slice(0, input[name].exclude.length),
    ).toEqual(input[name].exclude);
  expect(current.receipt.input.protected).toEqual(input.protected);
  expect(current.receipt.input.textEdits).toEqual(input.textEdits);
  expect(current.receipt.proposalBindings).toEqual(base.proposalBindings);
  expect(current.receipt.generatedWindow).toEqual(base.generatedWindow);
  expect((await records()).find((row) => row.id === base.receiptId)).toEqual(
    before[0],
  );
  expect(current.receipt.version).toBe(2);
});
it("only adds base GP occlusion and leaves newly included G/P overlap unsafe for the existing compose guard", async () => {
  const input = baseInput();
  input.protected.include = [region(25, 18, 32, 24), region(42, 18, 46, 22)];
  input.allowedOcclusion.include = [region(25, 18, 32, 24)];
  input.textEdits = empty();
  const base = await prepareImageEditMask(db, ctx, input, randomUUID());
  expect(base.diagnostics.safeToCompose).toBe(true);
  const args = refineInput(base.receiptId);
  args.sourceExclude = [];
  args.generatedInclude = [region(42, 18, 46, 22)];
  const id = randomUUID(),
    output = await refineImageEditMask(db, ctx, args, id),
    loaded = await readImageEditMask(db, ctx, id),
    before = await records();
  expect(output.diagnostics).toMatchObject({
    safeToCompose: false,
    generatedConflictPixels: 16,
  });
  expect(loaded.computed.g.pixels[19 * width + 43]).toBe(255);
  expect(loaded.computed.o.pixels[19 * width + 43]).toBe(0);
  expect(loaded.receipt.input.protected).toEqual(input.protected);
  expect(output.refinement.allowedOcclusionAdded[0]!.selectedPixels).toBe(42);
  await expect(
    recomposeImageMaskAsset(
      db,
      ctx,
      {
        maskReceiptId: id,
        generationOperationId: generationId,
        referenceImageId: sourceId,
        filename: "unsafe.png",
      },
      randomUUID(),
      { storage: {} as StorageRuntime },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await records()).toEqual(before);
});
it("rejects removing generated support under retained base O and rolls back the whole new receipt", async () => {
  const input = baseInput();
  input.allowedOcclusion.include = [region(25, 18, 27, 19)];
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    before = await records();
  const args = {
    ...refineInput(base.receiptId),
    sourceExclude: [],
    allowedOcclusionAdd: [],
    generatedExclude: [region(25, 18, 27, 19)],
  };
  await refused(
    refineImageEditMask(db, ctx, args, randomUUID()),
    "image_mask_invalid_occlusion",
  );
  expect(await records()).toEqual(before);
});
it("rolls back a newly prepared receipt if source include source-over alpha expands the expected binary union", async () => {
  const input = baseInput(),
    thin = region(50.3, 50, 50.7, 51);
  input.sourceTarget.include = [...input.sourceTarget.include, thin];
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    before = await records(),
    id = randomUUID();
  const args = {
    ...refineInput(base.receiptId),
    sourceExclude: [],
    allowedOcclusionAdd: [],
    sourceInclude: [thin],
  };
  await refused(
    refineImageEditMask(db, ctx, args, id),
    "image_mask_refine_roundtrip",
  );
  expect(await records()).toEqual(before);
  await expect(readImageEditMask(db, ctx, id)).rejects.toMatchObject({
    status: 404,
  });
});
it.each(["generatedInclude", "generatedExclude"] as const)(
  "rolls back source-over alpha differences for %s instead of changing the binary contract",
  async (kind) => {
    const input = baseInput(),
      thin = region(50.3, 50, 50.7, 51);
    if (kind === "generatedInclude")
      input.generatedTarget.include = [...input.generatedTarget.include, thin];
    else {
      input.generatedTarget.include = [
        ...input.generatedTarget.include,
        region(50, 49, 52, 52),
      ];
      input.generatedTarget.exclude = [...input.generatedTarget.exclude, thin];
    }
    const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
      before = await records(),
      id = randomUUID();
    const args = {
      ...refineInput(base.receiptId),
      sourceExclude: [],
      allowedOcclusionAdd: [],
      [kind]: [thin],
    };
    await refused(
      refineImageEditMask(db, ctx, args, id),
      "image_mask_refine_roundtrip",
    );
    expect(await records()).toEqual(before);
    await expect(readImageEditMask(db, ctx, id)).rejects.toMatchObject({
      status: 404,
    });
  },
);
function holePattern() {
  const pixels = binary(),
    clips = [];
  for (let i = 0; i < 90; i++) {
    const x = 2 + (i % 15) * 3,
      y = 2 + Math.floor(i / 15) * 3;
    set(pixels, x, y, 1, 1);
    clips.push(region(x, y, x + 1, y + 1));
  }
  const x = 3,
    y = 30,
    n = 20,
    points: [number, number][] = [
      [x, y],
      [x + 2, y],
    ];
  for (let i = 0; i < n; i++) set(pixels, x + i, y + i, 2, 1);
  for (let i = 0; i < n - 1; i++)
    points.push([x + i + 2, y + i + 1], [x + i + 3, y + i + 1]);
  points.push([x + n + 1, y + n], [x + n - 1, y + n]);
  for (let i = n - 1; i >= 1; i--)
    points.push([x + i, y + i], [x + i - 1, y + i]);
  clips.push({
    label: "orthogonal staircase",
    points: points.map(
      ([px, py]) => [px / width, py / height] as [number, number],
    ),
  });
  set(pixels, 55, 35, 20, 20);
  set(pixels, 60, 40, 10, 10, 0);
  clips.push(
    region(55, 35, 75, 40),
    region(55, 50, 75, 55),
    region(55, 40, 60, 50),
    region(70, 40, 75, 50),
  );
  return { pixels, clips };
}
it("rejects a source-protected subtraction containing a true hole rather than filling the hole", async () => {
  const { pixels } = holePattern(),
    input = baseInput();
  input.sourceTarget = {
    ...empty(),
    proposalIds: [await proposal(pixels, "reference")],
  };
  input.protected = {
    ...empty(),
    proposalIds: [await proposal(pixels, "reference")],
  };
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    before = await records();
  const args = { ...refineInput(base.receiptId), allowedOcclusionAdd: [] };
  await refused(
    refineImageEditMask(db, ctx, args, randomUUID()),
    "image_mask_refine_source_holes",
  );
  expect(await records()).toEqual(before);
});
it("rolls back when one occlusion geometry's hole would subtract another explicitly added GP selection", async () => {
  const { clips } = holePattern(),
    input = baseInput();
  input.generatedTarget = {
    ...empty(),
    include: [region(0, 0, width, height)],
  };
  input.protected = { ...empty(), include: [region(0, 0, width, height)] };
  input.textEdits = empty();
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    before = await records();
  const args: ImageMaskRefineInput = {
    baseMaskReceiptId: base.receiptId,
    sourceInclude: [],
    generatedInclude: [],
    generatedExclude: [],
    sourceExclude: [],
    allowedOcclusionAdd: [
      { selection: "generated-protected", clipRegions: clips },
      {
        selection: "generated-protected",
        clipRegions: [region(60, 40, 70, 50)],
      },
    ],
  };
  await refused(
    refineImageEditMask(db, ctx, args, randomUUID()),
    "image_mask_refine_roundtrip",
  );
  expect(await records()).toEqual(before);
});
it("rejects an unrepresentable full selection without saving a partial receipt", async () => {
  const pixels = binary(),
    input = baseInput();
  for (let i = 0; i < 101; i++)
    set(pixels, 2 + (i % 15) * 3, 2 + Math.floor(i / 15) * 3, 1, 1);
  input.sourceTarget = {
    ...empty(),
    proposalIds: [await proposal(pixels, "reference")],
  };
  input.protected = {
    ...empty(),
    proposalIds: [await proposal(pixels, "reference")],
  };
  const base = await prepareImageEditMask(db, ctx, input, randomUUID()),
    before = await records();
  await refused(
    refineImageEditMask(
      db,
      ctx,
      { ...refineInput(base.receiptId), allowedOcclusionAdd: [] },
      randomUUID(),
    ),
    "image_mask_refine_unrepresentable",
  );
  expect(await records()).toEqual(before);
});
it.each(["sourceInclude", "generatedInclude"] as const)(
  "keeps the existing generated-window guard and leaves no new receipt for outside %s",
  async (kind) => {
    const data = await sharp({
      create: { width: 50, height: 45, channels: 4, background: "#a87742" },
    })
      .png()
      .toBuffer();
    raw = {
      ...raw,
      data,
      candidate: rawImageCandidateSchema.parse({
        ...raw.candidate,
        size: data.length,
        sha256: sha(data),
        dimensions: { width: 50, height: 45 },
        request: { ...raw.candidate.request, size: { width: 50, height: 45 } },
        transform: {
          kind: "viewport",
          rect: { left: 0, top: 0, width: 50, height: 45 },
          workspace: null,
        },
      }),
    };
    const base = await prepareImageEditMask(db, ctx, baseInput(), randomUUID()),
      before = await records();
    const args = {
      ...refineInput(base.receiptId),
      sourceExclude: [],
      allowedOcclusionAdd: [],
      [kind]: [region(55, 5, 58, 8)],
    };
    await refused(
      refineImageEditMask(db, ctx, args, randomUUID()),
      "image_mask_viewport_bounds",
    );
    expect(await records()).toEqual(before);
  },
);
it.each(["generatedInclude", "generatedExclude"] as const)(
  "rejects old refine calls missing %s with 422 before any read or write",
  async (missing) => {
    const base = await prepareImageEditMask(db, ctx, baseInput(), randomUUID()),
      before = await records();
    const args: Record<string, unknown> = { ...refineInput(base.receiptId) };
    delete args[missing];
    const read = vi.spyOn(images, "readRawImageCandidate");
    read.mockClear();
    await expect(
      refineImageEditMask(db, ctx, args as ImageMaskRefineInput, randomUUID()),
    ).rejects.toMatchObject({ status: 422 });
    expect(read).not.toHaveBeenCalled();
    expect(await records()).toEqual(before);
  },
);
it("rejects old/missing-field receipts, mismatched operation identity, read-only access and cancellation without conversion", async () => {
  const base = await prepareImageEditMask(db, ctx, baseInput(), randomUUID()),
    before = await records();
  await refused(
    refineImageEditMask(db, ctx, refineInput(base.receiptId), base.receiptId),
    "image_mask_refine_operation",
  );
  await expect(
    refineImageEditMask(
      db,
      { ...ctx, writable: false },
      refineInput(base.receiptId),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  const controller = new AbortController();
  controller.abort();
  await expect(
    refineImageEditMask(db, ctx, refineInput(base.receiptId), randomUUID(), {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(await records()).toEqual(before);
  for (const persisted of [
    { ...base, version: 1 },
    { ...base, input: { ...base.input, textEdits: undefined } },
  ]) {
    await db
      .updateTable("ai_operations")
      .set({ result: JSON.stringify(persisted) })
      .where("id", "=", base.receiptId)
      .execute();
    const invalid = await records();
    await expect(
      refineImageEditMask(db, ctx, refineInput(base.receiptId), randomUUID()),
    ).rejects.toMatchObject({ status: 422 });
    expect(await records()).toEqual(invalid);
  }
});
