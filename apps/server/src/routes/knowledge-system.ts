import { registerKnowledgePermissions } from "./knowledge-permissions.js";
import { randomUUID } from "node:crypto";
import { createKnowledgeConversation, sendKnowledgeMessage } from "@core/modules/knowledge/conversations.js";
import { answerKnowledge } from "../services/ai/knowledge-curation.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { authorize } from "@core/modules/access/queries.js";
import { fail } from "@core/shared/errors.js";
import {
  cancelKnowledgeCuration,
  knowledgeRunHistory,
  knowledgeManagementView,
  maintainKnowledgeSource,
  saveKnowledgeInstruction,
  saveKnowledgeSettings,
  knowledgeEntries,
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  knowledgeSourceReviews,
  queueKnowledgeCuration,
  saveKnowledgeAssistant,
  listKnowledgeAssistants,
  visitKnowledgeAssistant,
  saveKnowledgeAssistantConnection,
  searchKnowledgeAssistant,
  detachKnowledgeSource,
  maintainKnowledge,
  effectiveKnowledgeSettings,
  sanitizeKnowledge,
  knowledgeSettingsSchema,
  knowledgeHumanChanges,
  knowledgeOutlineGaps,
  hideRestrictedKnowledgeLinks,
} from "@core/modules/knowledge/system.js";

