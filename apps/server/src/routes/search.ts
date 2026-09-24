import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import { processProjections } from "@core/modules/automation/jobs.js";
import { mailKnowledgeIncluded } from "@core/modules/mail/scope.js";
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
  searchDocument,
} from "@core/modules/discovery/search-reconciliation.js";
import {
  constrainedDocumentIds,
  searchIntent,
} from "@core/modules/discovery/search-intent.js";
import { topicMatchTerms } from "@core/modules/discovery/search-excerpts.js";
import { releaseDocumentFileIfUnused } from "@core/modules/documents/live-media.js";
type FilePolicyGroup = "image" | "pdf" | "office" | "text" | "other";
const defaultFileSearchGroups: FilePolicyGroup[] = [
  "image",
  "pdf",
  "office",
  "text",
  "other",
];
const filePolicyGroup = (mime: string): FilePolicyGroup =>
  mime.startsWith("image/")
    ? "image"
    : mime === "application/pdf"
      ? "pdf"
      : /officedocument|msword|ms-excel|ms-powerpoint/.test(mime)
        ? "office"
        : mime.startsWith("text/") || /json|xml|yaml/.test(mime)
          ? "text"
          : "other";
const fileObjectDocumentId = (storageObjectId: string) =>
  `file_object_${storageObjectId.replaceAll("-", "_")}`;
const fileItemDocumentId = (fileItemId: string) =>
  `file_item_${fileItemId.replaceAll("-", "_")}`;
