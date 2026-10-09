import { expect, it } from "vitest";
import {
  activeImageBatchReferences,
  imageBatchPromptStatus,
  projectImageBatchToolHistory,
} from "../apps/server/src/services/ai/image-batch-context.js";
import {
  imageBatchPrompt,
  imageBatchSchema,
  imageBatchStatus,
} from "../apps/server/src/services/ai/image-batch.js";
import { completeExchanges } from "../apps/server/src/services/ai/checkpoint.js";

const id = (number: number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
function fixture() {
  let counter = 100;
  const books = [10, 9, 9, 22, 9, 12, 12, 12].map((count, index) => ({
    source: { assetId: id(++counter) },
    filename: `book-${index + 1}.pdf`,
    pages: Array.from({ length: count }, (_, page) => ({
      referenceImageId: id(++counter),
      filename: `book-${index + 1}-page-${page + 1}.png`,
    })),
  }));
  const originalText = `全量处理8本95页，不改非目标人物、背景和正文。\r\n ${"必须保持原始身份、自然动作、完整身体与页边。😀\r\n".repeat(120)}结尾要求：所有95页验收后完整交付。 `;
  const batch = imageBatchSchema.parse({
    version: 5,
    attemptScope: {
      version: 3,
      operationId: id(3),
      taskRootJobId: id(1),
      manifestDigest: "b".repeat(64),
    },
    requirements: {
      original: {
        jobId: id(1),
        rootJobId: id(1),
        messageId: id(1),
        text: originalText,
      },
      scope: {
        selection: "all-documents",
        inputManifest: books.map((book) => ({
          source: book.source,
          filename: book.filename,
          mime: "application/pdf",
          objectId: id(++counter),
          sha256: "a".repeat(64),
          role: "target",
          inputReferences: [{ kind: "attachment", id: book.source.assetId }],
        })),
      },
      sources: books.map((book) => ({
        source: book.source,
        inputReference: { kind: "attachment", id: book.source.assetId },
      })),
      criteria: [
        "完整95页，不以样张代替",
        "按已确认身份保留人物关系与全部可见手臂",
        "不改非目标正文、背景和其他人物",
      ],
      clarifications: [
        {
          scope: "batch",
          source: {
            jobId: id(2),
            rootJobId: id(2),
            messageId: id(2),
            text: "  已确认角色；右侧手臂属于已确认孩子。\r\n不得把它删掉。😀  ",
          },
          boundToRootJobId: id(1),
        },
      ],
    },
    books,
    current: 0,
    notes: "已经完成的页保留，失败页继续返修",
    delivered: {},
    reviews: {},
  });
  for (const [index, page] of books.flatMap((book) => book.pages).entries()) {
    batch.delivered[page.referenceImageId] = id(1000 + index);
    batch.reviews[page.referenceImageId] = {
      assetId: id(1000 + index),
      passed: index % 3 === 0,
      evidence: `原生核对物理页${index + 1}：${"此处是完整真实失败证据，禁止删掉手臂或改写判决。".repeat(40)}`,
    };
  }
  return batch;
}
function exchange(
  name: string,
  toolCallId: string,
  input: object,
  output: any,
  modelOutput?: any,
): any[] {
  const options = modelOutput
    ? {
        providerOptions: {
          mastra: { modelOutput, unrelated: "keep SDK trace" },
          test: { actual: true },
        },
      }
    : {};
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolName: name, toolCallId, input, ...options },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolName: name, toolCallId, output, ...options },
      ],
    },
  ];
}

