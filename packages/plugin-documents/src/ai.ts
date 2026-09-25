import type { DomainAIContribution } from "@doca/ai-host";

const documentIntent =
  /(?:文档|知识库|表格|画板|幻灯片|演示|markdown|document|knowledge|spreadsheet|canvas|presentation)/iu;

export function documentsAIContribution<Context>(): DomainAIContribution<Context> {
  return {
    namespace: "doca.documents",
    intents: [
      {
        id: "doca.documents.edit",
        description: "读取、创建、编辑、整理文档或知识库内容。",
        priority: 50,
        workflowIds: ["doca.documents.workflow"],
        acceptanceIds: ["doca.documents.acceptance"],
        skillIds: ["doca.documents.skill"],
        evaluate(request) {
          const eligible = documentIntent.test(request.text);
          return {
            eligible,
            confidence: eligible ? 0.9 : 0,
            reason: eligible ? "matched document vocabulary" : undefined,
          };
        },
      },
    ],
    workflows: [
      {
        id: "doca.documents.workflow",
        description: "读取当前文档状态后执行原生格式操作，并保留版本回执。",
        run: async (input) => input,
      },
    ],
    acceptance: [
      {
        id: "doca.documents.acceptance",
        description: "文档写入必须通过权限、版本和协同提交确认。",
        evaluate: async () => ({ verdict: "accepted" }),
      },
    ],
    skills: [
      {
        id: "doca.documents.skill",
        description: "Doca 文档、知识库与编辑器能力规范。",
        activate: () => undefined,
      },
    ],
  };
}