function fileObjectSearchDocument(row: {
  storageObjectId: string;
  description?: string | null;
}) {
  // A physical object is indexed once. Names and per-location overrides belong
  // to aliases so inaccessible locations can never leak search terms.
  return searchDocument({
    id: fileObjectDocumentId(row.storageObjectId),
    title: "",
    text: row.description?.trim() || null,
  });
}
function fileItemSearchDocument(row: {
  id: string;
  name: string;
  description?: string | null;
  ai_description_override?: string | null;
}) {
  return searchDocument({
    id: fileItemDocumentId(row.id),
    title: row.name,
    text: (row.description ?? row.ai_description_override)?.trim() || null,
  });
}
type Config = { enabled: number; endpoint: string; index_name: string };
class SearchRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail = "",
  ) {
    super(
      detail
        ? `Meilisearch 请求失败（${status}）：${detail}`
        : `Meilisearch 请求失败（${status}）`,
    );
  }
}
export interface SearchRuntime {
  allowedOrigins: string[];
  apiKey?: string;
  fetch?: typeof fetch;
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
  async function ensureIndex(c: Config) {
    const base = `/indexes/${c.index_name}`;
    try {
      await request(c, base);
    } catch (error) {
      if (!(error instanceof SearchRequestError) || error.status !== 404)
        throw error;
      await waitTask(
        c,
        await request(c, "/indexes", "POST", {
          uid: c.index_name,
          primaryKey: "id",
        }),
      );
    }
    await waitTask(
      c,
      await request(c, base + "/settings", "PATCH", {
        filterableAttributes: ["id", "reader_ids"],
        searchableAttributes: ["title", "text"],
        displayedAttributes: ["id"],
        pagination: { maxTotalHits: 10000 },
      }),
    );
  }
  const reconciler = createSearchReconciler(db, {
    async list(c, offset, limit) {
      try {
        return await request(
          c,
          `/indexes/${c.index_name}/documents?offset=${offset}&limit=${limit}&fields=id,content_hash`,
        );
      } catch (error) {
        if (!(error instanceof SearchRequestError) || error.status !== 404)
          throw error;
        // A lost index is recoverable. Resetting the inventory avoids trusting its old offset.
        await ensureIndex(c);
        await transact(db, async (tx) => {
          const current = await tx
            .selectFrom("search_settings")
            .select("generation")
            .where("id", "=", "system")
            .executeTakeFirstOrThrow();
          if (current.generation === c.generation)
            await resetSearchReconciliation(tx, c.generation);
        });
        throw new Error("索引已重新创建，下一轮对账将补齐文档");
      }
    },
  });
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
      if (task.batchUid !== undefined && Date.now() - lastBatchCheck >= 1000) {
        lastBatchCheck = Date.now();
        try {
          const batch = await request(c, `/batches/${task.batchUid}`);
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
      const batches = await request(c, "/batches?limit=20", "GET", undefined, 2000);
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
  function reindex(c: Config) {
    if (indexing) return job!;
    indexing = true;
    lastError = "";
    job = (async () => {
      const base = `/indexes/${c.index_name}`;
      await ensureIndex(c);
      let cursor = "";
      while (!stopping) {
        const docs = await db
          .selectFrom("resources")
          .leftJoin(
            "document_states",
            "document_states.resource_id",
            "resources.id",
          )
          .select(["resources.id", "resources.title", "document_states.text"])
          .where("resources.kind", "=", "document")
          .where("resources.deleted_at", "is", null)
          .orderBy("resources.id")
          .limit(100)
          .where("resources.id", ">", cursor)
          .execute();
        if (!docs.length) break;
        await waitTask(
          c,
          await request(
            c,
            base + "/documents?primaryKey=id",
            "POST",
            docs.map(searchDocument),
          ),
        );
        cursor = docs.at(-1)!.id;
      }
      const fileSetting = await db
        .selectFrom("file_recognition_settings")
        .select("config")
        .where("id", "=", "default")
        .executeTakeFirst();
      const searchGroups = new Set<FilePolicyGroup>(
        (fileSetting ? JSON.parse(fileSetting.config).searchGroups : null) ??
          defaultFileSearchGroups,
      );
      let fileCursor = "";
      while (!stopping) {
        const objects = await db
          .selectFrom("file_storage_objects")
          .select(["id", "ai_description"])
          .where("id", ">", fileCursor)
          .orderBy("id")
          .limit(100)
          .execute();
        if (!objects.length) break;
        const documents = [];
        for (const object of objects) {
          const items = await db
            .selectFrom("file_items")
            .select(["id", "name", "mime", "ai_description_override"])
            .where("storage_object_id", "=", object.id)
            .where("deleted_at", "is", null)
            .execute();
          if (
            !items.length ||
            !items.some((item) => searchGroups.has(filePolicyGroup(item.mime)))
          )
            continue;
          documents.push(
            fileObjectSearchDocument({
              storageObjectId: object.id,
              description: object.ai_description,
            }),
          );
          documents.push(
            ...items
              .filter((item) => searchGroups.has(filePolicyGroup(item.mime)))
              .map(fileItemSearchDocument),
          );
        }
        if (documents.length)
          await waitTask(
            c,
            await request(
              c,
              base + "/documents?primaryKey=id",
              "POST",
              documents,
            ),
          );
        fileCursor = objects.at(-1)!.id;
      }
      lastIndexedAt = new Date().toISOString();
      await reconciler.schedule();
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
      imageRecognitionEnabled?: boolean;
      reconcileIntervalHours?: number;
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
            imageRecognitionEnabled: Type.Optional(Type.Boolean()),
            reconcileIntervalHours: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 168 }),
            ),
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
        const imageEnabled =
          req.body.imageRecognitionEnabled === undefined
            ? previous.image_recognition_enabled
            : Number(req.body.imageRecognitionEnabled);
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
            reconcile_interval_hours:
              req.body.reconcileIntervalHours ??
              previous.reconcile_interval_hours,
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
          req.body.reconcileIntervalHours !== undefined &&
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
        const row = await db
          .selectFrom("resources as r")
          .leftJoin("document_states as s", "s.resource_id", "r.id")
          .select(["r.id", "r.title", "r.kind", "r.deleted_at", "s.text"])
          .where("r.id", "=", id)
          .executeTakeFirst();
        const base = `/indexes/${c.index_name}/documents`;
        if (!row || row.deleted_at || row.kind !== "document") {
          try {
            await waitTask(
              c,
              await request(c, base + "/" + encodeURIComponent(id), "DELETE"),
            );
          } catch (error) {
            if (!(error instanceof SearchRequestError) || error.status !== 404)
              throw error;
          }
        } else {
          const document = searchDocument(row);
          let indexed: any;
          try {
            indexed = await request(
              c,
              base + "/" + encodeURIComponent(id) + "?fields=id,content_hash",
            );
          } catch (error) {
            if (!(error instanceof SearchRequestError) || error.status !== 404)
              throw error;
          }
          if (indexed?.content_hash !== document.content_hash)
            await waitTask(
              c,
              await request(c, base + "?primaryKey=id", "POST", [document]),
            );
        }
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
        const setting = await db
          .selectFrom("file_recognition_settings")
          .select("config")
          .where("id", "=", "default")
          .executeTakeFirst();
        const groups = new Set<FilePolicyGroup>(
          (setting ? JSON.parse(setting.config).searchGroups : null) ??
            defaultFileSearchGroups,
        );
        const base = `/indexes/${c.index_name}/documents`;
        try {
          await waitTask(
            c,
            await request(
              c,
              base + "/" + encodeURIComponent(fileItemDocumentId(id)),
              "DELETE",
            ),
          );
        } catch (error) {
          if (!(error instanceof SearchRequestError) || error.status !== 404)
            throw error;
        }
        if (row) {
          const items = await db
            .selectFrom("file_items")
            .select(["id", "name", "mime", "ai_description_override"])
            .where("storage_object_id", "=", row.storage_object_id)
            .where("deleted_at", "is", null)
            .execute();
          const documentId = fileObjectDocumentId(row.storage_object_id);
          if (
            !items.length ||
            !items.some((item) => groups.has(filePolicyGroup(item.mime)))
          ) {
            try {
              await waitTask(
                c,
                await request(
                  c,
                  base + "/" + encodeURIComponent(documentId),
                  "DELETE",
                ),
              );
            } catch (error) {
              if (
                !(error instanceof SearchRequestError) ||
                error.status !== 404
              )
                throw error;
            }
          } else {
            const documents = [
              fileObjectSearchDocument({
                storageObjectId: row.storage_object_id,
                description: row.ai_description,
              }),
              ...items
                .filter((item) => groups.has(filePolicyGroup(item.mime)))
                .map(fileItemSearchDocument),
            ];
            await waitTask(
              c,
              await request(c, base + "?primaryKey=id", "POST", documents),
            );
          }
        }
        lastIndexedAt = new Date().toISOString();
      });
      await processProjections(db, "search-mail", async (payload) => {
        const id = String(payload.messageId ?? "");
        if (!id) return;
        const row = await db
          .selectFrom("mail_messages")
          .leftJoin("mailboxes", "mailboxes.id", "mail_messages.mailbox_id")
          .selectAll("mail_messages")
          .select("mailboxes.address as mailbox_address")
          .select("mailboxes.knowledge_scope as mailbox_knowledge_scope")
          .select("mailboxes.deleted_at as mailbox_deleted_at")
          .where("mail_messages.id", "=", id)
          .executeTakeFirst();
        const documentId = `mail_message_${id.replaceAll("-", "_")}`;
        const base = `/indexes/${c.index_name}/documents`;
        const indexed = !!row
          && !row.mailbox_deleted_at
          && row.mailbox_knowledge_scope != null
          && mailKnowledgeIncluded(row.mailbox_knowledge_scope, row.starred);
        if (!indexed || !row) {
          try {
            await waitTask(
              c,
              await request(c, `${base}/${encodeURIComponent(documentId)}`, "DELETE"),
            );
          } catch (error) {
            if (!(error instanceof SearchRequestError) || error.status !== 404)
              throw error;
          }
          return;
        }
        await waitTask(
          c,
          await request(c, `${base}?primaryKey=id`, "POST", [
            searchDocument({
              id: documentId,
              title: row.subject || "（无主题）",
              text: [
                row.mailbox_address ? `邮箱 ${row.mailbox_address}` : "",
                row.from_addr ? `发件人 ${row.from_addr}` : "",
                row.to_addrs ? `收件人 ${row.to_addrs}` : "",
                row.ai_tags ? `标签 ${row.ai_tags}` : "",
                row.snippet,
                row.body_text,
              ]
                .filter(Boolean)
                .join("\n"),
            }),
          ]),
        );
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
  });
  async function documentIdsForFileTopic(
    actor: Actor,
    intent: ReturnType<typeof searchIntent>,
    query: Parameters<typeof content.list>[1],
  ) {
    const terms = topicMatchTerms(intent.topic).filter((term) => term.length >= 2);
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
    const mediaCache = new Map<string, Promise<{ ids: Set<string> | null; updatedAt: string }>>();
    const ids: string[] = [];
    for (const row of rows)
      if (await releaseDocumentFileIfUnused(db, row.id, mediaCache)) ids.push(row.parent_id);
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return [];
    const page = await content.list(actor, {
      ...query,
      q: undefined,
      offset: 0,
      cursor: undefined,
      kind: "document",
      matchedIds: uniqueIds,
    });
    return page.items.map((item) => item.id);
  }
  let chunkFilterReady = false;
  const knowledgeIndex = {
    async replace(
      removed: string[],
      docs: Array<{ id: string; title: string; text: string; readerIds: string[] }>,
    ) {
      const c = await config();
      if (!c.enabled) return;
      try {
        if (!chunkFilterReady) {
          const settings = await request(c, `/indexes/${c.index_name}/settings`);
          const filterable = Array.isArray(settings.filterableAttributes) ? settings.filterableAttributes : [];
          if (!filterable.includes("reader_ids")) {
            await request(c, `/indexes/${c.index_name}/settings`, "PATCH", {
              filterableAttributes: [...filterable, "reader_ids"],
            });
          }
          chunkFilterReady = true;
        }
        const base = `/indexes/${c.index_name}/documents`;
        for (const id of removed) {
          try {
            await request(c, `${base}/${encodeURIComponent(id)}`, "DELETE");
          } catch (error) {
            if (!(error instanceof SearchRequestError) || error.status !== 404) throw error;
          }
        }
        if (docs.length) {
          await request(c, `${base}?primaryKey=id`, "POST", docs.map((doc) => ({
            id: doc.id,
            title: doc.title,
            text: doc.text,
            reader_ids: doc.readerIds,
          })));
        }
      } catch {
        chunkFilterReady = false;
      }
    },
    async search(tokens: string[], query: string) {
      const c = await config();
      if (!c.enabled || !query.trim() || !tokens.length) return null;
      try {
        const embedder = await embeddings.queryEmbedder();
        const data = await request(c, `/indexes/${c.index_name}/search`, "POST", {
          q: query,
          limit: 20,
          filter: tokens.map((token) => `reader_ids = ${JSON.stringify(token)}`).join(" OR "),
          attributesToRetrieve: ["id"],
          ...(embedder
            ? { hybrid: { embedder, semanticRatio: 0.8 }, showRankingScore: true }
            : {}),
        });
        if (!Array.isArray(data.hits)) return null;
        return data.hits
          .filter((hit: any) => typeof hit.id === "string" && hit.id.startsWith("kc_"))
          .map((hit: any) => ({
            id: String(hit.id),
            score: typeof hit._rankingScore === "number" ? hit._rankingScore : 0.5,
          }));
      } catch {
        return null;
      }
    },
  };
  return {
    knowledgeIndex,
    async searchFiles(
      query: string,
      fileIds: string[],
      mode: "keyword" | "ai",
    ) {
      const c = await config();
      if (
        !c.enabled ||
        indexing ||
        !query.trim() ||
        !fileIds.length
      )
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
          .execute();
        const objectIds = [
          ...new Set(mappings.map((row) => row.storage_object_id)),
        ];
        const candidates = [
          ...objectIds.map(fileObjectDocumentId),
          ...mappings.map((row) => fileItemDocumentId(row.id)),
        ];
        const fileThreshold = Math.min(c.ai_min_score, 0.45);
        const data = await request(
          c,
          `/indexes/${c.index_name}/search`,
          "POST",
          {
            q: retrievalQuery,
            limit: candidates.length,
            filter: `id IN [${candidates.map((id) => JSON.stringify(id)).join(",")}]`,
            attributesToRetrieve: ["id"],
            ...(embedder
              ? {
                  hybrid: { embedder, semanticRatio: 0.8 },
                  showRankingScore: true,
                  rankingScoreThreshold: fileThreshold,
                }
              : {}),
          },
        );
        if (!Array.isArray(data.hits)) return null;
        const objectByIndexed = new Map(
          objectIds.map((id) => [fileObjectDocumentId(id), id]),
        );
        const itemByIndexed = new Map<string, string>();
        for (const row of mappings) {
          const indexedId = fileItemDocumentId(row.id);
          objectByIndexed.set(indexedId, row.storage_object_id);
          itemByIndexed.set(indexedId, row.id);
        }
        const orderedItems: string[] = [];
        const seenObjects = new Set<string>();
        for (const hit of data.hits) {
          if (
            embedder &&
            (typeof hit._rankingScore !== "number" ||
              hit._rankingScore < fileThreshold)
          )
            continue;
          const indexedId = String(hit.id);
          const objectId = objectByIndexed.get(indexedId);
          if (!objectId || seenObjects.has(objectId)) continue;
          seenObjects.add(objectId);
          const matchedItem = itemByIndexed.get(indexedId);
          if (matchedItem) orderedItems.push(matchedItem);
          orderedItems.push(
            ...mappings
              .filter(
                (row) =>
                  row.storage_object_id === objectId && row.id !== matchedItem,
              )
              .map((row) => row.id),
          );
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
      },
    ) {
      const c = await config();
      const intent = searchIntent(query.q ?? "");
      const scoped = {
        ...query,
        ...(intent.format && !query.format ? { format: intent.format } : {}),
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
          const evidenced = await documentIdsForFileTopic(actor, intent, scoped);
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
          return empty(embedder ? "ai" : query.mode === "ai" ? "ai" : "keyword");
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
            offset: 0,
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
        const data = await request(
          c,
          `/indexes/${c.index_name}/search`,
          "POST",
          {
            q: retrievalQuery,
            limit: candidates.length,
            filter: `id IN [${candidates.map((id) => JSON.stringify(id)).join(",")}]`,
            attributesToRetrieve: ["id"],
            ...(embedder
              ? {
                  hybrid: { embedder, semanticRatio: 0.8 },
                  showRankingScore: true,
                  rankingScoreThreshold: c.ai_min_score,
                }
              : {}),
          },
        );
        if (!Array.isArray(data.hits)) throw new Error("无效搜索结果");
        const ranked = [
          ...new Set<string>(
            data.hits
              .filter(
                (h: any) =>
                  !embedder ||
                  (typeof h._rankingScore === "number" &&
                    Number.isFinite(h._rankingScore) &&
                    h._rankingScore >= c.ai_min_score),
              )
              .map((h: any) => h.id)
              .filter(
                (id: unknown) =>
                  typeof id === "string" && candidates.includes(id),
              ),
          ),
        ];
        const evidenced = fromFiles.filter((id) => candidates.includes(id));
        const titleRows = ranked.length
          ? await db
              .selectFrom("resources")
              .select(["id", "title"])
              .where("id", "in", ranked)
              .execute()
          : [];
        const ids: string[] = constrainedDocumentIds(
          ranked,
          evidenced,
          intent,
          new Map(titleRows.map((row) => [row.id, row.title])),
        );
        if (!ids.length)
          return {
            items: [],
            total: 0,
            nextOffset: null,
            engine: "meilisearch",
            mode: embedder ? "ai" : "keyword",
          };
        // Re-check ACLs and filters, then retain Meilisearch's relevance order.
        const visible = [];
        let offset = 0;
        do {
          const page = await content.list(actor, {
            ...scoped,
            q: undefined,
            cursor: undefined,
            offset,
            kind: "document",
            matchedIds: ids,
          });
          visible.push(...page.items);
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        } while (visible.length < ids.length);
        const rank = new Map(ids.map((id, i) => [id, i]));
        visible.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        const start = query.offset ?? 0;
        const summarized = await searchSummaries(
          db,
          actor,
          embedder ? visible : visible.slice(start, start + 100),
          highlight,
        );
        if (embedder) {
          const scores = new Map<string, number>(
            data.hits.map((h: any) => [h.id, h._rankingScore]),
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
            new Map(summarized.map((item) => [item.id, item.title])),
          );
          const evidenceRank = new Map(reranked.map((id, i) => [id, i]));
          summarized.sort(
            (a, b) =>
              (evidenceRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (evidenceRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
          );
        }
        return {
          items: (embedder
            ? summarized.slice(start, start + 100)
            : summarized
          ).map(({ searchCoverage, ...r }) => r),
          total: embedder ? summarized.length : visible.length,
          nextOffset:
            start + 100 < (embedder ? summarized.length : visible.length)
              ? start + 100
              : null,
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
