import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  advanceImageBatch,
  batchPage,
  imageBatchCheckpoint,
  imageBatchPrompt,
  imageBatchStatus,
  imageBatchTools,
  imageBatchSchema,
  imageBatchHistory,
  requireImageBatch,
  updateImageBatchRequirements,
  prepareImageBatchReview,
  type ImageBatch,
} from "../apps/server/src/services/ai/image-batch.js";
function fixture(): ImageBatch {
  const jobId = randomUUID();
  const books = ["one.pdf", "two.pdf"].map((filename) => ({
    source: { assetId: randomUUID() },
    filename,
    pages: [1, 2].map((page) => ({
      referenceImageId: randomUUID(),
      filename: `page-${page}.png`,
    })),
  }));
  return {
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
        text: "all books and exact background; turn the target into a real person",
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
      criteria: ["Background pixels unchanged", "Real human body"],
      clarifications: [],
    },
    current: 0,
    notes: "Only the lead character; preserve background",
    delivered: {},
    reviews: {},
    books,
  };
}
it("keeps coverage preview available while a page-editing batch restricts unrelated tools", () => {
  const tools = [
    "image_edit_preview",
    "image_candidate_view",
    "image_generate",
    "image_recompose",
    "image_batch",
    "document_create",
  ].map((name) => ({ name }));
  expect(imageBatchTools(tools, fixture())).toEqual(tools.slice(0, 5));
  expect(imageBatchTools(tools, undefined)).toBe(tools);
});
it("enumerates every latest page for file delivery after completion, without rewriting persisted records", () => {
  const batch = fixture();
  for (const book of batch.books)
    for (const page of book.pages) {
      const assetId = randomUUID();
      batch.delivered[page.referenceImageId] = assetId;
      batch.reviews[page.referenceImageId] = {
        assetId,
        passed: true,
        evidence: "Actual latest pixels reviewed",
      };
    }
  batch.current = batch.books.length;
  const before = JSON.stringify(batch);
  const status = imageBatchStatus(batch);
  expect(status.complete).toBe(true);
  expect(status.deliveries).toHaveLength(4);
  expect(
    status.deliveries.map((item) => [item.bookIndex, item.physicalPage]),
  ).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
  ]);
  for (const item of status.deliveries) {
    expect(item.sourcePageFilename).toBe(`page-${item.physicalPage}.png`);
    expect(item).not.toHaveProperty("href");
    expect(item.reviewPassed).toBe(true);
  }
  expect(JSON.stringify(batch)).toBe(before);
  batch.reviews[batch.books[0]!.pages[0]!.referenceImageId]!.assetId =
    randomUUID();
  expect(imageBatchStatus(batch).complete).toBe(false);
  expect(imageBatchStatus(batch).deliveries[0]!.reviewPassed).toBe(false);
});
it("hides impossible write and candidate tools for a completed batch and restores them after explicit rejection", () => {
  const batch = fixture();
  for (const book of batch.books)
    for (const page of book.pages) {
      const assetId = randomUUID();
      batch.delivered[page.referenceImageId] = assetId;
      batch.reviews[page.referenceImageId] = {
        assetId,
        passed: true,
        evidence: "Actual latest pixels reviewed",
      };
    }
  batch.current = batch.books.length;
  const read = [
    "image_batch",
    "image_show",
    "image_view",
    "attachment_read",
    "session_images",
    "task_plan",
    "ask_user",
  ];
  const write = [
    "image_generate",
    "image_reference_generate",
    "image_edit",
    "image_edit_saved_local_preview",
    "image_edit_saved_local",
    "image_mask_segment",
    "image_mask_prepare",
    "image_mask_compose",
    "image_recompose",
    "image_edit_preview",
    "image_export",
    "image_candidate_view",
  ];
  const tools = [...read, ...write, "document_create"].map((name) => ({
    name,
  }));
  expect(imageBatchTools(tools, batch).map((tool: any) => tool.name)).toEqual(
    read,
  );
  const referenceImageId = batch.books[0]!.pages[0]!.referenceImageId;
  const reopened = prepareImageBatchReview(batch, {
    referenceImageId,
    assetId: batch.delivered[referenceImageId]!,
    passed: false,
    evidence: "New actual defect in this latest image",
  });
  expect(reopened.current).toBe(0);
  expect(
    imageBatchTools(tools, reopened).map((tool: any) => tool.name),
  ).toEqual([...read, ...write]);
  expect(imageBatchStatus(reopened).deliveries).toHaveLength(2);
});
it("requires real page receipts before moving to the next source and rejects edits to another book", () => {
  const batch = fixture();
  expect(() => advanceImageBatch(batch, "confirmed roles")).toThrow(/2 页/);
  expect(() =>
    batchPage(batch, batch.books[1]!.pages[0]!.referenceImageId),
  ).toThrow(/当前书册/);
  for (const page of batch.books[0]!.pages)
    batch.delivered[page.referenceImageId] = randomUUID();
  expect(() => advanceImageBatch(batch, "confirmed roles")).toThrow(
    /未通过验收/,
  );
  for (const page of batch.books[0]!.pages)
    batch.reviews[page.referenceImageId] = {
      assetId: batch.delivered[page.referenceImageId]!,
      passed: true,
      evidence: "Verified the actual image",
    };
  const next = advanceImageBatch(batch, "confirmed roles");
  expect(imageBatchStatus(next).books[0]!.status).toBe("completed");
  expect(imageBatchStatus(next).current?.filename).toBe("two.pdf");
  expect(next.notes).toBe("confirmed roles");
  expect(batch.current).toBe(0);
});
it("keeps original intent, current receipts and batch notes while dropping completed visual exchanges", () => {
  const batch = fixture();
  for (const page of batch.books[0]!.pages)
    batch.delivered[page.referenceImageId] = randomUUID();
  for (const page of batch.books[0]!.pages)
    batch.reviews[page.referenceImageId] = {
      assetId: batch.delivered[page.referenceImageId]!,
      passed: true,
      evidence: "Verified the actual image",
    };
  const next = advanceImageBatch(batch, "confirmed roles");
  const boundary = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolName: "image_batch",
        toolCallId: "advance",
        input: { action: "advance", notes: "confirmed roles" },
      },
    ],
  };
  const receipt = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "image_batch",
        toolCallId: "advance",
        output: { type: "json", value: imageBatchStatus(next) },
      },
    ],
  };
  const old = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "old",
        output: {
          type: "content",
          value: [
            { type: "file", data: "old book pixels", mediaType: "image/png" },
          ],
        },
      },
    ],
  };
  const prompt = [
    { role: "system", content: "system rules" },
    {
      role: "user",
      content: [
        { type: "text", text: "all books and exact background" },
        { type: "file", data: "upload preview" },
      ],
    },
    { role: "assistant", content: [] },
    old,
    boundary,
    receipt,
  ];
  const scoped = imageBatchPrompt(prompt, next);
  expect(JSON.stringify(scoped)).toContain("all books and exact background");
  expect(JSON.stringify(scoped)).toContain("confirmed roles");
  expect(JSON.stringify(scoped)).not.toContain("old book pixels");
  expect(JSON.stringify(scoped)).not.toContain("upload preview");
  expect(imageBatchCheckpoint(prompt.slice(2), next)).toEqual([
    boundary,
    receipt,
  ]);
  expect(prompt[3]).toBe(old);
});

