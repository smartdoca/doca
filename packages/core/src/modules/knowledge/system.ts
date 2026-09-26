import { knowledgeSourceMembers } from "./source-members.js";
import { knowledgeDocumentSnapshot } from "./document-snapshot.js";
import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";
import { distributionPolicy } from "../deployment/policies.js";
import { audienceDecision } from "../access/distribution-behavior.js";
import {
  checkPublication,
  requireCapability,
} from "../access/operation-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Transaction } from "kysely";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor, authorize } from "../access/queries.js";
import { AppError, fail } from "../../shared/errors.js";
import {
  writeKnowledgeRichDocument,
  type KnowledgeFigure,
} from "./rich-document.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function knowledgeFigures(value: unknown): KnowledgeFigure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((figure) => {
    if (!figure || (figure.type !== "flowchart" && figure.type !== "mindmap"))
      return [];
    const nodes = Array.isArray(figure.nodes)
      ? figure.nodes.flatMap((node: { id?: string; label?: string; shape?: string }) =>
          typeof node?.id === "string" && typeof node.label === "string" && node.label
            ? [{ id: node.id, label: node.label, shape: node.shape }]
            : [],
        )
      : [];
    const edges = Array.isArray(figure.edges)
      ? figure.edges.flatMap((edge: { source?: string; target?: string }) =>
          typeof edge?.source === "string" && typeof edge.target === "string"
            ? [{ source: edge.source, target: edge.target }]
            : [],
        )
      : [];
    return nodes.length >= 2
      ? [{ type: figure.type as KnowledgeFigure["type"], nodes, edges }]
      : [];
  });
}
const gapStop = new Set(
  "什么 哪些 如何 是否 可以 不能 以及 其中 这个 一个 多少 怎么 还是".split(" "),
);
/** Topics and questions named in the guide that published knowledge does not yet cover. */
export function knowledgeOutlineGaps(
  guide: string,
  entries: { title: string; markdown: string; path?: string[]; status: string }[],
) {
  const published = entries.filter((entry) => entry.status === "published");
  const hay = published
    .map((entry) => `${(entry.path ?? []).join("\n")}\n${entry.title}\n${entry.markdown}`)
    .join("\n");
  const gaps: { key: string; title: string; path: string[]; detail: string }[] = [];
  const seen = new Set<string>();
  const add = (title: string, detail: string) => {
    const name = title.trim().slice(0, 80);
    if (!name || seen.has(name) || hay.includes(name)) return;
    seen.add(name);
    gaps.push({
      key: hash({ name }).slice(0, 16),
      title: name,
      path: [],
      detail,
    });
  };
  for (const match of guide.matchAll(/[“"]([^”"\n]{2,24})[”"]/g))
    add(match[1]!, `指引提到「${match[1]}」，已发布知识里还没有。`);
  for (const match of guide.matchAll(/[^。\n#？?]{6,80}[？?]/g)) {
    const question = match[0].replace(/^[\s\-*]+/, "").trim();
    const tokens = question
      .replace(/[？?，,。.（）()]/g, " ")
      .replace(/哪些|如何|什么|是否|多少|怎么/g, " ")
      .replace(/([A-Za-z0-9][A-Za-z0-9.-]*)/g, " $1 ")
      .split(/\s+|、|或|与|和/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !gapStop.has(token));
    const hits = tokens.filter((token) => {
      if (hay.includes(token)) return true;
      const chars = [...token];
      if (chars.length < 4) return false;
      return chars.some(
        (char, index) =>
          index > 0 &&
          /[\u4e00-\u9fff]/.test(chars[index - 1] + char) &&
          hay.includes(chars[index - 1] + char),
      );
    });
    if (tokens.length && hits.length / tokens.length >= 0.5) continue;
    add(question.replace(/[？?]$/, ""), question);
  }
  return gaps.slice(0, 8);
}
const sourcePolicySchema = z
  .object({
    redactedTerms: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    redactContacts: z.boolean().default(false),
    excludedResourceIds: z.array(z.string().uuid()).max(200).default([]),
    linkAccess: z.enum(["public", "follow", "closed"]).default("public"),
  })
  .strict();
export const knowledgeSettingsSchema = z
  .object({
    modelId: z.string().max(64).default(""),
    maxDocumentDepth: z.number().int().min(1).max(8).default(3),
    autoPublishWeighted: z.boolean().default(false),
    publicationMode: z.enum(["automatic", "manual"]).default("automatic"),
    sourceScope: z.enum(["internal", "web"]).default("web"),
    automationPolicy: z.enum(["safe", "draft"]).default("safe"),
    sourcePolicies: z.record(z.string().uuid(), sourcePolicySchema).default({}),
    excludedSourceIds: z.array(z.string().uuid()).max(5000).default([]),
    redactedTerms: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    redactContacts: z.boolean().default(false),
  })
  .strict();
export type KnowledgeSettings = z.infer<typeof knowledgeSettingsSchema>;
/** Assistant patches preserve omitted settings, including source-local safety rules. */
export const knowledgeSettingsPatchSchema = z.object({
  publicationMode: knowledgeSettingsSchema.shape.publicationMode.removeDefault().optional(),
  sourceScope: knowledgeSettingsSchema.shape.sourceScope.removeDefault().optional(),
  automationPolicy: knowledgeSettingsSchema.shape.automationPolicy.removeDefault().optional(),
  modelId: knowledgeSettingsSchema.shape.modelId.removeDefault().optional(),
  maxDocumentDepth: knowledgeSettingsSchema.shape.maxDocumentDepth.removeDefault().optional(),
  autoPublishWeighted: knowledgeSettingsSchema.shape.autoPublishWeighted.removeDefault().optional(),
  excludedSourceIds: knowledgeSettingsSchema.shape.excludedSourceIds.removeDefault().optional(),
  redactedTerms: knowledgeSettingsSchema.shape.redactedTerms.removeDefault().optional(),
  redactContacts: knowledgeSettingsSchema.shape.redactContacts.removeDefault().optional(),
  sourcePolicies: z.record(z.string().uuid(), z.object({
    redactedTerms: sourcePolicySchema.shape.redactedTerms.removeDefault().optional(),
    redactContacts: sourcePolicySchema.shape.redactContacts.removeDefault().optional(),
    excludedResourceIds: sourcePolicySchema.shape.excludedResourceIds.removeDefault().optional(),
    linkAccess: sourcePolicySchema.shape.linkAccess.removeDefault().optional(),
  }).strict()).optional(),
}).strict();
export function mergeKnowledgeSettings(current: KnowledgeSettings, patch: z.infer<typeof knowledgeSettingsPatchSchema>): KnowledgeSettings {
  return knowledgeSettingsSchema.parse({ ...current, ...patch, sourcePolicies: {
    ...current.sourcePolicies,
    ...Object.fromEntries(Object.entries(patch.sourcePolicies ?? {}).map(([id, policy]) => [id, { ...current.sourcePolicies[id], ...policy }])),
  } });
}

export const instructionInput = z
  .object({
    path: z.string().max(160),
    markdown: z.string().max(40000),
    expectedRevision: z.number().int().min(0),
  })
  .strict();
const knowledgePath = z.array(z.string().trim().min(1).max(100)).max(7);
export const entryInput = z
  .object({
    path: knowledgePath.optional(),
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().min(0),
    title: z.string().trim().min(1).max(200),
    markdown: z.string().trim().min(1).max(60000),
  })
  .strict();
export const assistantInput = z
  .object({
    visibility: z
      .enum(["invited", "authenticated", "public"])
      .default("invited"),
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().min(0),
    title: z.string().trim().min(1).max(200),
    libraryIds: z.array(z.string().uuid()).min(1).max(20),
    memberIds: z.array(z.string().uuid()).max(200),
    enabled: z.boolean(),
  })
  .strict();
export const mainInstruction = `# 知识库整理指引\n\n## 目标与读者\n说明知识库用于解决什么问题，服务哪些读者。\n\n## 范围与目录\n按知识主题组织，不按来源逐份复制。保留人工编写与修订。\n\n## 提炼规则\n按本库需要声明字段、去重、权威来源、权重与冲突规则。缺失或冲突列为待核实，不编造。\n\n## 独立知识\n形成无需打开来源即可使用的知识，保留条件、时间和单位；不保存原文副本或仅保存链接。\n\n## 来源缺失\n来源删除或撤权不删除知识，下次整理列出待处理项。确认保留后无新证据不重复提醒。\n\n## 验收问题\n列出应能回答的问题及不能推断的信息。\n`;
export async function maintainKnowledgeSource(
  db: DB,
  actor: Actor,
  libraryId: string,
  id: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const source = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!source) fail(404, "来源不存在");

  return source;
}
export async function sourceActor(db: DB, source: Schema["knowledge_subscriptions"]) {
  if (!source.creator_id) return null;
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", source.creator_id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) return null;
  try {
    await maintainKnowledge(db, actor, source.library_id);
    return actor;
  } catch (error) {
    if (error instanceof AppError && [401, 403, 404].includes(error.status))
      return null;
    throw error;
  }
}
export async function maintainKnowledge(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  await activeActor(db, actor);
  const access = await authorize(db, actor, libraryId, 4);
  if (access.resource.kind !== "library") fail(400, "目标不是知识库");
  return access.resource;
}
export async function knowledgeInstructions(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  const library = await maintainKnowledge(db, actor, libraryId);
  const rows = await db
    .selectFrom("knowledge_instructions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .orderBy("revision", "desc")
    .execute();
  const latest = new Map<
    string,
    { path: string; markdown: string; revision: number }
  >();
  for (const row of rows)
    if (!latest.has(row.path))
      latest.set(row.path, {
        path: row.path,
        markdown: row.markdown,
        revision: row.revision,
      });
  if (!latest.has("KNOWLEDGE.md")) {
    const old = await db
      .selectFrom("resources")
      .select(["guide_text", "guide_document_id", "knowledge_preset"])
      .where("id", "=", libraryId)
      .executeTakeFirstOrThrow();
    const legacy = old.guide_document_id
      ? await db
          .selectFrom("document_states")
          .select("text")
          .where("resource_id", "=", old.guide_document_id)
          .executeTakeFirst()
      : null;
    let note = "";
    try {
      note = JSON.parse(old.knowledge_preset || "{}").note || "";
    } catch {
      /* legacy empty preset */
    }
    latest.set("KNOWLEDGE.md", {
      path: "KNOWLEDGE.md",
      revision: 0,
      markdown: [old.guide_text || legacy?.text || mainInstruction, note]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  const subscriptions = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .execute();
  for (const source of subscriptions) {
    const path = `sources/${source.id}/SOURCE.md`;
    if (latest.has(path)) continue;
    let note = "";
    try {
      note = JSON.parse(source.preset || "{}").note || "";
    } catch {
      /* legacy empty preset */
    }
    latest.set(path, {
      path,
      revision: 0,
      markdown:
        note || "# 来源指引\n\n说明材料用途、提炼方法、权威范围与特殊限制。",
    });
  }
  const sourceLabels: Record<string, string> = {};
  for (const source of subscriptions) {
    if (!(await knowledgeSourceLinkVisible(db, actor, source, true))) continue;
    if (source.source_kind === "document" || source.source_kind === "library") {
      const reader = await sourceActor(db,source);
      if(reader) try { sourceLabels[source.id] = (await authorize(db,reader,source.source_id,1)).resource.title; } catch {}
    }
    else if (source.source_kind === "file" || source.source_kind === "folder") {
      const row = await db
        .selectFrom(
          source.source_kind === "file" ? "file_items" : "file_folders",
        )
        .select("name")
        .where("id", "=", source.source_id)
        .executeTakeFirst();
      sourceLabels[source.id] = row?.name ?? "";
    } else if (source.source_kind === "url")
      sourceLabels[source.id] = source.url;
  }
  const sourceIds = new Set(subscriptions.map(source => source.id));
  const files = [...latest.values()].filter(file => !file.path.startsWith("sources/") || sourceIds.has(file.path.split("/")[1]!)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if ([...new Set(files.map(f=>f.markdown))].reduce((n, markdown) => n + markdown.length, 0) > 120000)
    fail(413, "整理指引过长，请精简后重试");
  const settings = await db
    .selectFrom("knowledge_settings")
    .selectAll()
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  const config = knowledgeSettingsSchema.parse(
    settings ? JSON.parse(settings.config) : {},
  );
  return {
    libraryId,
    title: library.title,
    sourceLabels,
    sourcePermissions: Object.fromEntries(
      subscriptions.map((source) => [
        source.id,
        {
          kind: source.source_kind,
          canEdit: true,
          canDelete: true,
        },
      ]),
    ),
    files,
    settings: config,
    settingsRevision: settings?.revision ?? 0,
    hash: hash({ files, config }),
  };
}
/** Management UI/tools never reveal another creator's literal masking values. */
export async function knowledgeManagementView(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  const bundle = await knowledgeInstructions(db, actor, libraryId);

  const visibleSettings = await hideRestrictedKnowledgeLinks(
    db,
    actor,
    libraryId,
    bundle.settings,
  );
  return {
    ...bundle,
    files: bundle.files.map((file) => {
      const sourceId = file.path.startsWith("sources/")
        ? file.path.split("/")[1]!
        : "";
      return sourceId && !bundle.sourcePermissions[sourceId]?.canEdit
        ? {
            ...file,
            markdown: sanitizeKnowledge(
              file.markdown,
              effectiveKnowledgeSettings(visibleSettings, [sourceId]),
            ),
          }
        : file;
    }),
    sourceLabels: Object.fromEntries(
      Object.entries(bundle.sourceLabels).map(([id, title]) => [
        id,
        sanitizeKnowledge(
          title,
          effectiveKnowledgeSettings(visibleSettings, [id]),
        ),
      ]),
    ),
    settings: {
      ...bundle.settings,
      sourcePolicies: Object.fromEntries(
        Object.entries(bundle.settings.sourcePolicies).filter(
          ([id]) => bundle.sourcePermissions[id]?.canEdit,
        ),
      ),
    },
  };
}
export async function knowledgeRunHistory(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  const bundle = await knowledgeInstructions(db, actor, libraryId);
  const settings = effectiveKnowledgeSettings(
    await hideRestrictedKnowledgeLinks(db, actor, libraryId, bundle.settings),
    Object.keys(bundle.settings.sourcePolicies),
  );
  const runs = await db
    .selectFrom("knowledge_runs")
    .selectAll()
    .where("library_id", "=", libraryId)
    .orderBy("created_at", "desc")
    .limit(10)
    .execute();
  return runs.map((run) => {
    let detail;
    try {
      detail = JSON.parse(run.detail);
    } catch {
      return { ...run, detail: "{}" };
    }
    if (typeof detail.notes === "string")
      detail.notes = sanitizeKnowledge(detail.notes, settings);
    if (typeof detail.error === "string")
      detail.error = sanitizeKnowledge(detail.error, settings);
    if (Array.isArray(detail.reviews))
      detail.reviews = detail.reviews.map((review: { title?: string }) => ({
        ...review,
        title: sanitizeKnowledge(review.title || "", settings),
      }));
    return { ...run, detail: JSON.stringify(detail) };
  });
}
export async function saveKnowledgeInstruction(
  db: DB,
  actor: Actor,
  libraryId: string,
  raw: z.input<typeof instructionInput>,
) {
  const input = instructionInput.parse(raw);
  if (
    !/^(KNOWLEDGE\.md|guides\/[a-zA-Z0-9_-]+\.md|sources\/[0-9a-f-]{36}\/SOURCE\.md)$/.test(
      input.path,
    )
  )
    fail(400, "指引路径不正确");
  return transact(db, async (tx) => {
    await maintainKnowledge(tx, actor, libraryId);
    if (input.path.startsWith("sources/")) {
      const source = await maintainKnowledgeSource(
        tx,
        actor,
        libraryId,
        input.path.split("/")[1]!,
      );
    }
    const current = await tx
      .selectFrom("knowledge_instructions")
      .select("revision")
      .where("library_id", "=", libraryId)
      .where("path", "=", input.path)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if ((current?.revision ?? 0) !== input.expectedRevision)
      fail(409, "指引已被修改，请重新读取后保存");
    const revision = input.expectedRevision + 1;
    // The composite primary key also rejects simultaneous first writes.
    try {
      await tx
        .insertInto("knowledge_instructions")
        .values({
          library_id: libraryId,
          path: input.path,
          revision,
          markdown: input.markdown,
          author_id: actor.id,
          created_at: new Date().toISOString(),
        })
        .execute();
    } catch (error) {
      if (/unique|duplicate/i.test(String(error)))
        fail(409, "指引已被修改，请重新读取后保存");
      throw error;
    }
    return { path: input.path, revision, markdown: input.markdown };
  });
}
export async function saveKnowledgeSettings(
  db: DB,
  actor: Actor,
  libraryId: string,
  expectedRevision: number,
  raw: unknown,
) {
  const config = knowledgeSettingsSchema.parse(raw);
  return transact(db, async (tx) => {
    await maintainKnowledge(tx, actor, libraryId);
    const current = await tx
      .selectFrom("knowledge_settings")
      .selectAll()
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    if ((current?.revision ?? 0) !== expectedRevision)
      fail(409, "配置已被修改，请刷新");
    const previous = knowledgeSettingsSchema.parse(
      current ? JSON.parse(current.config) : {},
    );
    const ownedSources = new Set(
      (
        await tx
          .selectFrom("knowledge_subscriptions")
          .select("id")
          .where("library_id", "=", libraryId)
          .execute()
      ).map((source) => source.id),
    );
    for (const [id, policy] of Object.entries(previous.sourcePolicies)) {
      if (!ownedSources.has(id) && !(id in config.sourcePolicies))
        config.sourcePolicies[id] = policy;
    }
    const sourceIds = new Set([
      ...Object.keys(previous.sourcePolicies),
      ...Object.keys(config.sourcePolicies),
      ...previous.excludedSourceIds,
      ...config.excludedSourceIds,
    ]);
    for (const id of sourceIds) {
      if (
        hash(previous.sourcePolicies[id] ?? null) !==
          hash(config.sourcePolicies[id] ?? null) ||
        previous.excludedSourceIds.includes(id) !==
          config.excludedSourceIds.includes(id)
      )
        await maintainKnowledgeSource(tx, actor, libraryId, id);
    }
    const values = {
      revision: expectedRevision + 1,
      config: JSON.stringify(config),
      updated_at: new Date().toISOString(),
    };
    if (current) {
      const changed = await tx
        .updateTable("knowledge_settings")
        .set(values)
        .where("library_id", "=", libraryId)
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      if (!Number(changed.numUpdatedRows)) fail(409, "配置已被修改，请刷新");
    } else {
      const saved = await tx
        .insertInto("knowledge_settings")
        .values({ library_id: libraryId, ...values })
        .onConflict((oc) => oc.column("library_id").doNothing())
        .returning("revision")
        .executeTakeFirst();
      if (!saved) fail(409, "配置已被修改，请刷新");
    }
    // Safety changes apply to stored knowledge as well as future model input.
    // Source exclusions alone never invalidate knowledge.
    return {
      revision: values.revision,
      updatedAt: values.updated_at,
      settings: (await knowledgeManagementView(tx, actor, libraryId)).settings,
    };
  });
}
export function sanitizeKnowledge(text: string, settings: KnowledgeSettings) {
  let result = text;
  for (const term of settings.redactedTerms)
    result = result.split(term).join("[REDACTED]");
  if (settings.redactContacts)
    result = result
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
      .replace(/(?<![\w])\+?\d[\d ()-]{7,}\d(?![\w])/g, "[REDACTED]");
  return result;
}
export function effectiveKnowledgeSettings(
  settings: KnowledgeSettings,
  sourceIds: string[],
) {
  const policies = sourceIds
    .map((id) => settings.sourcePolicies[id])
    .filter(Boolean);
  return {
    ...settings,
    redactContacts:
      settings.redactContacts || policies.some((p) => p!.redactContacts),
    redactedTerms: [
      ...new Set([
        ...settings.redactedTerms,
        ...policies.flatMap((p) => p!.redactedTerms),
      ]),
    ],
  };
}
export type SourceRef = {
  subscriptionId: string;
  version: string;
  title?: string;
};
type Entry = Schema["knowledge_entries"];
const refsOf = (entry: Entry): SourceRef[] => JSON.parse(entry.source_refs);
const publicEntry = (entry: Entry) => ({
  ...entry,
  path: JSON.parse(entry.review_state).path ?? [],
  sourceRefs: refsOf(entry),
  reviewState: JSON.parse(entry.review_state),
});
export async function knowledgeEntries(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const row = await db
    .selectFrom("knowledge_settings")
    .select("config")
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  const settings = await hideRestrictedKnowledgeLinks(
    db,
    actor,
    libraryId,
    knowledgeSettingsSchema.parse(row ? JSON.parse(row.config) : {}),
  );
  const live = new Map((await knowledgeDocumentSnapshot(db, libraryId)).map(doc => [doc.id, doc]));
  return (
    await db
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("library_id", "=", libraryId)
      .where("status", "in", ["draft", "published"])
      .orderBy("updated_at", "desc")
      .execute()
  ).map((entry) => {
    const doc = entry.status === "published" ? live.get(JSON.parse(entry.review_state).nodeId) : undefined;
    if (doc) entry = { ...entry, title: doc.title, markdown: doc.markdown };
    const effective = effectiveKnowledgeSettings(
      settings,
      refsOf(entry).map((ref) => ref.subscriptionId),
    );
    return publicEntry({
      ...entry,
      title: sanitizeKnowledge(entry.title, effective),
      markdown: sanitizeKnowledge(entry.markdown, effective),
      source_refs: JSON.stringify(
        refsOf(entry).map((ref) => ({
          ...ref,
          ...(ref.title
            ? { title: sanitizeKnowledge(ref.title, effective) }
            : {}),
        })),
      ),
      review_state: JSON.stringify({
        ...JSON.parse(entry.review_state),
        path: (JSON.parse(entry.review_state).path ?? []).map(
          (segment: string) => sanitizeKnowledge(segment, effective),
        ),
        ...(JSON.parse(entry.review_state).humanChange
          ? {
              humanChange: {
                ...JSON.parse(entry.review_state).humanChange,
                change: {
                  ...JSON.parse(entry.review_state).humanChange.change,
                  removed: sanitizeKnowledge(
                    JSON.parse(entry.review_state).humanChange.change.removed,
                    effective,
                  ),
                  inserted: sanitizeKnowledge(
                    JSON.parse(entry.review_state).humanChange.change.inserted,
                    effective,
                  ),
                },
              },
            }
          : {}),
        ...(JSON.parse(entry.review_state).resolution
          ? {
              resolution: {
                ...JSON.parse(entry.review_state).resolution,
                ruleQuote: sanitizeKnowledge(
                  JSON.parse(entry.review_state).resolution.ruleQuote,
                  effective,
                ),
              },
            }
          : {}),
        reason: sanitizeKnowledge(
          JSON.parse(entry.review_state).reason ?? "",
          effective,
        ),
      }),
    });
  });
}
async function versionEntry(db: DB, entry: Entry, actor: Actor) {
  await db
    .insertInto("knowledge_entry_versions")
    .values({
      entry_id: entry.id,
      revision: entry.revision,
      snapshot: JSON.stringify(entry),
      author_id: actor.id,
      created_at: entry.updated_at,
    })
    .execute();
}
/** Human amendments are independent, immutable source records in entry version history. */
export async function knowledgeHumanChanges(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const records = await db
    .selectFrom("knowledge_entry_versions as v")
    .innerJoin("knowledge_entries as e", "e.id", "v.entry_id")
    .select([
      "v.snapshot",
      "v.author_id",
      "v.created_at",
      "v.entry_id",
      "v.revision",
    ])
    .where("e.library_id", "=", libraryId)
    .orderBy("v.created_at", "asc")
    .execute();
  const unique = new Map<
    string,
    {
      id: string;
      entryId: string;
      authorId: string;
      createdAt: string;
      title: string;
      change: { offset: number; removed: string; inserted: string };
      status: string;
    }
  >();
  const settings = await db
    .selectFrom("knowledge_settings")
    .select("config")
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  const config = knowledgeSettingsSchema.parse(
    settings ? JSON.parse(settings.config) : {},
  );
  for (const record of records) {
    const snapshot: Entry = JSON.parse(record.snapshot);
    const state = JSON.parse(snapshot.review_state);
    if (!state.humanChange) continue;
    const effective = effectiveKnowledgeSettings(
      config,
      refsOf(snapshot).map((ref) => ref.subscriptionId),
    );
    unique.set(state.humanChange.id, {
      id: state.humanChange.id,
      entryId: record.entry_id,
      authorId: state.humanChange.authorId ?? record.author_id,
      createdAt: state.humanChange.createdAt ?? record.created_at,
      title: sanitizeKnowledge(snapshot.title, effective),
      change: {
        ...state.humanChange.change,
        removed: sanitizeKnowledge(state.humanChange.change.removed, effective),
        inserted: sanitizeKnowledge(
          state.humanChange.change.inserted,
          effective,
        ),
      },
      status: snapshot.status,
    });
  }
  return [...unique.values()];
}
function humanDelta(before: string, after: string) {
  let start = 0,
    end = 0;
  while (
    start < Math.min(before.length, after.length) &&
    before[start] === after[start]
  )
    start++;
  while (
    end < Math.min(before.length, after.length) - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  return {
    offset: start,
    removed: before.slice(start, before.length - end),
    inserted: after.slice(start, after.length - end),
  };
}
function validateKnowledgePath(path: string[], maxDepth: number) {
  if (path.length + 1 > maxDepth) fail(400, "知识目录超过配置的最大层数");
  return path;
}
export async function saveHumanKnowledge(
  db: DB,
  actor: Actor,
  libraryId: string,
  raw: z.input<typeof entryInput>,
  provenance: "human" | "ai" = "human",
) {
  const input = entryInput.parse(raw);
  return transact(db, async (tx) => {
    const bundle = await knowledgeInstructions(tx, actor, libraryId);
    const current = input.id
      ? await tx
          .selectFrom("knowledge_entries")
          .selectAll()
          .where("id", "=", input.id)
          .where("library_id", "=", libraryId)
          .executeTakeFirst()
      : null;
    if (input.id && !current) fail(404, "知识不存在");
    if (
      (current?.revision ?? 0) !== input.expectedRevision ||
      current?.status === "deleted"
    )
      fail(409, "知识已变化，请刷新");
    const now = new Date().toISOString();
    const replacing = current?.status === "published";
    const entry: Entry = {
      id: replacing ? randomUUID() : (current?.id ?? randomUUID()),
      library_id: libraryId,
      title: sanitizeKnowledge(
        input.title,
        effectiveKnowledgeSettings(
          bundle.settings,
          current ? refsOf(current).map((ref) => ref.subscriptionId) : [],
        ),
      ),
      markdown: sanitizeKnowledge(
        input.markdown,
        effectiveKnowledgeSettings(
          bundle.settings,
          current ? refsOf(current).map((ref) => ref.subscriptionId) : [],
        ),
      ),
      origin:
        provenance === "ai" ? "ai_synthesized" : current && current.origin !== "human_authored"
          ? "human_revised"
          : "human_authored",
      status: "draft",
      revision: replacing ? 1 : input.expectedRevision + 1,
      source_refs: current?.source_refs ?? "[]",
      instruction_hash: bundle.hash,
      review_state: replacing
        ? JSON.stringify({
            ...JSON.parse(current.review_state),
            replaces: current.id,
            replacesRevision: current.revision,
          })
        : (current?.review_state ?? "{}"),
      author_id: actor.id,
      created_at: current?.created_at ?? now,
      updated_at: now,
    };
    const state = JSON.parse(entry.review_state);
    state.path = validateKnowledgePath(
      input.path ?? state.path ?? [],
      bundle.settings.maxDocumentDepth,
    );
    if (current) {
      const nodeId = JSON.parse(current.review_state).nodeId;
      if (nodeId) state.baseDocumentSeq = (await tx.selectFrom("document_states").select("seq").where("resource_id", "=", nodeId).executeTakeFirst())?.seq;
    }
    if(provenance === "human") state.humanChange = {
      id: randomUUID(),
      authorId: actor.id,
      createdAt: now,
      change: humanDelta(current?.markdown ?? "", entry.markdown),
    };
    else delete state.humanChange;
    entry.review_state = JSON.stringify(state);
    if (current && !replacing) {
      const saved = await tx
        .updateTable("knowledge_entries")
        .set(entry)
        .where("id", "=", entry.id)
        .where("revision", "=", input.expectedRevision)
        .executeTakeFirst();
      if (!Number(saved.numUpdatedRows)) fail(409, "知识已变化，请刷新");
    } else await tx.insertInto("knowledge_entries").values(entry).execute();
    await versionEntry(tx, entry, actor);
    return publicEntry(entry);
  });
}
async function insertKnowledgeDocument(
  tx: Transaction<Schema>,
  libraryId: string,
  ownerId: string,
  parentId: string | null,
  title: string,
  markdown: string,
  figures: KnowledgeFigure[] = [],
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await tx
    .insertInto("resources")
    .values({
      id,
      kind: "document",
      format: "rich_text",
      title: title.slice(0, 160),
      owner_id: ownerId,
      library_id: libraryId,
      parent_id: parentId,
      access_mode: "inherit",
      visibility: "invited",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
      requests_enabled: 0,
      tree_order: 0,
      authz_revision: 1,
      history_readers: 0,
      discoverable: 0,
      public_role: "reader",
      content_bytes: Buffer.byteLength(markdown),
      share_links_enabled: 0,
      permission_overrides: 0,
      ai_curated: 0,
      guide_text: "",
      knowledge_schedule: "off",
      knowledge_preset: "",
    })
    .execute();
  await writeKnowledgeRichDocument(tx, id, markdown, figures);
  return id;
}

/** Published knowledge becomes the library document tree: path segments are parent documents, the entry is the leaf. */
export async function projectKnowledgeEntry(
  tx: Transaction<Schema>,
  libraryId: string,
  ownerId: string,
  entry: { id: string; title: string; markdown: string; review_state: string },
) {
  const state = JSON.parse(entry.review_state) as {
    path?: string[];
    nodeId?: string;
    figures?: unknown;
    projectedHash?: string;
    projectedSeq?: number;
  };
  const path = (state.path ?? []).filter((segment) => segment.trim());
  let parentId: string | null = null;
  const segments: string[] = [];
  for (const segment of path) {
    segments.push(segment);
    const key = segments.join("\u001f");
    const recorded = await tx
      .selectFrom("knowledge_directories")
      .select("resource_id")
      .where("library_id", "=", libraryId)
      .where("path", "=", key)
      .executeTakeFirst();
    const live = recorded
      ? await tx
          .selectFrom("resources")
          .select("id")
          .where("id", "=", recorded.resource_id)
          .where("deleted_at", "is", null)
          .executeTakeFirst()
      : undefined;
    if (live) {
      const directory = await tx
        .selectFrom("resources")
        .select("format")
        .where("id", "=", live.id)
        .executeTakeFirst();
      if (directory?.format !== "rich_text")
        await writeKnowledgeRichDocument(tx, live.id, `# ${segment}\n`);
      parentId = live.id;
    } else {
      parentId = await insertKnowledgeDocument(
        tx,
        libraryId,
        ownerId,
        parentId,
        segment,
        `# ${segment}\n`,
      );
      if (recorded)
        await tx
          .updateTable("knowledge_directories")
          .set({ resource_id: parentId })
          .where("library_id", "=", libraryId)
          .where("path", "=", key)
          .execute();
      else
        await tx
          .insertInto("knowledge_directories")
          .values({ library_id: libraryId, path: key, resource_id: parentId })
          .execute();
    }
  }
  const figures = knowledgeFigures(state.figures);
  const contentHash = hash({ markdown: entry.markdown, figures });
  const markdown = entry.markdown.startsWith("#")
    ? entry.markdown
    : `# ${entry.title}\n\n${entry.markdown}`;
  const liveNode = state.nodeId
    ? await tx
        .selectFrom("resources")
        .select(["id", "format", "title", "parent_id"])
        .where("id", "=", state.nodeId)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    : undefined;
  const placed =
    liveNode?.title === entry.title.slice(0, 160) &&
    (liveNode?.parent_id ?? null) === parentId;
  if (
    liveNode?.format === "rich_text" &&
    state.projectedHash === contentHash &&
    placed
  )
    return liveNode.id;
  const nodeId =
    liveNode?.id ??
    (await insertKnowledgeDocument(
      tx,
      libraryId,
      ownerId,
      parentId,
      entry.title,
      markdown,
      figures,
    ));
  if (liveNode) {
    if (!placed)
      await tx
        .updateTable("resources")
        .set({
          title: entry.title.slice(0, 160),
          parent_id: parentId,
          library_id: libraryId,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", liveNode.id)
        .execute();
    await writeKnowledgeRichDocument(tx, liveNode.id, markdown, figures);
  }
  state.nodeId = nodeId;
  state.projectedHash = contentHash;
  state.projectedSeq = (await tx.selectFrom("document_states").select("seq").where("resource_id", "=", nodeId).executeTakeFirst())?.seq;
  await tx
    .updateTable("knowledge_entries")
    .set({ review_state: JSON.stringify(state) })
    .where("id", "=", entry.id)
    .execute();
  return nodeId;
}

export async function projectPublishedKnowledge(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  const library = await db
    .selectFrom("resources")
    .select("owner_id")
    .where("id", "=", libraryId)
    .executeTakeFirst();
  if (!library) return;
  const published = await db
    .selectFrom("knowledge_entries")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("status", "=", "published")
    .execute();
  if (!published.length) return;
  await transact(db, async (tx) => {
    for (const entry of published)
      await projectKnowledgeEntry(tx, libraryId, library.owner_id, entry);
  });
}

export async function reviewKnowledgeEntry(
  db: DB,
  actor: Actor,
  libraryId: string,
  id: string,
  expectedRevision: number,
  action: "publish" | "keep" | "delete",
) {
  return transact(db, async (tx) => {
    const bundle = await knowledgeInstructions(tx, actor, libraryId);
    const row = await tx
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("id", "=", id)
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    if (!row || row.status === "deleted") fail(404, "知识不存在");
    if (row.revision !== expectedRevision) fail(409, "知识已变化，请刷新");
    if (action === "publish" && row.status !== "draft")
      fail(409, "只能发布待审核草稿");
    if (action === "publish" && row.instruction_hash !== bundle.hash)
      fail(409, "指引或安全配置已变化，请重新整理或编辑后发布");
    const state = JSON.parse(row.review_state);
    if (action === "publish" && state.replaces) {
      const original = await tx
        .selectFrom("knowledge_entries")
        .selectAll()
        .where("id", "=", state.replaces)
        .where("library_id", "=", libraryId)
        .where("status", "=", "published")
        .where("revision", "=", state.replacesRevision)
        .executeTakeFirst();
      if (!original) fail(409, "原知识已变化，请核对后重新发布");
      const originalState = JSON.parse(original.review_state);
      if (originalState.nodeId) {
        const live = await tx.selectFrom("document_states").select("seq").where("resource_id", "=", originalState.nodeId).executeTakeFirst();
        if (live && live.seq !== (state.baseDocumentSeq ?? originalState.projectedSeq ?? 0))
          fail(409, "文档已有人工修改，请重新读取文档并生成修订建议");
      }
      if (!state.nodeId && typeof originalState.nodeId === "string")
        state.nodeId = originalState.nodeId;
      const archived = {
        ...original,
        status: "superseded",
        revision: original.revision + 1,
        updated_at: new Date().toISOString(),
      };
      const result = await tx
        .updateTable("knowledge_entries")
        .set(archived)
        .where("id", "=", original.id)
        .where("revision", "=", original.revision)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows)) fail(409, "原知识已变化，请刷新");
      await versionEntry(tx, archived, actor);
    }
    if (action === "keep") {
      const missing = await missingSources(tx, actor, libraryId, row);
      state.retainedMissing = missing.sort();
      state.retainedAt = new Date().toISOString();
      state.retainedBy = actor.id;
    }
    const updated = {
      ...row,
      revision: row.revision + 1,
      review_state: JSON.stringify(state),
      status:
        action === "publish"
          ? "published"
          : action === "delete"
            ? "deleted"
            : row.status,
      updated_at: new Date().toISOString(),
    };
    const result = await tx
      .updateTable("knowledge_entries")
      .set(updated)
      .where("id", "=", id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows)) fail(409, "知识已变化，请刷新");
    await versionEntry(tx, updated, actor);
    if (action === "publish") {
      const library = await tx
        .selectFrom("resources")
        .select("owner_id")
        .where("id", "=", libraryId)
        .executeTakeFirstOrThrow();
      await projectKnowledgeEntry(tx, libraryId, library.owner_id, {
        ...updated,
        review_state: updated.review_state,
      });
    }
    const stored = await tx
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("id", "=", updated.id)
      .executeTakeFirstOrThrow();
    return publicEntry(stored);
  });
}

/** Metadata checks never load source text, and are never used during Q&A. */
export async function sourceAvailable(
  db: DB,
  actor: Actor,
  row: Schema["knowledge_subscriptions"],
) {
  try {
    if (row.status === "detached") return false;
    if (row.source_kind === "url") return row.status !== "missing";
    if (row.source_kind === "document" || row.source_kind === "library") {
      await authorize(db, actor, row.source_id, 1);
      return true;
    }
    if (row.source_kind === "file") {
      await authorizeFileItem(db, actor, row.source_id);
      return true;
    }
    if (row.source_kind === "folder") {
      await authorizeFileFolder(db, actor, row.source_id);
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.status))
      return false;
    throw error;
  }
}
/** Link visibility is independent of ingestion access and knowledge search access. */
export async function knowledgeSourceLinkVisible(
  db: DB,
  actor: Actor,
  source: Schema["knowledge_subscriptions"],
  managing = false,
) {
  if (managing) {
    try { await maintainKnowledge(db, actor, source.library_id); return true; } catch {}
  }
  if (!(await sourceAvailable(db, actor, source))) return false;
  if (source.source_kind !== "url") return true;
  const settings = await db
    .selectFrom("knowledge_settings")
    .select("config")
    .where("library_id", "=", source.library_id)
    .executeTakeFirst();
  const policy =
    knowledgeSettingsSchema.parse(settings ? JSON.parse(settings.config) : {})
      .sourcePolicies[source.id]?.linkAccess ?? "public";
  return (
    policy === "public" ||
    (policy === "follow" && source.creator_id === actor.id)
  );
}

export async function hideRestrictedKnowledgeLinks(
  db: DB,
  actor: Actor,
  libraryId: string,
  settings: KnowledgeSettings,
) {
  const sources = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("source_kind", "=", "url")
    .execute();
  const hidden: string[] = [];
  for (const source of sources)
    if (!(await knowledgeSourceLinkVisible(db, actor, source, true)))
      hidden.push(source.url);
  return {
    ...settings,
    redactedTerms: [...settings.redactedTerms, ...hidden.filter(Boolean)],
  };
}

export type KnowledgeCitation = { id: string; title: string; href?: string };
async function knowledgeCitations(
  db: DB,
  actor: Actor,
  entry: Entry,
  settings: KnowledgeSettings,
): Promise<KnowledgeCitation[]> {
  const citations: KnowledgeCitation[] = [];
  for (const ref of refsOf(entry)) {
    const source = await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("id", "=", ref.subscriptionId)
      .where("library_id", "=", entry.library_id)
      .executeTakeFirst();
    // A stable, non-sensitive label survives source deletion. Never expose credential URLs as labels.
    const citation: KnowledgeCitation = {
      id: ref.subscriptionId,
      title: sanitizeKnowledge(
        ref.title || `来源 ${citations.length + 1}`,
        settings,
      ),
    };
    if (source && (await knowledgeSourceLinkVisible(db, actor, source))) {
      if (source.source_kind === "url" && /^https?:\/\//i.test(source.url))
        citation.href = source.url;
      else if (source.source_kind === "file")
        citation.href = `/api/v1/files/items/${source.source_id}/content`;
      else if (source.source_kind === "document")
        citation.href = `/#/r/${source.source_id}`;
    }
    citations.push(citation);
  }
  return citations;
}
async function missingSources(
  db: DB,
  actor: Actor,
  libraryId: string,
  entry: Entry,
) {
  if (entry.origin === "human_authored") return [];
  const missing: string[] = [];
  for (const ref of refsOf(entry)) {
    const source = await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("library_id", "=", libraryId)
      .where("id", "=", ref.subscriptionId)
      .executeTakeFirst();
    const owner = source ? await sourceActor(db, source) : null;
    if (!source || !owner || !(await sourceAvailable(db, owner, source)))
      missing.push(ref.subscriptionId);
  }
  return missing;
}
export async function knowledgeSourceReviews(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  const bundle = await knowledgeInstructions(db, actor, libraryId);
  const entries = await db
    .selectFrom("knowledge_entries")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("status", "in", ["draft", "published"])
    .execute();
  const reviews = [];
  for (const entry of entries) {
    const missing = await missingSources(db, actor, libraryId, entry);
    const retained: string[] =
      JSON.parse(entry.review_state).retainedMissing ?? [];
    if (missing.some((id) => !retained.includes(id)))
      reviews.push({
        id: entry.id,
        revision: entry.revision,
        title: sanitizeKnowledge(
          entry.title,
          effectiveKnowledgeSettings(
            bundle.settings,
            refsOf(entry).map((ref) => ref.subscriptionId),
          ),
        ),
        origin: entry.origin,
        missingSourceIds: missing,
      });
  }
  return reviews;
}
export async function detachKnowledgeSource(
  db: DB,
  actor: Actor,
  libraryId: string,
  id: string,
) {
  const library = await maintainKnowledge(db, actor, libraryId);
  const source = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", id)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!source) fail(404, "来源不存在");

  const result = await db
    .updateTable("knowledge_subscriptions")
    .set({ status: "detached" })
    .where("library_id", "=", libraryId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!Number(result.numUpdatedRows)) fail(404, "来源不存在");
  return { detached: true, knowledgeRetained: true };
}

export type CurationMaterial = {
  subscriptionId: string;
  version: string;
  title: string;
  text: string;
};
export type CurationBundle = Awaited<ReturnType<typeof knowledgeInstructions>>;
export const curationOutput = z
  .object({
    entries: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            markdown: z.string().trim().min(1).max(60000),
            sourceIds: z.array(z.string().uuid()).min(1).max(100),
            reason: z.string().max(4000),
            replacesId: z.string().uuid().optional(),
            path: knowledgePath.optional(),
            figures: z
              .array(
                z
                  .object({
                    type: z.enum(["flowchart", "mindmap"]),
                    nodes: z
                      .array(
                        z
                          .object({
                            id: z.string().trim().min(1).max(40),
                            label: z.string().trim().min(1).max(80),
                            shape: z.string().max(40).optional(),
                          })
                          .strict(),
                      )
                      .min(2)
                      .max(12),
                    edges: z
                      .array(
                        z
                          .object({
                            source: z.string().min(1).max(40),
                            target: z.string().min(1).max(40),
                          })
                          .strict(),
                      )
                      .max(16),
                  })
                  .strict(),
              )
              .max(2)
              .optional(),
            resolution: z
              .object({
                mode: z.enum(["review", "weighted"]),
                rulePath: z.string().max(160),
                ruleQuote: z.string().max(2000),
                existingWeight: z.number().finite(),
                incomingWeight: z.number().finite(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(30),
    notes: z.string().max(8000),
  })
  .strict();
export type CurationGenerator = (input: {
  bundle: CurationBundle;
  materials: CurationMaterial[];
  humanChanges?: Awaited<ReturnType<typeof knowledgeHumanChanges>>;
  existing: {
    id: string;
    title: string;
    markdown: string;
    origin: string;
    status: string;
    path?: string[];
    sourceIds?: string[];
  }[];
  focus?: KnowledgeFocus;
}) => Promise<z.infer<typeof curationOutput>>;
export type KnowledgeFocus = {
  title: string;
  path: string[];
  detail: string;
};

export async function queueKnowledgeCuration(
  db: DB,
  actor: Actor,
  libraryId: string,
  trigger = "manual",
  focus?: KnowledgeFocus,
) {
  return transact(db, async (tx) => {
    const library = await maintainKnowledge(tx, actor, libraryId);
    if (!Number(library.ai_curated)) fail(400, "先启用知识体系");
    await tx
      .updateTable("resources")
      .set({ ai_curated: sql`ai_curated` })
      .where("id", "=", libraryId)
      .execute();
    const bundle = await knowledgeInstructions(tx, actor, libraryId);
    const active = await tx
      .selectFrom("knowledge_runs")
      .select(["id", "status"])
      .where("library_id", "=", libraryId)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (active) return active;
    const id = randomUUID();
    await tx
      .insertInto("knowledge_runs")
      .values({
        id,
        library_id: libraryId,
        trigger,
        status: "queued",
        detail: JSON.stringify({
          actorId: actor.id,
          instructionHash: bundle.hash,
          queuedAt: new Date().toISOString(),
          ...(focus
            ? {
                focus: {
                  title: focus.title.trim().slice(0, 80),
                  path: focus.path
                    .map((segment) => segment.trim())
                    .filter(Boolean)
                    .slice(0, 8),
                  detail: focus.detail.trim().slice(0, 400),
                },
              }
            : {}),
        }),
        created_at: new Date().toISOString(),
      })
      .execute();
    return { id, status: "queued" };
  });
}

export async function cancelKnowledgeCuration(
  db: DB,
  actor: Actor,
  libraryId: string,
  runId: string,
) {
  await maintainKnowledge(db, actor, libraryId);
  await db
    .updateTable("knowledge_runs")
    .set({ status: "canceled" })
    .where("id", "=", runId)
    .where("library_id", "=", libraryId)
    .where("status", "in", ["queued", "running"])
    .execute();
  return { canceled: true };
}

export async function executeKnowledgeCuration(
  db: DB,
  runId: string,
  generate: CurationGenerator,
  readWeb?: (url: string) => Promise<{ title: string; text: string }>,
) {
  const run = await db
    .selectFrom("knowledge_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const detail = JSON.parse(run.detail);
  const claim = await db
    .updateTable("knowledge_runs")
    .set({
      status: "running",
      detail: JSON.stringify({
        ...detail,
        startedAt: new Date().toISOString(),
      }),
    })
    .where("id", "=", runId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (!Number(claim.numUpdatedRows)) return;
  try {
    const actor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", detail.actorId)
      .executeTakeFirstOrThrow();
    const bundle = await knowledgeInstructions(db, actor, run.library_id);
    if (bundle.hash !== detail.instructionHash)
      fail(409, "指引已变化，请重新发起整理");
    const subscriptions = await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("library_id", "=", run.library_id)
      .where("status", "!=", "detached")
      .execute();
    const materials: CurationMaterial[] = [];
    const readGuards: ((connection: DB) => Promise<void>)[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const source of subscriptions) {
      if(bundle.settings.sourceScope === "internal" && source.source_kind === "url") {
        skipped.push({id:source.id,reason:"internal_sources_only"});continue;
      }
      const actor = await sourceActor(db, source);
      if (!actor) {
        skipped.push({ id: source.id, reason: "creator_unavailable" });
        continue;
      }
      if (bundle.settings.excludedSourceIds.includes(source.id)) {
        skipped.push({ id: source.id, reason: "excluded" });
        continue;
      }
      if (run.trigger === "schedule") {
        let frequency = "inherit";
        try {
          frequency = JSON.parse(source.preset || "{}").frequency ?? "inherit";
        } catch {
          /* legacy */
        }
        if (frequency === "off") continue;
      }
      if (!(await sourceAvailable(db, actor, source))) {
        skipped.push({ id: source.id, reason: "unavailable" });
        continue;
      }
      const policy = bundle.settings.sourcePolicies[source.id];
      const denied = new Set(policy?.excludedResourceIds ?? []);
      if (denied.has(source.source_id)) {
        skipped.push({ id: source.id, reason: "excluded" });
        continue;
      }
      const effectiveSettings = effectiveKnowledgeSettings(bundle.settings, [
        source.id,
      ]);
      let title = "",
        text = "",
        version = "";
      if (source.source_kind === "document" || source.source_kind === "library") {
        const access = await authorize(db, actor, source.source_id, 1);
        const members=await knowledgeSourceMembers(db,actor,source,[...denied]);
        const read=async(connection:DB)=>{
          const current=await knowledgeSourceMembers(connection,actor,source,[...denied]);
          const parts=[];
          for(const member of current){const state=await connection.selectFrom("document_states").select("text").where("resource_id","=",member.id).executeTakeFirst();parts.push(`# ${member.title}\n${state?.text??""}`);}
          return {members:current,text:parts.join("\n\n")};
        };
        const snapshot=await read(db);
        title=access.resource.title;text=snapshot.text;version=hash(snapshot);
        const expectedVersion=version;
        readGuards.push(async(connection)=>{await authorize(connection,actor,source.source_id,1);if(hash(await read(connection))!==expectedVersion)fail(409,"来源内容或范围已变化，请重新整理");});
      } else if (source.source_kind === "file") {
        const file = await db
          .selectFrom("file_items")
          .select(["name", "updated_at"])
          .where("id", "=", source.source_id)
          .executeTakeFirstOrThrow();
        const chunks = await db
          .selectFrom("knowledge_chunks")
          .select("text")
          .where("source_kind", "=", "file")
          .where("source_id", "=", source.source_id)
          .orderBy("ordinal")
          .execute();
        title = file.name;
        text = chunks.map((c) => c.text).join("\n\n");
        version = hash({ updatedAt: file.updated_at, chunks });
        const expectedVersion = version;
        readGuards.push(async (connection) => {
          const fresh = await connection
            .selectFrom("file_items")
            .selectAll()
            .where("id", "=", source.source_id)
            .executeTakeFirst();
          if (!fresh || fresh.deleted_at)
            fail(409, "来源授权已变化，请重新整理");
          await authorizeFileItem(connection, actor, source.source_id);
          const freshChunks = await connection
            .selectFrom("knowledge_chunks")
            .select("text")
            .where("source_kind", "=", "file")
            .where("source_id", "=", source.source_id)
            .orderBy("ordinal")
            .execute();
          if (
            fresh.name !== title ||
            hash({ updatedAt: fresh.updated_at, chunks: freshChunks }) !==
              expectedVersion
          )
            fail(409, "来源内容已变化，请重新整理");
        });
      } else if (source.source_kind === "folder") {
        const folder = await db
          .selectFrom("file_folders")
          .select(["name", "owner_id"])
          .where("id", "=", source.source_id)
          .executeTakeFirstOrThrow();
        const ids = [source.source_id];
        for (let index = 0; index < ids.length; index++) {
          const children = await db
            .selectFrom("file_folders")
            .select("id")
            .where("parent_id", "=", ids[index]!)
            .where("owner_id", "=", folder.owner_id)
            .where("deleted_at", "is", null)
            .limit(101)
            .execute();
          for (const child of children)
            if (!denied.has(child.id) && !ids.includes(child.id))
              ids.push(child.id);
          if (ids.length > 100) fail(413, "文件夹范围过大，请分别订阅子文件夹");
        }
        const files = await db
          .selectFrom("file_items")
          .select(["id", "name", "updated_at"])
          .where("parent_type", "=", "folder")
          .where("parent_id", "in", ids)
          .where("owner_id", "=", folder.owner_id)
          .where("deleted_at", "is", null)
          .orderBy("id")
          .limit(501)
          .execute();
        if (files.length > 500) fail(413, "文件夹文件过多，请分别订阅子文件夹");
        const parts: string[] = [];
        for (const file of files) {
          if (denied.has(file.id)) continue;
          const chunks = await db
            .selectFrom("knowledge_chunks")
            .select("text")
            .where("source_kind", "=", "file")
            .where("source_id", "=", file.id)
            .orderBy("ordinal")
            .execute();
          if (!chunks.length) {
            skipped.push({ id: source.id, reason: "file_not_parsed" });
            continue;
          }
          const expectedChunks = hash(chunks);
          readGuards.push(async (connection) => {
            const fresh = await connection
              .selectFrom("file_items")
              .selectAll()
              .where("id", "=", file.id)
              .executeTakeFirst();
            if (
              !fresh ||
              fresh.deleted_at ||
              fresh.owner_id !== folder.owner_id ||
              !ids.includes(fresh.parent_id ?? "") ||
              fresh.updated_at !== file.updated_at ||
              fresh.name !== file.name
            )
              fail(409, "文件夹来源已变化，请重新整理");
            await authorizeFileItem(connection, actor, file.id);
            for (const folderId of ids) {
              await authorizeFileFolder(connection, actor, folderId);
              const current = await connection
                .selectFrom("file_folders")
                .select(["owner_id", "deleted_at"])
                .where("id", "=", folderId)
                .executeTakeFirst();
              if (
                !current ||
                current.deleted_at ||
                current.owner_id !== folder.owner_id
              )
                fail(409, "文件夹授权已变化，请重新整理");
            }
            const currentChunks = await connection
              .selectFrom("knowledge_chunks")
              .select("text")
              .where("source_kind", "=", "file")
              .where("source_id", "=", file.id)
              .orderBy("ordinal")
              .execute();
            if (hash(currentChunks) !== expectedChunks)
              fail(409, "文件解析结果已变化，请重新整理");
          });
          parts.push(
            `# ${file.name}\n${chunks.map((c) => c.text).join("\n\n")}`,
          );
          if (parts.reduce((size, part) => size + part.length, 0) > 120000)
            fail(413, "文件夹正文过长，请缩小来源范围");
        }
        title = folder.name;
        text = parts.join("\n\n");
        version = hash({ files, text });
      } else if (source.source_kind === "url" && readWeb) {
        const page = await readWeb(source.url);
        title = page.title.split(source.url).join("[来源链接]");
        text = page.text.split(source.url).join("[来源链接]");
        version = hash(text);
      } else {
        skipped.push({ id: source.id, reason: "unsupported" });
        continue;
      }
      if (!text.trim()) {
        skipped.push({ id: source.id, reason: "not_parsed" });
        continue;
      }
      materials.push({
        subscriptionId: source.id,
        version,
        title: sanitizeKnowledge(title, effectiveSettings),
        text: sanitizeKnowledge(text, effectiveSettings),
      });
      if (materials.reduce((n, m) => n + m.text.length, 0) > 120000)
        fail(413, "材料过长，请缩小本次来源范围");
    }
    const existing = await db
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("library_id", "=", run.library_id)
      .execute();
    const currentDocuments = new Map((await knowledgeDocumentSnapshot(db, run.library_id)).map(doc => [doc.id, doc]));
    for (const entry of existing) {
      const doc = entry.status === "published" ? currentDocuments.get(JSON.parse(entry.review_state).nodeId) : undefined;
      if (doc) { entry.markdown = doc.markdown; entry.title = doc.title; }
    }
    const humanChanges = await knowledgeHumanChanges(db, actor, run.library_id);
    if (JSON.stringify(humanChanges).length > 120000)
      fail(413, "人工修订记录过长，请拆分知识库");
    const humanHash = hash(humanChanges);
    const priorRuns = await db
      .selectFrom("knowledge_runs")
      .select("detail")
      .where("library_id", "=", run.library_id)
      .where("status", "in", ["awaiting_review", "succeeded", "partial"])
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    const observed = new Set<string>();
    for (const previous of priorRuns) {
      const value = JSON.parse(previous.detail);
      if (
        value.instructionHash === bundle.hash &&
        (value.humanHash ?? hash([])) === humanHash
      )
        for (const fingerprint of value.materialFingerprints ?? [])
          observed.add(fingerprint);
    }
    const changedMaterials = materials.filter(
      (material) => !observed.has(hash(material)),
    );
    const focus = detail.focus as KnowledgeFocus | undefined;
    const targets = focus?.title ? materials : changedMaterials;
    const output: z.infer<typeof curationOutput> = {
      entries: [],
      notes:
        focus?.title && !targets.length
          ? "没有可读取的来源，这条缺口还补不上。"
          : "",
    };
    // Each source is extracted in isolation. Another source's instructions never
    // see its raw material; shared guidance cannot override source-local limits.
    for (const material of targets) {
      const currentRun = await db
        .selectFrom("knowledge_runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      if (currentRun?.status !== "running") fail(409, "任务已停止");
      const local = curationOutput.parse(
        await generate({
          bundle: {
            ...bundle,
            files: bundle.files.filter(
              (file) =>
                !file.path.startsWith("sources/") ||
                file.path === `sources/${material.subscriptionId}/SOURCE.md`,
            ),
          },
          materials: [material],
          humanChanges: humanChanges.map((record) => {
            const policy = effectiveKnowledgeSettings(bundle.settings, [
              material.subscriptionId,
            ]);
            return {
              ...record,
              title: sanitizeKnowledge(record.title, policy),
              change: {
                ...record.change,
                removed: sanitizeKnowledge(record.change.removed, policy),
                inserted: sanitizeKnowledge(record.change.inserted, policy),
              },
            };
          }),
          existing: existing.map((entry) => {
            const policy = effectiveKnowledgeSettings(bundle.settings, [
              material.subscriptionId,
              ...refsOf(entry).map((ref) => ref.subscriptionId),
            ]);
            return {
              id: entry.id,
              title: sanitizeKnowledge(entry.title, policy),
              markdown: sanitizeKnowledge(refsOf(entry).some(ref => ref.subscriptionId === material.subscriptionId) || entry.origin.startsWith("human") ? entry.markdown : "[目录条目，未加载全文；修改前请通过整理助手读取当前文档]", policy),
              origin: entry.origin,
              status: entry.status,
              sourceIds: refsOf(entry).map((ref) => ref.subscriptionId),
              path: JSON.parse(entry.review_state).path ?? [],
            };
          }),
          ...(focus?.title ? { focus } : {}),
        }),
      );
      if (
        local.entries.some((entry) =>
          entry.sourceIds.some((id) => id !== material.subscriptionId),
        )
      )
        fail(502, "AI 引用了本次未读取的来源");
      output.entries.push(...local.entries);
      output.notes = [output.notes, local.notes].filter(Boolean).join("\n\n");
      if (output.entries.length > 30 || output.notes.length > 8000)
        fail(413, "整理结果过多，请分批整理来源");
    }
    await transact(db, async (tx) => {
      const fresh = await knowledgeInstructions(tx, actor, run.library_id);
      if (
        hash(await knowledgeHumanChanges(tx, actor, run.library_id)) !==
        humanHash
      )
        fail(409, "人工修订已变化，请重新整理");
      if (fresh.hash !== bundle.hash)
        fail(409, "指引或安全配置已变化，请重新整理");
      const currentRun = await tx
        .selectFrom("knowledge_runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      if (currentRun?.status !== "running") fail(409, "任务已停止");
      for (const material of materials) {
        const source = await tx
          .selectFrom("knowledge_subscriptions")
          .selectAll()
          .where("id", "=", material.subscriptionId)
          .executeTakeFirst();
        const owner = source ? await sourceActor(tx, source) : null;
        if (!source || !owner || !(await sourceAvailable(tx, owner, source)))
          fail(409, "来源授权已变化，请重新整理");
      }
      for (const guard of readGuards) await guard(tx);
      const ids: string[] = [];
      let pendingCount = 0;
      const entryFingerprint = (title: string, markdown: string, figures: unknown = []) =>
        hash({ title, markdown, figures: figures ?? [] });
      const seen = new Set(
        existing.map((entry) =>
          entryFingerprint(
            entry.title,
            entry.markdown,
            knowledgeFigures(JSON.parse(entry.review_state).figures),
          ),
        ),
      );
      const revisionSeen = new Set(
        existing
          .filter((entry) => entry.status !== "superseded")
          .map((entry) =>
            entryFingerprint(
              entry.title,
              entry.markdown,
              knowledgeFigures(JSON.parse(entry.review_state).figures),
            ),
          ),
      );
      for (const proposed of output.entries) {
        const sourceIds = [...new Set(proposed.sourceIds)];
        if (
          sourceIds.some(
            (id) => !changedMaterials.some((m) => m.subscriptionId === id),
          )
        )
          fail(502, "AI 引用了本次未读取的来源");
        const outputSettings = effectiveKnowledgeSettings(
          bundle.settings,
          materials.map((material) => material.subscriptionId),
        );
        const title = sanitizeKnowledge(proposed.title, outputSettings),
          markdown = sanitizeKnowledge(proposed.markdown, outputSettings);
        const figures = knowledgeFigures(proposed.figures).map((figure) => ({
          ...figure,
          nodes: figure.nodes.map((node) => ({
            ...node,
            label: sanitizeKnowledge(node.label, outputSettings),
          })),
        })).filter((figure) => figure.nodes.every((node) => node.label));
        const fingerprint = entryFingerprint(title, markdown, figures);
        // A reviewed-away historical value may still conflict with a newer human amendment.
        // Suppress existing/rejected candidates, but let an explicit revision reference that history.
        if ((proposed.replacesId ? revisionSeen : seen).has(fingerprint)) continue;
        seen.add(fingerprint);
        revisionSeen.add(fingerprint);
        const replacement = proposed.replacesId
          ? existing.find(
              (e) => e.id === proposed.replacesId && e.status === "published",
            )
          : undefined;
        if (proposed.replacesId && !replacement)
          fail(502, "只能提出对当前发布知识的修订");
        const now = new Date().toISOString();
        const entry: Entry = {
          id: randomUUID(),
          library_id: run.library_id,
          title,
          markdown,
          origin: "ai_synthesized",
          status: "draft",
          revision: 1,
          source_refs: JSON.stringify([
            ...new Map(
              [
                ...(replacement ? refsOf(replacement) : []),
                ...sourceIds.map((id) => ({
                  subscriptionId: id,
                  title: materials.find((m) => m.subscriptionId === id)!.title,
                  version: materials.find((m) => m.subscriptionId === id)!
                    .version,
                })),
              ].map((ref) => [ref.subscriptionId, ref]),
            ).values(),
          ]),
          instruction_hash: bundle.hash,
          review_state: JSON.stringify({
            path: validateKnowledgePath(
              proposed.path ??
                (replacement
                  ? (JSON.parse(replacement.review_state).path ?? [])
                  : []),
              bundle.settings.maxDocumentDepth,
            ),
            resolution: proposed.resolution,
            conflict: !!replacement,
            reason: sanitizeKnowledge(proposed.reason, outputSettings),
            ...(figures.length ? { figures } : {}),
            runId,
            ...(replacement
              ? {
                  replaces: replacement.id,
                  replacesRevision: replacement.revision,
                  baseDocumentSeq: currentDocuments.get(JSON.parse(replacement.review_state).nodeId)?.seq,
                }
              : {}),
          }),
          author_id: actor.id,
          created_at: now,
          updated_at: now,
        };
        await tx.insertInto("knowledge_entries").values(entry).execute();
        await versionEntry(tx, entry, actor);
        const resolution = proposed.resolution;
        const weighted =
          replacement &&
          bundle.settings.autoPublishWeighted &&
          resolution?.mode === "weighted" &&
          resolution.incomingWeight > resolution.existingWeight &&
          resolution.ruleQuote.trim().length >= 10 &&
          bundle.files.some(
            (file) =>
              file.path === resolution.rulePath &&
              (!file.path.startsWith("sources/") ||
                sourceIds.some(
                  (id) => file.path === `sources/${id}/SOURCE.md`,
                )) &&
              file.markdown.includes(resolution.ruleQuote),
          );
        if (weighted)
          await reviewKnowledgeEntry(
            tx,
            actor,
            run.library_id,
            entry.id,
            entry.revision,
            "publish",
          );
        else pendingCount++;
        ids.push(entry.id);
      }
      for (const material of materials) {
        const source = subscriptions.find(
          (row) => row.id === material.subscriptionId,
        )!;
        let sourceVersion = material.version;
        if (source.source_kind === "document" || source.source_kind === "library") {
          sourceVersion = String(
            (
              await tx
                .selectFrom("resources")
                .select("version")
                .where("id", "=", source.source_id)
                .executeTakeFirstOrThrow()
            ).version,
          );
        } else if (
          source.source_kind === "file" ||
          source.source_kind === "folder"
        ) {
          sourceVersion = (
            await tx
              .selectFrom(
                source.source_kind === "file" ? "file_items" : "file_folders",
              )
              .select("updated_at")
              .where("id", "=", source.source_id)
              .executeTakeFirstOrThrow()
          ).updated_at;
        }
        await tx
          .updateTable("knowledge_subscriptions")
          .set({ status: "active", source_version: sourceVersion })
          .where("id", "=", source.id)
          .execute();
      }
      const reviews = await knowledgeSourceReviews(tx, actor, run.library_id);
      await tx
        .updateTable("knowledge_runs")
        .set({
          status:
            pendingCount || reviews.length
              ? "awaiting_review"
              : skipped.length
                ? "partial"
                : "succeeded",
          detail: JSON.stringify({
            ...detail,
            entryIds: ids,
            reviews,
            skipped,
            humanHash,
            materialFingerprints: materials.map((material) => hash(material)),
            notes: sanitizeKnowledge(
              output.notes,
              effectiveKnowledgeSettings(
                bundle.settings,
                materials.map((m) => m.subscriptionId),
              ),
            ),
            instructionFiles: bundle.files.map((f) => ({
              path: f.path,
              revision: f.revision,
            })),
          }),
        })
        .where("id", "=", runId)
        .where("status", "=", "running")
        .execute();
    });
  } catch (error) {
    await db
      .updateTable("knowledge_runs")
      .set({
        status: "failed",
        detail: JSON.stringify({
          ...detail,
          error:
            error instanceof AppError
              ? error.message
              : "整理失败，请检查模型配置后重试",
        }),
      })
      .where("id", "=", runId)
      .where("status", "=", "running")
      .execute();
  }
}

export async function saveKnowledgeAssistant(
  db: DB,
  actor: Actor,
  raw: z.input<typeof assistantInput>,
) {
  const input = assistantInput.parse(raw);
  return transact(db, async (tx) => {
    await activeActor(tx, actor);
    const current = input.id
      ? await tx
          .selectFrom("knowledge_assistants")
          .selectAll()
          .where("id", "=", input.id)
          .where("owner_id", "=", actor.id)
          .executeTakeFirst()
      : null;
    if (input.id && !current) fail(404, "机器人不存在");
    if ((current?.revision ?? 0) !== input.expectedRevision)
      fail(409, "机器人已修改，请刷新");
    const ids = [...new Set(input.libraryIds)];
    await checkPublication(tx, actor.id, actor.id, input.visibility);
    await requireCapability(tx, actor.id, "sharing.invite");
    if (input.memberIds.length) {
      const users = await tx
        .selectFrom("users")
        .select("id")
        .where("id", "in", [...new Set(input.memberIds)])
        .where("status", "=", "active")
        .execute();
      if (users.length !== new Set(input.memberIds).size)
        fail(400, "部分成员不存在或已停用");
    }
    // Binding and audience changes require explicit management of every affected library.
    for (const id of new Set([
      ...ids,
      ...JSON.parse(current?.library_ids ?? "[]"),
    ]))
      await maintainKnowledge(tx, actor, id);
    const row = {
      id: current?.id ?? randomUUID(),
      owner_id: actor.id,
      title: input.title,
      revision: input.expectedRevision + 1,
      library_ids: JSON.stringify(ids),
      member_ids: JSON.stringify([...new Set(input.memberIds)]),
      visibility: input.visibility,
      enabled: input.enabled ? 1 : 0,
      updated_at: new Date().toISOString(),
    };
    if (current) {
      const saved = await tx
        .updateTable("knowledge_assistants")
        .set(row)
        .where("id", "=", row.id)
        .where("revision", "=", input.expectedRevision)
        .executeTakeFirst();
      if (!Number(saved.numUpdatedRows)) fail(409, "机器人已修改，请刷新");
    } else await tx.insertInto("knowledge_assistants").values(row).execute();
    // A removed invitation must not reactivate an old acceptance after re-inviting.
    const removed = (
      JSON.parse(current?.member_ids ?? "[]") as string[]
    ).filter((id) => !input.memberIds.includes(id));
    if (removed.length)
      await tx
        .updateTable("knowledge_assistant_users")
        .set({ accepted: 0, integration: "default" })
        .where("assistant_id", "=", row.id)
        .where("user_id", "in", removed)
        .execute();
    return { ...row, libraryIds: ids, memberIds: JSON.parse(row.member_ids) };
  });
}
export async function knowledgeAssistantAccess(
  db: DB,
  actor: Actor,
  bot: Schema["knowledge_assistants"],
) {
  const state = await db
    .selectFrom("knowledge_assistant_users")
    .selectAll()
    .where("assistant_id", "=", bot.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  const decision = audienceDecision(await distributionPolicy(db), {
    owner: bot.owner_id === actor.id,
    granted: JSON.parse(bot.member_ids).includes(actor.id),
    accepted: !!state?.accepted,
    public: bot.visibility === "public" || bot.visibility === "authenticated",
    interacted: !!state?.visited_at,
    hidden: state?.integration === "disabled",
  });
  return {
    ...decision,
    interacted: !!state?.visited_at,
    accessible: !!bot.enabled && decision.accessible,
    connected:
      !!bot.enabled &&
      decision.accessible &&
      (state?.integration === "enabled" ||
        (state?.integration !== "disabled" && decision.defaultIncluded)),
    preference: state?.integration ?? "default",
    preferenceRevision: state?.revision ?? 0,
  };
}
export async function visitKnowledgeAssistant(
  db: DB,
  actor: Actor,
  id: string,
  accept = false,
) {
  return transact(db, async (tx) => {
    await activeActor(tx, actor);
    const bot = await tx
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!bot || !bot.enabled) fail(404, "机器人不可用");
    const access = await knowledgeAssistantAccess(tx, actor, bot);
    if (!access.accessible && !(accept && access.invitationPending))
      fail(404, "机器人不可用");
    const state = await tx
      .selectFrom("knowledge_assistant_users")
      .selectAll()
      .where("assistant_id", "=", id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    const row = {
      assistant_id: id,
      user_id: actor.id,
      accepted: accept ? 1 : (state?.accepted ?? 0),
      visited_at: new Date().toISOString(),
      integration: state?.integration ?? "default",
      revision: (state?.revision ?? 0) + 1,
    };
    await tx
      .insertInto("knowledge_assistant_users")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["assistant_id", "user_id"]).doUpdateSet(row),
      )
      .execute();
    return {
      id: bot.id,
      title: bot.title,
      enabled: !!bot.enabled,
      visibility: bot.visibility,
      canManage: bot.owner_id === actor.id,
    };
  });
}
export async function saveKnowledgeAssistantConnection(
  db: DB,
  actor: Actor,
  id: string,
  integration: "default" | "enabled" | "disabled",
  expectedRevision: number,
) {
  return transact(db, async (tx) => {
    await activeActor(tx, actor);
    const bot = await tx
      .selectFrom("knowledge_assistants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!bot) fail(404, "机器人不可用");
    const access = await knowledgeAssistantAccess(tx, actor, bot);
    if (!access.accessible) fail(404, "机器人不可用");
    if (access.preferenceRevision !== expectedRevision)
      fail(409, "接入设置已变化，请刷新");
    const old = await tx
      .selectFrom("knowledge_assistant_users")
      .selectAll()
      .where("assistant_id", "=", id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    const row = {
      assistant_id: id,
      user_id: actor.id,
      accepted: old?.accepted ?? 0,
      visited_at: old?.visited_at ?? new Date().toISOString(),
      integration,
      revision: expectedRevision + 1,
    };
    await tx
      .insertInto("knowledge_assistant_users")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["assistant_id", "user_id"]).doUpdateSet(row),
      )
      .execute();
    return row;
  });
}
export async function listKnowledgeAssistants(db: DB, actor: Actor) {
  await activeActor(db, actor);
  const rows = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .execute();
  const decisions = new Map<
    string,
    Awaited<ReturnType<typeof knowledgeAssistantAccess>>
  >();
  for (const row of rows)
    decisions.set(row.id, await knowledgeAssistantAccess(db, actor, row));
  const memberIds = [
    ...new Set(
      rows
        .filter((row) => row.owner_id === actor.id)
        .flatMap((row) => JSON.parse(row.member_ids) as string[]),
    ),
  ];
  const members = memberIds.length
    ? await db
        .selectFrom("users")
        .select(["id", "display_name"])
        .where("id", "in", memberIds)
        .execute()
    : [];
  return rows
    .filter(
      (row) =>
        row.owner_id === actor.id ||
        (row.enabled &&
          (JSON.parse(row.member_ids).includes(actor.id) ||
            decisions.get(row.id)!.defaultIncluded ||
            decisions.get(row.id)!.connected ||
            (decisions.get(row.id)!.accessible &&
              decisions.get(row.id)!.interacted))),
    )
    .map((row) => ({
      id: row.id,
      title: row.title,
      revision: row.revision,
      enabled: !!row.enabled,
      canManage: row.owner_id === actor.id,
      visibility: row.visibility || "invited",
      ...decisions.get(row.id)!,
      ...(row.owner_id === actor.id
        ? {
            libraryIds: JSON.parse(row.library_ids),
            memberIds: JSON.parse(row.member_ids),
            memberNames: Object.fromEntries(
              members
                .filter((member) =>
                  JSON.parse(row.member_ids).includes(member.id),
                )
                .map((member) => [member.id, member.display_name]),
            ),
          }
        : {}),
    }));
}
function knowledgeExcerpt(text: string, terms: string[]) {
  if (text.length <= 1200) return text;
  const lower = text.toLowerCase();
  const windows = new Map<number, number>();
  for (const term of terms) {
    if (!term) continue;
    let position = lower.indexOf(term), count = 0;
    while (position >= 0 && count++ < 100) {
      const start = Math.max(0, position - 160);
      const window = lower.slice(start, start + 1200);
      const score = terms.reduce((value, item) => value + (window.includes(item) ? Math.min(item.length, 40) : 0), 0);
      windows.set(start, score);
      position = lower.indexOf(term, position + term.length);
    }
  }
  const start = [...windows].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  return text.slice(start, start + 1200);
}
export async function searchKnowledgeAssistant(
  db: DB,
  actor: Actor,
  id: string,
  query: string,
) {
  await activeActor(db, actor);
  if (!query.trim() || query.length > 500)
    fail(400, "请输入不超过 500 字的查询");
  const bot = await db
    .selectFrom("knowledge_assistants")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!bot || !(await knowledgeAssistantAccess(db, actor, bot)).accessible)
    fail(404, "机器人不可用");
  const terms = [
    ...new Set(
      [
        query.trim().toLowerCase(),
        ...Array.from(
          new Intl.Segmenter("zh", { granularity: "word" }).segment(
            query.toLowerCase(),
          ),
        )
          .filter((part) => part.isWordLike)
          .map((part) => part.segment),
      ].filter(Boolean),
    ),
  ];
  const items: {
    id: string;
    title: string;
    excerpt: string;
    score: number;
    documentUrl?: string;
    sources: KnowledgeCitation[];
  }[] = [];
  for (const libraryId of JSON.parse(bot.library_ids) as string[]) {
    // Source permissions are deliberately absent: these are independent published assets.
    try {
      const owner = await db
        .selectFrom("users")
        .select(["id", "display_name", "admin"])
        .where("id", "=", bot.owner_id)
        .executeTakeFirst();
      if (!owner) continue;
      await maintainKnowledge(db, owner, libraryId);
    } catch (error) {
      if (error instanceof AppError && [401, 403, 404].includes(error.status))
        continue;
      throw error;
    }
    const settings = await db
      .selectFrom("knowledge_settings")
      .select("config")
      .where("library_id", "=", libraryId)
      .executeTakeFirst();
    const config = await hideRestrictedKnowledgeLinks(
      db,
      actor,
      libraryId,
      knowledgeSettingsSchema.parse(
        settings ? JSON.parse(settings.config) : {},
      ),
    );
    let canRead = false;
    try {
      await authorize(db, actor, libraryId, 1);
      canRead = true;
    } catch (error) {
      if (!(error instanceof AppError) || ![403, 404].includes(error.status))
        throw error;
    }
    const entries = await db
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("library_id", "=", libraryId)
      .where("status", "=", "published")
      .execute();
    for (const entry of entries) {
      const effectiveSettings = effectiveKnowledgeSettings(
        config,
        refsOf(entry).map((ref) => ref.subscriptionId),
      );
      const title = sanitizeKnowledge(entry.title, effectiveSettings),
        text = sanitizeKnowledge(entry.markdown, effectiveSettings);
      const score = terms.filter((term) =>
        `${title}\n${text}`.toLowerCase().includes(term),
      ).length;
      if (!score) continue;
      items.push({
        id: entry.id,
        title,
        excerpt: knowledgeExcerpt(text, terms),
        sources: await knowledgeCitations(db, actor, entry, effectiveSettings),
        score,
        ...(canRead
          ? {
              documentUrl: `/api/v1/knowledge/libraries/${libraryId}/entries/${entry.id}`,
            }
          : {}),
      });
    }
  }
  items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    title: bot.title,
    items: items.slice(0, 10),
    tools: ["knowledge_search"],
  };
}
