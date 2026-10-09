import { requireImageBatch, type ImageBatch } from "./image-batch.js";
import {
  imageReviewTaskScopeSchema,
  type ImageReviewTaskScope,
} from "./image-review.js";

export type PendingImageBatchReview = {
  bookIndex: number;
  source: ImageBatch["books"][number]["source"];
  sourceFilename: string;
  physicalPage: number;
  sourcePageFilename: string;
  referenceImageId: string;
  assetId: string;
  taskScope: Extract<ImageReviewTaskScope, { kind: "batch-page" }>;
};

/**
 * Select unreviewed latest deliveries from the current strict v3 book only.
 * This performs no IO and makes no verdict. An empty list neither approves a
 * page nor replaces advanceImageBatch's all-pages/latest-positive review gate.
 */
export function pendingImageBatchReviews(
  value: unknown,
): PendingImageBatchReview[] {
  const batch = requireImageBatch(value);
  const book = batch.books[batch.current];
  if (!book) return [];
  return book.pages.flatMap((page, index) => {
    const assetId = batch.delivered[page.referenceImageId];
    if (!assetId || batch.reviews[page.referenceImageId]?.assetId === assetId)
      return [];
    const taskScope = imageReviewTaskScopeSchema.parse({
      kind: "batch-page",
      bookIndex: batch.current + 1,
      totalBooks: batch.books.length,
      filename: book.filename,
      physicalPage: index + 1,
      totalPages: book.pages.length,
      referenceImageId: page.referenceImageId,
    }) as PendingImageBatchReview["taskScope"];
    return [
      {
        bookIndex: batch.current + 1,
        source: book.source,
        sourceFilename: book.filename,
        physicalPage: index + 1,
        sourcePageFilename: page.filename,
        referenceImageId: page.referenceImageId,
        assetId,
        taskScope,
      },
    ];
  });
}
