import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";
import {
  saveKnowledgeInstruction,
  saveKnowledgeSettings,
  knowledgeInstructions,
  mainInstruction,
  knowledgeManagementView,
  knowledgeRunHistory,
  knowledgeSourceLinkVisible,
  sourceAvailable,
  sourceActor,
  maintainKnowledgeSource,
} from "./system.js";
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
  const library = await db
    .selectFrom("resources")
    .select([
      "id",
      "kind",
      "owner_id",
      "ai_curated",
      "knowledge_schedule",
      "knowledge_preset",
    ])
    .where("id", "=", libraryId)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const rows = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .orderBy("created_at", "desc")
    .execute();
  const view = await knowledgeManagementView(db, actor, libraryId);
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
    const node = row.node_id
      ? await db
          .selectFrom("resources")
          .select("title")
          .where("id", "=", row.node_id)
          .where("deleted_at", "is", null)
          .executeTakeFirst()
      : undefined;
    const creator = creators.find((user) => user.id === row.creator_id);
    const guide = view.files.find(
      (file) => file.path === `sources/${row.id}/SOURCE.md`,
    );
    const policy = view.settings.sourcePolicies[row.id];
    items.push({
      id: row.id,
      name: row.name?.trim() || (await sourceTitle(db, row)),
      groupId: row.group_id ?? null,
      creator: {
        id: row.creator_id,
        displayName: creator?.display_name || creator?.public_id || "",
      },
      guideConfigured: !!guide?.revision,
      guidePreview: (guide?.markdown ?? "")
        .replace(/^#+\s*/gm, "")
        .slice(0, 180),
      weightHint: (guide?.markdown ?? "")
        .split("\n")
        .filter((line) => /权重|weight/i.test(line) && !/^#/.test(line))
        .slice(0, 2)
        .join(" ")
        .slice(0, 150),
      safety: {
        redactContacts:
          view.settings.redactContacts || !!policy?.redactContacts,
        hiddenTerms:
          (policy?.redactedTerms.length ?? 0) +
          view.settings.redactedTerms.length,
        excluded: view.settings.excludedSourceIds.includes(row.id),
        linkAccess: policy?.linkAccess ?? (visible ? "public" : "follow"),
        editable: true,
      },
      canEdit: true,
      canDelete: true,
      sourceKind: row.source_kind,
      sourceId: visible ? row.source_id : "",
      url: visible ? row.url : "",
      nodeId: row.node_id,
      nodeTitle: node?.title ?? "",
      status,
      sourceTitle: visible ? await sourceTitle(db, row) : "",
      sourceVersion: row.source_version,
      createdAt: row.created_at,
      preset: visible ? parseSourcePreset(row.preset) : parseSourcePreset("{}"),
    });
  }
  const guideText = await libraryGuideText(db, libraryId);
  const runs = await knowledgeRunHistory(db, actor, libraryId);
  return {
    aiCurated: Number(library.ai_curated ?? 0) === 1,
    guideText,
    splitMode: guideSplitMode(guideText),
    schedule: knowledgeSchedule(library.knowledge_schedule || "off"),
    preset: parseLibraryPreset(
      library.knowledge_preset,
      knowledgeSchedule(library.knowledge_schedule || "off"),
    ),
    runs: runs.map((run) => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      detail: run.detail,
      createdAt: run.created_at,
    })),
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
    guide?: string;
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
  if (
    input.sourceKind === "url" &&
    (await knowledgeInstructions(db, actor, libraryId)).settings.sourceScope ===
      "internal"
  )
    fail(403, "本库仅使用内部来源，请先由管理员明确允许网络来源");
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
      if (input.guide)
        await updateKnowledgeSourceGroup(tx, actor, libraryId, id, {
          guide: input.guide,
        });
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
      node_id: null,
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
      node_id: null,
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

const guideTemplate = mainInstruction;

