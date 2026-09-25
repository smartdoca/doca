import type { DomainAIContribution } from "@doca/ai-host";

const fileIntent =
  /(?:文件|文件夹|目录|上传|下载|附件|file|folder|upload|download)/iu;

export function filesAIContribution<Context>(): DomainAIContribution<Context> {
  return {
    namespace: "doca.files",
    intents: [
      {
        id: "doca.files.manage",
        description: "浏览、搜索、上传、下载、移动或整理文件与文件夹。",
        priority: 40,
        workflowIds: ["doca.files.workflow"],
        acceptanceIds: ["doca.files.acceptance"],
        skillIds: ["doca.files.skill"],
        evaluate(request) {
          const eligible = fileIntent.test(request.text);
          return {
            eligible,
            confidence: eligible ? 0.86 : 0,
            reason: eligible ? "matched file-management vocabulary" : undefined,
          };
        },
      },
    ],
    workflows: [
      {
        id: "doca.files.workflow",
        description: "限制文件任务只使用文件能力并保留操作回执。",
        run: async (input) => input,
      },
    ],
    acceptance: [
      {
        id: "doca.files.acceptance",
        description: "文件变更必须返回稳定文件 ID 或明确的只读结果。",
        evaluate: async () => ({ verdict: "accepted" }),
      },
    ],
    skills: [
      {
        id: "doca.files.skill",
        description: "Doca 文件与文件夹操作规范。",
        activate: () => undefined,
      },
    ],
  };
}
