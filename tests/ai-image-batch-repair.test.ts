import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  advanceImageBatch,
  batchPage,
  imageBatchSchema,
  imageBatchStatus,
  prepareImageBatchReview,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";

function fixture(current = 2): ImageBatch {
  const taskJobId = randomUUID();
  const books = ["one.pdf", "two.pdf", "three.pdf"].map((filename) => ({
    source: { assetId: randomUUID() },
    filename,
    pages: [1, 2].map((page) => ({
      referenceImageId: randomUUID(),
      filename: `page-${page}.png`,
    })),
  }));
  const delivered: ImageBatch["delivered"] = {};
  const reviews: ImageBatch["reviews"] = {};
  for (const book of books)
    for (const page of book.pages) {
      const assetId = randomUUID();
      delivered[page.referenceImageId] = assetId;
      reviews[page.referenceImageId] = {
        assetId,
        passed: true,
        evidence: "Host inspected the latest saved candidate",
      };
    }
  return imageBatchSchema.parse({
    version: 3,
    attemptScope: {
      version: 1,
      operationId: randomUUID(),
      taskRootJobId: taskJobId,
      manifestDigest: "b".repeat(64),
    },
    requirements: {
      original: {
        jobId: taskJobId,
        rootJobId: taskJobId,
        messageId: taskJobId,
        text: "Edit all books with complete natural characters",
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
          inputReferences: [{ kind: "attachment", id: book.source.assetId }],
        })),
      },
      sources: books.map((book) => ({
        source: book.source,
        inputReference: { kind: "attachment", id: book.source.assetId },
      })),
      criteria: ["Natural complete body", "All original pages delivered"],
      clarifications: [],
    },
    current,
    notes: "Keep completed candidates and the original request",
    books,
    delivered,
    reviews,
  });
}

function rejection(batch: ImageBatch, bookIndex: number, pageIndex = 0) {
  const referenceImageId =
    batch.books[bookIndex]!.pages[pageIndex]!.referenceImageId;
  return {
    referenceImageId,
    assetId: batch.delivered[referenceImageId]!,
    passed: false,
    evidence: "Actual inspection found a clipped foot and elbow",
  };
}

it("reopens an earlier completed book without losing task scope, candidates or other reviews", () => {
  const batch = fixture();
  const original = structuredClone(batch);
  const review = rejection(batch, 1, 1);
  const repaired = prepareImageBatchReview(batch, review);
  expect(repaired.current).toBe(1);
  expect(repaired.requirements).toEqual(original.requirements);
  expect(repaired.attemptScope).toEqual(original.attemptScope);
  expect(repaired.delivered).toEqual(original.delivered);
  expect(repaired.books).toEqual(original.books);
  expect(repaired.notes).toBe(original.notes);
  expect(repaired.reviews).toEqual({
    ...original.reviews,
    [review.referenceImageId]: {
      assetId: review.assetId,
      passed: false,
      evidence: review.evidence,
    },
  });
  expect(batch).toEqual(original);
  expect(batchPage(repaired, review.referenceImageId)).toBe(
    review.referenceImageId,
  );
  expect(() => advanceImageBatch(repaired, "skip the defect")).toThrow(
    /未通过验收/,
  );
});

it("reopens a fully completed batch and stops reporting completion until the rejected candidate passes", () => {
  const batch = fixture(3);
  expect(imageBatchStatus(batch).complete).toBe(true);
  const review = rejection(batch, 0);
  const repaired = prepareImageBatchReview(batch, review);
  expect(repaired.current).toBe(0);
  expect(imageBatchStatus(repaired).complete).toBe(false);
  expect(imageBatchStatus(repaired).current?.filename).toBe("one.pdf");
  expect(Object.values(repaired.delivered)).toEqual(
    Object.values(batch.delivered),
  );
  expect(repaired.attemptScope).toEqual(batch.attemptScope);
  expect(() => advanceImageBatch(repaired, "complete")).toThrow(/未通过验收/);

  const replacement = randomUUID();
  repaired.delivered[review.referenceImageId] = replacement;
  repaired.reviews[review.referenceImageId] = {
    assetId: replacement,
    passed: true,
    evidence: "Host reinspection confirms complete foot and elbow",
  };
  let resumed = repaired;
  for (let index = 0; index < repaired.books.length; index++)
    resumed = advanceImageBatch(resumed, "Repair independently verified");
  expect(imageBatchStatus(resumed).complete).toBe(true);
  expect(resumed.attemptScope).toEqual(batch.attemptScope);
  expect(resumed.delivered).toEqual({
    ...batch.delivered,
    [review.referenceImageId]: replacement,
  });
  expect(batch.delivered[review.referenceImageId]).toBe(review.assetId);
});

