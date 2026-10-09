import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { usageSummary } from "@core/modules/ai/usage.js";
import { AppError, systemErrorReason } from "@core/shared/errors.js";
import type { ToolContext } from "@core/workflows/ai-documents.js";
import * as policy from "@core/modules/access/operation-policy.js";
import * as transactions from "@db/transactions.js";
import { openTestDatabase } from "./database.js";
import * as storage from "../apps/server/src/adapters/storage.js";
import { objectKey } from "../apps/server/src/services/storage-policy.js";
import {
  readRawImageCandidate,
  readReferenceImages,
} from "../apps/server/src/services/ai/images.js";
import { generateTestImageAsset as generateImageAsset } from "./fixtures/ai-image-operation.js";
import {
  prepareImageMaskSegment,
  readImageMaskSegment,
  readUsableImageMaskSegment,
  previewImageMaskSegment,
  runSegmentationWorker,
  type ImageMaskSegmentInput,
  type SegmentationWorkerTask,
  type SegmentationWorkerResult,
} from "../apps/server/src/services/ai/image-mask-segment.js";
import {
  resolveSegmentationProfile,
  segmentationEngineTreeHash,
  type SegmentationProfileConfig,
  type VerifiedSegmentationProfile,
} from "../apps/server/src/services/ai/segmentation-profile.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string,
  owner: Actor,
  ctx: ToolContext,
  sourceId: string,
  source: Buffer,
  profile: VerifiedSegmentationProfile,
  calls: number;
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const runtime = () => ({ ...storage.storageRuntime(), root });
const dims = { width: 24, height: 18 };
const input = (): ImageMaskSegmentInput => ({
  source: { kind: "reference", referenceImageId: sourceId },
  targets: [
    {
      label: "person",
      box: [2 / 24, 2 / 18, 18 / 24, 14 / 18],
      positivePoints: [[3 / 24, 3 / 18]],
      negativePoints: [[0, 0]],
    },
    {
      label: "separate part",
      box: [21 / 24, 2 / 18, 23 / 24, 4 / 18],
      positivePoints: [[22 / 24, 3 / 18]],
      negativePoints: [[0, 0]],
    },
  ],
  exclusions: [
    {
      label: "visible prop",
      box: [14 / 24, 5 / 18, 17 / 24, 10 / 18],
      positivePoints: [[15 / 24, 6 / 18]],
      negativePoints: [[3 / 24, 3 / 18]],
    },
  ],
});
const options = (worker = fakeWorker()) => ({
  profile,
  storage: runtime(),
  worker,
});
const image = (width = dims.width, height = dims.height, color = "#426683") =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
async function installFixture(
  worker = "# no real model imports\n",
  pythonPath = process.execPath,
) {
  const engineRoot = join(root, "engine"),
    workerPath = join(root, "worker"),
    checkpointPath = join(root, "weights");
  await mkdir(engineRoot, { recursive: true });
  await writeFile(join(engineRoot, "config.yaml"), "model: fixture\n");
  await writeFile(join(engineRoot, "__init__.py"), "fixture\n");
  await writeFile(workerPath, worker);
  await writeFile(checkpointPath, "local fixture weights");
  const config: SegmentationProfileConfig = {
    version: 1,
    id: "fixture",
    pythonPath,
    workerPath,
    workerSha256: sha(await readFile(workerPath)),
    engineRoot,
    engineCommit: "1".repeat(40),
    engineTreeSha256: await segmentationEngineTreeHash(engineRoot),
    checkpointPath,
    checkpointVersion: "fixture-v1",
    checkpointSha256: sha(await readFile(checkpointPath)),
    config: "config.yaml",
    configSha256: sha(await readFile(join(engineRoot, "config.yaml"))),
    dependencies: {
      python: "3.12.14",
      torch: "2.5.1",
      torchvision: "0.20.1",
      numpy: "2.5.3",
      pillow: "12.3.0",
    },
    threads: 1,
    timeoutMs: 1000,
  };
  const path = join(root, "profile.json");
  await writeFile(path, JSON.stringify(config));
  const verified = await resolveSegmentationProfile(
    { DOCA_AI_IMAGE_SEGMENT_PROFILE: path },
    { probe: async () => ({ engineRoot, dependencies: config.dependencies }) },
  );
  if (verified.status !== "ready") throw Error("Fixture profile not ready");
  profile = verified.profile;
}
async function createJob(sessionId: string, actor = owner) {
  const id = randomUUID(),
    lease = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      user_id: actor.id,
      session_id: sessionId,
      model_id: "image",
      status: "running",
      input: JSON.stringify({ attachments: [sourceId] }),
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
  return { actor, jobId: id, lease, writable: true } as ToolContext;
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-mask-segment-"));
  owner = {
    ...(await createUser(
      db,
      {
        login: "segment-owner",
        displayName: "Owner",
        password: "isolated-segment-2026",
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
      vendors: [
        {
          id: "fixture",
          name: "Fixture",
          provider: "openai",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "image",
          vendorId: "fixture",
          model: "gpt-image-fixture",
          alias: "Image",
          enabled: true,
          tools: false,
          imageGeneration: true,
          imageProfile: "gpt-image-2",
          maxInput: 32000,
          maxOutput: 1000,
          imageRate: 250,
        },
      ],
    },
    0,
  );
  const id = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: owner.id,
      title: "Segmentation fixture",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  sourceId = randomUUID();
  ctx = await createJob(id);
  source = await image();
  const active = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow(),
    key = objectKey(sourceId, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), active),
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
      profile_id: active.id,
      object_key: key,
      filename: "source.png",
      mime: "image/png",
      size: source.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  await installFixture();
  calls = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

type Mode =
  | "valid"
  | "point-failure"
  | "nonbinary"
  | "wrong-dimensions"
  | "provenance"
  | "symlink"
  | "resolved-paths"
  | "path-alias"
  | "extra-file"
  | "exit-failure";
function fakeWorker(mode: Mode = "valid", hook?: () => Promise<void>) {
  return vi.fn(
    async (
      configured: VerifiedSegmentationProfile,
      task: SegmentationWorkerTask,
      signal: AbortSignal,
    ): Promise<SegmentationWorkerResult> => {
      calls++;
      signal.throwIfAborted();
      if (hook) await hook();
      if (mode === "exit-failure")
        return {
          exitCode: 1,
          stdout: Buffer.from("bad JSON from private fixture"),
          stderr: Buffer.from("private stack and secret body fixture"),
          code: null,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      const bytes = await readFile(task.sourcePath),
        meta = await sharp(bytes).metadata(),
        width = meta.width!,
        height = meta.height!,
        target = Buffer.alloc(width * height),
        exclusion = Buffer.alloc(target.length);
      const fill = (
        p: Buffer,
        left: number,
        top: number,
        right: number,
        bottom: number,
        value: number,
      ) => {
        for (let y = top; y < bottom; y++)
          for (let x = left; x < right; x++) p[y * width + x] = value;
      };
      fill(target, 2, 2, 18, 14, 255);
      fill(target, 8, 6, 10, 8, 0);
      fill(target, 21, 2, 23, 4, 255);
      fill(exclusion, 14, 5, 17, 10, 255);
      if (mode === "point-failure") target[3 * width + 3] = 0;
      if (mode === "nonbinary") target[0] = 128;
      const encode = (pixels: Buffer) =>
        sharp(pixels, { raw: { width, height, channels: 1 } })
          .toColourspace("b-w")
          .png()
          .toBuffer();
      let targetPNG = await encode(target);
      const exclusionPNG = await encode(exclusion);
      if (mode === "wrong-dimensions")
        targetPNG = await sharp(targetPNG)
          .resize(width + 1, height)
          .png()
          .toBuffer();
      const pointPixel = (p: [number, number]): [number, number] => [
        Math.min(Math.floor(p[0] * width), width - 1),
        Math.min(Math.floor(p[1] * height), height - 1),
      ];
      const reports = (group: typeof task.targets, mask: Buffer) =>
        group.map((hints) => {
          const check = (point: [number, number]) => {
            const pixel = pointPixel(point);
            return {
              point,
              pixel,
              included: mask[pixel[1] * width + pixel[0]] === 255,
            };
          };
          const positivePoints = hints.positivePoints.map(check),
            negativePoints = hints.negativePoints.map(check),
            positiveMissing = positivePoints.filter((p) => !p.included).length,
            negativeIncluded = negativePoints.filter((p) => p.included).length;
          return {
            label: hints.label,
            box: hints.box,
            selectedStage: "initial",
            selectedIndex: 0,
            modelScore: 0.99,
            pixels: mask.filter((p) => p === 255).length,
            pointChecks: {
              positivePoints,
              negativePoints,
              positiveMissing,
              negativeIncluded,
            },
            pointConstraintsSatisfied: !positiveMissing && !negativeIncluded,
            predictionSeconds: 0.01,
            candidates: [
              {
                stage: "initial",
                index: 0,
                modelScore: 0.99,
                positiveMissing,
                negativeIncluded,
              },
            ],
          };
        });
      const parts = {
          targets: reports(task.targets, target),
          exclusions: reports(task.exclusions, exclusion),
        },
        constraintFailures = [
          ...parts.targets.map((p) => ({ group: "targets", p })),
          ...parts.exclusions.map((p) => ({ group: "exclusions", p })),
        ]
          .filter(({ p }) => !p.pointConstraintsSatisfied)
          .map(({ group, p }) => ({
            group,
            label: p.label,
            positiveMissing: p.pointChecks.positiveMissing,
            negativeIncluded: p.pointChecks.negativeIncluded,
            missingPositive: p.pointChecks.positivePoints.filter(
              (p) => !p.included,
            ),
            includedNegative: p.pointChecks.negativePoints.filter(
              (p) => p.included,
            ),
          }));
      const selectionPixels = target.filter(
        (p, i) => p === 255 && exclusion[i] === 0,
      ).length;
      const report = {
        version: 1,
        candidateOnly: true,
        engine: {
          name: "sam2",
          device: "cpu",
          commit: configured.facts.engineCommit,
          checkpointVersion: configured.facts.checkpointVersion,
          checkpointSha256: configured.facts.checkpointSha256,
          config: configured.facts.config,
          configSha256: configured.facts.configSha256,
          torchVersion: configured.facts.dependencies.torch,
          pythonVersion: configured.facts.dependencies.python,
        },
        source: {
          width,
          height,
          originalWidth: width,
          originalHeight: height,
          exifOrientation: null,
          sha256: mode === "provenance" ? "0".repeat(64) : sha(bytes),
        },
        parts,
        pointConstraintsSatisfied: constraintFailures.length === 0,
        constraintFailures,
        conflicts: {
          overlapPixels:
            target.filter((p) => p === 255).length - selectionPixels,
          targetPositiveExcluded: [],
          exclusionPositiveInTarget: [],
        },
        counts: {
          targetPixels: target.filter((p) => p === 255).length,
          exclusionPixels: exclusion.filter((p) => p === 255).length,
          editablePixelsAfterExclusion: selectionPixels,
        },
        timings: {
          loadSeconds: 0.01,
          embeddingSeconds: 0.01,
          predictionSeconds: 0.01,
          writeSeconds: 0.01,
          totalSeconds: 0.04,
        },
        acceptance:
          "This is a segmentation candidate, not visual coverage or final-edit acceptance.",
        artifacts: {
          target: {
            path: join(task.outputDir, "target-union.png"),
            mime: "image/png",
            width,
            height,
            sha256: sha(targetPNG),
          },
          exclusion: {
            path: join(task.outputDir, "exclusion-union.png"),
            mime: "image/png",
            width,
            height,
            sha256: sha(exclusionPNG),
          },
        },
      };
      await mkdir(task.outputDir);
      if (mode === "symlink")
        await symlink(task.sourcePath, report.artifacts.target.path);
      else await writeFile(report.artifacts.target.path, targetPNG);
      await writeFile(report.artifacts.exclusion.path, exclusionPNG);
      if (mode === "resolved-paths") {
        report.artifacts.target.path = await realpath(
          report.artifacts.target.path,
        );
        report.artifacts.exclusion.path = await realpath(
          report.artifacts.exclusion.path,
        );
      }
      if (mode === "path-alias")
        report.artifacts.target.path = `${task.outputDir}/../output/target-union.png`;
      await writeFile(
        join(task.outputDir, "result.json"),
        JSON.stringify(report),
      );
      if (mode === "extra-file")
        await writeFile(join(task.outputDir, "unexpected.txt"), "unexpected");
      const failed = constraintFailures.length > 0;
      return {
        exitCode: failed ? 2 : 0,
        stdout: Buffer.from(
          JSON.stringify(
            failed
              ? {
                  ok: false,
                  version: 1,
                  error: {
                    code: "point_constraints_unsatisfied",
                    message: "fixture constraint failure",
                    facts: report,
                  },
                }
              : { ok: true, ...report },
          ),
        ),
        stderr: Buffer.from("fixture private diagnostic"),
        code: null,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  );
}
async function state() {
  return {
    assets: await db.selectFrom("assets").selectAll().orderBy("id").execute(),
    operations: await db
      .selectFrom("ai_operations")
      .selectAll()
      .orderBy("id")
      .execute(),
    objects: await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .orderBy("id")
      .execute(),
    files: await db
      .selectFrom("file_items")
      .selectAll()
      .orderBy("id")
      .execute(),
    calls: await db.selectFrom("ai_calls").selectAll().orderBy("id").execute(),
    usage: await usageSummary(db, owner.id),
  };
}
async function rawGeneration(
  editRegions?: { label: string; points: [number, number][] }[],
) {
  const id = randomUUID(),
    pixels = await image(dims.width, dims.height, "#c97643");
  await generateImageAsset(
    db,
    ctx,
    {
      prompt: "fixture raw",
      referenceImageIds: [sourceId],
      ...(editRegions ? { editRegions } : {}),
    },
    id,
    {
      storage: runtime(),
      fetch: (async () =>
        Response.json({
          data: [{ b64_json: pixels.toString("base64") }],
          usage: { input_images: 1, generated_images: 1 },
        })) as typeof fetch,
    },
  );
  return id;
}

it("persists exact source-coordinate holes and disconnected components privately, replays without another worker or supplier call, and provides bounded diagnostics", async () => {
  const before = await state(),
    worker = fakeWorker(),
    id = randomUUID(),
    receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      id,
      options(worker),
    );
  expect(receipt).toMatchObject({
    version: 1,
    state: "ready",
    usable: true,
    diagnostics: {
      semanticCoverage: "unverified",
      pointConstraintsSatisfied: true,
      selectionPixels: 177,
    },
  });
  const read = await readImageMaskSegment(db, ctx, id, options());
  const pixels = await sharp(read.selectionPNG!)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  expect(pixels[7 * 24 + 9]).toBe(0);
  expect(pixels[3 * 24 + 22]).toBe(255);
  expect(pixels[6 * 24 + 15]).toBe(0);
  expect(pixels[3 * 24 + 3]).toBe(255);
  for (const artifact of receipt.artifacts) {
    const asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", artifact.assetId)
      .executeTakeFirstOrThrow();
    expect(asset.purpose).toBe("ai_mask_segment");
    await expect(
      readReferenceImages(db, ctx, [asset.id], runtime()),
    ).rejects.toThrow("参考图片");
  }
  expect(
    await prepareImageMaskSegment(db, ctx, input(), id, options(worker)),
  ).toEqual(receipt);
  expect(worker).toHaveBeenCalledOnce();
  const preview = await previewImageMaskSegment(db, ctx, id, options());
  for (const view of [preview.full, preview.local]) {
    expect(view.width).toBeLessThanOrEqual(1600);
    expect(view.height).toBeLessThanOrEqual(1600);
    expect(view.contentRect.top).toBe(80);
    expect((await sharp(view.data).metadata()).format).toBe("png");
  }
  const after = await state();
  expect(after.calls).toEqual(before.calls);
  expect(after.usage).toEqual(before.usage);
  expect(after.files).toEqual(before.files);
  expect(await readFile(join(root, objectKey(sourceId, "image/png")))).toEqual(
    source,
  );
});
it("accepts Python-style resolved artifact paths after canonicalizing only the host-created temporary directory", async () => {
  const tempRoot = join(root, "host-temp"),
    tempAlias = join(root, "host-temp-alias");
  await mkdir(tempRoot);
  await symlink(tempRoot, tempAlias);
  expect(await realpath(tempAlias)).not.toBe(tempAlias);
  vi.stubEnv("TMPDIR", tempAlias);
  try {
    const before = await state(),
      worker = fakeWorker("resolved-paths"),
      implementation = worker.getMockImplementation()!;
    worker.mockImplementation(async (...args) => {
      const task = args[1];
      expect(await realpath(task.sourcePath)).toBe(task.sourcePath);
      expect(await realpath(dirname(task.outputDir))).toBe(
        dirname(task.outputDir),
      );
      return implementation(...args);
    });
    const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(worker),
    );
    expect(receipt).toMatchObject({ state: "ready", usable: true });
    const task = worker.mock.calls[0]![1];
    // Both Python-resolved source and output coordinates start from the same
    // canonical host path before inference, not a post-hoc metadata rewrite.
    expect(task.sourcePath).toBe(join(dirname(task.outputDir), "input.png"));
    expect(task.sourcePath).not.toContain("host-temp-alias");
    expect(task.sourcePath).toContain(`${await realpath(tempRoot)}/`);
    const read = await readUsableImageMaskSegment(
      db,
      ctx,
      receipt.receiptId,
      options(),
    );
    expect(read.selectionPNG).toBeDefined();
    expect((await state()).calls).toEqual(before.calls);
    expect((await state()).usage).toEqual(before.usage);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("rejects a worker-returned path alias even when it resolves to the expected artifact", async () => {
  const before = await state(),
    worker = fakeWorker("path-alias"),
    implementation = worker.getMockImplementation()!;
  worker.mockImplementation(async (...args) => {
    const result = await implementation(...args),
      metadata = JSON.parse(result.stdout.toString()).artifacts.target;
    expect(metadata.path).not.toBe(join(args[1].outputDir, "target-union.png"));
    expect(await realpath(metadata.path)).toBe(
      join(args[1].outputDir, "target-union.png"),
    );
    return result;
  });
  const receipt = await prepareImageMaskSegment(
    db,
    ctx,
    input(),
    randomUUID(),
    options(worker),
  );
  expect(receipt).toMatchObject({
    state: "diagnostic-only",
    usable: false,
    diagnostics: { failureCode: "worker_artifacts_invalid" },
  });
  await expect(
    readUsableImageMaskSegment(db, ctx, receipt.receiptId, options()),
  ).rejects.toThrow("仅可诊断");
  expect((await state()).calls).toEqual(before.calls);
  expect((await state()).usage).toEqual(before.usage);
});
it.each([
  "point-failure",
  "nonbinary",
  "wrong-dimensions",
  "provenance",
  "symlink",
  "extra-file",
  "exit-failure",
] as const)(
  "retains private %s evidence but never signs a usable proposal",
  async (mode) => {
    const before = await state(),
      id = randomUUID(),
      receipt = await prepareImageMaskSegment(
        db,
        ctx,
        input(),
        id,
        options(fakeWorker(mode)),
      );
    expect(receipt.state).toBe("diagnostic-only");
    expect(receipt.usable).toBe(false);
    expect(receipt.diagnostics.failureCode).not.toBeNull();
    await expect(
      readUsableImageMaskSegment(db, ctx, receipt.receiptId, options()),
    ).rejects.toThrow("仅可诊断");
    if (mode === "point-failure") {
      expect(receipt.diagnostics).toMatchObject({
        pointConstraintsSatisfied: false,
        failureCode: "point_constraints_unsatisfied",
      });
      expect(receipt.diagnostics.constraintFailures[0]).toMatchObject({
        label: "person",
        missingPositive: [
          { point: [3 / 24, 3 / 18], pixel: [3, 3], included: false },
        ],
      });
    }
    const read = await readImageMaskSegment(db, ctx, id, options());
    expect(read.artifacts.get("stdout")!.length).toBeGreaterThan(0);
    expect(read.artifacts.get("stderr")!.toString()).toContain("private");
    expect(JSON.stringify(receipt)).not.toContain(
      "private stack and secret body",
    );
    expect((await state()).usage).toEqual(before.usage);
    expect((await state()).calls).toEqual(before.calls);
    expect(
      await readFile(join(root, objectKey(sourceId, "image/png"))),
    ).toEqual(source);
  },
);
it("binds mapped raw to original source, operation/hash/transform and rejects new target pixels beyond its generation window", async () => {
  const id = await rawGeneration(),
    raw = await readRawImageCandidate(db, ctx, id, runtime()),
    before = await state();
  const value = {
      ...input(),
      source: { kind: "raw" as const, generationOperationId: id },
    },
    receipt = await prepareImageMaskSegment(
      db,
      ctx,
      value,
      randomUUID(),
      options(),
    );
  expect(receipt.binding.raw).toMatchObject({
    generationOperationId: id,
    receiptId: raw.receiptId,
    sha256: raw.candidate.sha256,
    transform: raw.candidate.transform,
  });
  // A thumbnail is smaller than the real edit-window padding. Use a distinct large
  // source so the crop is genuinely smaller than its page, preserving the old source.
  const originalSourceId = sourceId,
    now = new Date().toISOString();
  sourceId = randomUUID();
  const large = await image(1200, 1600),
    active = await db
      .selectFrom("storage_profiles")
      .selectAll()
      .where("active", "=", 1)
      .executeTakeFirstOrThrow(),
    key = objectKey(sourceId, "image/png");
  await storage
    .createStorage(runtime())
    .put(
      storage.storageConfigForProfile(runtime(), active),
      key,
      large,
      "image/png",
      "large.png",
    );
  await db
    .insertInto("assets")
    .values({
      id: sourceId,
      owner_id: owner.id,
      uploaded_by: owner.id,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: active.id,
      object_key: key,
      filename: "large.png",
      mime: "image/png",
      size: large.length,
      created_at: now,
      deleted_at: null,
    })
    .execute();
  await db
    .updateTable("ai_jobs")
    .set({
      input: JSON.stringify({ attachments: [originalSourceId, sourceId] }),
    })
    .where("id", "=", ctx.jobId!)
    .execute();
  const small = await rawGeneration([
    {
      label: "small window",
      points: [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
      ],
    },
  ]);
  const bounded = input();
  for (const group of [bounded.targets, bounded.exclusions])
    for (const hints of group) {
      hints.box = [
        (hints.box[0] * 24) / 1200,
        (hints.box[1] * 18) / 1600,
        (hints.box[2] * 24) / 1200,
        (hints.box[3] * 18) / 1600,
      ];
      hints.positivePoints = hints.positivePoints.map(([x, y]) => [
        (x * 24) / 1200,
        (y * 18) / 1600,
      ]);
      hints.negativePoints = hints.negativePoints.map(([x, y]) => [
        (x * 24) / 1200,
        (y * 18) / 1600,
      ]);
    }
  const beyond = await prepareImageMaskSegment(
    db,
    ctx,
    { ...bounded, source: { kind: "raw", generationOperationId: small } },
    randomUUID(),
    options(),
  );
  expect(beyond).toMatchObject({
    usable: false,
    state: "diagnostic-only",
    diagnostics: { failureCode: "image_mask_viewport_bounds" },
  });
  expect(beyond.diagnostics.outsideGeneratedWindowPixels).toBeGreaterThan(0);
  const callsAfterGeneration = await state();
  expect(callsAfterGeneration.calls).toHaveLength(before.calls.length + 1);
});
it.each(["source", "raw", "mask", "receipt", "version"] as const)(
  "strictly rejects changed %s without regenerating or converting historical evidence",
  async (changed) => {
    const rawId = changed === "raw" ? await rawGeneration() : undefined,
      value = rawId
        ? {
            ...input(),
            source: { kind: "raw" as const, generationOperationId: rawId },
          }
        : input();
    const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      value,
      randomUUID(),
      options(),
    );
    if (changed === "source" || changed === "raw" || changed === "mask") {
      const assetId =
          changed === "source"
            ? sourceId
            : changed === "mask"
              ? receipt.artifacts.find((p) => p.role === "selection")!.assetId
              : (await readRawImageCandidate(db, ctx, rawId!, runtime()))
                  .candidate.assetId,
        asset = await db
          .selectFrom("assets")
          .selectAll()
          .where("id", "=", assetId)
          .executeTakeFirstOrThrow();
      await writeFile(
        join(root, asset.object_key),
        await image(24, 18, "#112233"),
      );
    } else
      await db
        .updateTable("ai_operations")
        .set({
          result: JSON.stringify({
            ...receipt,
            ...(changed === "version"
              ? { version: 0 }
              : { digest: "0".repeat(64) }),
          }),
        })
        .where("id", "=", receipt.receiptId)
        .execute();
    const before = await state();
    await expect(
      readImageMaskSegment(db, ctx, receipt.receiptId, options()),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(calls).toBe(1);
  },
);
it("rechecks source ACL after inference and storage quota before write, without bypassing lease or publishing masks", async () => {
  const sourceRevoked = fakeWorker("valid", async () => {
    await db
      .updateTable("assets")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", sourceId)
      .execute();
  });
  await expect(
    prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(sourceRevoked),
    ),
  ).rejects.toThrow("参考图片");
  expect((await state()).assets).toHaveLength(1);
  await db
    .updateTable("assets")
    .set({ deleted_at: null })
    .where("id", "=", sourceId)
    .execute();
  const before = await state(),
    put = vi.spyOn(storage.createStorage(runtime()), "put"),
    originalStorage = storage.createStorage;
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const result = originalStorage(value);
    return { ...result, put };
  });
  vi.spyOn(policy, "checkStorage").mockRejectedValue(
    new AppError(413, "fixture storage quota denied", {
      code: "storage_quota_exceeded",
    }),
  );
  await expect(
    prepareImageMaskSegment(db, ctx, input(), randomUUID(), options()),
  ).rejects.toThrow("quota");
  expect(put).not.toHaveBeenCalled();
  const after = await state();
  expect(after.assets).toEqual(before.assets);
  expect(after.objects).toEqual(before.objects);
  expect(after.usage).toEqual(before.usage);
});
it.each(["cancel", "lease"] as const)(
  "does not register a proposal when %s is withdrawn after the first object write",
  async (mode) => {
    const before = await state(),
      controller = new AbortController(),
      originalStorage = storage.createStorage,
      written: string[] = [];
    vi.spyOn(storage, "createStorage").mockImplementation((value) => {
      const result = originalStorage(value);
      return {
        ...result,
        put: async (...args) => {
          await result.put(...args);
          written.push(args[1]);
          if (mode === "cancel") controller.abort();
          else
            await db
              .updateTable("ai_jobs")
              .set({ lease: randomUUID() })
              .where("id", "=", ctx.jobId!)
              .execute();
        },
      };
    });
    const id = randomUUID();
    await expect(
      prepareImageMaskSegment(db, ctx, input(), id, {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    const after = await state();
    expect(after.assets).toEqual(before.assets);
    expect(after.objects).toEqual(before.objects);
    expect(after.files).toEqual(before.files);
    expect(after.usage).toEqual(before.usage);
    expect(
      JSON.parse(after.operations.find((row) => row.id === id)!.result),
    ).toMatchObject({ state: "failed", cleanup: "removed" });
    for (const key of written)
      await expect(readFile(join(root, key))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);
it("rejects foreign sessions, missing profile, readonly preparation and pre-cancelled jobs before a worker or artifact write", async () => {
  const worker = fakeWorker(),
    id = randomUUID(),
    before = await state(),
    controller = new AbortController();
  controller.abort();
  await expect(
    prepareImageMaskSegment(db, ctx, input(), id, {
      storage: runtime(),
      worker,
    }),
  ).rejects.toThrow("未启用");
  await expect(
    prepareImageMaskSegment(
      db,
      { ...ctx, writable: false },
      input(),
      id,
      options(worker),
    ),
  ).rejects.toThrow("只允许读取");
  await expect(
    prepareImageMaskSegment(db, ctx, input(), id, {
      ...options(worker),
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(worker).not.toHaveBeenCalled();
  expect(await state()).toEqual(before);
  const receipt = await prepareImageMaskSegment(
    db,
    ctx,
    input(),
    id,
    options(worker),
  );
  const session = randomUUID(),
    now = new Date().toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id: session,
      user_id: owner.id,
      title: "different",
      model_id: "image",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await expect(
    readImageMaskSegment(
      db,
      await createJob(session),
      receipt.receiptId,
      options(),
    ),
  ).rejects.toThrow("会话绑定");
});
it("does not rewrite a pending same-ID operation owned by another active execution", async () => {
  const worker = fakeWorker(),
    receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(worker),
    ),
    row = await db
      .selectFrom("ai_operations")
      .selectAll()
      .where("id", "=", receipt.receiptId)
      .executeTakeFirstOrThrow();
  const pending = JSON.stringify({
    kind: "image_mask_segment",
    version: 1,
    state: "running",
    input: receipt.input,
  });
  await db
    .updateTable("ai_operations")
    .set({ result: pending })
    .where("id", "=", receipt.receiptId)
    .execute();
  await expect(
    prepareImageMaskSegment(
      db,
      ctx,
      input(),
      receipt.receiptId,
      options(worker),
    ),
  ).rejects.toThrow("未确认");
  expect(
    (
      await db
        .selectFrom("ai_operations")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(pending);
  expect(worker).toHaveBeenCalledOnce();
});
it("preserves a committed private mask after a lost final transaction acknowledgement", async () => {
  const run = transactions.transact;
  let count = 0;
  vi.spyOn(transactions, "transact").mockImplementation((async (
    ...args: Parameters<typeof run>
  ) => {
    const result = await run(...args);
    if (++count === 3) throw Error("lost final acknowledgement");
    return result;
  }) as typeof run);
  const receipt = await prepareImageMaskSegment(
    db,
    ctx,
    input(),
    randomUUID(),
    options(),
  );
  expect(receipt.usable).toBe(true);
  expect(
    (await readImageMaskSegment(db, ctx, receipt.receiptId, options()))
      .selectionPNG!.length,
  ).toBeGreaterThan(0);
});
it("checks registered storage-object facts and rejects model-controlled local paths", async () => {
  const worker = fakeWorker(),
    before = await state();
  await expect(
    prepareImageMaskSegment(
      db,
      ctx,
      {
        ...input(),
        source: {
          kind: "reference",
          referenceImageId: sourceId,
          sourcePath: "/untrusted/local/file",
        },
      } as ImageMaskSegmentInput,
      randomUUID(),
      options(worker),
    ),
  ).rejects.toThrow();
  expect(worker).not.toHaveBeenCalled();
  expect(await state()).toEqual(before);
  const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(worker),
    ),
    artifact = receipt.artifacts.find((a) => a.role === "selection")!;
  await db
    .updateTable("file_storage_objects")
    .set({ sha256: "0".repeat(64) })
    .where("id", "=", artifact.assetId)
    .execute();
  const after = await state();
  await expect(
    readUsableImageMaskSegment(db, ctx, receipt.receiptId, options()),
  ).rejects.toThrow("存储对象事实");
  expect(await state()).toEqual(after);
});

it("rejects a changed operation job association while preserving the signed receipt and stored mask", async () => {
  const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(),
    ),
    original = await db
      .selectFrom("ai_jobs")
      .select("session_id")
      .where("id", "=", ctx.jobId!)
      .executeTakeFirstOrThrow(),
    otherJob = await createJob(original.session_id);
  await db
    .updateTable("ai_operations")
    .set({ job_id: otherJob.jobId! })
    .where("id", "=", receipt.receiptId)
    .execute();
  const before = await state();
  await expect(
    readImageMaskSegment(db, ctx, receipt.receiptId, options()),
  ).rejects.toThrow("绑定不一致");
  expect(await state()).toEqual(before);
});
it("terminates the worker on lease withdrawal during inference and records only a failed reservation", async () => {
  const before = await state(),
    id = randomUUID(),
    observed = vi.fn();
  const worker = vi.fn(
    async (
      _profile: VerifiedSegmentationProfile,
      _task: SegmentationWorkerTask,
      signal: AbortSignal,
    ): Promise<SegmentationWorkerResult> => {
      await db
        .updateTable("ai_jobs")
        .set({ lease: randomUUID() })
        .where("id", "=", ctx.jobId!)
        .execute();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            observed();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  );
  await expect(
    prepareImageMaskSegment(db, ctx, input(), id, options(worker)),
  ).rejects.toMatchObject({
    name: "AbortError",
    message: "本地分割已取消或任务授权已撤回",
  });
  expect(observed).toHaveBeenCalledOnce();
  const after = await state();
  expect(after.assets).toEqual(before.assets);
  expect(after.objects).toEqual(before.objects);
  expect(after.calls).toEqual(before.calls);
  expect(after.usage).toEqual(before.usage);
  expect(
    JSON.parse(after.operations.find((row) => row.id === id)!.result),
  ).toMatchObject({ state: "failed" });
});
it("passes only fixed oriented original-page pixels to the worker while preserving EXIF source bytes", async () => {
  const rotated = await sharp(source)
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer(),
    asset = await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirstOrThrow();
  await writeFile(join(root, asset.object_key), rotated);
  await db
    .updateTable("assets")
    .set({ size: rotated.length })
    .where("id", "=", sourceId)
    .execute();
  const worker = vi.fn(
    async (
      _profile: VerifiedSegmentationProfile,
      task: SegmentationWorkerTask,
    ): Promise<SegmentationWorkerResult> => {
      expect(
        await sharp(await readFile(task.sourcePath)).metadata(),
      ).toMatchObject({ width: 18, height: 24, channels: 3 });
      expect(
        (await sharp(await readFile(task.sourcePath)).metadata()).orientation,
      ).toBeUndefined();
      return {
        exitCode: 1,
        stdout: Buffer.from("invalid output fixture"),
        stderr: Buffer.alloc(0),
        code: null,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  );
  const receipt = await prepareImageMaskSegment(
    db,
    ctx,
    input(),
    randomUUID(),
    options(worker),
  );
  expect(receipt.binding.dimensions).toEqual({ width: 18, height: 24 });
  expect(receipt.binding.sourceSha256).toBe(sha(rotated));
  expect(await readFile(join(root, asset.object_key))).toEqual(rotated);
});

async function processProfile(body: string) {
  const interpreter = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  await installFixture(body, interpreter);
  return profile;
}
const processTask = (): SegmentationWorkerTask => ({
  version: 1,
  sourcePath: join(root, "untrusted-name;touch should-not-exist.png"),
  outputDir: join(root, "output"),
  targets: input().targets,
  exclusions: [],
});
it("runs the trusted process with shell disabled, model hints only on stdin and no inherited secret environment", async () => {
  const configured = await processProfile(
    `import json,sys,os\nprint(json.dumps({"task":json.loads(sys.stdin.read()),"argv":sys.argv[1:],"secret":os.environ.get("DOCA_SEGMENT_TEST_SECRET"),"offline":os.environ.get("HF_HUB_OFFLINE")}))\n`,
  );
  vi.stubEnv("DOCA_SEGMENT_TEST_SECRET", "fixture-must-not-reach-worker");
  try {
    const result = await runSegmentationWorker(
        configured,
        processTask(),
        new AbortController().signal,
      ),
      value = JSON.parse(result.stdout.toString());
    expect(result.exitCode).toBe(0);
    expect(value.task).toEqual(processTask());
    expect(value.secret).toBeNull();
    expect(value.offline).toBe("1");
    expect(value.argv).toContain("--checkpoint");
    await expect(
      readFile(join(root, "should-not-exist.png")),
    ).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each(["timeout", "stdout-limit", "abort"] as const)(
  "bounds and terminates an actual worker for %s without image or supplier calls",
  async (mode) => {
    const configured = await processProfile(
        mode === "stdout-limit"
          ? "import sys,time\nsys.stdout.buffer.write(b' '* (9*1024*1024))\nsys.stdout.flush()\ntime.sleep(10)\n"
          : "import time\ntime.sleep(10)\n",
      ),
      controller = new AbortController();
    if (mode === "abort") setTimeout(() => controller.abort(), 100);
    if (mode === "abort")
      await expect(
        runSegmentationWorker(configured, processTask(), controller.signal),
      ).rejects.toThrow();
    else {
      const result = await runSegmentationWorker(
        configured,
        processTask(),
        controller.signal,
      );
      expect(result.code).toBe(
        mode === "timeout" ? "worker_timeout" : "worker_output_limit",
      );
      expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    expect((await state()).calls).toEqual([]);
  },
);

async function expectPrivateIOFailure(operation: Promise<unknown>) {
  const error = await operation.then(
    () => {
      throw new Error("Unexpected public operation success");
    },
    (value) => value,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error.status).toBe(503);
  expect(systemErrorReason(error)).toEqual({
    code: "local_segmentation_io_failed",
  });
  expect(error.message).toBe(
    "本地分割资料或图像处理暂时不可用，原记录保留；本次没有调用图片服务",
  );
  expect(error).not.toHaveProperty("cause");
  const serialized = JSON.stringify({
    message: error.message,
    stack: error.stack,
    ...error,
  });
  for (const privateValue of [
    root,
    profile.config.workerPath,
    profile.config.engineRoot,
    profile.config.checkpointPath,
    "PRIVATE_STORAGE_BODY",
    "PRIVATE_CAUSE_TOKEN",
  ])
    expect(serialized).not.toContain(privateValue);
  return error;
}
it("does not expose a missing private selection object through any read, usable, preview or prepare replay boundary", async () => {
  const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      input(),
      randomUUID(),
      options(),
    ),
    selection = receipt.artifacts.find((a) => a.role === "selection")!;
  await rm(join(root, selection.objectKey));
  const before = await state(),
    worker = fakeWorker();
  await expectPrivateIOFailure(
    readImageMaskSegment(db, ctx, receipt.receiptId, options()),
  );
  await expectPrivateIOFailure(
    readUsableImageMaskSegment(db, ctx, receipt.receiptId, options()),
  );
  await expectPrivateIOFailure(
    previewImageMaskSegment(db, ctx, receipt.receiptId, options()),
  );
  await expectPrivateIOFailure(
    prepareImageMaskSegment(
      db,
      ctx,
      input(),
      receipt.receiptId,
      options(worker),
    ),
  );
  expect(worker).not.toHaveBeenCalled();
  expect(await state()).toEqual(before);
});

it.each(["source", "raw"] as const)(
  "keeps missing %s bytes private and rejects new preparation and existing proposal reads without any new operation, worker or fee",
  async (kind) => {
    const generation = kind === "raw" ? await rawGeneration() : undefined;
    const value: ImageMaskSegmentInput = {
      ...input(),
      source: generation
        ? { kind: "raw", generationOperationId: generation }
        : { kind: "reference", referenceImageId: sourceId },
    };
    const receipt = await prepareImageMaskSegment(
      db,
      ctx,
      value,
      randomUUID(),
      options(),
    );
    const key = generation
      ? (await readRawImageCandidate(db, ctx, generation, runtime())).candidate
          .objectKey
      : (
          await db
            .selectFrom("assets")
            .select("object_key")
            .where("id", "=", sourceId)
            .executeTakeFirstOrThrow()
        ).object_key;
    await rm(join(root, key));
    const before = await state(),
      worker = fakeWorker();
    await expectPrivateIOFailure(
      prepareImageMaskSegment(db, ctx, value, randomUUID(), options(worker)),
    );
    await expectPrivateIOFailure(
      readImageMaskSegment(db, ctx, receipt.receiptId, options()),
    );
    await expectPrivateIOFailure(
      readUsableImageMaskSegment(db, ctx, receipt.receiptId, options()),
    );
    await expectPrivateIOFailure(
      previewImageMaskSegment(db, ctx, receipt.receiptId, options()),
    );
    expect(worker).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  },
);

it("sanitizes a partial private object-write failure, cleans only proven uncommitted writes and retains failed CAS evidence without registering assets or usage", async () => {
  const original = storage.createStorage,
    written: string[] = [];
  vi.spyOn(storage, "createStorage").mockImplementation((value) => {
    const result = original(value);
    return {
      ...result,
      put: async (...args) => {
        await result.put(...args);
        written.push(args[1]);
        if (written.length === 2)
          throw new Error("PRIVATE_STORAGE_BODY " + join(root, args[1]), {
            cause: new Error("PRIVATE_CAUSE_TOKEN"),
          });
      },
    };
  });
  const before = await state(),
    id = randomUUID();
  await expectPrivateIOFailure(
    prepareImageMaskSegment(db, ctx, input(), id, options()),
  );
  const after = await state();
  expect(after.assets).toEqual(before.assets);
  expect(after.objects).toEqual(before.objects);
  expect(after.files).toEqual(before.files);
  expect(after.calls).toEqual(before.calls);
  expect(after.usage).toEqual(before.usage);
  expect(after.operations).toHaveLength(before.operations.length + 1);
  const failed = JSON.parse(
    after.operations.find((row) => row.id === id)!.result,
  );
  expect(failed).toMatchObject({
    state: "failed",
    failureCode: "local_segmentation_failed",
    cleanup: "removed",
  });
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_STORAGE_BODY");
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_CAUSE_TOKEN");
  expect(JSON.stringify(failed)).not.toContain(root);
  expect(written).toHaveLength(2);
  for (const key of written)
    await expect(readFile(join(root, key))).rejects.toMatchObject({
      code: "ENOENT",
    });
});

it("preserves safe capability AppError status, code and identity without converting a policy rejection into a storage failure", async () => {
  const denied = new AppError(403, "fixture public capability denied", {
      code: "capability_denied",
    }),
    before = await state();
  vi.spyOn(policy, "requireCapability").mockRejectedValue(denied);
  await expect(
    prepareImageMaskSegment(db, ctx, input(), randomUUID(), options()),
  ).rejects.toBe(denied);
  expect(await state()).toEqual(before);
});

it("preserves abort semantics without serializing a private custom signal reason at any public entry", async () => {
  const controller = new AbortController(),
    reason = new Error("PRIVATE_STORAGE_BODY " + root, {
      cause: new Error("PRIVATE_CAUSE_TOKEN"),
    });
  controller.abort(reason);
  const before = await state(),
    common = { ...options(), signal: controller.signal };
  const operations = [
    () => prepareImageMaskSegment(db, ctx, input(), randomUUID(), common),
    () => readImageMaskSegment(db, ctx, randomUUID(), common),
    () => readUsableImageMaskSegment(db, ctx, randomUUID(), common),
    () => previewImageMaskSegment(db, ctx, randomUUID(), common),
  ];
  for (const run of operations) {
    const error = await run().catch((value) => value);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("本地分割已取消或任务授权已撤回");
    expect(error).not.toHaveProperty("cause");
    expect(error.stack).not.toContain(root);
    expect(error.stack).not.toContain("PRIVATE_STORAGE_BODY");
  }
  expect(await state()).toEqual(before);
});
