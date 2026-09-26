import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { AppError, fail } from "@core/shared/errors.js";
import type { Actor } from "@core/modules/identity/passwords.js";

import { aiConfig } from "@core/modules/ai/config.js";
import {
  embeddingSettings,
  embeddingFingerprint,
  embeddingModelIssue,
} from "@core/modules/ai/embeddings.js";

type Connection = Schema["search_settings"];
type Task = Schema["search_embedding_task"];
const active = ["submitting", "enqueued", "processing"] as const;
const responseTemplate = { data: [{ embedding: "{{embedding}}" }, "{{..}}"] };
const schema = Type.Object(
  {
    generation: Type.Integer({ minimum: 0 }),
    name: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
    modelId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
    aiRevision: Type.Integer({ minimum: 0 }),
    documentTemplate: Type.String({ minLength: 1, maxLength: 8000 }),
    documentTemplateMaxBytes: Type.Integer({ minimum: 1, maximum: 1000000 }),
  },
  { additionalProperties: false },
);
const deleteSchema = Type.Object(
  {
    generation: Type.Integer({ minimum: 0 }),
    name: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
  },
  { additionalProperties: false },
);
const deletePrefix = "delete:";
function isDeleteOperation(operationId: string) {
  return operationId.startsWith(deletePrefix);
}
function taskAction(operationId: string) {
  return isDeleteOperation(operationId) ? "delete" : "apply";
}

