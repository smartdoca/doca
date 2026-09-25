import { createTranslator } from "@doca/i18n";
import type {
  AIApproval,
  AIProgress,
  AIProgressEvent,
} from "@core/modules/ai/progress.js";
import {
  aiApprovalDetail,
  aiApprovalTitle,
  aiEventLabel,
  aiPhaseLabel,
} from "../apps/web/src/features/ai/ai-progress-label.js";
import { expect, it } from "vitest";

const baseProgress: AIProgress = {
  phase: "using_tool",
  phaseData: { toolName: "web_search" },
  text: "",
  reasoning: "",
  sources: [],
};

it("renders the same stored progress codes in the selected locale", () => {
  const event: AIProgressEvent = {
    id: "event-1",
    at: "2026-09-25T00:00:00.000Z",
    kind: "tool",
    code: "tool_call",
    data: { toolName: "web_search" },
    status: "success",
  };

  expect(aiPhaseLabel(baseProgress, createTranslator("en"))).toBe(
    "Search the web",
  );
  expect(aiPhaseLabel(baseProgress, createTranslator("zh"))).toBe(
    "联网查找资料",
  );
  expect(aiEventLabel(event, createTranslator("en"))).toBe("Search the web");
  expect(aiEventLabel(event, createTranslator("zh"))).toBe("联网查找资料");
});

it("renders approval codes and data without persisted display copy", () => {
  const approval: AIApproval = {
    id: "approval-1",
    action: "create",
    code: "create_file",
    data: { name: "report.pdf", path: "Research" },
    state: "pending",
  };

  expect(aiApprovalTitle(approval, createTranslator("en"))).toBe(
    "Create “report.pdf”",
  );
  expect(aiApprovalDetail(approval, createTranslator("zh"))).toBe(
    "将新文件保存到 Research。",
  );
  expect(approval).not.toHaveProperty("title");
  expect(approval).not.toHaveProperty("detail");
});

it("renders persisted approvals and events from before display codes existed", async () => {
  const mobile = await import("../apps/mobile/src/ai-progress-label.js");
  const web = await import("../apps/web/src/features/ai/ai-progress-label.js");
  const approval = { id: "old", action: "create", state: "approved", title: "创建文档（1 个）", detail: "位置：个人文档" } as unknown as AIApproval;
  const event = { id: "old-event", kind: "tool", text: "创建文档", detail: "已保存", status: "success" } as unknown as AIProgressEvent;
  for (const labels of [web, mobile]) {
    for (const locale of ["zh", "en"] as const) {
      const t = createTranslator(locale);
      expect(labels.aiApprovalTitle(approval, t)).toBe("创建文档（1 个）");
      expect(labels.aiApprovalDetail(approval, t)).toBe("位置：个人文档");
      expect(labels.aiEventLabel(event, t)).toBe("创建文档");
      expect(labels.aiEventDetail(event, t)).toBe("已保存");
    }
  }
  expect(web.aiPhaseLabel({ ...baseProgress, phase: "正在验收" } as unknown as AIProgress, createTranslator("zh"))).toBe("正在验收");
});

it("uses safe labels for missing, future and inherited object keys", async () => {
  const mobile = await import("../apps/mobile/src/ai-progress-label.js");
  const web = await import("../apps/web/src/features/ai/ai-progress-label.js");
  const t = createTranslator("en");
  for (const code of [undefined, "plugin.future", "constructor", "__proto__"]) {
    for (const labels of [web, mobile]) {
      const approval = { code, data: { count: 1 } } as unknown as AIApproval;
      expect(labels.aiApprovalTitle(approval, t)).toBe("Operation approval");
      expect(labels.aiApprovalDetail(approval, t)).toContain("Review the operation");
      expect(labels.aiEventLabel({ kind: "status", code, data: {} } as AIProgressEvent, t)).toBe("Task progress");
    }
  }
});