export async function setLibraryCuration(
  db: DB,
  actor: Actor,
  libraryId: string,
  enabled: boolean,
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (enabled) {
    const bundle = await knowledgeInstructions(db, actor, libraryId);
    const guide = bundle.files.find((file) => file.path === "KNOWLEDGE.md")!;
    if (guide.revision === 0)
      await saveKnowledgeInstruction(db, actor, libraryId, {
        path: "KNOWLEDGE.md",
        expectedRevision: 0,
        markdown: guideTemplate,
      });
  }
  await db
    .updateTable("resources")
    .set({ ai_curated: enabled ? 1 : 0 })
    .where("id", "=", libraryId)
    .execute();
  const guideText = await libraryGuideText(db, libraryId);
  return { aiCurated: enabled, splitMode: guideSplitMode(guideText) };
}

export type KnowledgeSchedule = "off" | "daily" | "weekly";

export function knowledgeSchedule(value: string): KnowledgeSchedule {
  if (value === "daily" || value === "weekly" || value === "off") return value;
  return "off";
}

export type LibraryPreset = {
  weight: number;
  frequency: KnowledgeSchedule;
  copyText: boolean;
  note: string;
};

export type SourcePreset = {
  weight: number | null;
  frequency: "inherit" | KnowledgeSchedule;
  copyText: "inherit" | "yes" | "no";
  note: string;
};

function clampWeight(value: unknown, fallback: number) {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) return fallback;
  return weight;
}

export function parseLibraryPreset(
  raw: string | null | undefined,
  frequency: KnowledgeSchedule,
): LibraryPreset {
  const fallback: LibraryPreset = {
    weight: 5,
    frequency,
    copyText: true,
    note: "",
  };
  if (!raw?.trim()) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<LibraryPreset>;
    return {
      weight: clampWeight(value.weight, 5),
      frequency:
        value.frequency === "daily" ||
        value.frequency === "weekly" ||
        value.frequency === "off"
          ? value.frequency
          : frequency,
      copyText: value.copyText !== false,
      note: typeof value.note === "string" ? value.note.slice(0, 20000) : "",
    };
  } catch {
    return fallback;
  }
}

export function parseSourcePreset(
  raw: string | null | undefined,
): SourcePreset {
  const fallback: SourcePreset = {
    weight: null,
    frequency: "inherit",
    copyText: "inherit",
    note: "",
  };
  if (!raw?.trim()) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<SourcePreset>;
    const frequency =
      value.frequency === "off" ||
      value.frequency === "daily" ||
      value.frequency === "weekly" ||
      value.frequency === "inherit"
        ? value.frequency
        : "inherit";
    const copyText =
      value.copyText === "yes" ||
      value.copyText === "no" ||
      value.copyText === "inherit"
        ? value.copyText
        : "inherit";
    return {
      weight: value.weight == null ? null : clampWeight(value.weight, 5),
      frequency,
      copyText,
      note: typeof value.note === "string" ? value.note.slice(0, 20000) : "",
    };
  } catch {
    return fallback;
  }
}

export function draftLibraryPreset(
  guideText: string,
  frequency: KnowledgeSchedule,
): LibraryPreset {
  const splitMode = guideSplitMode(guideText);
  const copyText = splitMode !== "content";
  const weight = splitMode === "custom" ? 7 : 5;
  const cadence = frequency === "off" ? "weekly" : frequency;
  const splitLabel =
    splitMode === "content"
      ? "按知识内容"
      : splitMode === "outline"
        ? "按目录"
        : splitMode === "custom"
          ? "按说明里的规则"
          : "按来源";
  return {
    weight,
    frequency: cadence,
    copyText,
    note: [
      "# 整库预设",
      "",
      `权重 ${weight}。频率${cadence === "daily" ? "每天" : "每周"}。${copyText ? "写入节点时复制来源正文。" : "节点只记下位置，正文留在来源。"}`,
      "",
      `结构说明的拆分是「${splitLabel}」。这份说明可以改，保存之后才当作这套知识库的预设。`,
    ].join("\n"),
  };
}