it("restores exact durable intent and frozen criteria after compression without replaying unrelated old tasks", () => {
  const batch = fixture();
  const prompt = [
    { role: "system", content: "system" },
    { role: "user", content: "unrelated previous task marker" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "image_batch",
          input: { action: "resume" },
        },
      ],
    },
    { role: "user", content: "continue" },
  ];
  const serialized = JSON.stringify(imageBatchPrompt(prompt, batch));
  expect(serialized).toContain(batch.requirements.original.text);
  expect(serialized).toContain(batch.requirements.original.jobId);
  expect(serialized).toContain("Real human body");
  expect(serialized).not.toContain("unrelated previous task marker");
  // A restart may have only the checkpoint, with no resume tool boundary in history.
  expect(
    JSON.stringify(
      imageBatchPrompt([{ role: "user", content: "continue" }], batch),
    ),
  ).toContain(batch.requirements.original.text);
});

it("rejects old versions and missing v3 task, document or attempt scope while retaining invalid history", () => {
  const batch = fixture(),
    v1 = { ...batch, version: 1 };
  delete (v1 as any).requirements;
  expect(() => requireImageBatch(v1)).toThrow(/不能续批/);
  const v2 = { ...batch, version: 2 };
  delete (v2 as any).attemptScope;
  expect(() => requireImageBatch(v2)).toThrow(/不能续批/);
  const missingAttemptScope = { ...batch, attemptScope: undefined };
  expect(() => requireImageBatch(missingAttemptScope)).toThrow(/不能续批/);
  expect(() =>
    requireImageBatch({
      ...batch,
      attemptScope: { ...batch.attemptScope, taskRootJobId: randomUUID() },
    }),
  ).toThrow(/不能续批/);
  expect(
    imageBatchSchema.safeParse({ ...batch, requirements: undefined }).success,
  ).toBe(false);
  const missingScope = {
    ...batch,
    requirements: { ...batch.requirements, scope: undefined },
  };
  expect(() => requireImageBatch(missingScope)).toThrow(/不能续批/);
  expect(
    imageBatchSchema.safeParse({ ...batch, books: batch.books.slice(1) })
      .success,
  ).toBe(false);
  const raw = JSON.stringify({ checkpoint: { imageBatch: v1 } });
  const rows = [
    { id: randomUUID(), result: raw },
    {
      id: randomUUID(),
      result: JSON.stringify({ checkpoint: { imageBatch: v2 } }),
    },
    {
      id: randomUUID(),
      result: JSON.stringify({
        checkpoint: { imageBatch: missingAttemptScope },
      }),
    },
    {
      id: randomUUID(),
      result: JSON.stringify({ checkpoint: { imageBatch: missingScope } }),
    },
    {
      id: randomUUID(),
      result: JSON.stringify({ checkpoint: { imageBatch: batch } }),
    },
  ];
  const history = imageBatchHistory(rows);
  expect(history.map((item) => item.resumable)).toEqual([
    false,
    false,
    false,
    false,
    true,
  ]);
  expect(rows[0]!.result).toBe(raw);
  expect((history[0] as any).reason).toContain("保留原记录");
});

