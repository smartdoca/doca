import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

export const reviewSchema = z.object({
  verdict: z.enum(["pass", "revise", "needs_user"]),
  summary: z.string().min(1).max(3000),
  checks: z
    .array(
      z.object({
        requirement: z.string().min(1).max(500),
        criterionIndex: z
          .number()
          .int()
          .min(0)
          .max(19)
          .optional()
          .describe(
            "对应 task_plan.criteria 的下标，从 0 开始；每项标准单独检查",
          ),
        passed: z.boolean(),
        evidence: z.string().min(1).max(1500),
      }),
    )
    .min(1)
    .max(30),
});
export type DeliveryReview = z.infer<typeof reviewSchema>;

export function missingReviewCriteria(
  criteria: string[],
  review: DeliveryReview,
) {
  return criteria.filter(
    (criterion, index) =>
      !review.checks.some(
        (check) =>
          check.passed &&
          (check.criterionIndex === index ||
            (check.criterionIndex === undefined &&
              check.requirement.trim() === criterion.trim())),
      ),
  );
}

// Text is not evidence that a side effect happened. Check claims even for tasks
// that never created a plan or wrote a document (and otherwise skip review).
export function unverifiedImageDelivery(
  text: string,
  hasImageReceipt: boolean,
): DeliveryReview | null {
  if (hasImageReceipt) return null;
  const claims =
    /(?:图片|图像|生图|生成接口|生成工具|工具)[^。！？\n]{0,45}(?:已生成|已展示|生成成功|生成.{0,4}成功|返回.{0,8}成功|报告成功)|(?:已生成|已展示|生成了|生成成功)[^。！？\n]{0,25}(?:图片|图像|照片)|(?:image|picture)[^.!?\n]{0,40}(?:generated|displayed|created)|(?:generated|created|displayed)[^.!?\n]{0,25}(?:image|picture)/i;
  const asserted = text
    .split(/[。！？\n]/)
    .filter(
      (sentence) =>
        !/(?:没有|尚未|未能|并未|不能|无法|未生成|未返回|\bnot\b|\bnever\b)/i.test(
          sentence,
        ),
    );
  if (!asserted.some((sentence) => claims.test(sentence))) return null;
  return {
    verdict: "revise",
    summary:
      "图片交付未通过：本轮没有真实图片回执，不能声称生成成功或猜测客户端展示故障。先调用 image_show 核实已有图片；没有记录且用户要求生图时必须实际调用 image_generate，失败则如实报告工具错误。",
    checks: [
      {
        requirement: "图片交付必须有可展示的真实素材回执",
        passed: false,
        evidence: "本轮没有任何图片生成或展示回执；助手文字不作为操作证据。",
      },
    ],
  };
}

// Workflow controls the bounded acceptance loop; Doca's job/lease and operation ledger
// remain authoritative. A process interruption is retried explicitly, never replayed blindly.
export function deliveryWorkflow(callbacks: {
  execute: (
    feedback: DeliveryReview | undefined,
    round: number,
  ) => Promise<void>;
  review: (round: number) => Promise<DeliveryReview | null>;
  rejected: (review: DeliveryReview) => never;
}) {
  const state = z.object({
    round: z.number(),
    done: z.boolean(),
    feedback: reviewSchema.optional(),
  });
  const attempt = createStep({
    id: "execute-and-accept",
    inputSchema: state,
    outputSchema: state,
    execute: async ({ inputData }) => {
      await callbacks.execute(inputData.feedback, inputData.round);
      const review = await callbacks.review(inputData.round);
      if (
        !review ||
        review.verdict === "pass" ||
        review.verdict === "needs_user"
      )
        return { round: inputData.round, done: true };
      if (inputData.round >= 2) callbacks.rejected(review);
      return { round: inputData.round + 1, done: false, feedback: review };
    },
  });
  return createWorkflow({
    id: "doca-delivery",
    inputSchema: state,
    outputSchema: state,
  })
    .dountil(attempt, async ({ inputData }) => inputData.done)
    .commit();
}

