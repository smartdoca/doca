import { expect, it } from "vitest";
import {
  deliveryWorkflow,
  documentDeliveryDeclined,
  EMPTY_JOB_ANSWER,
  folderMutationRequested,
  jobAssistantAnswer,
  missingReviewCriteria,
  fileCopyRequested,
  fileSendRequested,
  secretValueProvided,
  unverifiedSecretDelivery,
  unverifiedDocumentDelivery,
  unverifiedFileDelivery,
  unverifiedFolderDelivery,
  unverifiedImageDelivery,
  spreadsheetImageInsertRequested,
  type DeliveryReview,
} from "../apps/server/src/services/ai/delivery.js";
const report = (verdict: DeliveryReview["verdict"]): DeliveryReview => ({
  verdict,
  summary: "报告缺少方法章节",
  checks: [
    {
      requirement: "方法章节",
      passed: verdict === "pass",
      evidence: "读取原生正文后检查章节",
    },
  ],
});
it("requires evidence for every planned criterion, not a generic pass or duplicate checks", () => {
  const criteria: [string, string, string] = [
    "保留全部原始源码",
    "使用原生代码块",
    "不改变其他章节",
  ];
  const review = report("pass");
  expect(missingReviewCriteria(criteria, review)).toEqual(criteria);
  review.checks = [
    {
      requirement: criteria[0],
      criterionIndex: 0,
      passed: true,
      evidence: "源码逐字一致",
    },
    {
      requirement: criteria[1],
      criterionIndex: 1,
      passed: true,
      evidence: "code-block 且 code 字段完整",
    },
    {
      requirement: criteria[1],
      criterionIndex: 1,
      passed: true,
      evidence: "重复检查不能替代其他标准",
    },
  ];
  expect(missingReviewCriteria(criteria, review)).toEqual([criteria[2]]);
  review.checks.push({
    requirement: criteria[2],
    passed: false,
    evidence: "其他章节发生变动",
  });
  expect(missingReviewCriteria(criteria, review)).toEqual([criteria[2]]);
  review.checks.at(-1)!.passed = true;
  expect(missingReviewCriteria(criteria, review)).toEqual([]);
});
it("rejects image success claims without a real receipt, including blaming the browser", () => {
  for (const text of [
    "图片已生成。您在对话中应该能看到这张图。",
    '我这边工具连续 3 次都返回"生成成功"，但您都看不到，这说明问题出在图片展示链路。',
    "生成接口报告成功，但对话里渲染不出来。",
    "The image has been generated.",
  ])
    expect(unverifiedImageDelivery(text, false)?.verdict).toBe("revise");
  expect(unverifiedImageDelivery("图片已生成", true)).toBeNull();
  for (const text of [
    "没有生成图片，工具未配置。",
    "图片无法生成成功。",
    "我可以帮你生成图片。",
    "The image was not generated.",
    "你好",
  ]) {
    expect(unverifiedImageDelivery(text, false)).toBeNull();
  }
});
it("runs independent acceptance and sends rejected requirements back for repair", async () => {
  const feedback: (DeliveryReview | undefined)[] = [];
  const rounds: number[] = [];
  const workflow = deliveryWorkflow({
    execute: async (r) => {
      feedback.push(r);
    },
    review: async (round) => {
      rounds.push(round);
      return report(round ? "pass" : "revise");
    },
    rejected: () => {
      throw Error("unexpected");
    },
  });
  const result = await (
    await workflow.createRun()
  ).start({ inputData: { round: 0, done: false } });
  expect(result.status).toBe("success");
  expect(rounds).toEqual([0, 1]);
  expect(feedback[1]?.summary).toBe("报告缺少方法章节");
});
it("stops for clarification and does not count silence as approval", async () => {
  let executions = 0;
  const workflow = deliveryWorkflow({
    execute: async () => {
      executions++;
    },
    review: async () => report("needs_user"),
    rejected: () => {
      throw Error("unexpected");
    },
  });
  expect(
    (
      await (
        await workflow.createRun()
      ).start({ inputData: { round: 0, done: false } })
    ).status,
  ).toBe("success");
  expect(executions).toBe(1);
});
it("bounds repair attempts and never marks an unaccepted artifact complete", async () => {
  let executions = 0,
    rejected = false;
  const workflow = deliveryWorkflow({
    execute: async () => {
      executions++;
    },
    review: async () => report("revise"),
    rejected: () => {
      rejected = true;
      throw Error("未通过验收");
    },
  });
  expect(
    (
      await (
        await workflow.createRun()
      ).start({ inputData: { round: 0, done: false } })
    ).status,
  ).toBe("failed");
  expect(executions).toBe(3);
  expect(rejected).toBe(true);
});