it("golden: projects 95 real page IDs/statuses while retaining exact formal bodies, all criteria and the active full failure, without changing any source object", () => {
  const batch = fixture(),
    ref = batch.books[0]!.pages[1]!.referenceImageId;
  const history: any[] = [];
  for (let i = 0; i < 12; i++)
    history.push(
      ...exchange(
        "image_batch",
        `status-${i}`,
        { action: "status" },
        { type: "json", value: imageBatchStatus(batch) },
      ),
    );
  for (let i = 0; i < 20; i++) {
    const facts = {
      kind: "image_revision",
      version: 2,
      state: "saved",
      mode: "local",
      assetId: id(2000 + i),
      filename: `candidate-${i}.png`,
      generationOperationId: id(3000 + i),
      paidAttempt: {
        version: 3,
        ordinal: i + 1,
        referenceImageId: ref,
        scope: batch.attemptScope,
      },
      rawCandidate: {
        version: 2,
        receiptId: id(4000 + i),
        assetId: id(5000 + i),
        sha256: "c".repeat(64),
      },
      binding: { diagnostics: "Historical exact bitmap binding. ".repeat(200) },
    };
    history.push(
      ...exchange(
        "image_edit_saved_local",
        `paid-${i}`,
        {
          originalReferenceImageId: ref,
          baseAssetId: id(1500 + i),
          prompt: `Paid prompt ${i} must remain exact`,
          region: { left: 0.2, top: 0.3, width: 0.4, height: 0.5 },
        },
        { type: "json", value: facts },
        {
          type: "content",
          value: [{ type: "text", text: JSON.stringify(facts) }],
        },
      ),
    );
  }
  const currentMedia = {
    type: "content",
    value: [
      { type: "text", text: "CURRENT_VIEW_METADATA_MUST_STAY_EXACT" },
      { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
    ],
  };
  history.push(
    ...exchange(
      "image_view",
      "current-view",
      { referenceImageIds: [ref, batch.delivered[ref]] },
      { type: "json", value: { images: [{ referenceImageId: ref }] } },
      currentMedia,
    ),
  );
  const originalBatch = structuredClone(batch),
    originalHistory = structuredClone(history);
  const active = activeImageBatchReferences(history, batch),
    status = imageBatchPromptStatus(batch, active);
  expect(active).toEqual([ref]);
  expect(status.books).toHaveLength(8);
  const projectedPages = status.books.flatMap((book) => book.pages);
  expect(projectedPages).toHaveLength(95);
  expect(
    new Set(projectedPages.map((page) => page.referenceImageId)).size,
  ).toBe(95);
  for (const page of projectedPages) {
    expect(page.assetId).toBe(batch.delivered[page.referenceImageId]);
    expect(page.inspection).toMatchObject({
      assetId: batch.reviews[page.referenceImageId]!.assetId,
      passed: batch.reviews[page.referenceImageId]!.passed,
    });
    if (page.referenceImageId === ref)
      expect(page.inspection!.evidence).toBe(batch.reviews[ref]!.evidence);
    else expect(page.inspection).not.toHaveProperty("evidence");
  }
  expect(status.unfinishedPages).toBe(63);
  const projected = projectImageBatchToolHistory(history, batch, active);
  expect(completeExchanges(projected)).toBe(true);
  expect(projected.slice(-2)).toEqual(history.slice(-2));
  expect(projected.at(-1)).toBe(history.at(-1));
  const inputs = (values: any[]) =>
    values
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      }));
  expect(inputs(projected)).toEqual(inputs(history));
  const paid = projected[25].content[0].output.value;
  expect(paid.paidAttempt).toEqual(
    originalHistory[25].content[0].output.value.paidAttempt,
  );
  expect(paid.rawCandidate).toEqual(
    originalHistory[25].content[0].output.value.rawCandidate,
  );
  expect(JSON.stringify(projected).length).toBeLessThan(
    JSON.stringify(history).length * 0.4,
  );
  const current = {
    jobId: id(50),
    text: "这是本轮最新完整用户输入。\r\n所有原约束仍有效。  ",
  };
  const request = imageBatchPrompt(
    [{ role: "system", content: "Strict host rules" }, ...history],
    batch,
    current,
  );
  const source = request.find((message) => message.role === "user").content[0]
    .text;
  expect(source).toContain(batch.requirements.original.text);
  expect(source).toContain(batch.requirements.clarifications[0]!.source.text);
  expect(source).toContain(JSON.stringify(batch.requirements.criteria));
  expect(source).toContain(batch.reviews[ref]!.evidence);
  expect(
    request.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part: any) => part.text === current.text),
    ),
  ).toBe(true);
  expect(batch).toEqual(originalBatch);
  expect(history).toEqual(originalHistory);
  const projectedBodyBytes = Buffer.byteLength(
    JSON.stringify({ messages: request }),
  );
  const samePrefixUnprojectedBodyBytes = Buffer.byteLength(
    JSON.stringify({
      messages: [...request.slice(0, -history.length), ...history],
    }),
  );
  expect(projectedBodyBytes).toBeLessThan(samePrefixUnprojectedBodyBytes * 0.4);
});