// Recent user turns decide whether document persistence is in scope at all.
// An explicit decline suppresses document claim checks until a newer turn asks
// for a document again; newest decisive statement wins.
export function documentDeliveryDeclined(userTexts: string[]): boolean {
  const request =
    /(?:创建|新建|保存|存为|生成|写入|整理成|转成|做成|归档|记录到)[^。！？\n]{0,10}(?:文档|文件|知识库)|(?:文档|文件)[^。！？\n]{0,6}(?:创建|新建|保存)|(?:create|save|write)[^.!?\n]{0,20}(?:document|file)/i;
  const decline =
    /(?:不需要|不用|不要|无需|无须|不必|不再|别|取消)[^。！？\n]{0,10}(?:文档|文件)|(?:文档|文件)[^。！？\n]{0,6}(?:不需要|不用|不要|没必要|算了)|(?:don't|do not|no need to)[^.!?\n]{0,20}(?:document|file)/i;
  for (const text of userTexts) {
    if (decline.test(text)) return true;
    if (request.test(text)) return false;
  }
  return false;
}

export function unverifiedDocumentDelivery(
  text: string,
  hasWriteReceipt: boolean,
): DeliveryReview | null {
  if (hasWriteReceipt) return null;
  const sentences = text
    .split(/[。！？\n]/)
    .filter(
      (s) =>
        !/(?:没有|尚未|未能|并未|不能|无法|不再|不需要|不用|不要|无需|无须|不必|未完成|未保存|未修改|未创建|未生成|未写入|\bnot\b|\bnever\b)/i.test(
          s,
        ),
    );
  const claim =
    /(?:已|已经|本次|这次)[^。！？\n]{0,45}(?:修复|修改|更新|保存|插入|删除|移动|创建|写入|恢复|改为|改成)|(?:修复|修改|更新|保存|插入|写入|恢复)[^。！？\n]{0,12}(?:成功|完成|完毕)|(?:I\s+(?:have\s+)?|successfully\s+)(?:fixed|saved|updated|inserted|deleted|created|edited)\b/i;
  const document =
    /文档|代码块|段落|标题|章节|正文|画布|画板|表格|单元格|幻灯片|PPT|document|spreadsheet|slide|canvas|code block/i;
  // A delivery claim only counts when the same sentence says a document was
  // persisted; mentioning documents elsewhere in a text answer is not a claim.
  if (!sentences.some((s) => claim.test(s) && document.test(s))) return null;
  return {
    verdict: "revise",
    summary:
      "文档交付未通过：本轮没有已保存的文档操作回执，不能声称已修复、写入或回读确认。先调用 document_read 查看目标和 capabilities，再实际调用对应类型的编辑工具。只需说明或无法完成时如实回答，不得编造操作和保存结果。",
    checks: [
      {
        requirement: "文档修改必须有真实保存回执",
        passed: false,
        evidence: "本轮及恢复链没有文档写入记录，助手文字不作为保存证据。",
      },
    ],
  };
}

export function needsLlmReview(options: {
  written: number;
  plan?: { mode?: string; criteria?: string[] } | null;
  round: number;
}) {
  if (!options.written) return false;
  if (options.plan?.mode === "clarify") return false;
  return true;
}

function directFolderMutation(text: string) {
  if (
    /(?:调研|方案|怎么|如何|是否应该|优缺点|对比|成熟做法)/.test(text) &&
    !/(?:帮我|请你?|给我).{0,16}(?:创建|新建|改名|重命名)/.test(text)
  )
    return false;
  if (
    /(?:帮我|请你?|给我)?(?:创建|新建)(?:一个)?文件夹|(?:帮我|请你?)?(?:把|将)?.{0,24}文件夹.{0,12}(?:改名|重命名|改成)|(?:帮我|请你?)?(?:改名|重命名).{0,12}文件夹/.test(
      text,
    )
  )
    return true;
  return /我的选择：/.test(text) && /(?:名字|名称|改名|重命名|文件夹)/.test(text);
}

function renameFollowUp(text: string) {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  if (/(?:文档|段落|标题|表格|单元格|正文|代码|内容|这段|那句|那篇)/.test(t))
    return false;
  return /^(?:好的?，?)?(?:那)?(?:请)?(?:帮我)?(?:把它|将它|把这个|这个)?(?:改成|改名为|重命名为|就叫)[「『""]?[^\n]{1,30}[」』""]?(?:吧|呀|啊|好了)?[。！？.!?]*$/.test(
    t,
  );
}

export function folderMutationRequested(
  text: string,
  recentUserTexts: string[] = [],
) {
  if (directFolderMutation(text)) return true;
  if (!renameFollowUp(text)) return false;
  return recentUserTexts.some(
    (t) =>
      t.trim() !== text.trim() &&
      (directFolderMutation(t) || /文件夹|目录|\bfolder\b/i.test(t)),
  );
}

export const EMPTY_JOB_ANSWER = "本轮工具操作已结束，请查看任务结果。";

export function spreadsheetImageInsertRequested(
  text: string,
  recentUserTexts: string[] = [],
) {
  const blob = [text, ...recentUserTexts].join("\n");
  return /(?:插入|加入|放进|写进|贴到|放到).{0,20}(?:表格|excel|工作表|spreadsheet)|(?:表格|excel|工作表|spreadsheet).{0,24}(?:插图|图片|照片)/i.test(
    blob,
  );
}

export function jobAssistantAnswer(options: {
  text: string;
  eventTexts: string[];
  folderName?: string;
  folderMutationPending?: boolean;
  imageInsertPending?: boolean;
}) {
  const meaningful =
    [options.text, ...options.eventTexts]
      .map((t) => t.trim())
      .find((t) => t && t !== EMPTY_JOB_ANSWER) ?? "";
  if (options.folderName)
    return meaningful || `已更新文件夹「${options.folderName}」。`;
  if (options.folderMutationPending)
    return (
      meaningful ||
      "文件夹尚未改动。请实际调用改名工具，成功后会展示文件夹卡片。"
    );
  if (options.imageInsertPending)
    return (
      meaningful ||
      "图片尚未写入表格。请调用 image_insert，必须传 assetId、resourceId、sheetId、row、column。"
    );
  return meaningful || EMPTY_JOB_ANSWER;
}

export function unverifiedFolderDelivery(
  text: string,
  hasFolderReceipt: boolean,
): DeliveryReview | null {
  if (hasFolderReceipt) return null;
  const sentences = text
    .split(/[。！？.\n]/)
    .filter(
      (s) =>
        !/(?:没有|尚未|未能|并未|不能|无法|未完成|未改名|未重命名|未创建|未移动|\bnot\b|\bnever\b|wants to rename)/i.test(
          s,
        ),
    );
  const claim =
    /(?:已|已经|本次|这次)[^。！？\n]{0,40}(?:改名|重命名|创建文件夹|新建文件夹)|(?:改名|重命名|创建文件夹)(?:成功|完成|完毕)|(?:改名|重命名)完成|folder rename is complete|(?:renamed|created)\s+(?:the\s+)?folder|\brenamed to\b/i;
  if (!sentences.some((s) => claim.test(s))) return null;
  return {
    verdict: "revise",
    summary:
      "文件夹操作未通过：本轮没有文件夹工具回执，不能声称已改名、创建或移动。请调用 file_folder_manage（rename 必须带完整 folderId 和 name），成功回执会展示可跳转的文件夹卡片。",
    checks: [
      {
        requirement: "文件夹改名、创建或移动必须有真实工具回执",
        passed: false,
        evidence: "本轮没有文件夹操作回执；助手文字不作为改名或创建证据。",
      },
    ],
  };
}

// These legacy names are not the editor's native code-block type. Expose IDs so
// acceptance can fail with concrete evidence rather than trusting an answer.
export function invalidCodeBlocks(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (
      ["codeBlock", "code_block", "pre"].includes(node.type) ||
      (node.type === "code-block" && typeof node.code !== "string")
    )
      ids.push(String(node.id ?? "无 ID"));
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(value);
  return ids;
}