it("records a negative current-page review without moving to another book", () => {
  const batch = fixture(1);
  const review = rejection(batch, 1);
  const result = prepareImageBatchReview(batch, review);
  expect(result.current).toBe(1);
  expect(result.reviews[review.referenceImageId]).toMatchObject({
    assetId: review.assetId,
    passed: false,
    evidence: review.evidence,
  });
  expect(batch.reviews[review.referenceImageId]!.passed).toBe(true);
});

it("only checks eligibility for positive current-page review and does not accept the model's claim", () => {
  const batch = fixture(1);
  const rejected = rejection(batch, 1);
  batch.reviews[rejected.referenceImageId] = {
    assetId: rejected.assetId,
    passed: false,
    evidence: "Host rejected this candidate",
  };
  const result = prepareImageBatchReview(batch, {
    ...rejected,
    passed: true,
    evidence: "Executor claims it is now good",
  });
  expect(result).toEqual(batch);
  expect(result.reviews[rejected.referenceImageId]!.passed).toBe(false);
});

it("rejects positive review of an old page even when its latest candidate exists", () => {
  const batch = fixture(2);
  expect(() =>
    prepareImageBatchReview(batch, { ...rejection(batch, 0), passed: true }),
  ).toThrow(/当前书册/);
  const completed = fixture(3);
  expect(() =>
    prepareImageBatchReview(completed, {
      ...rejection(completed, 1),
      passed: true,
    }),
  ).toThrow(/当前书册/);
});

it("rejects future-book negative review without using preexisting delivery or pass fields to infer permission", () => {
  const batch = fixture(0);
  const original = structuredClone(batch);
  expect(() => prepareImageBatchReview(batch, rejection(batch, 2))).toThrow(
    /未来书册/,
  );
  expect(batch).toEqual(original);
});

it("rejects stale, undelivered and unknown source pages before changing batch state", () => {
  const batch = fixture();
  const original = structuredClone(batch);
  const review = rejection(batch, 0);
  expect(() =>
    prepareImageBatchReview(batch, { ...review, assetId: randomUUID() }),
  ).toThrow(/最新保存/);
  expect(() =>
    prepareImageBatchReview(batch, { ...review, assetId: randomUUID() }),
  ).toThrow(review.assetId);
  const undelivered = structuredClone(batch);
  delete undelivered.delivered[review.referenceImageId];
  expect(() => prepareImageBatchReview(undelivered, review)).toThrow(
    /尚无已保存交付/,
  );
  const unknownPage = randomUUID();
  batch.delivered[unknownPage] = randomUUID();
  expect(() =>
    prepareImageBatchReview(batch, {
      referenceImageId: unknownPage,
      assetId: batch.delivered[unknownPage]!,
      passed: false,
      evidence: "A receipt cannot invent a new source page",
    }),
  ).toThrow(/不属于当前批次/);
  delete batch.delivered[unknownPage];
  expect(batch).toEqual(original);
});

it("requires a fresh negative review to move back again and keeps later generation tools current-only", () => {
  const batch = fixture();
  const result = prepareImageBatchReview(batch, rejection(batch, 1));
  expect(() =>
    batchPage(result, batch.books[2]!.pages[0]!.referenceImageId),
  ).toThrow(/当前书册/);
  const furtherBack = prepareImageBatchReview(result, rejection(result, 0));
  expect(furtherBack.current).toBe(0);
  expect(
    furtherBack.reviews[batch.books[1]!.pages[0]!.referenceImageId]!.passed,
  ).toBe(false);
  expect(furtherBack.attemptScope).toEqual(batch.attemptScope);
  expect(furtherBack.delivered).toEqual(batch.delivered);
});