export function registerKnowledgeSystem(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  notify?: (id:string)=>Promise<void>,
) {
  registerKnowledgePermissions(api, db, auth);
  const root = "/api/v1/knowledge/libraries/:id";
  const params = Type.Object({ id: Type.String({ format: "uuid" }) });
  api.get<{ Params: { id: string } }>(
    `${root}/system`,
    { schema: { params } },
    async (req) => {
      const actor = auth(req),
        id = req.params.id;
      const view = await knowledgeManagementView(db, actor, id);
      const entries = await knowledgeEntries(db, actor, id);
      return {
        ...view,
        entries,
        gaps: knowledgeOutlineGaps(
          view.files.find((file) => file.path === "KNOWLEDGE.md")?.markdown ??
            "",
          entries,
        ),
        humanChanges: await knowledgeHumanChanges(db, actor, id),
        reviews: await knowledgeSourceReviews(db, actor, id),
        runs: await knowledgeRunHistory(db, actor, id),
      };
    },
  );
  api.post<{
    Params: { id: string };
    Body: { path: string; markdown: string; expectedRevision: number };
  }>(
    `${root}/instructions`,
    {
      schema: {
        params,
        body: Type.Object({
          path: Type.String({ maxLength: 160 }),
          markdown: Type.String({ maxLength: 40000 }),
          expectedRevision: Type.Integer({ minimum: 0 }),
        }),
      },
    },
    (req) => saveKnowledgeInstruction(db, auth(req), req.params.id, req.body),
  );
  api.get<{ Params: { id: string }; Querystring: { path: string } }>(
    `${root}/instructions/history`,
    {
      schema: {
        params,
        querystring: Type.Object({ path: Type.String({ maxLength: 160 }) }),
      },
    },
    async (req) => {
      await maintainKnowledge(db, auth(req), req.params.id);
      if (req.query.path.startsWith("sources/"))
        await maintainKnowledgeSource(
          db,
          auth(req),
          req.params.id,
          req.query.path.split("/")[1]!,
        );
      return {
        items: await db
          .selectFrom("knowledge_instructions")
          .selectAll()
          .where("library_id", "=", req.params.id)
          .where("path", "=", req.query.path)
          .orderBy("revision", "desc")
          .limit(50)
          .execute(),
      };
    },
  );
  api.post<{
    Params: { id: string };
    Body: { expectedRevision: number; settings: unknown };
  }>(
    `${root}/settings`,
    {
      schema: {
        params,
        body: Type.Object({
          expectedRevision: Type.Integer({ minimum: 0 }),
          settings: Type.Object(
            {
              sourcePolicies: Type.Optional(
                Type.Record(
                  Type.String(),
                  Type.Object(
                    {
                      redactedTerms: Type.Array(
                        Type.String({ minLength: 1, maxLength: 200 }),
                        { maxItems: 100 },
                      ),
                      redactContacts: Type.Boolean(),
                      linkAccess: Type.Optional(
                        Type.Union([
                          Type.Literal("public"),
                          Type.Literal("follow"),
                          Type.Literal("closed"),
                        ]),
                      ),
                      excludedResourceIds: Type.Array(
                        Type.String({ format: "uuid" }),
                        { maxItems: 200 },
                      ),
                    },
                    { additionalProperties: false },
                  ),
                ),
              ),
              modelId: Type.String({ maxLength: 64 }),
              sourceScope: Type.Optional(Type.Union([Type.Literal("internal"),Type.Literal("web")])),
              automationPolicy: Type.Optional(Type.Union([Type.Literal("safe"),Type.Literal("draft")])),
              publicationMode: Type.Optional(Type.Union([Type.Literal("automatic"),Type.Literal("manual")])),
              maxDocumentDepth: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 8 }),
              ),
              autoPublishWeighted: Type.Optional(Type.Boolean()),
              excludedSourceIds: Type.Array(Type.String({ format: "uuid" }), {
                maxItems: 200,
              }),
              redactedTerms: Type.Array(
                Type.String({ minLength: 1, maxLength: 200 }),
                { maxItems: 100 },
              ),
              redactContacts: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        }),
      },
    },
    (req) =>
      saveKnowledgeSettings(
        db,
        auth(req),
        req.params.id,
        req.body.expectedRevision,
        req.body.settings,
      ),
  );
  api.post<{
    Params: { id: string };
    Body: {
      id?: string;
      title: string;
      markdown: string;
      expectedRevision: number;
    };
  }>(
    `${root}/entries`,
    {
      schema: {
        params,
        body: Type.Object({
          id: Type.Optional(Type.String({ format: "uuid" })),
          path: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
              maxItems: 7,
            }),
          ),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          markdown: Type.String({ minLength: 1, maxLength: 60000 }),
          expectedRevision: Type.Integer({ minimum: 0 }),
        }),
      },
    },
    (req) => saveHumanKnowledge(db, auth(req), req.params.id, req.body),
  );
  api.get<{ Params: { id: string; entryId: string } }>(
    `${root}/entries/:entryId`,
    async (req) => {
      await authorize(db, auth(req), req.params.id, 1);
      const entry = await db
        .selectFrom("knowledge_entries")
        .select([
          "id",
          "title",
          "markdown",
          "origin",
          "revision",
          "source_refs",
        ])
        .where("library_id", "=", req.params.id)
        .where("id", "=", req.params.entryId)
        .where("status", "=", "published")
        .executeTakeFirst();
      if (!entry) fail(404, "知识不存在");
      const row = await db
        .selectFrom("knowledge_settings")
        .select("config")
        .where("library_id", "=", req.params.id)
        .executeTakeFirst();
      const settings = effectiveKnowledgeSettings(
        await hideRestrictedKnowledgeLinks(
          db,
          auth(req),
          req.params.id,
          knowledgeSettingsSchema.parse(row ? JSON.parse(row.config) : {}),
        ),
        JSON.parse(entry.source_refs).map(
          (ref: { subscriptionId: string }) => ref.subscriptionId,
        ),
      );
      const { source_refs, ...visible } = entry;
      return {
        ...visible,
        title: sanitizeKnowledge(entry.title, settings),
        markdown: sanitizeKnowledge(entry.markdown, settings),
      };
    },
  );
  api.post<{
    Params: { id: string; entryId: string };
    Body: { expectedRevision: number; action: "publish" | "keep" | "delete" };
  }>(
    `${root}/entries/:entryId/review`,
    {
      schema: {
        body: Type.Object({
          expectedRevision: Type.Integer({ minimum: 1 }),
          action: Type.Union([
            Type.Literal("publish"),
            Type.Literal("keep"),
            Type.Literal("delete"),
          ]),
        }),
      },
    },
    async (req) => {
      const entry = await reviewKnowledgeEntry(
        db,
        auth(req),
        req.params.id,
        req.params.entryId,
        req.body.expectedRevision,
        req.body.action,
      );
      if(entry.reviewState.nodeId) await notify?.(entry.reviewState.nodeId).catch(()=>{});
      return entry;
    },
  );
  api.post<{ Params: { id: string; subscriptionId: string } }>(
    `${root}/subscriptions/:subscriptionId/detach`,
    (req) =>
      detachKnowledgeSource(
        db,
        auth(req),
        req.params.id,
        req.params.subscriptionId,
      ),
  );
  api.post<{
    Params: { id: string };
    Body: {
      gap?: { title?: string; path?: string[]; detail?: string };
    };
  }>(
    `${root}/curate`,
    { schema: { params } },
    async (req) => {
      const actor=auth(req),gap=req.body?.gap;
      const conversation=await createKnowledgeConversation(db,actor,req.params.id,"curation",gap?.title||"知识整理");
      await sendKnowledgeMessage(db,actor,conversation.id,gap?.title?`补全主题：${gap.title}。${gap.detail||""}`:"检查来源质量与覆盖缺口，整理详细知识文档，保留人工修改，并推荐可靠来源。",randomUUID());
      return {id:conversation.id,conversationId:conversation.id,status:"queued"};
    },
  );
  api.post<{ Params: { id: string; runId: string } }>(
    `${root}/runs/:runId/cancel`,
    (req) =>
      cancelKnowledgeCuration(db, auth(req), req.params.id, req.params.runId),
  );
  api.get<{Querystring:{libraryId?:string}}>("/api/v1/knowledge/assistants", async (req) => ({
    items: await listKnowledgeAssistants(db, auth(req),req.query.libraryId),
  }));
  api.post<{ Params: { id: string }; Body: { accept?: boolean } }>(
    "/api/v1/knowledge/assistants/:id/visit",
    {
      schema: {
        params,
        body: Type.Object({ accept: Type.Optional(Type.Boolean()) }),
      },
    },
    (req) =>
      visitKnowledgeAssistant(db, auth(req), req.params.id, req.body.accept),
  );
  api.put<{
    Params: { id: string };
    Body: {
      integration: "default" | "enabled" | "disabled";
      expectedRevision: number;
    };
  }>(
    "/api/v1/knowledge/assistants/:id/connection",
    {
      schema: {
        params,
        body: Type.Object({
          integration: Type.Union([
            Type.Literal("default"),
            Type.Literal("enabled"),
            Type.Literal("disabled"),
          ]),
          expectedRevision: Type.Integer({ minimum: 0 }),
        }),
      },
    },
    (req) =>
      saveKnowledgeAssistantConnection(
        db,
        auth(req),
        req.params.id,
        req.body.integration,
        req.body.expectedRevision,
      ),
  );
  api.post<{
    Body: {
      id?: string;
      expectedRevision: number;
      title: string;
      libraryIds: string[];
      memberIds: string[];
      managerIds?:string[];
      attachmentsEnabled?:boolean;
      channels?:Array<"web"|"embed"|"api"|"mcp">;
      visibility?: "invited" | "authenticated" | "public";
      enabled: boolean;
    };
  }>(
    "/api/v1/knowledge/assistants",
    {
      schema: {
        body: Type.Object({
          id: Type.Optional(Type.String({ format: "uuid" })),
          expectedRevision: Type.Integer({ minimum: 0 }),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          libraryIds: Type.Array(Type.String({ format: "uuid" }), {
            maxItems: 20,
          }),
          memberIds: Type.Array(Type.String({ format: "uuid" }), {
            maxItems: 200,
          }),
          visibility: Type.Optional(
            Type.Union([
              Type.Literal("invited"),
              Type.Literal("authenticated"),
              Type.Literal("public"),
            ]),
          ),
          managerIds:Type.Optional(Type.Array(Type.String({format:"uuid"}),{maxItems:100})),
          attachmentsEnabled:Type.Optional(Type.Boolean()),
          channels:Type.Optional(Type.Array(Type.Union([Type.Literal("web"),Type.Literal("embed"),Type.Literal("api"),Type.Literal("mcp")]))),
          enabled: Type.Boolean(),
        }),
      },
    },
    (req) => saveKnowledgeAssistant(db, auth(req), req.body),
  );
}