it("rejects document repair claims without saved operations and identifies unsupported code blocks", async () => {
  const { unverifiedDocumentDelivery, invalidCodeBlocks } =
    await import("../apps/server/src/services/ai/delivery.js");
  for (const text of [
    "这次已按文档原生代码块格式修复并确认保存成功。",
    "第八部分代码块：已改为与文档原生代码块一致的格式。",
    "文档修改成功。",
    "I have updated the document.",
  ])
    expect(unverifiedDocumentDelivery(text, false)?.verdict).toBe("revise");
  for (const text of [
    "文档尚未保存，工具调用失败。",
    "我可以帮你修改文档。",
    "文档中包含三个章节。",
    "The document was not updated.",
  ])
    expect(unverifiedDocumentDelivery(text, false)).toBeNull();
  expect(unverifiedDocumentDelivery("文档修改成功。", true)).toBeNull();
  expect(
    unverifiedDocumentDelivery(
      [
        "建「猫猫」子文件夹并移入",
        '4 folderId × 3 parentType × 2 源文件组穷尽测试，全部"文件夹不存在"；"系统已修复"后重试错误一致',
        "文件系统操作已超出工具能力边界，请在文件面板新建文件夹。",
      ].join("\n"),
      false,
    ),
  ).toBeNull();
  expect(
    invalidCodeBlocks([
      { id: "wrong", type: "codeBlock", children: [{ text: "package main" }] },
      {
        id: "ok",
        type: "code-block",
        code: "package main",
        children: [{ text: "" }],
      },
    ]),
  ).toEqual(["wrong"]);
});

it("only treats same-sentence document persistence claims as delivery, and honors user declines", () => {
  for (const text of [
    "已按你的要求改成纯文字，内容如下：\n需要存档的话我可以帮你保存成文档。",
    "已转成文字：明天上午十点产品评审。文档我就不创建了。",
    "已将随手记内容整理如下，未保存到任何文档。",
    "好的，本次不再创建文档，已将内容转为文字如下。",
    "已帮你改成纯文字，文档就不用创建了。",
  ])
    expect(unverifiedDocumentDelivery(text, false)).toBeNull();
  for (const text of [
    "已将内容保存到文档。",
    "这次已按文档原生代码块格式修复并确认保存成功。",
  ])
    expect(unverifiedDocumentDelivery(text, false)?.verdict).toBe("revise");
  expect(documentDeliveryDeclined(["把这条随手记转成文字发我"])).toBe(false);
  expect(documentDeliveryDeclined(["把随手记内容发我，不需要文档"])).toBe(true);
  expect(documentDeliveryDeclined(["谢谢", "不用创建文档，直接发我"])).toBe(
    true,
  );
  expect(documentDeliveryDeclined(["还是保存成文档吧", "不需要文档"])).toBe(
    false,
  );
  expect(documentDeliveryDeclined(["把这条随手记创建成文档保存下来"])).toBe(
    false,
  );
});

it("rejects folder rename claims without a folder tool receipt", () => {
  expect(
    folderMutationRequested(
      "把「猫猫」文件夹改成什么名字？也可以自定义输入\n我的选择：可爱猫猫",
    ),
  ).toBe(true);
  expect(folderMutationRequested("帮我把猫猫文件夹改名")).toBe(true);
  expect(folderMutationRequested("看看猫猫文件夹里有什么")).toBe(false);
  expect(folderMutationRequested("改成无敌猫猫吧")).toBe(false);
  expect(
    folderMutationRequested("改成无敌猫猫吧", [
      "把「猫猫」文件夹改成什么名字？也可以自定义输入",
    ]),
  ).toBe(true);
  expect(folderMutationRequested("改成中文吧", ["把这段翻译一下"])).toBe(false);
  expect(
    unverifiedFolderDelivery(
      "我的文件夹 / 可爱猫猫（原「猫猫」文件夹，改名成功）",
      false,
    )?.verdict,
  ).toBe("revise");
  expect(
    unverifiedFolderDelivery("folder rename is complete", false)?.verdict,
  ).toBe("revise");
  expect(
    unverifiedFolderDelivery(
      "The folder is currently 超级猫猫\nRename with version=3.Renamed to 无敌猫猫 (version 3).",
      false,
    )?.verdict,
  ).toBe("revise");
  expect(
    unverifiedFolderDelivery("还没有改名，请问要改成什么名字？", false),
  ).toBeNull();
  expect(
    unverifiedFolderDelivery("原「猫猫」文件夹，改名成功", true),
  ).toBeNull();
  expect(
    unverifiedFolderDelivery(
      "The user wants to rename the folder again to 无敌猫猫",
      false,
    ),
  ).toBeNull();
  expect(
    jobAssistantAnswer({
      text: EMPTY_JOB_ANSWER,
      eventTexts: [EMPTY_JOB_ANSWER],
      folderMutationPending: true,
    }),
  ).toBe("文件夹尚未改动。请实际调用改名工具，成功后会展示文件夹卡片。");
  expect(
    jobAssistantAnswer({
      text: EMPTY_JOB_ANSWER,
      eventTexts: [],
      folderName: "无敌猫猫",
    }),
  ).toBe("已更新文件夹「无敌猫猫」。");
});