it("retains saved images but invalidates all old reviews only for newly bound batch facts", () => {
  const batch = fixture();
  for (const book of batch.books)
    for (const page of book.pages) {
      const assetId = randomUUID();
      batch.delivered[page.referenceImageId] = assetId;
      batch.reviews[page.referenceImageId] = {
        assetId,
        passed: true,
        evidence: "Earlier actual review",
      };
    }
  batch.current = 2;
  const jobId = randomUUID(),
    clarification = {
      source: {
        jobId,
        rootJobId: jobId,
        messageId: jobId,
        text: "Future generic guidance only",
      },
      scope: "general" as const,
      boundToRootJobId: batch.requirements.original.rootJobId,
    };
  const general = updateImageBatchRequirements(
    batch,
    { ...batch.requirements, clarifications: [clarification] },
    "executor note",
  );
  expect(general.current).toBe(2);
  expect(general.reviews).toEqual(batch.reviews);
  const confirmedJob = randomUUID();
  const rebound = updateImageBatchRequirements(
    general,
    {
      ...general.requirements,
      clarifications: [
        ...general.requirements.clarifications,
        {
          source: {
            jobId: confirmedJob,
            rootJobId: confirmedJob,
            messageId: confirmedJob,
            text: "For this batch Kipper is Zeze",
          },
          scope: "batch",
          boundToRootJobId: batch.requirements.original.rootJobId,
        },
      ],
    },
    "confirmed",
  );
  expect(rebound.current).toBe(0);
  expect(rebound.reviews).toEqual({});
  expect(rebound.delivered).toEqual(batch.delivered);
  expect(rebound.requirements.criteria).toEqual(batch.requirements.criteria);
  expect(batch.current).toBe(2);
  expect(Object.keys(batch.reviews)).toHaveLength(4);
  expect(() =>
    updateImageBatchRequirements(
      rebound,
      { ...rebound.requirements, criteria: ["weaker"] },
      "notes",
    ),
  ).toThrow(/不能改写/);
  expect(() =>
    updateImageBatchRequirements(
      general,
      { ...general.requirements, clarifications: [] },
      "notes",
    ),
  ).toThrow(/不能改写/);
});