export function draftSourcePreset(
  input: { title: string; sourceKind: string },
  library: LibraryPreset,
): SourcePreset {
  const broad = input.sourceKind === "folder";
  const copyText = input.sourceKind === "url" ? "no" : "inherit";
  const weight = broad ? Math.min(10, library.weight + 2) : null;
  return {
    weight,
    frequency: "inherit",
    copyText,
    note: [
      `# ${input.title || input.sourceKind}`,
      "",
      `频率沿用整库。${copyText === "no" ? "这条来源不复制正文。" : "是否复制正文沿用整库。"}${weight == null ? "" : ` 权重 ${weight}。`}`,
      "",
      "生成后可以直接改。保存之后，确认加入才按这份预设写入节点。",
    ].join("\n"),
  };
}

export async function setKnowledgeSchedule(
  db: DB,
  actor: Actor,
  libraryId: string,
  mode: KnowledgeSchedule,
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind", "ai_curated", "knowledge_preset"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (mode !== "off" && Number(library.ai_curated ?? 0) !== 1)
    fail(400, "先打开知识关系");
  const preset = parseLibraryPreset(library.knowledge_preset, mode);
  preset.frequency = mode;
  await db
    .updateTable("resources")
    .set({ knowledge_schedule: mode, knowledge_preset: JSON.stringify(preset) })
    .where("id", "=", libraryId)
    .execute();
  return { schedule: mode, preset };
}

async function requireCuratedLibrary(db: DB, actor: Actor, libraryId: string) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select([
      "id",
      "kind",
      "ai_curated",
      "knowledge_schedule",
      "knowledge_preset",
    ])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  if (Number(library.ai_curated ?? 0) !== 1) fail(400, "先打开知识关系");
  return library;
}

export async function saveLibraryPreset(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: LibraryPreset,
) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  const preset = parseLibraryPreset(
    JSON.stringify(input),
    knowledgeSchedule(library.knowledge_schedule || "off"),
  );
  await db
    .updateTable("resources")
    .set({
      knowledge_preset: JSON.stringify(preset),
      knowledge_schedule: preset.frequency,
    })
    .where("id", "=", libraryId)
    .execute();
  return { preset, schedule: preset.frequency };
}

export async function draftLibraryPresetForActor(
  db: DB,
  actor: Actor,
  libraryId: string,
) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  const guideText = await libraryGuideText(db, libraryId);
  return {
    preset: draftLibraryPreset(
      guideText,
      knowledgeSchedule(library.knowledge_schedule || "off"),
    ),
  };
}