it("finds an existing file instead of copying it, and requires a card", () => {
  const ask = "需要武汉大学品牌声誉深度分析报告.pdf（2 份相同副本）";
  expect(fileCopyRequested(ask)).toBe(false);
  expect(fileSendRequested(ask)).toBe(true);
  expect(fileCopyRequested("把这个 pdf 复制到我的文件夹")).toBe(true);
  expect(fileSendRequested("把这个文件再发给我一下")).toBe(true);
  expect(fileSendRequested("你要把这个文件卡片发给我")).toBe(true);
  expect(fileSendRequested("帮我写一份 pdf 报告")).toBe(false);
  expect(
    unverifiedFileDelivery(
      "把这个文件再发给我一下",
      "已为您找到《武汉大学品牌声誉深度分析报告.pdf》，文件位于您的「我的文件夹」中。",
      false,
    )?.verdict,
  ).toBe("revise");
  expect(
    unverifiedFileDelivery(
      "你要把这个文件卡片发给我",
      "您可以点击下方卡片访问该文件：[武汉大学品牌声誉深度分析报告.pdf](#/files?path=我的文件夹)",
      false,
    )?.verdict,
  ).toBe("revise");
  expect(unverifiedFileDelivery(ask, "已找到该文件。", true)).toBeNull();
  expect(
    unverifiedFileDelivery(
      "把这个文件再发给我一下",
      "没有找到这个文件。",
      false,
    ),
  ).toBeNull();
});

it("requires a password-book write when the user supplies a secret", () => {
  const given = "GitHub 密钥：ghp_exampletokenvalue1234";
  expect(secretValueProvided(given)).toBe(true);
  expect(secretValueProvided("帮我写一篇密钥管理说明")).toBe(false);
  expect(secretValueProvided("密钥：abc，不要保存")).toBe(false);
  expect(unverifiedSecretDelivery(given, 0)?.verdict).toBe("revise");
  expect(unverifiedSecretDelivery(given, 1)).toBeNull();
});

it("does not treat research questions as folder-create requests", () => {
  expect(folderMutationRequested("调研一下竞品方案怎么做")).toBe(false);
  expect(folderMutationRequested("成熟做法是如何创建文件夹的")).toBe(false);
  expect(folderMutationRequested("帮我创建一个文件夹叫调研资料")).toBe(true);
  expect(unverifiedFolderDelivery("创建文件夹并完成调研", false)).toBeNull();
  expect(
    unverifiedFolderDelivery("思考：将创建文件夹一张审批", false),
  ).toBeNull();
});

it("does not treat spreadsheet image insert as finished without image_insert", () => {
  expect(spreadsheetImageInsertRequested("把这三张图插入表格")).toBe(true);
  expect(spreadsheetImageInsertRequested("在 excel 里贴图片")).toBe(true);
  expect(spreadsheetImageInsertRequested("改成无敌猫猫吧")).toBe(false);
  expect(
    jobAssistantAnswer({
      text: EMPTY_JOB_ANSWER,
      eventTexts: [EMPTY_JOB_ANSWER],
      imageInsertPending: true,
    }),
  ).toBe(
    "图片尚未写入表格。请调用 image_insert，必须传 assetId、resourceId、sheetId、row、column。",
  );
});

it("keeps contradictory acceptance checks unresolved", () => {
  const review = report("pass");
  review.checks.push({
    ...review.checks[0]!,
    passed: false,
    evidence: "缺少方法章节",
  });
  expect(missingReviewCriteria(["方法章节"], review)).toEqual(["方法章节"]);
});

it.each([
  ["不用创建文档，还是保存成文档吧", false],
  ["保存成文档吧，不用创建文档了", true],
])("honors the latest decision within a user turn: %s", (text, declined) => {
  expect(documentDeliveryDeclined([text])).toBe(declined);
});

it.each([
  "把这个文件复制到资料文件夹",
  "把这个文件移动到资料文件夹",
  "把这个文件改名为报告.pdf",
])("does not confuse file mutation with sending: %s", (text) => {
  expect(fileSendRequested(text)).toBe(false);
});

it.each(["已将文档改名为季度报告。", "已将幻灯片标题重命名为项目进展。"])(
  "does not demand a folder receipt for document edits: %s",
  (text) => {
    expect(unverifiedFolderDelivery(text, false)).toBeNull();
  },
);

it("requires a receipt for a claimed folder move", () => {
  expect(
    unverifiedFolderDelivery("已移动文件夹到归档目录。", false)?.verdict,
  ).toBe("revise");
});

it("distinguishes moving a file into a folder from moving the folder", () => {
  expect(
    unverifiedFolderDelivery("已将报告.pdf移入文件夹。", false),
  ).toBeNull();
  expect(
    unverifiedFolderDelivery("已把资料文件夹移到归档目录。", false)?.verdict,
  ).toBe("revise");
});
