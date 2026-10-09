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

import { normalizeWebExclude, normalizeWebSites, searchWeb, type WebSearchConstraints } from "../services/ai/web-search.js";
import { confirmKnowledgeSubscription, dismissKnowledgeSubscription, listKnowledgeSubscriptions, subscribeKnowledgeSource, updateKnowledgeSourceGroup, deleteKnowledgeSourceGroup, subscriptionKind } from "@core/modules/knowledge/subscriptions.js";
import { createContentSubscription, updateContentSubscription } from "@core/modules/knowledge/content-subscriptions.js";
import { detachKnowledgeSource } from "@core/modules/knowledge/source-access.js";

export function registerKnowledge(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  options: { indexer?: KnowledgeIndexer; storage?: StorageRuntime; notify?: (id:string)=>Promise<void> } = {},
) {
  const content = createContent(db);
  let stopped = false;
  let processing: Promise<void> | null = null;
  const rebuild = async (payload: Record<string, unknown>) => {
    const kind = String(payload.kind ?? "");
    const id = String(payload.id ?? "");
    if (!kind || !id) return;
    await rebuildKnowledge(db, kind, id, options.indexer);
  };
  const drain = async () => {
    if (processing || stopped) return;
    processing = Promise.resolve(processProjections(db, "knowledge", rebuild)).then(() => {})
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

  api.put<{Params:{id:string;groupId:string};Body:{title?:string;sourceIds?:string[];urls?:string[]}}>("/api/v1/knowledge/libraries/:id/source-groups/:groupId",{schema:{params:Type.Object({id:Type.String({format:"uuid"}),groupId:Type.String({format:"uuid"})}),body:Type.Object({title:Type.Optional(Type.String({minLength:1,maxLength:200})),sourceIds:Type.Optional(Type.Array(Type.String({format:"uuid"}),{minItems:1,maxItems:500})),urls:Type.Optional(Type.Array(Type.String({maxLength:500}),{minItems:1,maxItems:500}))})}},async req=>updateKnowledgeSourceGroup(db,auth(req),req.params.id,req.params.groupId,req.body));
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

  const sourceRoot = "/api/v1/knowledge/libraries/:id";
  const sourceParams = Type.Object({id:Type.String({format:"uuid"})},{additionalProperties:false});
  api.post<{Params:{id:string};Body:{sourceId:string;config:Record<string,any>;title:string}}>(`${sourceRoot}/content-subscriptions`,{schema:{params:sourceParams,body:Type.Object({sourceId:Type.String({minLength:1,maxLength:200}),title:Type.String({minLength:1,maxLength:200}),config:Type.Record(Type.String(),Type.Unknown())},{additionalProperties:false})}},req=>createContentSubscription(db,auth(req),req.params.id,req.body));
  api.put<{Params:{id:string;groupId:string};Body:{sourceId:string;config:Record<string,any>;title:string}}>(`${sourceRoot}/content-source-groups/:groupId`,{schema:{params:Type.Object({id:Type.String({format:"uuid"}),groupId:Type.String({format:"uuid"})}),body:Type.Object({sourceId:Type.String({minLength:1,maxLength:200}),title:Type.String({minLength:1,maxLength:200}),config:Type.Record(Type.String(),Type.Unknown())},{additionalProperties:false})}},req=>updateContentSubscription(db,auth(req),req.params.id,req.params.groupId,req.body));
  api.post<{Params:{id:string;subscriptionId:string}}>(`${sourceRoot}/subscriptions/:subscriptionId/detach`,{schema:{params:Type.Object({id:Type.String({format:"uuid"}),subscriptionId:Type.String({format:"uuid"})})}},req=>detachKnowledgeSource(db,auth(req),req.params.id,req.params.subscriptionId));

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
