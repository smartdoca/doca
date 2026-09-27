import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { authorizeFileFolder } from "@core/modules/access/file-access.js";
import {
  maintainKnowledge,
  knowledgeInstructions,
  saveKnowledgeSettings,
  reviewKnowledgeEntry,
} from "@core/modules/knowledge/system.js";
import {
  reconcileHumanTasks,
  closeHumanTask,
} from "@core/modules/knowledge/human-tasks.js";
import {
  createKnowledgeConversation,
  sendKnowledgeMessage,
} from "@core/modules/knowledge/conversations.js";
import { libraryCases,runSourceAction } from "../services/ai/knowledge-studio.js";
import { fail } from "@core/shared/errors.js";
import { transact } from "@db/transactions.js";
export function registerCurationWorkspace(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
) {
  const root = "/api/v1/knowledge/libraries/:id";
  api.get<{ Params: { id: string } }>(`${root}/upload-targets`, async (req) => {
    const actor = auth(req);
    await maintainKnowledge(db, actor, req.params.id);
    const bundle = await knowledgeInstructions(db, actor, req.params.id);
    const sources = await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("library_id", "=", req.params.id)
      .where("source_kind", "=", "folder")
      .where("status", "!=", "detached")
      .execute();
    const items = [];
    for (const source of sources) {
      if (bundle.settings.excludedSourceIds.includes(source.id)) continue;
      try {
        await authorizeFileFolder(db, actor, source.source_id, 3);
        const folder = await db
          .selectFrom("file_folders")
          .select(["id", "name"])
          .where("id", "=", source.source_id)
          .executeTakeFirst();
        if (folder) items.push(folder);
      } catch {}
    }
    return { items };
  });
  api.patch<{ Params: { id: string; source: string } }>(
    `${root}/subscriptions/:source/name`,
    async (req) => {
      await maintainKnowledge(db, auth(req), req.params.id);
      const { name } = z
        .object({ name: z.string().trim().min(1).max(200) })
        .parse(req.body);
      const result = await db
        .updateTable("knowledge_subscriptions")
        .set({ name })
        .where("id", "=", req.params.source)
        .where("library_id", "=", req.params.id)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows)) fail(404, "来源不存在");
      return { ok: true };
    },
  );
  api.get<{ Params: { id: string } }>(`${root}/human-tasks`, async (req) => {
    const items = await reconcileHumanTasks(db, auth(req), req.params.id);
    return {
      items: items.map((task) => ({
        ...task,
        detail: JSON.parse(task.detail),
      })),
    };
  });
  api.get<{ Params: { id: string; task: string } }>(
    `${root}/human-tasks/:task`,
    async (req) => {
      const task = (
        await reconcileHumanTasks(db, auth(req), req.params.id)
      ).find((x) => x.id === req.params.task);
      if (!task) fail(404, "待办已关闭或不存在");
      const detail = JSON.parse(task.detail);
      const entry = detail.entryId
        ? await db
            .selectFrom("knowledge_entries")
            .select(["markdown", "title"])
            .where("id", "=", detail.entryId)
            .where("library_id", "=", req.params.id)
            .executeTakeFirst()
        : undefined;
      return { ...task, detail, entry };
    },
  );
  api.post<{ Params: { id: string; task: string } }>(
    `${root}/human-tasks/:task/resolve`,
    async (req) => {
      const actor = auth(req),
        body = z
          .object({
            revision: z.number().int(),
            action: z.enum(["adopt", "dismiss", "resolve"]),
            reason: z.string().max(4000).default(""),
          })
          .parse(req.body);
      return transact(db, async (tx) => {
        await reconcileHumanTasks(tx, actor, req.params.id);
        const task = await tx
          .selectFrom("knowledge_human_tasks")
          .selectAll()
          .where("id", "=", req.params.task)
          .where("library_id", "=", req.params.id)
          .executeTakeFirst();
        if (!task || task.status !== "open" || task.revision !== body.revision)
          fail(409, "待办已变化，请刷新");
        const detail = JSON.parse(task.detail);
        if (body.action === "adopt") {
          if (!detail.entryId) fail(400, "此待办不支持采用草稿");
          await reviewKnowledgeEntry(
            tx,
            actor,
            req.params.id,
            detail.entryId,
            detail.entryRevision,
            "publish",
          );
        }
        if(body.action==="dismiss" && detail.sourceKey)await runSourceAction(tx,actor,req.params.id,{sourceKey:detail.sourceKey,action:"ignore",reason:body.reason||"human_dismissed"});
        await closeHumanTask(
          tx,
          actor,
          req.params.id,
          task.id,
          body.revision,
          body.reason || body.action,
        );
        await sendKnowledgeMessage(
          tx,
          actor,
          task.conversation_id,
          `人工待办「${task.title}」已处理：${body.action}。${body.reason}`,
          randomUUID(),
        );
        return { ok: true };
      });
    },
  );
  api.get<{ Params: { id: string } }>(
    `${root}/feedback-workspace`,
    async (req) => {
      const actor = auth(req),
        bundle = await knowledgeInstructions(db, actor, req.params.id),
        cases = await libraryCases(db, actor, req.params.id);
      const bots = await db
        .selectFrom("knowledge_assistants")
        .select(["id", "title"])
        .execute();
      return {
        schedule: bundle.settings.feedbackSchedule,
        items: cases.map((item) => ({
          ...item,
          botTitle: bots.find((b) => b.id === item.bot_id)?.title ?? "",
          snapshot: JSON.parse(item.snapshot),
        })),
      };
    },
  );
  api.post<{ Params: { id: string } }>(
    `${root}/feedback-schedule`,
    async (req) => {
      const actor = auth(req),
        { schedule } = z
          .object({ schedule: z.enum(["off", "daily", "weekly"]) })
          .parse(req.body);
      const bundle = await knowledgeInstructions(db, actor, req.params.id);
      return saveKnowledgeSettings(
        db,
        actor,
        req.params.id,
        bundle.settingsRevision,
        { ...bundle.settings, feedbackSchedule: schedule },
      );
    },
  );
  api.post<{ Params: { id: string } }>(`${root}/feedback-run`, async (req) => {
    const actor = auth(req);
    await maintainKnowledge(db, actor, req.params.id);
    const conversation = await createKnowledgeConversation(
      db,
      actor,
      req.params.id,
      "curation",
      `问答反馈 · ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    );
    await sendKnowledgeMessage(
      db,
      actor,
      conversation.id,
      "请读取当前知识库的问答反馈，批量分类根因，修正知识并回归验证。只处理有权查看的案例；需要人工协助时创建待办，继续完成其他工作。",
      randomUUID(),
    );
    return { conversationId: conversation.id };
  });
}
