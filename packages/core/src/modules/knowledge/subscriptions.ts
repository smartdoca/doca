import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";
import { sourceActor, sourceAvailable, maintainKnowledgeSource, knowledgeSourceLinkVisible } from "./source-access.js";
import { randomUUID } from "node:crypto";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { authorize } from "../access/queries.js";
import { fail } from "../../shared/errors.js";

export type SubscriptionKind =
  "document" | "library" | "file" | "folder" | "url";
export type KnowledgeDocumentCreator = (
  actor: Actor,
  input: {
    title: string;
    kind: "document";
    format: "markdown";
    libraryId: string;
    parentId?: string | null;
    markdown: string;
  },
) => Promise<{ id: string }>;

const kinds = new Set<SubscriptionKind>([
  "document",
  "library",
  "file",
  "folder",
  "url",
]);

export function subscriptionKind(value: string): SubscriptionKind {
  if (kinds.has(value as SubscriptionKind)) return value as SubscriptionKind;
  fail(400, "来源类型不正确");
}

export async function listKnowledgeSubscriptions(
  db: DB,
  actor: Actor,
  libraryId: string,
  options: { refreshStatus?: boolean } = {},
) {
  await authorize(db, actor, libraryId, 4);
  const rows = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .orderBy("created_at", "desc")
    .execute();
  const creatorIds = [
    ...new Set(
      rows
        .map((row) => row.creator_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const creators = creatorIds.length
    ? await db
        .selectFrom("users")
        .select(["id", "display_name", "public_id"])
        .where("id", "in", creatorIds)
        .execute()
    : [];
  const items = [];
  for (const row of rows) {
    const owner = await sourceActor(db, row);
    const available = !!owner && (await sourceAvailable(db, owner, row));
    const visible = await knowledgeSourceLinkVisible(db, actor, row, true);
    const status =
      row.status === "detached"
        ? "detached"
        : !available
          ? "missing"
          : row.status === "pending"
            ? await pendingStatus(db, row)
            : await subscriptionStatus(db, row);
    if (options.refreshStatus !== false && status !== row.status) {
      await db
        .updateTable("knowledge_subscriptions")
        .set({ status })
        .where("id", "=", row.id)
        .execute();
    }
    const creator = creators.find((user) => user.id === row.creator_id);
    items.push({
      id: row.id,
      name: visible ? row.name?.trim() || (await sourceTitle(db, row)) : "",
      groupId: row.group_id ?? null,
      creator: {
        id: row.creator_id,
        displayName: creator?.display_name || creator?.public_id || "",
      },
      canEdit: row.creator_id === actor.id,
      canDelete: true,
      sourceKind: row.source_kind,
      sourceId: visible ? row.source_id : "",
      url: visible ? row.url : "",
      status,
      sourceTitle: visible ? await sourceTitle(db, row) : "",
      sourceVersion: row.source_version,
      createdAt: row.created_at,
    });
  }
  return {
    groups: await db
      .selectFrom("knowledge_source_groups")
      .selectAll()
      .where("library_id", "=", libraryId)
      .orderBy("created_at")
      .execute(),
    items,
  };
}

type SubscribedSource = Awaited<ReturnType<typeof publicSubscription>> & {
  included: number;
  groupId?: string;
  members?: SubscribedSource[];
};

export async function subscribeKnowledgeSource(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: {
    sourceKind: SubscriptionKind;
    sourceId?: string;
    url?: string;
    sourceIds?: string[];
    urls?: string[];
    title?: string;
  },
): Promise<SubscribedSource> {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (input.sourceIds || input.urls) {
    if (
      input.sourceKind === "url"
        ? !!input.sourceIds?.length || !!input.sourceId
        : !!input.urls?.length || !!input.url
    )
      fail(400, "每条来源只能包含一种类型");
    const targets = [
      ...new Set(
        input.sourceKind === "url"
          ? (input.urls ?? []).map(normalizeSubscriptionUrl)
          : (input.sourceIds ?? []),
      ),
    ];
    if (!targets.length || targets.length > 500)
      fail(400, "请选择 1 至 500 项同类来源");
    // Validate the entire selection before any writes; a failed item cannot leave a partial group.
    for (const target of targets)
      await readSource(db, actor, libraryId, {
        sourceKind: input.sourceKind,
        ...(input.sourceKind === "url"
          ? { url: target }
          : { sourceId: target }),
      });
    const persist = async (tx: DB) => {
      const members = [];
      for (const target of targets)
        members.push(
          await subscribeKnowledgeSource(tx, actor, libraryId, {
            sourceKind: input.sourceKind,
            ...(input.sourceKind === "url"
              ? { url: target }
              : { sourceId: target }),
          }),
        );
      const existing = await tx
        .selectFrom("knowledge_subscriptions")
        .select(["id", "group_id"])
        .where(
          "id",
          "in",
          members.map((x) => x.id),
        )
        .execute();
      if (existing.some((x) => x.group_id))
        fail(409, "部分内容已属于其他来源，请编辑原来源，避免重复绑定");
      const id = randomUUID();
      await tx
        .insertInto("knowledge_source_groups")
        .values({
          id,
          library_id: libraryId,
          title:
            input.title?.trim().slice(0, 200) ||
            `${input.sourceKind} · ${targets.length}`,
          source_kind: input.sourceKind,
          created_at: new Date().toISOString(),
        })
        .execute();
      await tx
        .updateTable("knowledge_subscriptions")
        .set({ group_id: id })
        .where(
          "id",
          "in",
          members.map((x) => x.id),
        )
        .execute();
      return { ...members[0]!, groupId: id, members, included: 0 };
    };
    return db.isTransaction ? persist(db) : db.transaction().execute(persist);
  }
  if (input.sourceKind === "url" ? !!input.sourceId : !!input.url)
    fail(400, "每条来源只能包含一种类型");
  const source = await readSource(db, actor, libraryId, input);
  const existing = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("source_kind", "=", input.sourceKind)
    .where("source_id", "=", source.sourceId)
    .where("url", "=", source.url)
    .executeTakeFirst();
  if (existing) {
    if (existing.status === "detached") {
      await maintainKnowledgeSource(db, actor, libraryId, existing.id);
      await db
        .updateTable("knowledge_subscriptions")
        .set({ status: "active" })
        .where("id", "=", existing.id)
        .execute();
      existing.status = "active";
    }
    return { ...(await publicSubscription(db, existing)), included: 0 };
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto("knowledge_subscriptions")
    .values({
      id,
      library_id: libraryId,
      name:
        input.title?.trim().slice(0, 200) ||
        (await sourceTitle(db, {
          source_kind: input.sourceKind,
          source_id: source.sourceId,
          url: source.url,
        })),
      creator_id: actor.id,
      source_kind: input.sourceKind,
      source_id: source.sourceId,
      url: source.url,
      source_version: source.version,
      status: "pending",
      created_at: now,
    })
    .execute();
  return {
    ...(await publicSubscription(db, {
      id,
      source_kind: input.sourceKind,
      source_id: source.sourceId,
      url: source.url,
      source_version: source.version,
      status: "pending",
      created_at: now,
    })),
    included: 0,
  };
}

export async function confirmKnowledgeSubscription(
  db: DB,
  actor: Actor,
  libraryId: string,
  subscriptionId: string,
  _createDocument: KnowledgeDocumentCreator,
) {
  await authorize(db, actor, libraryId, 4);
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", subscriptionId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!row || !(await sourceAvailable(db, actor, row))) fail(404, "来源不可用");
  await maintainKnowledgeSource(db, actor, libraryId, subscriptionId);
  // Confirmation enables a source; only reviewed AI summaries become knowledge.
  await db
    .updateTable("knowledge_subscriptions")
    .set({ status: "active" })
    .where("id", "=", row.id)
    .execute();
  return {
    ...(await publicSubscription(db, { ...row, status: "active" })),
    included: 0,
  };
}

export async function dismissKnowledgeSubscription(
  db: DB,
  actor: Actor,
  libraryId: string,
  subscriptionId: string,
) {
  await authorize(db, actor, libraryId, 4);
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .select(["id", "status"])
    .where("id", "=", subscriptionId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  const source = await db
    .selectFrom("knowledge_subscriptions")
    .select("creator_id")
    .where("id", "=", row.id)
    .executeTakeFirstOrThrow();
  const library = await db
    .selectFrom("resources")
    .select("owner_id")
    .where("id", "=", libraryId)
    .executeTakeFirstOrThrow();

  if (row.status !== "pending") fail(400, "只有等待确认的连线可以不加入");
  await db
    .deleteFrom("knowledge_subscriptions")
    .where("id", "=", row.id)
    .execute();
  return { ok: true };
}


async function publicSubscription(
  db: DB,
  row: {
    id: string;
    source_kind: string;
    source_id: string;
    url: string;
    source_version: string;
    status: string;
    created_at: string;
  },
) {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    url: row.url,
    status: row.status,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
  };
}

async function pendingStatus(
  db: DB,
  row: {
    source_kind: string;
    source_id: string;
    url: string;
    source_version: string;
    status: string;
  },
) {
  return (await subscriptionStatus(db, row)) === "missing"
    ? "missing"
    : "pending";
}

async function sourceTitle(
  db: DB,
  row: { source_kind: string; source_id: string; url: string },
) {
  if (row.source_kind === "content") return (await db.selectFrom("knowledge_source_groups").select("title").where("id","=",row.source_id).executeTakeFirst())?.title ?? "";
  if (row.url) return row.url;
  if (row.source_kind === "document" || row.source_kind === "library") {
    const resource = await db
      .selectFrom("resources")
      .select("title")
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    return resource?.title ?? "";
  }
  if (row.source_kind === "file") {
    const file = await db
      .selectFrom("file_items")
      .select("name")
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    return file?.name ?? "";
  }
  if (row.source_kind === "folder") {
    const folder = await db
      .selectFrom("file_folders")
      .select("name")
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    return folder?.name ?? "";
  }
  return "";
}

async function subscriptionStatus(
  db: DB,
  row: {
    source_kind: string;
    source_id: string;
    url: string;
    source_version: string;
    status: string;
  },
) {
  if (row.source_kind === "content") return row.status;
  if (row.source_kind === "url")
    return row.status === "missing" ? "missing" : "active";
  if (row.source_kind === "document" || row.source_kind === "library") {
    const resource = await db
      .selectFrom("resources")
      .select(["version", "deleted_at"])
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    if (!resource || resource.deleted_at) return "missing";
    return String(resource.version) === row.source_version ? "active" : "stale";
  }
  if (row.source_kind === "file") {
    const file = await db
      .selectFrom("file_items")
      .select(["updated_at", "deleted_at"])
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    if (!file || file.deleted_at) return "missing";
    return file.updated_at === row.source_version ? "active" : "stale";
  }
  if (row.source_kind === "folder") {
    const folder = await db
      .selectFrom("file_folders")
      .select(["updated_at", "deleted_at"])
      .where("id", "=", row.source_id)
      .executeTakeFirst();
    if (!folder || folder.deleted_at) return "missing";
    return folder.updated_at === row.source_version ? "active" : "stale";
  }
  return "missing";
}

async function readSource(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: { sourceKind: SubscriptionKind; sourceId?: string; url?: string },
) {
  if (input.sourceKind === "url") {
    const url = normalizeSubscriptionUrl(input.url ?? "");
    return {
      sourceId: "",
      url,
      version: "",
      title: urlHost(url),
      markdown: nodeMarkdown(urlHost(url), url, `链接：${url}`),
    };
  }
  const sourceId = input.sourceId ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) fail(400, "来源不存在");
  if (input.sourceKind === "document" || input.sourceKind === "library") {
    const resource = await authorize(db, actor, sourceId, 1);
    if (resource.resource.kind !== input.sourceKind)
      fail(400, "来源类型与所选内容不符");
    if (sourceId === libraryId) fail(400, "不能将当前知识库作为自身来源");
    if (resource.resource.library_id === libraryId)
      fail(400, "这篇已经在这个知识库里");
    const state = await db
      .selectFrom("document_states")
      .select("text")
      .where("resource_id", "=", sourceId)
      .executeTakeFirst();
    const text = (state?.text ?? "").trim();
    return {
      sourceId,
      url: "",
      version: String(resource.resource.version),
      title: resource.resource.title,
      markdown: nodeMarkdown(
        resource.resource.title,
        text || resource.resource.title,
        `来源文档：${resource.resource.title}`,
      ),
    };
  }
  if (input.sourceKind === "file") {
    const file = await db
      .selectFrom("file_items")
      .select([
        "id",
        "owner_id",
        "name",
        "ai_description_override",
        "updated_at",
        "deleted_at",
      ])
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (!file || file.deleted_at) fail(404, "文件不存在");
    await authorizeFileItem(db, actor, sourceId);
    const chunks = await db
      .selectFrom("knowledge_chunks")
      .select("text")
      .where("source_kind", "=", "file")
      .where("source_id", "=", sourceId)
      .orderBy("ordinal")
      .limit(8)
      .execute();
    const text = [
      file.ai_description_override,
      ...chunks.map((chunk) => chunk.text),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      sourceId,
      url: "",
      version: file.updated_at,
      title: file.name,
      markdown: nodeMarkdown(
        file.name,
        text || file.name,
        `来源文件：${file.name}`,
      ),
    };
  }
  if (input.sourceKind === "folder") {
    const folder = await db
      .selectFrom("file_folders")
      .select(["id", "owner_id", "name", "updated_at", "deleted_at"])
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (!folder || folder.deleted_at) fail(404, "文件夹不存在");
    await authorizeFileFolder(db, actor, sourceId);
    return {
      sourceId,
      url: "",
      version: folder.updated_at,
      title: folder.name,
      markdown: nodeMarkdown(
        folder.name,
        `文件夹「${folder.name}」里的文件会写进这个知识库的对应节点。`,
        `来源文件夹：${folder.name}`,
      ),
    };
  }
  fail(400, "不支持的来源类型");
}

function nodeMarkdown(title: string, body: string, sourceLine: string) { return [title, body, sourceLine].join("\n"); }

function normalizeSubscriptionUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail(400, "链接需要写成 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    fail(400, "链接需要写成 http 或 https 地址");
  if (!url.hostname || url.username || url.password)
    fail(400, "链接需要写成 http 或 https 地址");
  return url.toString().slice(0, 500);
}

function urlHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

export async function updateKnowledgeSourceGroup(
  db: DB,
  actor: Actor,
  libraryId: string,
  groupId: string,
  input: {
    title?: string;
    sourceIds?: string[];
    urls?: string[];
  },
) {
  await authorize(db, actor, libraryId, 4);
  const group = await db
    .selectFrom("knowledge_source_groups")
    .selectAll()
    .where("id", "=", groupId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!group) fail(404, "来源组不存在");
  if (group.source_kind === "url" ? !!input.sourceIds : !!input.urls)
    fail(400, "不能更改来源组类型或混入其他类型");
  const targets = group.source_kind === "url" ? input.urls : input.sourceIds;
  if(targets){const members=await db.selectFrom("knowledge_subscriptions").select("creator_id").where("group_id","=",groupId).execute();if(members.some(member=>member.creator_id!==actor.id))fail(403,"Only the contributors can modify source authorization scopes");}
  const persist = async (tx: DB) => {
    if (input.title !== undefined) {
      if (!input.title.trim()) fail(400, "来源名称不能为空");
      await tx
        .updateTable("knowledge_source_groups")
        .set({ title: input.title.trim().slice(0, 200) })
        .where("id", "=", groupId)
        .execute();
    }
    if (targets) {
      const unique = [...new Set(targets)];
      if (!unique.length || unique.length > 500)
        fail(400, "请选择 1 至 500 项同类来源");
      const ids: string[] = [];
      for (const target of unique) {
        const member = await subscribeKnowledgeSource(tx, actor, libraryId, {
          sourceKind: subscriptionKind(group.source_kind),
          ...(group.source_kind === "url"
            ? { url: target }
            : { sourceId: target }),
        });
        const current = await tx
          .selectFrom("knowledge_subscriptions")
          .select("group_id")
          .where("id", "=", member.id)
          .executeTakeFirstOrThrow();
        if (current.group_id && current.group_id !== groupId)
          fail(409, "内容已属于其他来源组");
        ids.push(member.id);
      }
      // Keep provenance for published documents after removal; detached entries no longer ingest.
      await tx
        .updateTable("knowledge_subscriptions")
        .set({ status: "detached" })
        .where("group_id", "=", groupId)
        .where("id", "not in", ids)
        .execute();
      await tx
        .updateTable("knowledge_subscriptions")
        .set({ group_id: groupId })
        .where("id", "in", ids)
        .execute();
    }
    return { id: groupId };
  };
  return db.isTransaction ? persist(db) : db.transaction().execute(persist);
}

export async function deleteKnowledgeSourceGroup(
  db: DB,
  actor: Actor,
  libraryId: string,
  groupId: string,
) {
  await authorize(db, actor, libraryId, 4);
  const group = await db
    .selectFrom("knowledge_source_groups")
    .select("id")
    .where("id", "=", groupId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!group) fail(404, "来源组不存在");
  const persist = async (tx: DB) => {
    await tx
      .updateTable("knowledge_subscriptions")
      .set({ status: "detached" })
      .where("library_id", "=", libraryId)
      .where("group_id", "=", groupId)
      .where("status", "!=", "detached")
      .execute();
    await tx
      .deleteFrom("knowledge_source_groups")
      .where("id", "=", groupId)
      .execute();
    return { deleted: true };
  };
  return db.isTransaction ? persist(db) : db.transaction().execute(persist);
}