export async function saveSourcePreset(
  db: DB,
  actor: Actor,
  libraryId: string,
  subscriptionId: string,
  input: SourcePreset,
) {
  await requireCuratedLibrary(db, actor, libraryId);
  await maintainKnowledgeSource(db, actor, libraryId, subscriptionId);
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .select("id")
    .where("id", "=", subscriptionId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  const preset = parseSourcePreset(JSON.stringify(input));
  await db
    .updateTable("knowledge_subscriptions")
    .set({ preset: JSON.stringify(preset) })
    .where("id", "=", subscriptionId)
    .execute();
  return { preset };
}

export async function draftSourcePresetForActor(
  db: DB,
  actor: Actor,
  libraryId: string,
  subscriptionId: string,
) {
  const library = await requireCuratedLibrary(db, actor, libraryId);
  await maintainKnowledgeSource(db, actor, libraryId, subscriptionId);
  const row = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("id", "=", subscriptionId)
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (!row) fail(404, "连线不存在");
  const libraryPreset = parseLibraryPreset(
    library.knowledge_preset,
    knowledgeSchedule(library.knowledge_schedule || "off"),
  );
  return {
    preset: draftSourcePreset(
      { title: await sourceTitle(db, row), sourceKind: row.source_kind },
      libraryPreset,
    ),
  };
}

export async function runKnowledgeLibrary(
  db: DB,
  actor: Actor,
  libraryId: string,
  trigger: "manual" | "schedule",
) {
  await authorize(db, actor, libraryId, 4);
  const listed = await listKnowledgeSubscriptions(db, actor, libraryId);
  if (!listed.aiCurated) fail(400, "先打开知识关系");
  const counts = { pending: 0, stale: 0, active: 0, missing: 0 };
  for (const item of listed.items) {
    if (item.status === "pending") counts.pending += 1;
    else if (item.status === "stale") counts.stale += 1;
    else if (item.status === "missing") counts.missing += 1;
    else counts.active += 1;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const detail = JSON.stringify(counts);
  await db
    .insertInto("knowledge_runs")
    .values({
      id,
      library_id: libraryId,
      trigger,
      status: "done",
      detail,
      created_at: now,
    })
    .execute();
  return { id, trigger, status: "done", createdAt: now, ...counts };
}

export async function sweepKnowledgeSchedules(
  db: DB,
  curate?: (
    actor: Actor,
    id: string,
    occurrenceKey: string,
  ) => Promise<unknown>,
) {
  const libraries = await db
    .selectFrom("resources")
    .select(["id", "owner_id", "knowledge_schedule"])
    .where("kind", "=", "library")
    .where("deleted_at", "is", null)
    .where("ai_curated", "=", 1)
    .where("knowledge_schedule", "in", ["daily", "weekly"])
    .execute();
  for (const library of libraries) {
    try {
      const last = await db
        .selectFrom("knowledge_runs")
        .select("created_at")
        .where("library_id", "=", library.id)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      const wait =
        library.knowledge_schedule === "weekly"
          ? 7 * 24 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
      if (last && Date.now() - Date.parse(last.created_at) < wait) continue;
      // Scheduling is represented by a conversation task.
      // Count queued/failed occurrences too: recovery belongs to that same conversation.
      const scheduled = await db
        .selectFrom("knowledge_messages as m")
        .innerJoin("knowledge_conversations as c", "c.id", "m.conversation_id")
        .select("m.created_at")
        .where("c.scope_id", "=", library.id)
        .where("c.kind", "=", "curation")
        .where("m.trigger", "=", "schedule")
        .where("m.role", "=", "user")
        .orderBy("m.created_at", "desc")
        .executeTakeFirst();
      if (scheduled && Date.now() - Date.parse(scheduled.created_at) < wait)
        continue;
      const owner = await db
        .selectFrom("users")
        .select(["id", "display_name", "admin"])
        .where("id", "=", library.owner_id)
        .executeTakeFirst();
      if (!owner) continue;
      if (curate)
        await curate(
          owner,
          library.id,
          `${library.knowledge_schedule}:${Math.floor(Date.now() / wait)}`,
        );
      else await runKnowledgeLibrary(db, owner, library.id, "schedule");
    } catch {
      continue;
    }
  }
}

export async function getKnowledgeBot(db: DB, actor: Actor, libraryId: string) {
  await authorize(db, actor, libraryId, 1);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind", "title"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const bot = await db
    .selectFrom("knowledge_bots")
    .selectAll()
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  return {
    title: bot?.title || library.title,
    published: Number(bot?.published ?? 0) === 1,
  };
}

export async function saveKnowledgeBot(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: { title: string; published: boolean },
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind", "title"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const title = input.title.trim() || library.title;
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("knowledge_bots")
    .select("library_id")
    .where("library_id", "=", libraryId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("knowledge_bots")
      .set({ title, published: input.published ? 1 : 0, updated_at: now })
      .where("library_id", "=", libraryId)
      .execute();
  } else {
    await db
      .insertInto("knowledge_bots")
      .values({
        library_id: libraryId,
        title,
        published: input.published ? 1 : 0,
        updated_at: now,
      })
      .execute();
  }
  return { title, published: input.published };
}

export async function askKnowledgeLibrary(
  db: DB,
  actor: Actor,
  libraryId: string,
  query: string,
) {
  const bot = await getKnowledgeBot(db, actor, libraryId);
  await authorize(db, actor, libraryId, bot.published ? 1 : 4);
  const phrase = query.trim().toLowerCase();
  const terms = [
    ...new Set(
      [phrase, ...phrase.split(/\s+/)].filter((term) => term.length >= 2),
    ),
  ].slice(0, 8);
  const libraryRow = await db
    .selectFrom("resources")
    .select(["knowledge_preset", "knowledge_schedule"])
    .where("id", "=", libraryId)
    .executeTakeFirst();
  const libraryPreset = parseLibraryPreset(
    libraryRow?.knowledge_preset,
    knowledgeSchedule(libraryRow?.knowledge_schedule || "off"),
  );
  const rows = (
    await db
      .selectFrom("resources")
      .select("id")
      .where("library_id", "=", libraryId)
      .where("kind", "=", "document")
      .where("deleted_at", "is", null)
      .execute()
  ).map((row) => ({ node_id: row.id, preset: "" }));
  const items = [];
  for (const row of rows) {
    if (!row.node_id) continue;
    try {
      await authorize(db, actor, row.node_id, 1);
    } catch (error) {
      if ([403, 404].includes((error as { status?: number }).status ?? 0))
        continue;
      throw error;
    }
    const node = await db
      .selectFrom("resources")
      .select(["id", "title"])
      .where("id", "=", row.node_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!node) continue;
    const state = await db
      .selectFrom("document_states")
      .select("text")
      .where("resource_id", "=", node.id)
      .executeTakeFirst();
    const text = state?.text ?? "";
    const haystack = `${node.title}\n${text}`.toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term)).length;
    if (!matched) continue;
    const sourcePreset = parseSourcePreset(row.preset);
    const weight = sourcePreset.weight ?? libraryPreset.weight;
    const score = matched + weight / 10;
    const inText = terms
      .map((term) => text.toLowerCase().indexOf(term))
      .find((index) => index >= 0);
    const start = Math.max(0, (inText ?? 0) - 40);
    const excerpt = (
      inText == null ? text : text.slice(start, start + 160)
    ).trim();
    items.push({ nodeId: node.id, title: node.title, excerpt, score });
  }
  items.sort((left, right) => right.score - left.score);
  return {
    title: bot.title,
    items: items
      .slice(0, 5)
      .map((item) => ({
        nodeId: item.nodeId,
        title: item.title,
        excerpt: item.excerpt,
      })),
  };
}

