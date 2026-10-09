import type { ImageBatch } from "./image-batch.js";

/** Request-only projection. It neither changes stored receipts nor grants visual proof. */
export function activeImageBatchReferences(prompt: any[], batch: ImageBatch) {
  const pages = batch.books[batch.current]?.pages ?? [];
  const originals = new Set(pages.map((page) => page.referenceImageId));
  const byAsset = new Map(
    pages.flatMap((page) => {
      const asset = batch.delivered[page.referenceImageId];
      return asset ? [[asset, page.referenceImageId] as const] : [];
    }),
  );
  const resolve = (value: unknown) =>
    typeof value === "string"
      ? originals.has(value)
        ? value
        : byAsset.get(value)
      : undefined;
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    if (message?.role === "tool" && Array.isArray(message.content)) {
      const refs = new Set<string>();
      for (const part of message.content) {
        if (
          part.type !== "tool-result" ||
          part.toolName === "image_batch" ||
          !part.toolName?.startsWith("image_")
        )
          continue;
        const facts = outputFacts(
          part.providerOptions?.mastra?.modelOutput ?? part.output,
        );
        if (!object(facts) || facts.error) continue;
        for (const value of [
          facts.originalReferenceImageId,
          facts.referenceImageId,
          facts.binding?.original?.referenceImageId,
        ]) {
          const ref = resolve(value);
          if (ref) refs.add(ref);
        }
      }
      if (refs.size) return [...refs];
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    const refs = new Set<string>();
    for (const part of message.content) {
      if (part.type !== "tool-call" || !part.toolName?.startsWith("image_"))
        continue;
      const input = part.input;
      if (!input || typeof input !== "object") continue;
      const values = [
        input.originalReferenceImageId,
        input.referenceImageId,
        input.sourceImageId,
        input.review?.referenceImageId,
        input.candidate?.referenceImageId,
      ];
      if (Array.isArray(input.referenceImageIds))
        values.push(...input.referenceImageIds);
      if (input.baseAssetId) values.push(input.baseAssetId);
      for (const value of values) {
        const ref = resolve(value);
        if (ref) refs.add(ref);
      }
    }
    if (refs.size) return [...refs];
  }
  // A host page-order queue is an execution focus, never a guessed role mapping.
  const first = pages.find((page) => {
    const asset = batch.delivered[page.referenceImageId],
      review = batch.reviews[page.referenceImageId];
    return !asset || review?.assetId !== asset || !review.passed;
  });
  return first ? [first.referenceImageId] : [];
}