function compatibleRest(e: any) {
  const common =
    e.source === "rest" &&
    typeof e.request?.model === "string" &&
    !Object.keys(e.headers ?? {}).length;
  const standard =
    Object.keys(e.request ?? {}).every((k) =>
      ["model", "input", "encoding_format"].includes(k),
    ) &&
    isDeepStrictEqual(e.request?.input, ["{{text}}", "{{..}}"]) &&
    (!e.request.encoding_format || e.request.encoding_format === "float") &&
    isDeepStrictEqual(e.response, responseTemplate);
  const multimodal =
    Object.keys(e.request ?? {}).every((k) => ["model", "input"].includes(k)) &&
    isDeepStrictEqual(e.request?.input, [{ type: "text", text: "{{text}}" }]) &&
    isDeepStrictEqual(e.response, { data: { embedding: "{{embedding}}" } });
  return common && (standard || multimodal);
}
function supported(e: any) {
  return e?.source === "openAi" || (e && compatibleRest(e));
}
export function safeEmbeddingError(message: string) {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/gi, "$1***")
    .replace(/model-private-key/gi, "模型密钥")
    .trim();
}
export function embeddingFailureNotice(message: string) {
  const safe = safeEmbeddingError(message);
  if (safe.includes("Rejected URI"))
    return "模型服务地址被 Meilisearch 拒绝。云端 Meilisearch 会拦截内网或自建向量地址，只允许它能访问的官方接口；请到「搜索与发现 → 向量索引 → 查看向量任务诊断」核对原始错误。";
  if (/401|403|unauthorized|authentication|api.?key/i.test(safe))
    return "模型服务鉴权失败，请检查 AI 模型管理中的密钥及模型访问权限。";
  if (/dimension/i.test(safe)) return "向量维度不匹配，请核对模型实际输出维度。";
  return `向量服务返回错误：${safe.slice(0, 300)}`;
}
export async function registerSearchEmbeddings(
  api: FastifyInstance,
  db: DB,
  admin: (req: FastifyRequest) => Actor,
  options: {
    request: (
      c: Connection,
      path: string,
      method?: string,
      body?: unknown,
      timeoutMs?: number,
    ) => Promise<any>;
    indexing: () => boolean;
  },
) {
  const config = () =>
    db
      .selectFrom("search_settings")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  const task = async () => {
    const existing = await db
      .selectFrom("search_embedding_task")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirst();
    if (existing) return existing;
    await db
      .insertInto("search_embedding_task")
      .values({
        id: "system",
        operation_id: "",
        endpoint: "",
        index_name: "",
        embedder_name: "",
        task_uid: null,
        status: "idle",
        updated_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    return db
      .selectFrom("search_embedding_task")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
  };
  const path = (c: Connection) => `/indexes/${c.index_name}/settings/embedders`;
  const sameTarget = (a: Task, b: Connection) =>
    a.endpoint === b.endpoint && a.index_name === b.index_name;
  async function status(c: Connection) {
    let current = await task();
    if (!sameTarget(current, c))
      return {
        status: "idle",
        taskUid: null,
        name: "",
        notice: "",
        remoteStatus: null,
        error: null,
        batchUid: null,
        updatedAt: current.updated_at,
        endpoint: c.endpoint,
        indexName: c.index_name,
      };
    let next = current.status,
      notice = "",
      remoteStatus: string | null = null,
      error: string | null = null,
      batchUid: number | null = null;
    if (
      current.task_uid !== null &&
      ["enqueued", "processing", "succeeded", "failed"].includes(
        current.status,
      )
    ) {
      try {
        const remote = await options.request(
          c,
          `/tasks/${current.task_uid}`,
          "GET",
          undefined,
          2000,
        );
        if (
          [
            "enqueued",
            "processing",
            "succeeded",
            "failed",
            "canceled",
          ].includes(remote.status)
        )
          next = remote.status;
        else notice = "暂时无法确认任务状态，请稍后刷新。";
        remoteStatus = String(remote.status ?? "");
        const message = String(remote.error?.message ?? "");
        if (message) {
          error = safeEmbeddingError(message);
          notice = embeddingFailureNotice(message);
        }
        if (
          !message &&
          ["enqueued", "processing"].includes(remote.status) &&
          Number.isSafeInteger(remote.batchUid)
        ) {
          batchUid = Number(remote.batchUid);
          try {
            const batch = await options.request(
              c,
              `/batches/${remote.batchUid}`,
              "GET",
              undefined,
              2000,
            );
            const batchError = String(
              batch.stats?.embedderRequests?.lastError ?? "",
            );
            if (batchError) {
              error = safeEmbeddingError(batchError);
              notice = embeddingFailureNotice(batchError);
            }
          } catch {
            // Keep the task state when the optional diagnostic request fails.
          }
        }
      } catch {
        // A transport error does not mean the remote task failed. Keep its UID.
        notice = "暂时无法读取任务状态，Meilisearch 可能仍在处理，请稍后刷新。";
        remoteStatus = "unreachable";
        error = notice;
      }
    } else if (
      current.status === "submitting" &&
      Date.now() - Date.parse(current.updated_at) > 30000
    ) {
      next = "unknown";
    }
    if (next !== current.status) {
      await db
        .updateTable("search_embedding_task")
        .set({ status: next, updated_at: new Date().toISOString() })
        .where("id", "=", "system")
        .where("operation_id", "=", current.operation_id)
        .where("status", "=", current.status)
        .execute();
      current = await task();
    }
    if (current.status === "succeeded") {
      if (isDeleteOperation(current.operation_id))
        await db
          .deleteFrom("search_embedding_models")
          .where("endpoint", "=", current.endpoint)
          .where("index_name", "=", current.index_name)
          .where("embedder_name", "=", current.embedder_name)
          .execute();
      else
        await db
          .updateTable("search_embedding_models")
          .set({ applied: 1, applied_at: new Date().toISOString() })
          .where("operation_id", "=", current.operation_id)
          .where("applied", "=", 0)
          .execute();
    }
    return {
      status: current.status,
      taskUid: current.task_uid === null ? null : Number(current.task_uid),
      name: current.embedder_name,
      action: taskAction(current.operation_id),
      notice:
        current.status === "failed"
          ? notice ||
            (isDeleteOperation(current.operation_id)
              ? "删除向量配置失败，请检查 Meilisearch 连接后重试。"
              : "向量配置任务失败，请检查模型名称、维度、密钥及 Meilisearch 到模型服务的连接。")
            : current.status === "unknown"
              ? "提交结果未确认。请先刷新配置并核对 Meilisearch 任务列表，再决定是否重新保存。"
              : notice,
      remoteStatus,
      error,
      batchUid,
      updatedAt: current.updated_at,
      endpoint: current.endpoint,
      indexName: current.index_name,
    };
  }
  async function readEmbedders(c: Connection) {
    try {
      const value = await options.request(c, path(c));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, any>;
    } catch {
      fail(
        502,
        "无法读取向量配置，请检查 Meilisearch 连接，并等待文档索引创建完成",
      );
    }
  }

  api.get("/api/v1/admin/search/embeddings", async (req) => {
    admin(req);
    const c = await config();
    const progress = await status(c);
    let remote: Record<string, any> = {};
    let readNotice = "";
    if (c.enabled) {
      try {
        remote = await readEmbedders(c);
      } catch {
        readNotice =
          "暂时无法读取 Meilisearch，以下为平台已保存的配置，生效状态待确认。";
      }
    }
    const models = await aiConfig(db);
    const bindings = await db
      .selectFrom("search_embedding_models")
      .selectAll()
      .where("endpoint", "=", c.endpoint)
      .where("index_name", "=", c.index_name)
      .execute();
    function bindingInfo(name: string) {
      const binding = bindings.find((b) => b.embedder_name === name);
      if (!binding) return { modelId: "", needsApply: true };
      const model = models.models.find((m) => m.id === binding.model_id);
      return {
        modelId: binding.model_id,
        needsApply:
          !binding.applied ||
          !remote[name] ||
          !model ||
          !!embeddingModelIssue(models, model) ||
          binding.fingerprint !== embeddingFingerprint(model),
      };
    }
    return {
      enabled: !!c.enabled,
      generation: c.generation,
      endpoint: c.endpoint,
      indexName: c.index_name,
      task: progress,
      notice: readNotice,
      aiRevision: models.revision,
      minScore: c.ai_min_score,
      models: models.models
        .filter((m) => m.embedding)
        .map((m) => ({
          id: m.id,
          name: m.alias || m.model,
          model: m.model,
          vendor: models.vendors.find((v) => v.id === m.vendorId)?.name ?? "",
          dimensions: m.embeddingDimensions ?? null,
          issue: embeddingModelIssue(models, m),
        })),
      // Never forward raw settings: apiKey, headers and custom REST payloads may contain secrets.
      embedders: [
        ...new Set([
          ...Object.keys(remote),
          ...bindings.map((b) => b.embedder_name),
        ]),
      ].map((name) => {
        const e = remote[name] ?? {};
        const binding = bindings.find((b) => b.embedder_name === name);
        return {
          name,
          ...bindingInfo(name),
          supported: !remote[name] || supported(e),
          remotePresent: !!remote[name],
          source: e.source,
          model:
            e.source === "rest"
              ? compatibleRest(e)
                ? e.request.model
                : ""
              : (e.model ?? ""),
          url: supported(e) ? (e.url ?? "") : "",
          dimensions: e.dimensions ?? null,
          documentTemplate:
            binding?.document_template ??
            e.documentTemplate ??
            "{{doc.title}}\n{{doc.text}}",
          documentTemplateMaxBytes:
            binding?.document_template_max_bytes ??
            e.documentTemplateMaxBytes ??
            8000,
          credentialConfigured: !!e.apiKey,
        };
      }),
    };
  });
  api.get("/api/v1/admin/search/embeddings/status", async (req) => {
    admin(req);
    return status(await config());
  });
  api.put<{ Body: Static<typeof schema> }>(
    "/api/v1/admin/search/embeddings",
    {
      schema: { summary: "配置 Meilisearch 自动向量化模型", body: schema },
    },
    async (req, reply) => {
      const actor = admin(req),
        body = req.body,
        c = await config();
      if (!c.enabled) fail(409, "请先保存并启用 Meilisearch");
      if (c.generation !== body.generation)
        fail(409, "搜索连接已变更，请重新加载向量配置");
      if (options.indexing())
        fail(409, "文档索引正在建立，请完成后再配置向量模型");
      if (!body.documentTemplate.trim()) fail(400, "内容模板不能为空");
      await status(c);
      const operation = randomUUID();
      const model = await transact(db, async (tx) => {
        const latest = await tx
          .selectFrom("search_settings")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
        if (!latest.enabled || latest.generation !== body.generation)
          fail(409, "搜索连接已变更，请重新加载向量配置");
        await assertIdle(tx);
        const models = await aiConfig(tx);
        if (models.revision !== body.aiRevision)
          fail(409, "AI 模型配置已变化，请重新读取后应用");
        const selected = models.models.find((m) => m.id === body.modelId);
        if (!selected) fail(400, "所选 AI 模型已不存在，请重新选择");
        const issue = embeddingModelIssue(models, selected);
        if (issue) fail(400, issue);
        const binding = {
          id: createHash("sha256")
            .update(JSON.stringify([c.endpoint, c.index_name, body.name]))
            .digest("hex"),
          endpoint: c.endpoint,
          index_name: c.index_name,
          embedder_name: body.name,
          model_id: selected.id,
          fingerprint: embeddingFingerprint(selected),
          operation_id: operation,
          applied: 0,
          document_template: body.documentTemplate,
          document_template_max_bytes: body.documentTemplateMaxBytes,
          applied_at: null,
        };
        await tx
          .insertInto("search_embedding_models")
          .values(binding)
          .onConflict((oc) => oc.column("id").doUpdateSet(binding))
          .execute();
        await tx
          .updateTable("search_embedding_task")
          .set({
            operation_id: operation,
            endpoint: c.endpoint,
            index_name: c.index_name,
            embedder_name: body.name,
            task_uid: null,
            status: "submitting",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", "system")
          .execute();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: actor.id,
            resource_id: null,
            action: "search.embedding_settings_updated",
            created_at: new Date().toISOString(),
          })
          .execute();
        return selected;
      });
      let accepted: any;
      let submitting = false;
      try {
        const remote = await readEmbedders(c);
        const previous = Object.hasOwn(remote, body.name)
          ? remote[body.name]
          : undefined;
        if (previous && !supported(previous))
          fail(
            400,
            "此配置使用自定义接口，暂不支持在页面编辑，请使用新的配置名称",
          );
        const selectedSettings = embeddingSettings(model);
        if (previous && previous.source !== selectedSettings.source)
          fail(400, "更换接口类型时请使用新的配置名称");
        const settings = {
          ...selectedSettings,
          documentTemplate: body.documentTemplate,
          documentTemplateMaxBytes: body.documentTemplateMaxBytes,
        };
        submitting = true;
        accepted = await options.request(c, path(c), "PATCH", {
          [body.name]: settings,
        });
        if (!Number.isSafeInteger(accepted.taskUid) || accepted.taskUid < 0)
          throw new Error();
      } catch (error) {
        // Do not automatically resubmit an ambiguous request: it may already be queued.
        const rejected =
          !submitting ||
          (typeof (error as { status?: number }).status === "number" &&
            (error as { status: number }).status < 500);
        await db
          .updateTable("search_embedding_task")
          .set({
            status: rejected ? "failed" : "unknown",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", "system")
          .where("operation_id", "=", operation)
          .execute();
        if (error instanceof AppError) throw error;
        const detail =
          error instanceof Error
            ? error.message.replace(/^Meilisearch 请求失败（\d+）：?/, "").trim()
            : "";
        fail(
          502,
          rejected
            ? detail
              ? embeddingFailureNotice(detail)
              : "Meilisearch 拒绝了向量配置，请检查配置和服务版本"
            : "提交结果未确认，请先刷新配置并核对 Meilisearch 任务列表",
        );
      }
      await db
        .updateTable("search_embedding_task")
        .set({
          task_uid: accepted.taskUid,
          status: "enqueued",
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", "system")
        .where("operation_id", "=", operation)
        .execute();
      return reply.code(202).send({
        taskUid: accepted.taskUid,
        status: "enqueued",
        name: body.name,
        action: "apply",
        notice: "",
      });
    },
  );
  api.delete<{ Body: Static<typeof deleteSchema> }>(
    "/api/v1/admin/search/embeddings",
    {
      schema: {
        summary: "删除 Meilisearch 上的命名向量配置",
        body: deleteSchema,
      },
    },
    async (req, reply) => {
      const actor = admin(req),
        body = req.body,
        c = await config();
      if (!c.enabled) fail(409, "请先保存并启用 Meilisearch");
      if (c.generation !== body.generation)
        fail(409, "搜索连接已变更，请重新加载向量配置");
      if (options.indexing())
        fail(409, "文档索引正在建立，请完成后再修改向量配置");
      await status(c);
      const remote = await readEmbedders(c);
      const binding = await db
        .selectFrom("search_embedding_models")
        .selectAll()
        .where("endpoint", "=", c.endpoint)
        .where("index_name", "=", c.index_name)
        .where("embedder_name", "=", body.name)
        .executeTakeFirst();
      const remotePresent = Object.hasOwn(remote, body.name);
      if (!remotePresent && !binding) fail(404, "该向量配置不存在");
      const operation = deletePrefix + randomUUID();
      await transact(db, async (tx) => {
        const latest = await tx
          .selectFrom("search_settings")
          .selectAll()
          .where("id", "=", "system")
          .executeTakeFirstOrThrow();
        if (!latest.enabled || latest.generation !== body.generation)
          fail(409, "搜索连接已变更，请重新加载向量配置");
        await assertIdle(tx);
        await tx
          .updateTable("search_embedding_task")
          .set({
            operation_id: operation,
            endpoint: c.endpoint,
            index_name: c.index_name,
            embedder_name: body.name,
            task_uid: null,
            status: remotePresent ? "submitting" : "succeeded",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", "system")
          .execute();
        if (!remotePresent)
          await tx
            .deleteFrom("search_embedding_models")
            .where("id", "=", binding!.id)
            .execute();
        await tx
          .insertInto("audit_events")
          .values({
            id: randomUUID(),
            actor_id: actor.id,
            resource_id: null,
            action: "search.embedding_settings_deleted",
            created_at: new Date().toISOString(),
          })
          .execute();
      });
      if (!remotePresent)
        return {
          taskUid: null,
          status: "succeeded",
          name: body.name,
          action: "delete",
          notice: "Meilisearch 上没有该配置，已删除平台记录。",
        };
      let accepted: any;
      let submitting = false;
      try {
        submitting = true;
        accepted = await options.request(c, path(c), "PATCH", {
          [body.name]: null,
        });
        if (!Number.isSafeInteger(accepted.taskUid) || accepted.taskUid < 0)
          throw new Error();
      } catch (error) {
        const rejected =
          !submitting ||
          (typeof (error as { status?: number }).status === "number" &&
            (error as { status: number }).status < 500);
        await db
          .updateTable("search_embedding_task")
          .set({
            status: rejected ? "failed" : "unknown",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", "system")
          .where("operation_id", "=", operation)
          .execute();
        if (error instanceof AppError) throw error;
        const detail =
          error instanceof Error
            ? error.message.replace(/^Meilisearch 请求失败（\d+）：?/, "").trim()
            : "";
        fail(
          502,
          rejected
            ? detail
              ? embeddingFailureNotice(detail)
              : "Meilisearch 拒绝了删除向量配置，请检查连接和服务版本"
            : "提交结果未确认，请先刷新配置并核对 Meilisearch 任务列表",
        );
      }
      await db
        .updateTable("search_embedding_task")
        .set({
          task_uid: accepted.taskUid,
          status: "enqueued",
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", "system")
        .where("operation_id", "=", operation)
        .execute();
      return reply.code(202).send({
        taskUid: accepted.taskUid,
        status: "enqueued",
        name: body.name,
        action: "delete",
        notice: "",
      });
    },
  );

  async function assertIdle(connection: DB = db) {
    const current = await connection
      .selectFrom("search_embedding_task")
      .selectAll()
      .where("id", "=", "system")
      .executeTakeFirstOrThrow();
    if ((active as readonly string[]).includes(current.status))
      fail(409, "向量配置任务仍在处理中，请刷新状态并等待完成");
  }
  return {
    assertIdle,
    async replicaEmbedders(remote: Record<string,any>) {
      const c=await config(),models=await aiConfig(db);
      const bindings=await db.selectFrom("search_embedding_models").selectAll().where("endpoint","=",c.endpoint).where("index_name","=",c.index_name).where("applied","=",1).execute();
      const result:Record<string,unknown>={};
      for(const [name,value] of Object.entries(remote)) {
        const binding=bindings.find(x=>x.embedder_name===name),model=binding&&models.models.find(x=>x.id===binding.model_id);
        if(model) {
          const issue=embeddingModelIssue(models,model);if(issue)fail(503,issue);
          // GET /settings redacts apiKey. Reconstruct from the trusted host binding;
          // never send the host credential to a URL supplied by remote settings.
          result[name]={...embeddingSettings(model),documentTemplate:binding!.document_template??value.documentTemplate,documentTemplateMaxBytes:binding!.document_template_max_bytes??value.documentTemplateMaxBytes};
        } else {
          if(value.apiKey)fail(503,"独立索引需要在 Doca 中绑定对应向量模型，不能复制远端脱敏凭据");
          result[name]=value;
        }
      }
      return result;
    },
    refreshStatus: async () => status(await config()),
    async queryEmbedder() {
      const c = await config();
      if (!c.enabled) return undefined;
      await status(c);
      const bindings = await db
        .selectFrom("search_embedding_models")
        .selectAll()
        .where("endpoint", "=", c.endpoint)
        .where("index_name", "=", c.index_name)
        .where("applied", "=", 1)
        .orderBy(sql<string>`coalesce(applied_at, '')`, "desc")
        .orderBy("embedder_name", "asc")
        .execute();
      if (!bindings.length) return undefined;
      const remote = await readEmbedders(c);
      return bindings.find((b) => supported(remote[b.embedder_name]))
        ?.embedder_name;
    },
  };
}
