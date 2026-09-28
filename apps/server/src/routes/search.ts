import type { AnswerIndex } from "@core/modules/knowledge/publications.js";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createSearchHost } from "@smartdoca/search-host";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB } from "@db/index.js";
import { transact } from "@db/transactions.js";
import {
  embeddingFailureNotice,
  safeEmbeddingError,
  registerSearchEmbeddings,
} from "./search-embeddings.js";
import { searchSummaries } from "../services/search/search-summary.js";
import {
  createSearchReconciler,
  resetSearchReconciliation,
} from "@core/modules/discovery/search-reconciliation.js";
import {
  constrainedDocumentIds,
  searchIntent,
} from "@core/modules/discovery/search-intent.js";
import { topicMatchTerms } from "@core/modules/discovery/search-excerpts.js";
import { releaseDocumentFileIfUnused } from "@core/modules/documents/live-media.js";
import {
  createBuiltinSearchSources,
  documentProjectionForId,
  documentSearchSource,
  fileItemDocumentId,
  fileObjectDocumentId,
  fileProjectionsForObject,
  fileSearchSource,
  knowledgeSearchSource,
  type SearchQueryContext,
} from "../services/search/sources.js";
import {
  MeilisearchSearchProvider,
  SearchRequestError,
} from "../services/search/meilisearch-provider.js";

