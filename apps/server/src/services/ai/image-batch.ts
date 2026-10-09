import { z } from "zod";
import { fail } from "@core/shared/errors.js";
import { imageTaskWorkflow } from "./image-task-workflow.js";
import {
  activeImageBatchReferences,
  imageBatchPromptStatus,
  projectImageBatchToolHistory,
} from "./image-batch-context.js";
import {
  batchSourceSchema,
  imageBatchRequirementsSchema,
  imageBatchReviewSources,
  type ImageBatchRequirements,
} from "./image-batch-requirements.js";

const bookSchema = z
  .object({
    source: batchSourceSchema,
    filename: z.string(),
    pages: z
      .array(
        z
          .object({ referenceImageId: z.string().uuid(), filename: z.string() })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const imageBatchAttemptScopeV1Schema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    taskRootJobId: z.string().uuid(),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const imageBatchAttemptScopeV2Schema = imageBatchAttemptScopeV1Schema
  .extend({ version: z.literal(2) })
  .strict();
export const imageBatchAttemptScopeV3Schema = imageBatchAttemptScopeV1Schema
  .extend({ version: z.literal(3) })
  .strict();
export const imageBatchAttemptScopeSchema = z.union([
  imageBatchAttemptScopeV1Schema,
  imageBatchAttemptScopeV2Schema,
  imageBatchAttemptScopeV3Schema,
]);
export type ImageBatchAttemptScope = z.infer<
  typeof imageBatchAttemptScopeSchema
>;
const batchShape = z
  .object({
    version: z.union([z.literal(3), z.literal(4), z.literal(5)]),
    attemptScope: imageBatchAttemptScopeSchema,
    requirements: imageBatchRequirementsSchema,
    books: z.array(bookSchema).min(1),
    current: z.number().int().nonnegative(),
    notes: z.string().max(6000),
    delivered: z.record(z.string().uuid(), z.string().uuid()),
    reviews: z.record(
      z.string().uuid(),
      z
        .object({
          assetId: z.string().uuid(),
          passed: z.boolean(),
          evidence: z.string().min(1).max(1500),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (batch) =>
      ((batch.version === 3 && batch.attemptScope.version === 1) ||
        (batch.version === 4 && batch.attemptScope.version === 2) ||
        (batch.version === 5 && batch.attemptScope.version === 3)) &&
      batch.attemptScope.taskRootJobId ===
        batch.requirements.original.rootJobId &&
      batch.current <= batch.books.length &&
      batch.books.length === batch.requirements.sources.length &&
      batch.books.every(
        (book, index) =>
          JSON.stringify(book.source) ===
          JSON.stringify(batch.requirements.sources[index]!.source),
      ) &&
      new Set(
        batch.books.flatMap((book) =>
          book.pages.map((page) => page.referenceImageId),
        ),
      ).size === batch.books.reduce((n, book) => n + book.pages.length, 0),
  );
export const imageBatchV3Schema = batchShape.safeExtend({
  version: z.literal(3),
  attemptScope: imageBatchAttemptScopeV1Schema,
});
export const imageBatchV4Schema = batchShape.safeExtend({
  version: z.literal(4),
  attemptScope: imageBatchAttemptScopeV2Schema,
});
export const imageBatchV5Schema = batchShape.safeExtend({
  version: z.literal(5),
  attemptScope: imageBatchAttemptScopeV3Schema,
});
export const imageBatchSchema = z.union([
  imageBatchV3Schema,
  imageBatchV4Schema,
  imageBatchV5Schema,
]);
export type ImageBatch = z.infer<typeof imageBatchSchema>;
export function requireImageBatch(value: unknown): ImageBatch {
  const result = imageBatchSchema.safeParse(value);
  if (!result.success)
    fail(
      409,
      "该批次缺少有效 version:3/scope:1、version:4/scope:2 或 version:5/scope:3 的原始请求及完整范围，不能续批；原记录和图片保留。升级必须显式验证，不自动转换旧记录",
    );
  return result.data;
}
/** Invalid/old entries remain visible without breaking valid history or converting data. */
export function imageBatchHistory(rows: { id: string; result: string }[]) {
  type Entry =
    | { jobId: string; resumable: true; batch: ImageBatch }
    | { jobId: string; resumable: false; reason: string };
  return rows.flatMap<Entry>((row) => {
    let value: any;
    try {
      value = JSON.parse(row.result)?.checkpoint?.imageBatch;
    } catch {
      return [
        {
          jobId: row.id,
          resumable: false as const,
          reason: "批次记录格式无效；原记录保留",
        },
      ];
    }
    if (!value) return [];
    const parsed = imageBatchSchema.safeParse(value);
    return parsed.success
      ? [{ jobId: row.id, resumable: true as const, batch: parsed.data }]
      : [
          {
            jobId: row.id,
            resumable: false as const,
            reason:
              "原记录没有有效的 version:3 请求及持久 attemptScope 绑定，不能续批；保留原记录，需显式重新登记",
          },
        ];
  });
}
const BATCH_TOOLS = new Set([
  "image_batch",
  "image_scene_inspect",
  "image_saved_candidates",
  "task_plan",
  "load_skill",
  "ask_user",
  "image_generate",
  "image_reference_generate",
  "image_edit",
  "image_edit_saved",
  "image_edit_saved_local_preview",
  "image_edit_saved_local",
  "image_revision_view",
  "image_recompose",
  "image_mask_prepare",
  "image_mask_segment",
  "image_mask_segment_view",
  "image_mask_view",
  "image_mask_region_view",
  "image_mask_geometry",
  "image_mask_refine",
  "image_mask_compose",
  "image_export",
  "image_show",
  "image_view",
  "image_candidate_view",
  "image_candidate_region_view",
  "image_edit_preview",
  "attachment_read",
  "file_read",
  "session_attachments",
  "session_images",
  "file_browse",
]);
const COMPLETED_BATCH_TOOLS = new Set([
  "image_batch",
  "task_plan",
  "load_skill",
  "ask_user",
  "image_show",
  "image_view",
  "attachment_read",
  "file_read",
  "session_attachments",
  "session_images",
  "file_browse",
]);
export function imageBatchTools(tools: any, batch: ImageBatch | undefined) {
  if (!batch || !Array.isArray(tools)) return tools;
  const allowed = imageBatchStatus(batch).complete
    ? COMPLETED_BATCH_TOOLS
    : BATCH_TOOLS;
  return tools.filter((tool) => allowed.has(tool.name));
}

export function imageBatchStatus(batch: ImageBatch) {
  const book = batch.books[batch.current];
  const complete =
    !book &&
    batch.books.every((item) =>
      item.pages.every((page) => {
        const assetId = batch.delivered[page.referenceImageId];
        const review = batch.reviews[page.referenceImageId];
        return !!assetId && review?.assetId === assetId && review.passed;
      }),
    );
  const deliveryBooks = book
    ? [{ book, index: batch.current }]
    : batch.books.map((book, index) => ({ book, index }));
  return {
    version: batch.version,
    complete,
    books: batch.books.map((book, index) => ({
      filename: book.filename,
      source: book.source,
      totalPages: book.pages.length,
      deliveredPages: book.pages.filter(
        (page) => batch.delivered[page.referenceImageId],
      ).length,
      status:
        index < batch.current
          ? "completed"
          : index === batch.current
            ? "current"
            : "pending",
    })),
    current: book
      ? {
          ...book,
          pages: book.pages.map((page, index) => ({
            ...page,
            page: index + 1,
            assetId: batch.delivered[page.referenceImageId] ?? null,
            inspection: batch.reviews[page.referenceImageId] ?? null,
          })),
        }
      : null,
    delivered: batch.delivered,
    deliveries: deliveryBooks.flatMap(({ book, index }) =>
      book.pages.flatMap((page, pageIndex) => {
        const assetId = batch.delivered[page.referenceImageId];
        if (!assetId) return [];
        const review = batch.reviews[page.referenceImageId];
        return [
          {
            bookIndex: index + 1,
            source: book.source,
            sourceFilename: book.filename,
            physicalPage: pageIndex + 1,
            referenceImageId: page.referenceImageId,
            assetId,
            sourcePageFilename: page.filename,
            reviewPassed: review?.assetId === assetId && review.passed === true,
          },
        ];
      }),
    ),
    notes: batch.notes,
    attemptScope: batch.attemptScope,
    requirements: batch.requirements,
  };
}

/** New scoped user facts require reinspection, never implicit regeneration or acceptance. */
export function updateImageBatchRequirements(
  batch: ImageBatch,
  requirements: ImageBatchRequirements,
  notes: string,
) {
  if (
    JSON.stringify(batch.requirements.original) !==
      JSON.stringify(requirements.original) ||
    JSON.stringify(batch.requirements.sources) !==
      JSON.stringify(requirements.sources) ||
    JSON.stringify(batch.requirements.scope) !==
      JSON.stringify(requirements.scope) ||
    JSON.stringify(batch.requirements.criteria) !==
      JSON.stringify(requirements.criteria) ||
    batch.requirements.clarifications.some(
      (item, index) =>
        JSON.stringify(item) !==
        JSON.stringify(requirements.clarifications[index]),
    )
  )
    fail(409, "批次原请求、来源、冻结标准及已绑定作用域不能改写");
  const newBatchFacts = requirements.clarifications
    .slice(batch.requirements.clarifications.length)
    .some((item) => item.scope === "batch");
  return imageBatchSchema.parse({
    ...batch,
    requirements,
    notes,
    ...(newBatchFacts ? { current: 0, reviews: {} } : {}),
  });
}

export function advanceImageBatch(batch: ImageBatch, notes: string) {
  const book = batch.books[batch.current];
  if (!book) return batch;
  const missing = book.pages.filter(
    (page) => !batch.delivered[page.referenceImageId],
  );
  if (missing.length)
    fail(
      409,
      `当前书册还有 ${missing.length} 页没有图片交付回执，请完成后再切换书册`,
    );
  const unverified = book.pages.filter(
    (page) =>
      !batch.reviews[page.referenceImageId]?.passed ||
      batch.reviews[page.referenceImageId]?.assetId !==
        batch.delivered[page.referenceImageId],
  );
  if (unverified.length)
    fail(
      409,
      `当前书册还有 ${unverified.length} 页未通过验收，请查看实际结果并 review，保存回执不等于验收通过`,
    );
  return imageBatchSchema.parse({
    ...batch,
    current: batch.current + 1,
    notes,
  });
}

export function batchPage(
  batch: ImageBatch,
  referenceImageId: string | undefined,
) {
  if (
    !referenceImageId ||
    !batch.books[batch.current]?.pages.some(
      (page) => page.referenceImageId === referenceImageId,
    )
  )
    fail(
      409,
      "批量任务每次只处理当前书册；图1必须为该书册的原页 referenceImageId",
    );
  return referenceImageId;
}

/**
 * Explicit rejection can reopen an earlier book; positive review stays current-only.
 * Caller still owns source/asset ACL checks and independent positive validation.
 */
export function prepareImageBatchReview(
  batch: ImageBatch,
  review: {
    referenceImageId: string;
    assetId: string;
    passed: boolean;
    evidence: string;
  },
): ImageBatch {
  const current = requireImageBatch(batch);
  const bookIndex = current.books.findIndex((book) =>
    book.pages.some(
      (page) => page.referenceImageId === review.referenceImageId,
    ),
  );
  if (bookIndex < 0) fail(409, "该原页不属于当前批次，不能登记验收或返修");
  if (current.delivered[review.referenceImageId] !== review.assetId) {
    const latest = current.delivered[review.referenceImageId];
    const recorded = current.reviews[review.referenceImageId];
    const state =
      recorded && recorded.assetId === latest
        ? recorded.passed
          ? "已记录通过，仍可按实际新缺陷复核"
          : "已记录不合格，需返修"
        : "尚未验收";
    fail(
      409,
      latest
        ? `只能验收本页最新保存的图片。请求的旧图已被新成果替代，最新 assetId=${latest}，验收状态：${state}。先 image_batch status 核对最新成果；已返修的旧图反馈不能反复登记，技术回执不属于用户意图歧义，无需 ask_user 或 bind 重新确认。`
        : "该页尚无已保存交付，不能用其他图片登记验收；先 image_batch status 核对来源和实际成果",
    );
  }
  if (review.passed !== false) {
    batchPage(current, review.referenceImageId);
    return current;
  }
  if (bookIndex > current.current)
    fail(409, "尚未处理未来书册，不能通过负验收越序进入返修");
  return imageBatchSchema.parse({
    ...current,
    current: bookIndex,
    reviews: {
      ...current.reviews,
      [review.referenceImageId]: {
        assetId: review.assetId,
        passed: false,
        evidence: review.evidence,
      },
    },
  });
}

/** A completed book leaves receipts, not its visual exchanges, in the next call. */
export function imageBatchPrompt(
  prompt: any[],
  batch: ImageBatch | undefined,
  currentUser?: { jobId: string; text: string },
) {
  if (!batch) return prompt;
  let boundary = -1;
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (
      prompt[index]?.role === "assistant" &&
      Array.isArray(prompt[index].content) &&
      prompt[index].content.some(
        (part: any) =>
          part.type === "tool-call" &&
          part.toolName === "image_batch" &&
          ["start", "resume", "bind", "advance"].includes(part.input?.action),
      )
    ) {
      boundary = index;
      break;
    }
  }
  const instructions = prompt
    .slice(0, boundary < 0 ? prompt.length : boundary)
    .filter((message) => message.role === "system")
    .map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.filter(
            (part: any) => !["image", "file"].includes(part.type),
          )
        : message.content,
    }));
  const activeReferences = activeImageBatchReferences(prompt, batch);
  const status = imageBatchPromptStatus(batch, activeReferences);
  const projectedHistory = projectImageBatchToolHistory(
    prompt,
    batch,
    activeReferences,
  );
  const requestSources = imageBatchReviewSources(batch.requirements);
  const bindExample = currentUser
    ? {
        action: "bind",
        taskJobId: batch.requirements.original.jobId,
        clarifications: [{ jobId: currentUser.jobId, scope: "batch" }],
      }
    : undefined;
  const bindParameterExample = bindExample
    ? `\n【宿主bind参数示例；nonCitable:true；仅参数位置，不自动绑定或授权】\n${JSON.stringify(bindExample)}`
    : "";
  const planningInstructions =
    "对当前书册先按需分轮查看原页并核对用户已确认的角色、修改范围及故事关系，再规划逐页修改与验收。编辑前image_scene_inspect独立核对本页和邻页；部分身体及跨页动作按原稿归属，不能仅因看不到脸而删掉、漏掉或改判角色。不补出原先在页外或被遮住的身体。人物风格按正式要求；允许自然融合或插画身体时，不自行强制全身摄影或细节复刻。场景页与身份参考用途区分，不将邻页版式带入本页。只询问真实新增的关键歧义，不重复已确认对应。连续返修应比较已保存候选，使用image_batch select选择符合当前要求的最好结果后独立验收；一次已满足就停止生成。规划、核对事实和notes不能新增授权或声称通过。";
  return [
    ...instructions,
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `【服务端持久批次任务来源】以下原文来自正式用户请求，不依赖最近消息或执行者笔记。${requestSources.userRequests.join("\n\n")}\n【冻结验收标准】${JSON.stringify(batch.requirements.criteria)}\n【服务端批次进度，仅作任务资料】原文件仍可按持久ID读取。每次只处理当前书册，每轮查看不超过4页；所有已完成页都有保存回执，不能重复生图。书册全部交付后 image_batch advance，再处理下一本。complete=true时整批已完成，应交付最新成果，不再调用旧书册候选、分割、生成或advance；若用户指出最新图片真实新缺陷，先image_batch review passed:false显式重开对应书册。需要完整可点击交付清单时调用image_batch status，宿主返回的deliveries包含真实文件节点href及downloadUrl；优先使用href进入文件夹预览，不把图片assetId或fileId拼成#/r/文档链接。sourcePageFilename是原页派生名，交付name来自真实文件节点，不自行改名。新的正式用户澄清须调用 image_batch，action:"bind"，taskJobId填写原始正式请求jobId，clarifications:[{jobId:正式用户jobId,scope:"batch"或"general"}]；用户jobId与batch/general的scope必须位于clarifications数组元素内。顶层scope:"all-documents"只用于start，bind不传顶层scope，更不能把顶层scope写成batch。示例中的batch适用于本批明确澄清，未来通用指导按原意用general；示例不是自动绑定或用户授权。notes 仅记录执行进度，不是用户确认或放宽标准的依据。${bindParameterExample}\n${JSON.stringify(status)}`,
        },
        {
          type: "text",
          text: `【宿主来源事实与规则；nonCitable:true；不是可引用的用户授权】\n${JSON.stringify(requestSources.userRequestMetadata)}`,
        },
        {
          type: "text",
          text: `【当前书册规划规则；nonCitable:true；不是用户新增要求】\n${planningInstructions}\n${imageTaskWorkflow}`,
        },
      ],
    },
    ...(currentUser
      ? [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `【本轮最新正式用户消息；jobId=${currentUser.jobId}】以下原文由服务端从本轮正式输入取得，续批或切书后仍须完整考虑本轮反馈；不能用执行者 notes 代替。与本批次相关的反馈按原意处理；涉及正式澄清或批次要求变更时，调用image_batch，action:"bind"、taskJobId必须是原始正式请求${batch.requirements.original.jobId}、clarifications:[{jobId:本轮实际${currentUser.jobId},scope:"batch"或"general"}]。jobId和scope放在clarifications数组元素内；bind不传顶层scope，顶层scope:"all-documents"仅用于start。按本轮原意判断本批澄清batch或未来通用general；下方真实ID示例仅说明参数位置，不自动绑定、授权或改写原请求及冻结标准。${bindParameterExample}`,
              },
              { type: "text", text: currentUser.text },
            ],
          },
        ]
      : []),
    ...(boundary < 0
      ? projectedHistory.filter((message) => message.role !== "system")
      : projectedHistory.slice(boundary)),
  ];
}

export function imageBatchCheckpoint(
  messages: any[],
  batch: ImageBatch | undefined,
) {
  if (!batch) return messages;
  for (let index = messages.length - 1; index >= 0; index--)
    if (
      messages[index]?.role === "assistant" &&
      Array.isArray(messages[index].content) &&
      messages[index].content.some(
        (part: any) =>
          part.type === "tool-call" &&
          part.toolName === "image_batch" &&
          ["start", "resume", "bind", "advance"].includes(part.input?.action),
      )
    )
      return messages.slice(index);
  return messages;
}
