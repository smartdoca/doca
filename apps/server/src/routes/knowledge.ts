import { registerKnowledgeStudio } from "./knowledge-studio.js";
import type { AnswerIndex } from "@core/modules/knowledge/publications.js";
import { createScheduledKnowledgeConversation } from "@core/modules/knowledge/conversations.js";
import { randomUUID } from "node:crypto";
import { registerKnowledgeSystem } from "./knowledge-system.js";
import { executeKnowledgeCuration, queueKnowledgeCuration } from "@core/modules/knowledge/system.js";
import { knowledgeGenerator } from "../services/ai/knowledge-curation.js";
import { fetchWebPage } from "../services/ai/web-fetch.js";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import { aiConfig } from "@core/modules/ai/config.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import {
  annotateWebSources,
  enqueueKnowledge,
  enqueueMissingKnowledge,
  hideKnowledgeLink,
  knowledgeGraph,
  rebuildKnowledge,
  recordKnowledgeFeedback,
  searchKnowledgeChunks,
  suggestFolder,
  suggestLibrary,
  type KnowledgeIndexer,
} from "@core/modules/knowledge/service.js";
import { fail } from "@core/shared/errors.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB } from "@db/index.js";
import type { StorageRuntime } from "../adapters/storage.js";
import { waitFileExtract } from "../services/ai/file-extract.js";
import { sweepKnowledgeFeedbackSchedules } from "@core/modules/knowledge/feedback-schedule.js";
import { normalizeWebExclude, normalizeWebSites, searchWeb, type WebSearchConstraints } from "../services/ai/web-search.js";
import { askKnowledgeLibrary, confirmKnowledgeSubscription, dismissKnowledgeSubscription, draftLibraryPresetForActor, draftSourcePresetForActor, getKnowledgeBot, knowledgeSchedule, listKnowledgeSubscriptions, runKnowledgeLibrary, saveKnowledgeBot, saveLibraryGuide, saveLibraryPreset, saveSourcePreset, setKnowledgeSchedule, setLibraryCuration, subscribeKnowledgeSource, updateKnowledgeSourceGroup, deleteKnowledgeSourceGroup, subscriptionKind, sweepKnowledgeSchedules } from "@core/modules/knowledge/subscriptions.js";

