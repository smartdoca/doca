import type {
  DomainAIContribution,
  JsonObject,
  JsonValue,
  ToolDefinition,
} from "@doca/ai-host";

const mailIntent =
  /(?:邮件|邮箱|收件箱|发信|回信|草稿|mail|email|inbox|reply|compose)/iu;

export interface MailAIToolHost {
  executePluginTool(toolId: string, input: JsonObject): Promise<JsonValue>;
}

const tool = <Context>(
  id: string,
  command: string,
  description: string,
): ToolDefinition<Context> => ({
  id,
  description,
  exposure: ["chat"],
  requiredPermissions: [`mail.${command}`],
  idempotency: command === "search" || command === "read" ? "none" : "call",
  async execute(input, context) {
    const execute = (context.host as Context & Partial<MailAIToolHost>)
      .executePluginTool;
    if (!execute) throw new Error("Mail AI tool adapter is unavailable");
    return execute(`mail_${command}`, input);
  },
});

export function mailAIContribution<Context>(): DomainAIContribution<Context> {
  return {
    namespace: "doca.mail",
    intents: [
      {
        id: "doca.mail.manage",
        description: "搜索、阅读、撰写、回复或发送邮件。",
        priority: 60,
        workflowIds: ["doca.mail.workflow"],
        acceptanceIds: ["doca.mail.acceptance"],
        skillIds: ["doca.mail.skill"],
        evaluate(request) {
          const eligible = mailIntent.test(request.text);
          return {
            eligible,
            confidence: eligible ? 0.94 : 0,
            reason: eligible ? "matched mail vocabulary" : undefined,
          };
        },
      },
    ],
    tools: [
      tool(
        "doca.mail.browse",
        "browse",
        "列出当前用户可见邮箱，或查看某个邮箱的文件夹。",
      ),
      tool(
        "doca.mail.search",
        "search",
        "在可见邮箱中搜索邮件主题、发件人和正文。",
      ),
      tool(
        "doca.mail.read",
        "read",
        "读取一封邮件正文和附件，并可返回打开邮件的地址。",
      ),
      tool(
        "doca.mail.compose",
        "compose",
        "把收件人、主题和正文写入可继续编辑的邮件草稿。",
      ),
      tool(
        "doca.mail.send",
        "send",
        "仅在用户明确要求发送时发送邮件，也可保存服务端草稿。",
      ),
      tool(
        "doca.mail.manage",
        "manage",
        "标记已读或未读、星标、归档或删除邮件。",
      ),
    ],
    workflows: [
      {
        id: "doca.mail.workflow",
        description: "先确认邮箱与收件人，写入草稿；只有明确要求时才发送。",
        run: async (input) => input,
      },
    ],
    acceptance: [
      {
        id: "doca.mail.acceptance",
        description: "发送必须有邮件服务回执，草稿必须可由用户继续编辑。",
        evaluate: async () => ({ verdict: "accepted" }),
      },
    ],
    skills: [
      {
        id: "doca.mail.skill",
        description: "Doca 邮件搜索、草稿与发送规范。",
        activate: () => undefined,
      },
    ],
  };
}