export async function saveLibraryGuide(
  db: DB,
  actor: Actor,
  libraryId: string,
  markdown: string,
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select(["id", "kind"])
    .where("id", "=", libraryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!library || library.kind !== "library") fail(404, "知识库不存在");
  const text = markdown.trim() ? markdown : guideTemplate;
  const bundle = await knowledgeInstructions(db, actor, libraryId);
  const current = bundle.files.find((file) => file.path === "KNOWLEDGE.md")!;
  await saveKnowledgeInstruction(db, actor, libraryId, {
    path: "KNOWLEDGE.md",
    expectedRevision: current.revision,
    markdown: text,
  });
  return { splitMode: guideSplitMode(text) };
}

async function libraryGuideText(db: DB, libraryId: string) {
  const instruction = await db
    .selectFrom("knowledge_instructions")
    .select("markdown")
    .where("library_id", "=", libraryId)
    .where("path", "=", "KNOWLEDGE.md")
    .orderBy("revision", "desc")
    .executeTakeFirst();
  return instruction?.markdown ?? mainInstruction;
}

async function librarySplitMode(db: DB, libraryId: string) {
  return guideSplitMode(await libraryGuideText(db, libraryId));
}

export function guideSplitMode(markdown: string) {
  const line = markdown
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("拆分："));
  if (!line || line.includes("按来源")) return "source" as const;
  if (line.includes("按知识内容")) return "content" as const;
  if (line.includes("按目录")) return "outline" as const;
  return "custom" as const;
}