export function registerKnowledge(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  options: { indexer?: KnowledgeIndexer; storage?: StorageRuntime; answerIndex?: AnswerIndex; notify?: (id:string)=>Promise<void>; consumeRateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean> } = {},
) {
  registerKnowledgeSystem(api, db, auth, options.notify);
  registerKnowledgeStudio(api, db, auth, options.answerIndex, options.notify, options.consumeRateLimit);
  const content = createContent(db);
  let stopped = false;
  let processing: Promise<void> | null = null;
  let lastSweep = Date.now();
  const rebuild = async (payload: Record<string, unknown>) => {
    const kind = String(payload.kind ?? "");
    const id = String(payload.id ?? "");
    if (!kind || !id) return;
    await rebuildKnowledge(db, kind, id, options.indexer);
  };
  const drain = async () => {
    if (processing || stopped) return;
    processing = Promise.resolve(processProjections(db, "knowledge", rebuild)).then(async () => {
      // Jobs are persisted; stale attempts fail visibly rather than reporting success.
      const stale = await db.selectFrom("knowledge_runs").select(["id", "detail"]).where("status", "=", "running").execute();
      for (const run of stale) {
        const detail = JSON.parse(run.detail);
        if (Date.now() - Date.parse(detail.startedAt || "") > 300_000)
          await db.updateTable("knowledge_runs").set({ status: "failed", detail: JSON.stringify({ ...detail, error: "整理中断，请重新发起" }) }).where("id", "=", run.id).where("status", "=", "running").execute();
      }
      const next = await db.selectFrom("knowledge_runs").select(["id", "detail"]).where("status", "=", "queued").orderBy("created_at").executeTakeFirst();
      if (next && !stopped) {
        const detail = JSON.parse(next.detail);
        await executeKnowledgeCuration(db, next.id, knowledgeGenerator(db, detail.actorId, next.id), async url => {
          const page = await fetchWebPage(url, AbortSignal.timeout(20000));
          if (page.truncated) fail(413, "网页正文过长，请使用具体章节来源");
          return page;
        });
      }
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      await sweepKnowledgeSchedules(db, async (actor, id, occurrenceKey) => {
        return createScheduledKnowledgeConversation(
          db,
          actor,
          id,
          new Date(),
          "sources",
          occurrenceKey,
        );
      });
      await sweepKnowledgeFeedbackSchedules(db);
    })
      .catch(() => {})
      .finally(() => {
        processing = null;
      });
  };
  const timer = setInterval(() => void drain(), 1000);
  timer.unref();
  api.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
    if (processing) await processing;
  });

  api.get<{ Params: { id: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => listKnowledgeSubscriptions(db, auth(req), req.params.id),
  );

  api.post<{ Params: { id: string }; Body: { sourceKind: string; sourceId?: string; url?: string; sourceIds?: string[]; urls?: string[]; title?: string; guide?: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          sourceKind: Type.String({ minLength: 3, maxLength: 16 }),
          title: Type.Optional(Type.String({maxLength:200})),
          guide: Type.Optional(Type.String({maxLength:20000})),
          sourceIds: Type.Optional(Type.Array(Type.String({format:"uuid"}),{minItems:1,maxItems:500})),
          urls: Type.Optional(Type.Array(Type.String({maxLength:500}),{minItems:1,maxItems:500})),
          sourceId: Type.Optional(Type.String({ maxLength: 36 })),
          url: Type.Optional(Type.String({ maxLength: 500 })),
        }),
      },
    },
    async (req) => subscribeKnowledgeSource(db, auth(req), req.params.id, {
      ...req.body,
      sourceKind: subscriptionKind(req.body.sourceKind),
      sourceId: req.body.sourceId,
      url: req.body.url,
    }),
  );

  api.put<{Params:{id:string;groupId:string};Body:{title?:string;guide?:string;sourceIds?:string[];urls?:string[]}}>("/api/v1/knowledge/libraries/:id/source-groups/:groupId",{schema:{params:Type.Object({id:Type.String({format:"uuid"}),groupId:Type.String({format:"uuid"})}),body:Type.Object({guide:Type.Optional(Type.String({maxLength:20000})),title:Type.Optional(Type.String({minLength:1,maxLength:200})),sourceIds:Type.Optional(Type.Array(Type.String({format:"uuid"}),{minItems:1,maxItems:500})),urls:Type.Optional(Type.Array(Type.String({maxLength:500}),{minItems:1,maxItems:500}))})}},async req=>updateKnowledgeSourceGroup(db,auth(req),req.params.id,req.params.groupId,req.body));
  api.delete<{Params:{id:string;groupId:string}}>("/api/v1/knowledge/libraries/:id/source-groups/:groupId",{schema:{params:Type.Object({id:Type.String({format:"uuid"}),groupId:Type.String({format:"uuid"})})}},async req=>deleteKnowledgeSourceGroup(db,auth(req),req.params.id,req.params.groupId));

  api.post<{ Params: { id: string; subscriptionId: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions/:subscriptionId/confirm",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }), subscriptionId: Type.String({ format: "uuid" }) }) } },
    async (req) =>
      confirmKnowledgeSubscription(
        db,
        auth(req),
        req.params.id,
        req.params.subscriptionId,
        (actor, input) => content.create(actor, input),
      ),
  );

  api.post<{ Params: { id: string; subscriptionId: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions/:subscriptionId/dismiss",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }), subscriptionId: Type.String({ format: "uuid" }) }) } },
    async (req) => dismissKnowledgeSubscription(db, auth(req), req.params.id, req.params.subscriptionId),
  );

  api.post<{ Params: { id: string }; Body: { markdown?: string } }>(
    "/api/v1/knowledge/libraries/:id/guide",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({ markdown: Type.Optional(Type.String({ maxLength: 20000 })) }),
      },
    },
    async (req) => saveLibraryGuide(db, auth(req), req.params.id, req.body.markdown ?? ""),
  );

  api.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/v1/knowledge/libraries/:id/curation",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({ enabled: Type.Boolean() }),
      },
    },
    async (req) => setLibraryCuration(db, auth(req), req.params.id, req.body.enabled),
  );

  api.post<{ Params: { id: string }; Body: { mode: string } }>(
    "/api/v1/knowledge/libraries/:id/schedule",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({ mode: Type.Union([Type.Literal("off"), Type.Literal("daily"), Type.Literal("weekly")]) }),
      },
    },
    async (req) => setKnowledgeSchedule(db, auth(req), req.params.id, knowledgeSchedule(req.body.mode)),
  );

  const libraryPresetBody = Type.Object({
    weight: Type.Integer({ minimum: 1, maximum: 10 }),
    frequency: Type.Union([Type.Literal("off"), Type.Literal("daily"), Type.Literal("weekly")]),
    copyText: Type.Boolean(),
    note: Type.String({ maxLength: 20000 }),
  });
  const sourcePresetBody = Type.Object({
    weight: Type.Union([Type.Integer({ minimum: 1, maximum: 10 }), Type.Null()]),
    frequency: Type.Union([Type.Literal("inherit"), Type.Literal("off"), Type.Literal("daily"), Type.Literal("weekly")]),
    copyText: Type.Union([Type.Literal("inherit"), Type.Literal("yes"), Type.Literal("no")]),
    note: Type.String({ maxLength: 20000 }),
  });

  api.post<{ Params: { id: string }; Body: { weight: number; frequency: "off" | "daily" | "weekly"; copyText: boolean; note: string } }>(
    "/api/v1/knowledge/libraries/:id/preset",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }), body: libraryPresetBody } },
    async (req) => saveLibraryPreset(db, auth(req), req.params.id, req.body),
  );

  api.post<{ Params: { id: string } }>(
    "/api/v1/knowledge/libraries/:id/preset/draft",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => draftLibraryPresetForActor(db, auth(req), req.params.id),
  );

  api.post<{ Params: { id: string; subscriptionId: string }; Body: { weight: number | null; frequency: "inherit" | "off" | "daily" | "weekly"; copyText: "inherit" | "yes" | "no"; note: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions/:subscriptionId/preset",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }), subscriptionId: Type.String({ format: "uuid" }) }),
        body: sourcePresetBody,
      },
    },
    async (req) => saveSourcePreset(db, auth(req), req.params.id, req.params.subscriptionId, req.body),
  );

  api.post<{ Params: { id: string; subscriptionId: string } }>(
    "/api/v1/knowledge/libraries/:id/subscriptions/:subscriptionId/preset/draft",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }), subscriptionId: Type.String({ format: "uuid" }) }) } },
    async (req) => draftSourcePresetForActor(db, auth(req), req.params.id, req.params.subscriptionId),
  );

  api.post<{ Params: { id: string } }>(
    "/api/v1/knowledge/libraries/:id/runs",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => runKnowledgeLibrary(db, auth(req), req.params.id, "manual"),
  );

  api.get<{ Params: { id: string } }>(
    "/api/v1/knowledge/libraries/:id/bot",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => getKnowledgeBot(db, auth(req), req.params.id),
  );

  api.post<{ Params: { id: string }; Body: { title?: string; published: boolean } }>(
    "/api/v1/knowledge/libraries/:id/bot",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          title: Type.Optional(Type.String({ maxLength: 200 })),
          published: Type.Boolean(),
        }),
      },
    },
    async (req) => saveKnowledgeBot(db, auth(req), req.params.id, { title: req.body.title ?? "", published: req.body.published }),
  );

  api.post<{ Params: { id: string }; Body: { query: string } }>(
    "/api/v1/knowledge/libraries/:id/ask",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({ query: Type.String({ minLength: 1, maxLength: 300 }) }),
      },
    },
    async (req) => askKnowledgeLibrary(db, auth(req), req.params.id, req.body.query),
  );

  api.get("/api/v1/knowledge/graph", async (req) => {
    if (await enqueueMissingKnowledge(db)) await processProjections(db, "knowledge", rebuild);
    return knowledgeGraph(db, auth(req).id);
  });

  api.post<{ Body: { query: string } }>(
    "/api/v1/knowledge/search",
    { schema: { body: Type.Object({ query: Type.String({ minLength: 1, maxLength: 300 }) }) } },
    async (req) => ({ items: await searchKnowledgeChunks(db, auth(req).id, req.body.query, options.indexer) }),
  );

  api.post<{ Body: { chunkId: string; judgment: "useful" | "irrelevant"; query?: string } }>(
    "/api/v1/knowledge/feedback",
    {
      schema: {
        body: Type.Object({
          chunkId: Type.String({ minLength: 3, maxLength: 80 }),
          judgment: Type.Union([Type.Literal("useful"), Type.Literal("irrelevant")]),
          query: Type.Optional(Type.String({ maxLength: 300 })),
        }),
      },
    },
    async (req) => {
      const ok = await recordKnowledgeFeedback(db, auth(req).id, req.body.chunkId, req.body.judgment, req.body.query ?? "");
      if (!ok) fail(404, "知识片段不存在");
      return { ok: true };
    },
  );

  api.post<{ Body: { kind: "document" | "file"; id: string } }>(
    "/api/v1/knowledge/rebuild",
    {
      schema: {
        body: Type.Object({
          kind: Type.Union([Type.Literal("document"), Type.Literal("file")]),
          id: Type.String({ format: "uuid" }),
        }),
      },
    },
    async (req) => {
      await enqueueKnowledge(db, req.body.kind, req.body.id);
      return rebuildKnowledge(db, req.body.kind, req.body.id, options.indexer);
    },
  );

  api.post<{ Body: { kind: "document" | "file" | "folder" | "library"; id: string } }>(
    "/api/v1/knowledge/related",
    {
      schema: {
        body: Type.Object({
          kind: Type.Union([
            Type.Literal("document"),
            Type.Literal("file"),
            Type.Literal("folder"),
            Type.Literal("library"),
          ]),
          id: Type.String({ format: "uuid" }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      if (req.body.kind === "folder") await suggestFolder(db, actor.id, req.body.id);
      else if (req.body.kind === "library") await suggestLibrary(db, actor.id, req.body.id);
      else await rebuildKnowledge(db, req.body.kind, req.body.id, options.indexer);
      const graph = await knowledgeGraph(db, actor.id);
      return {
        links: graph.links.filter((link) =>
          (link.from_kind === req.body.kind && link.from_id === req.body.id) ||
          (link.to_kind === req.body.kind && link.to_id === req.body.id)),
      };
    },
  );

  api.post<{ Params: { id: string } }>(
    "/api/v1/knowledge/links/:id/hide",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => {
      await hideKnowledgeLink(db, auth(req).id, req.params.id);
      return { ok: true };
    },
  );

  api.post<{ Params: { id: string } }>(
    "/api/v1/knowledge/files/:id/parse",
    { schema: { params: Type.Object({ id: Type.String({ format: "uuid" }) }) } },
    async (req) => {
      const actor = auth(req);
      const item = await db.selectFrom("file_items").select(["id", "storage_object_id", "owner_id"]).where("id", "=", req.params.id).where("deleted_at", "is", null).executeTakeFirst();
      if (!item || item.owner_id !== actor.id) fail(404, "文件不存在");
      const extract = await waitFileExtract(db, item.storage_object_id, options.storage, 30000);
      const rebuilt = await rebuildKnowledge(db, "file", item.id, options.indexer);
      return { status: extract.status, markdown: extract.markdown.slice(0, 500), chunks: rebuilt.chunks };
    },
  );

  api.post<{
    Params: { id: string };
    Body: { query: string; site?: string; exclude?: string; freshness?: "any" | "day" | "week" | "month" | "year"; language?: "any" | "zh" | "en" };
  }>(
    "/api/v1/knowledge/gaps/:id/expand",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          query: Type.String({ minLength: 2, maxLength: 240 }),
          site: Type.Optional(Type.String({ maxLength: 200 })),
          exclude: Type.Optional(Type.String({ maxLength: 120 })),
          freshness: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
          language: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("zh"), Type.Literal("en")])),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const gap = await db.selectFrom("knowledge_gaps").selectAll().where("id", "=", req.params.id).where("user_id", "=", actor.id).executeTakeFirst();
      if (!gap) fail(404, "资料缺口不存在");
      const constraints: WebSearchConstraints = {
        sites: normalizeWebSites(req.body.site),
        exclude: normalizeWebExclude(req.body.exclude),
        ...(req.body.freshness && req.body.freshness !== "any" ? { freshness: req.body.freshness } : {}),
        ...(req.body.language && req.body.language !== "any" ? { language: req.body.language } : {}),
        limit: 8,
      };
      const result = await searchWeb((await aiConfig(db)).webSearch, req.body.query.trim(), undefined, fetch, constraints);
      const sources = annotateWebSources(req.body.query.trim(), result.sources);
      const detail = {
        query: req.body.query.trim(),
        site: req.body.site?.trim() ?? "",
        exclude: req.body.exclude?.trim() ?? "",
        freshness: req.body.freshness ?? "any",
        language: req.body.language ?? "any",
        searched: result.query,
        sources,
      };
      await db.updateTable("knowledge_gaps").set({
        status: "ready",
        detail: JSON.stringify(detail),
      }).where("id", "=", gap.id).execute();
      return detail;
    },
  );

  api.post<{ Params: { id: string }; Body: { documentId: string; urls: string[] } }>(
    "/api/v1/knowledge/gaps/:id/fill",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          documentId: Type.String({ format: "uuid" }),
          urls: Type.Array(Type.String({ minLength: 8, maxLength: 2000 }), { minItems: 1, maxItems: 8 }),
        }),
      },
    },
    async (req) => {
      const actor = auth(req);
      const gap = await db.selectFrom("knowledge_gaps").selectAll().where("id", "=", req.params.id).where("user_id", "=", actor.id).executeTakeFirst();
      if (!gap) fail(404, "资料缺口不存在");
      const detail = gapDetail(gap.detail);
      const allowed = new Set(detail.sources.map((source) => source.url));
      const chosen = [...new Set(req.body.urls)].filter((url) => allowed.has(url));
      if (!chosen.length) fail(400, "请选择至少一条要收录的结果");
      await db.updateTable("knowledge_gaps").set({
        status: "filled",
        detail: JSON.stringify({ documentId: req.body.documentId, urls: chosen }),
      }).where("id", "=", gap.id).execute();
      await enqueueKnowledge(db, "document", req.body.documentId);
      return { ok: true, urls: chosen };
    },
  );
}

function gapDetail(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { sources?: Array<{ url?: string }> };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.flatMap((source) => typeof source.url === "string" ? [{ url: source.url }] : [])
      : [];
    return { sources };
  } catch {
    return { sources: [] as Array<{ url: string }> };
  }
}
