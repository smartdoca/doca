import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AppError } from "@core/shared/errors.js";
import {
  advanceImageBatch,
  imageBatchStatus,
  requireImageBatch,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
import { pendingImageBatchReviews } from "../apps/server/src/services/ai/image-batch-pending-reviews.js";

function fixture(): ImageBatch {
  const jobId = randomUUID();
  const books = ["one.pdf", "two.pdf", "three.pdf"].map((filename, index) => ({
    source: index === 1 ? { fileId: randomUUID() } : { assetId: randomUUID() },
    filename,
    pages: [1, 2, 3].map((page) => ({
      referenceImageId: randomUUID(),
      filename: `${filename}-physical-${page}.png`,
    })),
  }));
  const inputReference = (source: ImageBatch["books"][number]["source"]) =>
    source.fileId
      ? { kind: "file" as const, id: source.fileId }
      : { kind: "attachment" as const, id: source.assetId! };
  return requireImageBatch({
    version: 3,
    attemptScope: {
      version: 1,
      operationId: randomUUID(),
      taskRootJobId: jobId,
      manifestDigest: "b".repeat(64),
    },
    requirements: {
      original: {
        jobId,
        rootJobId: jobId,
        messageId: jobId,
        text: "Deliver every page after actual independent review.",
      },
      scope: {
        selection: "all-documents",
        inputManifest: books.map((book) => ({
          source: book.source,
          filename: book.filename,
          mime: "application/pdf",
          objectId: randomUUID(),
          sha256: "a".repeat(64),
          role: "target",
          ...(book.source.fileId ? { fileVersion: 1 } : {}),
          inputReferences: [inputReference(book.source)],
        })),
      },
      sources: books.map((book) => ({
        source: book.source,
        inputReference: inputReference(book.source),
      })),
      criteria: ["All latest pages must independently pass"],
      clarifications: [],
    },
    books,
    current: 0,
    notes: "Executor notes cannot approve a page",
    delivered: {},
    reviews: {},
  });
}

function deliver(batch: ImageBatch, bookIndex: number, pageIndex: number) {
  const page = batch.books[bookIndex]!.pages[pageIndex]!;
  const assetId = randomUUID();
  batch.delivered[page.referenceImageId] = assetId;
  return { page, assetId };
}

it("selects latest unreviewed deliveries only in the current book, preserving physical order and host source identity", () => {
  const batch = fixture();
  batch.current = 1;
  deliver(batch, 0, 0);
  deliver(batch, 2, 0);
  const third = deliver(batch, 1, 2),
    first = deliver(batch, 1, 0);
  const before = JSON.stringify(batch);
  const selected = pendingImageBatchReviews(batch);
  expect(selected).toEqual(
    [first, third].map(({ page, assetId }, index) => ({
      bookIndex: 2,
      source: batch.books[1]!.source,
      sourceFilename: "two.pdf",
      physicalPage: index === 0 ? 1 : 3,
      sourcePageFilename: page.filename,
      referenceImageId: page.referenceImageId,
      assetId,
      taskScope: {
        kind: "batch-page",
        bookIndex: 2,
        totalBooks: 3,
        filename: "two.pdf",
        physicalPage: index === 0 ? 1 : 3,
        totalPages: 3,
        referenceImageId: page.referenceImageId,
      },
    })),
  );
  expect(JSON.stringify(batch)).toBe(before);
  selected[0]!.source.fileId = randomUUID();
  expect(JSON.stringify(batch)).toBe(before);
});

it.each([true, false])(
  "does not let a stale %s review suppress the latest candidate awaiting review",
  (passed) => {
    const batch = fixture();
    const { page, assetId } = deliver(batch, 0, 0);
    batch.reviews[page.referenceImageId] = {
      assetId: randomUUID(),
      passed,
      evidence: "Old asset review retained",
    };
    expect(pendingImageBatchReviews(batch).map((item) => item.assetId)).toEqual(
      [assetId],
    );
    expect(() =>
      advanceImageBatch(batch, "Cannot advance on an old verdict"),
    ).toThrow(AppError);
  },
);

it.each([true, false])(
  "never re-reviews a recorded latest %s verdict, or treats a negative verdict as acceptance",
  (passed) => {
    const batch = fixture();
    for (let index = 0; index < 3; index++) {
      const { page, assetId } = deliver(batch, 0, index);
      batch.reviews[page.referenceImageId] = {
        assetId,
        passed,
        evidence: "Actual latest pixels reviewed",
      };
    }
    expect(pendingImageBatchReviews(batch)).toEqual([]);
    if (passed)
      expect(advanceImageBatch(batch, "All latest positive").current).toBe(1);
    else
      expect(() => advanceImageBatch(batch, "Negative is not pass")).toThrow(
        AppError,
      );
  },
);

it("selects both exported and generated latest assets without assuming their origin or skipping review", () => {
  const batch = fixture();
  const exported = deliver(batch, 0, 0),
    generated = deliver(batch, 0, 1);
  expect(pendingImageBatchReviews(batch).map((item) => item.assetId)).toEqual([
    exported.assetId,
    generated.assetId,
  ]);
  expect(() =>
    advanceImageBatch(batch, "A saved receipt is not review"),
  ).toThrow(AppError);
  expect(batch.reviews).toEqual({});
});

it("does not create reviews or infer completion when there are no saved candidates or the cursor is past the last book", () => {
  const batch = fixture();
  expect(pendingImageBatchReviews(batch)).toEqual([]);
  expect(() => advanceImageBatch(batch, "No delivery")).toThrow(AppError);
  batch.current = batch.books.length;
  expect(pendingImageBatchReviews(batch)).toEqual([]);
  expect(imageBatchStatus(batch).complete).toBe(false);
  for (let bookIndex = 0; bookIndex < 3; bookIndex++)
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const { page, assetId } = deliver(batch, bookIndex, pageIndex);
      batch.reviews[page.referenceImageId] = {
        assetId,
        passed: true,
        evidence: "Every actual latest page passed",
      };
    }
  const before = JSON.stringify(batch);
  expect(imageBatchStatus(batch).complete).toBe(true);
  expect(pendingImageBatchReviews(batch)).toEqual([]);
  expect(JSON.stringify(batch)).toBe(before);
});

it("strictly rejects old versions, missing scope, malformed latest IDs and mismatched host source binding without conversion", () => {
  const batch = fixture();
  const before = JSON.stringify(batch);
  const missingScope: any = structuredClone(batch);
  delete missingScope.attemptScope;
  const mismatch = structuredClone(batch);
  mismatch.books[0]!.source = { assetId: randomUUID() };
  const badAsset = structuredClone(batch);
  badAsset.delivered[badAsset.books[0]!.pages[0]!.referenceImageId] =
    "not-an-asset-id";
  for (const invalid of [
    { ...batch, version: 1 },
    { ...batch, version: 2 },
    missingScope,
    mismatch,
    badAsset,
  ])
    expect(() => pendingImageBatchReviews(invalid)).toThrow(AppError);
  expect(JSON.stringify(batch)).toBe(before);
});