export function imageBatchPromptStatus(
  batch: ImageBatch,
  activeReferences: readonly string[],
) {
  const active = new Set(activeReferences);
  const books = batch.books.map((book, index) => {
    const pages = book.pages.map((page, pageIndex) => {
      const assetId = batch.delivered[page.referenceImageId] ?? null;
      const review = batch.reviews[page.referenceImageId];
      const inspection = review
        ? {
            assetId: review.assetId,
            passed: review.passed,
            ...(index === batch.current && active.has(page.referenceImageId)
              ? { evidence: review.evidence }
              : {}),
          }
        : null;
      return { ...page, page: pageIndex + 1, assetId, inspection };
    });
    return {
      filename: book.filename,
      source: book.source,
      totalPages: pages.length,
      deliveredPages: pages.filter((page) => page.assetId).length,
      unfinishedPages: pages.filter(
        (page) =>
          !page.assetId ||
          page.inspection?.assetId !== page.assetId ||
          !page.inspection.passed,
      ).length,
      status:
        index < batch.current
          ? "completed"
          : index === batch.current
            ? "current"
            : "pending",
      pages,
    };
  });
  const unfinishedPages = books.reduce(
    (sum, book) => sum + book.unfinishedPages,
    0,
  );
  return {
    version: batch.version,
    complete: batch.current >= books.length && unfinishedPages === 0,
    books,
    current: books[batch.current] ?? null,
    delivered: batch.delivered,
    notes: batch.notes,
    attemptScope: batch.attemptScope,
    activeReferenceImageIds: [...activeReferences],
    unfinishedPages,
  };
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function hasActualMedia(part: any): boolean {
  if (!object(part)) return false;
  if (["image", "image_url", "file", "media"].includes(part.type)) return true;
  if (Array.isArray(part.value) && part.value.some(hasActualMedia)) return true;
  return [part.output, part.providerOptions?.mastra?.modelOutput].some(
    (value) => object(value) && hasActualMedia(value),
  );
}
const pick = (source: Record<string, any>, keys: string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
function projectToolFacts(
  toolName: string,
  value: unknown,
  active: Set<string>,
) {
  if (!object(value) || value.error || value.complete === true)
    return undefined;
  if (
    toolName === "image_batch" &&
    [3, 4, 5].includes(value.version) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.books) &&
    (value.current === null || object(value.current))
  ) {
    const projected = pick(value, [
      "version",
      "complete",
      "books",
      "notes",
      "attemptScope",
      "delivered",
      "selection",
      "reviewOutcome",
    ]);
    if (value.current === null) projected.current = null;
    else if (Array.isArray(value.current.pages))
      projected.current = {
        ...value.current,
        pages: value.current.pages.map((page: any) =>
          !object(page) ||
          !object(page.inspection) ||
          active.has(page.referenceImageId)
            ? page
            : {
                ...page,
                inspection: pick(page.inspection, ["assetId", "passed"]),
              },
        ),
      };
    else return undefined;
    // Formal text and frozen criteria are already supplied in full by the authoritative prefix.
    projected.historyOnly = true;
    return projected;
  }
  if (
    [
      "image_edit",
      "image_reference",
      "image_generate",
      "image_export",
      "image_edit_saved",
      "image_edit_saved_local",
      "image_recompose",
      "image_mask_compose",
    ].includes(toolName) &&
    ["image_generation", "image_revision"].includes(value.kind) &&
    value.state === "saved" &&
    typeof value.assetId === "string"
  ) {
    return {
      ...pick(value, [
        "kind",
        "version",
        "state",
        "mode",
        "origin",
        "assetId",
        "fileId",
        "filename",
        "name",
        "mime",
        "width",
        "height",
        "url",
        "href",
        "downloadUrl",
        "generationOperationId",
        "providerCallId",
        "paidAttempt",
        "rawCandidate",
        "providerImageUsage",
      ]),
      historyOnly: true,
    };
  }
  if (
    toolName === "image_edit_saved_local_preview" &&
    value.kind === "image_revision_local_preview" &&
    value.version === 1 &&
    value.paid === false
  )
    return { ...value, historyOnly: true };
  return undefined;
}
function outputFacts(output: any) {
  if (output?.type === "json") return output.value;
  if (output?.type === "content" && Array.isArray(output.value)) {
    const first = output.value[0];
    if (first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
function withoutModelOutput(part: any) {
  const mastra = part.providerOptions?.mastra;
  if (!object(mastra) || !Object.hasOwn(mastra, "modelOutput")) return part;
  const { modelOutput: _modelOutput, ...rest } = mastra;
  return {
    ...part,
    providerOptions: { ...part.providerOptions, mastra: rest },
  };
}

/** Preserve every call input/ID and complete result pair; only known old host payloads are projected. */
export function projectImageBatchToolHistory(
  prompt: any[],
  batch: ImageBatch,
  activeReferences = activeImageBatchReferences(prompt, batch),
) {
  const active = new Set(activeReferences),
    calls = new Map<string, number>(),
    protectedCalls = new Set<string>();
  let latestCall = -1;
  for (let index = 0; index < prompt.length; index++) {
    const message = prompt[index];
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content)
      if (part.type === "tool-call" && typeof part.toolCallId === "string") {
        calls.set(part.toolCallId, index);
        latestCall = index;
      }
  }
  for (let index = 0; index < prompt.length; index++) {
    const message = prompt[index];
    if (!Array.isArray(message?.content)) continue;
    if (index >= latestCall || message.content.some(hasActualMedia))
      for (const part of message.content)
        if (typeof part.toolCallId === "string")
          protectedCalls.add(part.toolCallId);
  }
  const replacements = new Map<string, any>();
  for (const message of prompt) {
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type !== "tool-result" ||
        protectedCalls.has(part.toolCallId) ||
        !calls.has(part.toolCallId)
      )
        continue;
      // Current Mastra modelOutput is the effective rendered payload, not a second receipt.
      const rendered = part.providerOptions?.mastra?.modelOutput;
      const facts = projectToolFacts(
        part.toolName,
        outputFacts(rendered ?? part.output),
        active,
      );
      if (facts) replacements.set(part.toolCallId, facts);
    }
  }
  return prompt.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const content = message.content.map((part: any) => {
      if (!replacements.has(part.toolCallId)) return part;
      const copy = withoutModelOutput(part);
      return part.type === "tool-result"
        ? {
            ...copy,
            output: { type: "json", value: replacements.get(part.toolCallId) },
          }
        : copy;
    });
    return content.every(
      (part: any, index: number) => part === message.content[index],
    )
      ? message
      : { ...message, content };
  });
}
