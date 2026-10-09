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
  return criteria.filter((criterion, index) => {
    const checks = review.checks.filter(
      (check) =>
        check.criterionIndex === index ||
        (check.criterionIndex === undefined &&
          check.requirement.trim() === criterion.trim()),
    );
    return !checks.length || checks.some((check) => !check.passed);
  });
}

// Text is not evidence that a side effect happened. Check claims even for tasks
// that never created a plan or wrote a document (and otherwise skip review).
export function unverifiedImageDelivery(
  text: string,
  hasImageReceipt: boolean,
): DeliveryReview | null {
  if (hasImageReceipt) return null;
  const claims =
    /(?:图片|图像|生图|生成接口|生成工具)[^。！？\n]{0,45}(?:已生成|已展示|生成成功|生成.{0,4}成功|返回.{0,8}成功|报告成功)|(?:已生成|已展示|生成了|生成成功)[^。！？\n]{0,25}(?:图片|图像|照片)|(?:image|picture)[^.!?\n]{0,40}(?:generated|displayed|created)|(?:generated|created|displayed)[^.!?\n]{0,25}(?:image|picture)/i;
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
      "图片交付未通过：本轮没有真实图片回执，不能声称生成成功或猜测客户端展示故障。先调用 image_show 核实已有图片；没有记录且用户要求生图时必须实际调用相应图片工具：文生图 image_generate、参考图生图 image_reference_generate、底图修改 image_edit；失败则如实报告工具错误。",
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
    // Within a turn, the last decisive clause wins as well.
    for (const clause of text.split(/[，,。！？;；\n]/).reverse()) {
      if (decline.test(clause)) return true;
      if (request.test(clause)) return false;
    }
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
      "文档交付未通过：本轮没有已保存的文档操作回执，不能声称已修复、写入或回读确认。需要修改时先调用 document_read 查看目标和 capabilities，再调用对应编辑工具。若本轮仅核验已有成果，回读后明确“本轮未修改”，不要为获取回执重复写入。只需说明或无法完成时如实回答，不得编造操作和保存结果。",
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
  return (
    /我的选择：/.test(text) && /(?:名字|名称|改名|重命名|文件夹)/.test(text)
  );
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

export function fileCopyRequested(text: string) {
  return /复制|拷贝|克隆|另存为?|做(?:一)?[份个]副本|创建副本|新建副本|\bcopy\b/i.test(
    text,
  );
}

export function fileSendRequested(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (fileCopyRequested(t)) return false;
  if (/文件卡片|再发给我|发给我一下/.test(t)) return true;
  if (/(?:写|起草|生成|制作|总结|摘要)/.test(t) && !/(?:找|发给|卡片)/.test(t))
    return false;
  return /(?:需要|找|查找|搜索|发给我|发我).{0,80}[\w\u4e00-\u9fff ._-]{0,80}\.(?:pdf|docx|xlsx|pptx|png|jpe?g|webp|zip)/i.test(
    t,
  );
}

export function secretValueProvided(text: string) {
  const t = text.trim();
  if (!t || /不要(?:保存|记住|写入)|别(?:保存|记住)/.test(t)) return false;
  if (/(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/.test(t))
    return true;
  return /(?:密钥|令牌|token|api[_ ]?key|密码|secret)\s*[:：=是为]\s*\S{8,}/i.test(
    t,
  );
}

export function unverifiedSecretDelivery(
  userText: string,
  secretsWritten: number,
): DeliveryReview | null {
  if (secretsWritten > 0 || !secretValueProvided(userText)) return null;
  return {
    verdict: "revise",
    summary:
      "密钥还没进密码本。请立刻 secret_write：key 以字母开头，只含字母、数字和下划线（如 API_KEY），value 用用户给出的原文。备忘里只写 {{KEY}}，回复不要出现密钥。",
    checks: [
      {
        requirement: "用户给出的密钥必须写入密码本",
        passed: false,
        evidence: "本轮没有 secret_write 成功回执。",
      },
    ],
  };
}

export function unverifiedFileDelivery(
  userText: string,
  answer: string,
  hasFileReceipt: boolean,
): DeliveryReview | null {
  if (hasFileReceipt || !fileSendRequested(userText)) return null;
  if (
    /(?:没有找到|未找到|找不到|不存在)/.test(answer) &&
    !/(?:已找到|已为您找到|点击)/.test(answer)
  )
    return null;
  const claimed =
    /已[^。！？\n]{0,16}(?:找到|创建|复制)|已发给|文件卡片|点击(?:下方)?(?:卡片|链接)|\[(?:[^\]]+\.(?:pdf|docx|xlsx|pptx|png|jpe?g|webp|zip))\]\([^)]+\)/i.test(
      answer,
    );
  if (!claimed) return null;
  return {
    verdict: "revise",
    summary:
      "文件没有真正发给用户：本轮没有文件卡片回执。请调用 file_search 或 file_browse，使用已有文件的 fileId。工具会发出卡片，打开地址用返回的 href（含 focus）。不要 file_manage copy，不要自己写 markdown 链接。「N 份相同副本」是说已经有重复文件，选出一份即可。",
    checks: [
      {
        requirement: "查找或发送已有文件必须有文件卡片回执",
        passed: false,
        evidence: "本轮没有文件卡片回执；手写链接不能代替卡片。",
      },
    ],
  };
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
    /(?:已|已经|本次|这次)[^。！？\n]{0,40}(?:改名|重命名|创建文件夹|新建文件夹|移动文件夹|文件夹[^。！？\n]{0,20}(?:移动|移入|移到))|(?:改名|重命名|创建文件夹)(?:成功|完成|完毕)|(?:改名|重命名)完成|folder rename is complete|(?:renamed|created)\s+(?:the\s+)?folder|\brenamed to\b/i;
  if (
    !sentences.some(
      (s) => claim.test(s) && /文件夹|目录|\bfolder\b|\brenamed to\b/i.test(s),
    )
  )
    return null;
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

// These aliases are not the editor's native code-block type. Expose IDs so
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