it("preserves every actual-media exchange, newest pair, unknown output and error instead of inventing a historical proof or acceptance", () => {
  const batch = fixture(),
    ref = batch.books[0]!.pages[1]!.referenceImageId;
  const actual = exchange(
    "image_batch",
    "recovery",
    { action: "review", review: { referenceImageId: ref } },
    {
      type: "json",
      value: {
        error: true,
        code: "image_review_requires_fresh_view",
        evidence: "Exact error",
      },
    },
    {
      type: "content",
      value: [
        { type: "text", text: "EXACT_LABELS" },
        { type: "file", mediaType: "image/png", data: new Uint8Array([1]) },
      ],
    },
  );
  const unknown = exchange(
    "image_edit_saved_local",
    "unknown",
    { originalReferenceImageId: ref },
    {
      type: "json",
      value: { kind: "future_unknown", untouched: "Unknown means unchanged" },
    },
  );
  const latest = exchange(
    "image_batch",
    "last",
    { action: "status" },
    { type: "json", value: imageBatchStatus(batch) },
  );
  const history = [...actual, ...unknown, ...latest],
    projected = projectImageBatchToolHistory(history, batch);
  expect(projected).toEqual(history);
  for (const [index, message] of history.entries())
    expect(projected[index]).toBe(message);
});

it("focuses explicit parallel page calls together and otherwise uses the real first unfinished host queue", () => {
  const batch = fixture(),
    pages = batch.books[0]!.pages;
  expect(activeImageBatchReferences([], batch)).toEqual([
    pages[1]!.referenceImageId,
  ]);
  const input = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolName: "image_edit",
        input: { sourceImageId: pages[2]!.referenceImageId },
      },
      {
        type: "tool-call",
        toolName: "image_edit_saved_local",
        input: {
          originalReferenceImageId: pages[4]!.referenceImageId,
          baseAssetId: batch.delivered[pages[4]!.referenceImageId],
        },
      },
      {
        type: "tool-call",
        toolName: "image_view",
        input: { referenceImageIds: [id(999999)] },
      },
    ],
  };
  expect(activeImageBatchReferences([input], batch)).toEqual([
    pages[2]!.referenceImageId,
    pages[4]!.referenceImageId,
  ]);
  const candidate = exchange(
    "image_candidate_view",
    "candidate",
    { generationOperationId: id(7000) },
    {
      type: "json",
      value: {
        kind: "image_candidate_view",
        referenceImageId: pages[4]!.referenceImageId,
        generationOperationId: id(7000),
      },
    },
  );
  expect(activeImageBatchReferences(candidate, batch)).toEqual([
    pages[4]!.referenceImageId,
  ]);
});

it("does not turn a stale positive review into completed work or remove completed delivery links", () => {
  const batch = fixture(),
    ref = batch.books[0]!.pages[0]!.referenceImageId;
  batch.delivered[ref] = id(9000);
  expect(imageBatchPromptStatus(batch, [ref]).unfinishedPages).toBe(64);
  for (const book of batch.books)
    for (const page of book.pages)
      batch.reviews[page.referenceImageId] = {
        assetId: batch.delivered[page.referenceImageId]!,
        passed: true,
        evidence: "Actual accepted result",
      };
  batch.current = batch.books.length;
  expect(imageBatchPromptStatus(batch, [])).toMatchObject({
    complete: true,
    unfinishedPages: 0,
    current: null,
  });
  const complete = {
    ...imageBatchStatus(batch),
    deliveries: [
      {
        referenceImageId: ref,
        assetId: id(9000),
        href: "#/files?focus=actual-file-node",
      },
    ],
  };
  const messages = [
    ...exchange(
      "image_batch",
      "complete",
      { action: "status" },
      { type: "json", value: complete },
    ),
    ...exchange(
      "task_plan",
      "later",
      { goal: "Deliver all files" },
      { type: "json", value: { saved: true } },
    ),
  ];
  expect(projectImageBatchToolHistory(messages, batch)[1]).toBe(messages[1]);
});