type Config = { enabled: number; endpoint: string; index_name: string };
export interface SearchRuntime {
  allowedOrigins: string[];
  apiKey?: string;
  fetch?: typeof fetch;
  sources?: {
    documents?: boolean;
    files?: boolean;
    knowledge?: boolean;
  };
}
export async function registerSearch(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  runtime: SearchRuntime = {
    allowedOrigins: (
      process.env.MEILI_ALLOWED_ORIGINS ??
      "http://127.0.0.1:7700,http://localhost:7700"
    ).split(","),
    apiKey: process.env.MEILI_API_KEY,
  },
) {
  let indexing = false,
    lastError = "",
    lastIndexedAt: string | null = null;
  let stopping = false;
  const content = createContent(db);
  const config = () =>
    db
      .selectFrom("search_settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  function validate(c: Config) {
    let url: URL;
    try {
      url = new URL(c.endpoint);
    } catch {
      fail(400, "搜索服务地址无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !runtime.allowedOrigins.includes(url.origin)
    )
      fail(400, "地址需列入“服务凭据”的搜索允许来源，且不能包含路径或凭据");
    return url.origin;
  }
  async function request(
    c: Config,
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 10000,
  ) {
    const res = await (runtime.fetch ?? fetch)(validate(c) + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(runtime.apiKey
          ? { Authorization: `Bearer ${runtime.apiKey}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: string };
        detail = String(parsed.message || parsed.code || text);
      } catch {
        /* Keep the raw body when Meilisearch does not return JSON. */
      }
      throw new SearchRequestError(
        res.status,
        safeEmbeddingError(detail).slice(0, 300),
      );
    }
    return res.json();
  }
  async function waitTask(c: Config, task: any) {
    // Embedding batches can spend more than 30s in Meilisearch. A short
    // timeout causes the same document job to submit another task while the
    // original task is still running, creating an unbounded task queue.
    const deadline = Date.now() + 300000;
    let lastBatchCheck = 0;
    for (;;) {
      if (Date.now() >= deadline)
        throw new Error(`索引任务超时，请稍后重试（任务 ${task.taskUid}）`);
      if (stopping) throw new Error("服务正在停止");
      const result = await request(c, `/tasks/${task.taskUid}`);
      if (result.status === "succeeded") return;
      if (result.status === "failed" || result.status === "canceled") {
        const reason =
          result.error?.message ||
          result.error?.code ||
          result.error?.link ||
          "未提供具体原因";
        throw new Error(
          `搜索索引任务${result.status === "canceled" ? "已取消" : "失败"}：${reason}`,
        );
      }
      // Meilisearch may expose the useful embedding failure on the batch
      // while the individual document task is still marked as processing.
      if (result.batchUid != null && Date.now() - lastBatchCheck >= 1000) {
        lastBatchCheck = Date.now();
        try {
          const batch = await request(c, `/batches/${result.batchUid}`);
          const reason = batch.stats?.embedderRequests?.lastError;
          if (typeof reason === "string" && reason.trim())
            throw new Error(`搜索索引任务失败：${reason.trim()}`);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("搜索索引任务失败：")
          )
            throw error;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  async function latestEmbeddingError(c: Config) {
    try {
      const batches = await request(
        c,
        "/batches?limit=20",
        "GET",
        undefined,
        2000,
      );
      const message = batches.results
        ?.map((batch: any) => batch.stats?.embedderRequests?.lastError)
        .find((value: unknown): value is string => !!value);
      return message
        ? `${embeddingFailureNotice(message)} 详情：${safeEmbeddingError(message)}`
        : null;
    } catch {
      return null;
    }
  }
  let job: Promise<void> | null = null;
  function reindex(_c: Config) {
    if (indexing) return job!;
    indexing = true;
    lastError = "";
    job = (async () => {
      const failures: unknown[] = [];
      let rebuilt = 0;
      for (const source of searchHost.registry.list()) {
        if (stopping) break;
        try {
          await searchHost.rebuild({
            source: source.descriptor,
            context: { kind: "system" },
          });
          rebuilt++;
        } catch (error) {
          failures.push(error);
        }
      }
      if (rebuilt) {
        lastIndexedAt = new Date().toISOString();
        await reconciler.schedule();
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `${failures.length} 个搜索来源重建失败`,
        );
    })()
      .catch((e) => {
        lastError = (e as Error).message;
      })
      .finally(() => {
        indexing = false;
        job = null;
      });
    return job;
  }
  const embeddings = await registerSearchEmbeddings(api, db, admin, {
    request,
    indexing: () => indexing,
  });
  const provider = new MeilisearchSearchProvider({
    config,
    request,
    waitTask,
    queryEmbedder: embeddings.queryEmbedder,
    replicaEmbedders: embeddings.replicaEmbedders,
  });
  const searchHost = createSearchHost<SearchQueryContext>(provider);
  const registerSource = (
    source: Parameters<typeof searchHost.registry.register>[0],
  ) => {
    const registration = searchHost.registry.register(source);
    provider.bindAlias(
      searchHost.indexNames(source.descriptor).alias,
      source.descriptor,
      {
        useConfiguredIndex:
          source.descriptor.pluginId === documentSearchSource.pluginId &&
          source.descriptor.sourceId === documentSearchSource.sourceId,
      },
    );
    return registration;
  };
  for (const source of createBuiltinSearchSources(db, runtime.sources)) {
    registerSource(source);
  }
  const reconciler = createSearchReconciler(db, {
    list: (_config, offset, limit) =>
      provider.listDocuments(
        searchHost.indexNames(documentSearchSource).alias,
        offset,
        limit,
      ),
  });
  api.put<{ Body: { minScore: number } }>(
    "/api/v1/admin/search/relevance",
    {
      schema: {
        body: Type.Object(
          { minScore: Type.Number({ minimum: 0, maximum: 1 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = admin(req);
      await transact(db, async (tx) => {
        await tx
          .updateTable("search_settings")
          .set({ ai_min_score: req.body.minScore })
          .where("id", "=", "system")
          .execute();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: actor.id,
            resource_id: null,
            action: "search.relevance_updated",
            created_at: new Date().toISOString(),
          })
          .execute();
      });
      return { minScore: req.body.minScore };
    },
  );
  api.get("/api/v1/admin/search", async (req) => {
    admin(req);
    const c = await config();
    let embedding = {
      status: "idle",
      taskUid: null as number | null,
      name: "",
      notice: "",
      remoteStatus: null as string | null,
      error: null as string | null,
      batchUid: null as number | null,
    };
    try {
      embedding = await embeddings.refreshStatus();
    } catch (error) {
      embedding = {
        ...embedding,
        status: "unknown",
        notice: "暂时无法读取 Meilisearch，已显示本地保存的配置。",
        remoteStatus: "unreachable",
        error: error instanceof Error ? error.message : "Meilisearch 不可达",
      };
    }
    // A failed embedding batch is historical once the current configuration
    // task succeeds. Do not let that old batch keep the whole index card red.
    const syncDiagnostic =
      c.enabled && embedding.status !== "succeeded"
        ? await latestEmbeddingError(c)
        : null;
    return {
      ...c,
      enabled: !!c.enabled,
      image_recognition_enabled: !!c.image_recognition_enabled,
      imageRecognitionAvailable: false,
      reconciliation: await reconciler.status(),
      embedding,
      syncDiagnostic,
      credentialConfigured: !!runtime.apiKey,
      indexing,
      lastError,
      lastIndexedAt,
      allowedOrigins: runtime.allowedOrigins,
    };
  });
  api.put<{
    Body: {
      enabled: boolean;
      endpoint: string;
      indexName: string;
      imageRecognitionEnabled: boolean;
      reconcileIntervalHours: number;
    };
  }>(
    "/api/v1/admin/search",
    {
      schema: {
        summary: "配置文档搜索引擎",
        body: Type.Object(
          {
            enabled: Type.Boolean(),
            endpoint: Type.String({ maxLength: 500 }),
            indexName: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
            imageRecognitionEnabled: Type.Boolean(),
            reconcileIntervalHours: Type.Integer({ minimum: 1, maximum: 168 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const actor = admin(req);
      const before = await config();
      const connectionChanged =
        before.endpoint !== req.body.endpoint ||
        before.index_name !== req.body.indexName;
      if (
        indexing &&
        (connectionChanged || !!before.enabled !== req.body.enabled)
      )
        fail(409, "正在建立索引，请稍后修改连接或启用状态");
      const c = {
        enabled: Number(req.body.enabled),
        endpoint: req.body.endpoint,
        index_name: req.body.indexName,
      };
      validate(c);
      if (c.enabled && (connectionChanged || !before.enabled))
        await request(c, "/health");
      if (connectionChanged || !!before.enabled !== req.body.enabled)
        await embeddings.refreshStatus();
      const rebuild = await transact(db, async (tx) => {
        const previous = await tx
          .selectFrom("search_settings")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
        const targetChanged =
          previous.endpoint !== c.endpoint ||
          previous.index_name !== c.index_name;
        const lifecycleChanged =
          targetChanged || previous.enabled !== c.enabled;
        if (lifecycleChanged) await embeddings.assertIdle(tx);
        const imageEnabled = Number(req.body.imageRecognitionEnabled);
        const generation = previous.generation + Number(lifecycleChanged);
        await tx
          .updateTable("search_settings")
          .set({
            ...c,
            generation,
            updated_at: new Date().toISOString(),
            image_recognition_enabled: imageEnabled,
            image_policy_version:
              previous.image_policy_version +
              Number(imageEnabled !== previous.image_recognition_enabled),
            reconcile_interval_hours: req.body.reconcileIntervalHours,
          })
          .where("id", "=", "system")
          .execute();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: actor.id,
            resource_id: null,
            action:
              imageEnabled !== previous.image_recognition_enabled
                ? `search.image_recognition_${imageEnabled ? "enabled" : "disabled"}`
                : "search.settings_updated",
            created_at: new Date().toISOString(),
          })
          .execute();
        if (lifecycleChanged) await resetSearchReconciliation(tx, generation);
        else if (
          req.body.reconcileIntervalHours !== previous.reconcile_interval_hours
        )
          await tx
            .updateTable("search_reconciliation")
            .set({ next_at: new Date().toISOString() })
            .where("id", "=", "system")
            .execute();
        return c.enabled && (targetChanged || !previous.enabled);
      });
      if (rebuild) void reindex(c);
      return { ok: true };
    },
  );
  api.post("/api/v1/admin/search/reconcile", async (req) => {
    admin(req);
    if (!(await config()).enabled) fail(409, "请先启用 Meilisearch");
    await reconciler.schedule();
    return { accepted: true };
  });
  api.post("/api/v1/admin/search/reindex", async (req) => {
    admin(req);
    const c = await config();
    if (!c.enabled) fail(409, "请先启用 Meilisearch");
    void reindex(c);
    return { accepted: true };
  });
  let processing: Promise<void> | null = null;
  const drain = async () => {
    if (processing || stopping) return;
    processing = (async () => {
      await publishIntegrationEvents(db);
      const c = await config();
      if (!c.enabled || indexing) return;
      await reconciler.tick(c);
      await processProjections(db, "search", async (payload) => {
        const id = String(payload.resourceId);
        const repair = await reconciler.repairToken(id);
        const projection = await documentProjectionForId(db, id);
        if (projection)
          await searchHost.upsertProjections({
            source: documentSearchSource,
            projections: [projection],
          });
        else
          await searchHost.deleteProjections({
            source: documentSearchSource,
            documentIds: [id],
          });
        await reconciler.completeRepair(c, id, repair);
        lastIndexedAt = new Date().toISOString();
      });
      await processProjections(db, "search-file", async (payload) => {
        const id = String(payload.fileId);
        const row = await db
          .selectFrom("file_items as f")
          .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
          .select(["f.id", "f.storage_object_id", "o.ai_description"])
          .where("f.id", "=", id)
          .executeTakeFirst();
        const deleted = [fileItemDocumentId(id)];
        if (row) {
          deleted.push(fileObjectDocumentId(row.storage_object_id));
          const projections = await fileProjectionsForObject(
            db,
            row.storage_object_id,
          );
          await searchHost.deleteProjections({
            source: fileSearchSource,
            documentIds: deleted,
          });
          if (projections.length)
            await searchHost.upsertProjections({
              source: fileSearchSource,
              projections,
            });
        } else {
          await searchHost.deleteProjections({
            source: fileSearchSource,
            documentIds: deleted,
          });
        }
        lastIndexedAt = new Date().toISOString();
      });
    })()
      .catch(() => {})
      .finally(() => {
        processing = null;
      });
    await processing;
  };
  const timer = setInterval(() => {
    void drain();
  }, 1000);
  timer.unref();
  api.addHook("preClose", async () => {
    stopping = true;
    clearInterval(timer);
    if (job) await job;
    if (processing) await processing;
    await searchHost.dispose();
  });
  async function documentIdsForFileTopic(
    actor: Actor,
    intent: ReturnType<typeof searchIntent>,
    query: Parameters<typeof content.list>[1],
  ) {
    const terms = topicMatchTerms(intent.topic).filter(
      (term) => term.length >= 2,
    );
    if (!terms.length) return [] as string[];
    let rowsQuery = db
      .selectFrom("file_items as f")
      .innerJoin("file_storage_objects as o", "o.id", "f.storage_object_id")
      .select(["f.id", "f.parent_id"])
      .where("f.deleted_at", "is", null)
      .where("f.parent_type", "=", "document")
      .where((eb) =>
        eb.or(
          terms.flatMap((term) => {
            const pattern = "%" + term.replace(/[%_]/g, "\\$&") + "%";
            return [
              eb("f.name", "like", pattern),
              eb("f.ai_description_override", "like", pattern),
              eb("o.ai_description", "like", pattern),
            ];
          }),
        ),
      );
    if (intent.media === "image")
      rowsQuery = rowsQuery.where("f.mime", "like", "image/%");
    const rows = await rowsQuery.limit(200).execute();
    const mediaCache = new Map<
      string,
      Promise<{ ids: Set<string> | null; updatedAt: string }>
    >();
    const ids: string[] = [];
    for (const row of rows)
      if (await releaseDocumentFileIfUnused(db, row.id, mediaCache))
        ids.push(row.parent_id);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return [];
    const page = await content.list(actor, {
      ...query,
      q: undefined,
      cursor: undefined,
      kind: "document",
      matchedIds: uniqueIds,
    });
    return page.items.map((item) => item.id);
  }
  const knowledgeIndex = {
    async replace(
      removed: string[],
      docs: Array<{
        id: string;
        title: string;
        text: string;
        readerIds: string[];
      }>,
    ) {
      const c = await config();
      if (!c.enabled) return;
      try {
        if (removed.length)
          await searchHost.deleteProjections({
            source: knowledgeSearchSource,
            documentIds: removed,
          });
        if (docs.length)
          await searchHost.upsertProjections({
            source: knowledgeSearchSource,
            projections: docs.map((doc) => ({
              id: doc.id,
              text: doc.text,
              metadata: {
                title: doc.title,
                reader_ids: doc.readerIds,
              },
            })),
          });
      } catch {}
    },
    async search(tokens: string[], query: string) {
      const c = await config();
      if (!c.enabled || !query.trim() || !tokens.length) return null;
      try {
        const result = await searchHost.query<string>({
          query,
          context: { kind: "knowledge", tokens },
          sources: [knowledgeSearchSource],
          limit: 20,
        });
        if (result.failures.length) return null;
        return result.items
          .filter((item) => item.id.startsWith("kc_"))
          .map((item) => ({ id: item.id, score: item.score }));
      } catch {
        return null;
      }
    },
  };
  const answerIndex: AnswerIndex = {
    async mode() {
      return (await config()).enabled && (await embeddings.queryEmbedder())
        ? "hybrid"
        : "keyword";
    },
    async prepare(chunks) {
      if (!(await config()).enabled) return;
      const descriptor = {
        pluginId: "doca.knowledge",
        sourceId: "answers",
        schemaVersion: 1,
        renderer: { kind: "knowledge", version: 1 },
      };
      await provider.createIndex("knowledge_answers", descriptor);
      await provider.upsertProjections(
        "knowledge_answers",
        chunks.map((chunk) => ({
          id: chunk.id,
          text: chunk.text,
          metadata: { title: `${chunk.title} — ${chunk.heading}` },
        })),
      );
    },
    async search(ids, query) {
      if (!(await config()).enabled) return null;
      const hits = await provider.queryIndex("knowledge_answers", {
        query,
        candidateIds: ids,
        semantic: true,
        limit: 16,
      });
      return [...hits];
    },
  };
  return {
    answerIndex,
    searchHost,
    registerSource,
    knowledgeIndex,
    async searchFiles(
      query: string,
      fileIds: string[],
      mode: "keyword" | "ai",
    ) {
      const c = await config();
      if (!c.enabled || indexing || !query.trim() || !fileIds.length)
        return null;
      try {
        const embedder =
          mode === "ai" ? await embeddings.queryEmbedder() : undefined;
        const intent = searchIntent(query);
        const retrievalQuery = intent.topic || query;
        const mappings = await db
          .selectFrom("file_items")
          .select(["id", "storage_object_id"])
          .where("id", "in", fileIds)
          .where("deleted_at", "is", null)
          .execute();
        if (!mappings.length) return null;
        const fileThreshold = Math.min(c.ai_min_score, 0.45);
        const result = await searchHost.query<{
          fileIds: string[];
          objectId: string;
        }>({
          query: retrievalQuery,
          context: {
            kind: "files",
            allowedFileIds: fileIds,
            mappings,
            retrievalQuery,
            semantic: !!embedder,
            minScore: fileThreshold,
          },
          sources: [fileSearchSource],
          limit: mappings.length * 2,
        });
        if (result.failures.length) return null;
        const orderedItems: string[] = [];
        const seenObjects = new Set<string>();
        for (const item of result.items) {
          if (seenObjects.has(item.value.objectId)) continue;
          seenObjects.add(item.value.objectId);
          orderedItems.push(...item.value.fileIds);
        }
        return orderedItems.length ? orderedItems : null;
      } catch {
        return null;
      }
    },
    async search(
      actor: Actor,
      query: Parameters<typeof content.list>[1] & {
        mode?: "keyword" | "ai" | "auto";
        offset?: number;
      },
    ) {
      if (query.scope === "discover" || query.scope === "collected")
        return {
          ...(await content.list(actor, query)),
          engine: "database" as const,
          mode: "keyword",
        };
      const c = await config();
      const intent = searchIntent(query.q ?? "");
      const inferredFormat =
        intent.format && !/插入(?:一?个)?表格/u.test(query.q ?? "")
          ? intent.format
          : undefined;
      const scoped = {
        ...query,
        ...(inferredFormat && !query.format ? { format: inferredFormat } : {}),
      };
      const highlight = intent.topic || query.q;
      const empty = (mode: string) => ({
        items: [] as Awaited<ReturnType<typeof searchSummaries>>,
        total: 0,
        nextOffset: null as number | null,
        engine: "database" as const,
        mode,
      });
      const fallback = async (reason?: string) => {
        if (intent.requireEvidence) {
          const evidenced = await documentIdsForFileTopic(
            actor,
            intent,
            scoped,
          );
          if (!evidenced.length)
            return empty(query.mode === "ai" ? "ai" : "keyword");
          const page = await content.list(actor, {
            ...scoped,
            q: undefined,
            kind: "document",
            matchedIds: evidenced,
          });
          return {
            ...page,
            items: await searchSummaries(db, actor, page.items, highlight),
            engine: "database",
            mode: query.mode === "ai" ? "ai" : "keyword",
            ...(reason ? { notice: reason } : {}),
          };
        }
        if (query.mode === "ai" && query.q?.trim())
          fail(
            503,
            reason ??
              "AI 搜索尚未就绪，请管理员配置并应用向量模型，或切换关键词搜索",
          );
        const page = await content.list(actor, { ...scoped, kind: "document" });
        return {
          ...page,
          items: await searchSummaries(db, actor, page.items, highlight),
          engine: "database",
          mode: "keyword",
          ...(reason ? { notice: reason } : {}),
        };
      };
      if (!query.q?.trim()) return fallback();
      if (!c.enabled)
        return fallback(
          query.mode === "auto"
            ? "未启用 AI 搜索，已使用关键词搜索"
            : undefined,
        );
      if (indexing)
        return fallback(
          query.mode === "ai"
            ? "搜索索引更新中，请稍后重试 AI 搜索"
            : "搜索索引更新中，暂用基础搜索",
        );
      try {
        const embedder =
          query.mode === "ai" || query.mode === "auto"
            ? await embeddings.queryEmbedder()
            : undefined;
        const fromFiles =
          intent.requireEvidence || intent.focus === "mixed"
            ? await documentIdsForFileTopic(actor, intent, scoped)
            : [];
        if (intent.requireEvidence && !fromFiles.length)
          return empty(
            embedder ? "ai" : query.mode === "ai" ? "ai" : "keyword",
          );
        if (query.mode === "ai" && !embedder) {
          if (intent.requireEvidence) {
            const page = await content.list(actor, {
              ...scoped,
              q: undefined,
              kind: "document",
              matchedIds: fromFiles,
            });
            return {
              items: await searchSummaries(db, actor, page.items, highlight),
              total: page.items.length,
              nextOffset: null,
              engine: "database",
              mode: "ai",
            };
          }
          return fallback();
        }
        // Bound remote work to this user's visible candidate scope. Large scopes
        // use the database until a dedicated scoped search projection is configured.
        const candidates: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await content.list(actor, {
            ...scoped,
            q: undefined,
            cursor,
            kind: "document",
          });
          candidates.push(...page.items.map((r) => r.id));
          cursor = page.nextCursor ?? undefined;
          if (candidates.length >= 1000 && cursor)
            return fallback(
              "搜索范围较大，请限定知识库后重试；关键词模式可使用基础搜索",
            );
        } while (cursor);
        if (!candidates.length)
          return {
            items: [],
            total: 0,
            nextOffset: null,
            engine: "meilisearch",
            mode: embedder ? "ai" : "keyword",
          };
        const retrievalQuery = intent.topic || query.q;
        type Summary = Awaited<ReturnType<typeof searchSummaries>>[number];
        const result = await searchHost.query<Summary>({
          query: retrievalQuery,
          context: {
            kind: "documents",
            actor,
            scoped,
            candidateIds: candidates,
            retrievalQuery,
            highlight: highlight ?? "",
            semantic: !!embedder,
            minScore: c.ai_min_score,
          },
          sources: [documentSearchSource],
          limit: candidates.length,
        });
        if (result.failures.length)
          throw new AggregateError(
            result.failures.map((failure) => failure.error),
            "文档搜索来源失败",
          );
        const ranked = result.items.map((item) => item.id);
        const evidenced = fromFiles.filter((id) => candidates.includes(id));
        const values = new Map(
          result.items.map((item) => [item.id, item.value]),
        );
        const ids: string[] = constrainedDocumentIds(
          ranked,
          evidenced,
          intent,
          new Map(
            result.items.map((item) => [
              item.id,
              `${item.value.title ?? ""}\n${item.value.summary ?? ""}`,
            ]),
          ),
        );
        if (!ids.length)
          return {
            items: [],
            total: 0,
            nextOffset: null,
            engine: "meilisearch",
            mode: embedder ? "ai" : "keyword",
          };
        const start = query.offset ?? 0;
        const summarized = ids.flatMap((id) => {
          const value = values.get(id);
          return value ? [value] : [];
        });
        if (embedder) {
          const scores = new Map<string, number>(
            result.items.map((item) => [item.id, item.providerScore]),
          );
          // Break close semantic matches using concrete terms in the current source.
          // The bounded boost never rescues a hit below the semantic threshold.
          summarized.sort(
            (a, b) =>
              (scores.get(b.id) ?? 0) +
              b.searchCoverage * 0.08 -
              ((scores.get(a.id) ?? 0) + a.searchCoverage * 0.08),
          );
          const reranked = constrainedDocumentIds(
            summarized.map((item) => item.id),
            evidenced,
            intent,
            new Map(
              summarized.map((item) => [
                item.id,
                `${item.title ?? ""}\n${item.summary ?? ""}`,
              ]),
            ),
          );
          const evidenceRank = new Map(reranked.map((id, i) => [id, i]));
          summarized.sort(
            (a, b) =>
              (evidenceRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (evidenceRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
          );
        }
        return {
          items: summarized
            .slice(start, start + 100)
            .map(({ searchCoverage, ...r }) => r),
          total: summarized.length,
          nextOffset: start + 100 < summarized.length ? start + 100 : null,
          engine: "meilisearch",
          mode: embedder ? "ai" : "keyword",
          ...(query.mode === "auto" && !embedder
            ? { notice: "向量模型尚未生效，已使用关键词搜索" }
            : {}),
        };
      } catch {
        return fallback(
          query.mode === "ai"
            ? "AI 搜索暂不可用，请检查向量模型服务，或切换关键词搜索"
            : "Meilisearch 暂不可用，已使用基础搜索",
        );
      }
    },
  };
}