async function publicSubscription(
  db: DB,
  row: {
    id: string;
    source_kind: string;
    source_id: string;
    url: string;
    node_id: string | null;
    source_version: string;
    status: string;
    created_at: string;
    preset?: string | null;
  },
) {
  const node = row.node_id
    ? await db
        .selectFrom("resources")
        .select("title")
        .where("id", "=", row.node_id)
        .executeTakeFirst()
    : undefined;
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    url: row.url,
    nodeId: row.node_id,
    nodeTitle: node?.title ?? "",
    status: row.status,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
    preset: parseSourcePreset(row.preset),
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

async function filesUnderFolder(db: DB, folderId: string) {
  const folderIds = [folderId];
  for (
    let index = 0;
    index < folderIds.length && folderIds.length < 20;
    index += 1
  ) {
    const children = await db
      .selectFrom("file_folders")
      .select("id")
      .where("parent_id", "=", folderIds[index]!)
      .where("deleted_at", "is", null)
      .limit(20)
      .execute();
    for (const child of children)
      if (!folderIds.includes(child.id)) folderIds.push(child.id);
  }
  const files = await db
    .selectFrom("file_items")
    .select("id")
    .where("parent_type", "=", "folder")
    .where("parent_id", "in", folderIds)
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "desc")
    .limit(40)
    .execute();
  return files.map((file) => file.id);
}

function nodeMarkdown(title: string, body: string, sourceLine: string) {
  return [`# ${title}`, "", body.trim().slice(0, 8000), "", sourceLine].join(
    "\n",
  );
}

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
    guide?: string;
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
  const persist = async (tx: DB) => {
    if (input.title !== undefined) {
      if (!input.title.trim()) fail(400, "来源名称不能为空");
      await tx
        .updateTable("knowledge_source_groups")
        .set({ title: input.title.trim().slice(0, 200) })
        .where("id", "=", groupId)
        .execute();
    }
    const config = JSON.parse(group.config ?? "{}");
    if (input.guide !== undefined) {
      config.guide = input.guide;
      await tx
        .updateTable("knowledge_source_groups")
        .set({ config: JSON.stringify(config) })
        .where("id", "=", groupId)
        .execute();
    }
    const previousIds = new Set(
      (
        await tx
          .selectFrom("knowledge_subscriptions")
          .select("id")
          .where("group_id", "=", groupId)
          .where("status", "!=", "detached")
          .execute()
      ).map((x) => x.id),
    );
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
    const members = await tx
      .selectFrom("knowledge_subscriptions")
      .select("id")
      .where("group_id", "=", groupId)
      .where("status", "!=", "detached")
      .execute();
    for (const member of members)
      if (input.guide !== undefined || !previousIds.has(member.id)) {
        let guide = config.guide ?? "";
        if (config.priority)
          guide += `\n\n管理员优先级：${config.priority.weight ?? 50}。范围：${config.priority.scope ?? "此来源主题"}。依据：${config.priority.reason}`;
        {
          const bundle = await knowledgeInstructions(tx, actor, libraryId),
            path = `sources/${member.id}/SOURCE.md`;
          await saveKnowledgeInstruction(tx, actor, libraryId, {
            path,
            expectedRevision:
              bundle.files.find((x) => x.path === path)?.revision ?? 0,
            markdown: guide,
          });
        }
      }
    if (config.paused) {
      const bundle = await knowledgeInstructions(tx, actor, libraryId);
      await saveKnowledgeSettings(
        tx,
        actor,
        libraryId,
        bundle.settingsRevision,
        {
          ...bundle.settings,
          excludedSourceIds: [
            ...new Set([
              ...bundle.settings.excludedSourceIds,
              ...members.map((x) => x.id),
            ]),
          ],
        },
      );
    }
    return { id: groupId };
  };
  return db.isTransaction ? persist(db) : db.transaction().execute(persist);
}
