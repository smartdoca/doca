import type {
  SearchProjection,
  SearchSource,
  SearchSourceDescriptor,
} from "@doca/search-host";

import type { Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import type { DB } from "@db/index.js";
import { searchDocument } from "@core/modules/discovery/search-reconciliation.js";
import { searchSummaries } from "./search-summary.js";

export const documentSearchSource = {
  pluginId: "doca.documents",
  sourceId: "documents",
  schemaVersion: 1,
  renderer: { kind: "document-search-result", version: 1 },
} as const satisfies SearchSourceDescriptor;

export const fileSearchSource = {
  pluginId: "doca.files",
  sourceId: "files",
  schemaVersion: 1,
  renderer: { kind: "file-search-result", version: 1 },
} as const satisfies SearchSourceDescriptor;

export const knowledgeSearchSource = {
  pluginId: "doca.documents",
  sourceId: "knowledge-chunks",
  schemaVersion: 1,
  renderer: { kind: "knowledge-search-result", version: 1 },
} as const satisfies SearchSourceDescriptor;

type ResourceSearchQuery = Parameters<
  ReturnType<typeof createContent>["list"]
>[1];

export type SearchQueryContext =
  | { readonly kind: "plugin"; readonly principalId: string; readonly signal?: AbortSignal }
  | {
      readonly kind: "documents";
      readonly actor: Actor;
      readonly scoped: ResourceSearchQuery;
      readonly candidateIds: readonly string[];
      readonly retrievalQuery: string;
      readonly highlight: string;
      readonly semantic: boolean;
      readonly minScore: number;
    }
  | {
      readonly kind: "files";
      readonly allowedFileIds: readonly string[];
      readonly mappings: readonly {
        readonly id: string;
        readonly storage_object_id: string;
      }[];
      readonly retrievalQuery: string;
      readonly semantic: boolean;
      readonly minScore: number;
    }
  | {
      readonly kind: "knowledge";
      readonly tokens: readonly string[];
    }
  | { readonly kind: "system" };

type FilePolicyGroup = "image" | "pdf" | "office" | "text" | "other";
const defaultFileSearchGroups: FilePolicyGroup[] = [
  "image",
  "pdf",
  "office",
  "text",
  "other",
];

function filePolicyGroup(mime: string): FilePolicyGroup {
  return mime.startsWith("image/")
    ? "image"
    : mime === "application/pdf"
      ? "pdf"
      : /officedocument|msword|ms-excel|ms-powerpoint/.test(mime)
        ? "office"
        : mime.startsWith("text/") || /json|xml|yaml/.test(mime)
          ? "text"
          : "other";
}

export function fileObjectDocumentId(storageObjectId: string): string {
  return `file_object_${storageObjectId.replaceAll("-", "_")}`;
}

export function fileItemDocumentId(fileItemId: string): string {
  return `file_item_${fileItemId.replaceAll("-", "_")}`;
}

function documentProjection(row: {
  id: string;
  title: string;
  text: string | null;
}): SearchProjection {
  const document = searchDocument(row);
  return {
    id: document.id,
    text: document.text,
    metadata: {
      title: document.title,
      content_hash: document.content_hash,
    },
  };
}

export function fileObjectProjection(row: {
  storageObjectId: string;
  description?: string | null;
}): SearchProjection {
  const document = searchDocument({
    id: fileObjectDocumentId(row.storageObjectId),
    title: "",
    text: row.description?.trim() || null,
  });
  return {
    id: document.id,
    text: document.text,
    metadata: {
      title: document.title,
      content_hash: document.content_hash,
    },
  };
}

export function fileItemProjection(row: {
  id: string;
  name: string;
  description?: string | null;
  ai_description_override?: string | null;
}): SearchProjection {
  const document = searchDocument({
    id: fileItemDocumentId(row.id),
    title: row.name,
    text: (row.description ?? row.ai_description_override)?.trim() || null,
  });
  return {
    id: document.id,
    text: document.text,
    metadata: {
      title: document.title,
      content_hash: document.content_hash,
    },
  };
}

async function fileSearchGroups(db: DB): Promise<Set<FilePolicyGroup>> {
  const setting = await db
    .selectFrom("file_recognition_settings")
    .select("config")
    .where("id", "=", "default")
    .executeTakeFirst();
  return new Set<FilePolicyGroup>(
    (setting ? JSON.parse(setting.config).searchGroups : null) ??
      defaultFileSearchGroups,
  );
}

export async function fileProjectionsForObject(
  db: DB,
  storageObjectId: string,
): Promise<readonly SearchProjection[]> {
  const object = await db
    .selectFrom("file_storage_objects")
    .select(["id", "ai_description"])
    .where("id", "=", storageObjectId)
    .executeTakeFirst();
  if (!object) return [];
  const stored = await db
    .selectFrom("file_items")
    .select([
      "id",
      "name",
      "mime",
      "ai_description_override",
      "parent_id",
      "metadata",
    ])
    .where("storage_object_id", "=", storageObjectId)
    .where("deleted_at", "is", null)
    .execute();
  const groups = await fileSearchGroups(db);
  const items = [];
  for (const item of stored)
    if (
      groups.has(filePolicyGroup(item.mime)) &&
      true
    )
      items.push(item);
  if (!items.length) return [];
  return [
    fileObjectProjection({
      storageObjectId: object.id,
      description: object.ai_description,
    }),
    ...items.map(fileItemProjection),
  ];
}

export async function documentProjectionForId(
  db: DB,
  id: string,
): Promise<SearchProjection | undefined> {
  const row = await db
    .selectFrom("resources as r")
    .leftJoin("document_states as s", "s.resource_id", "r.id")
    .select(["r.id", "r.title", "r.kind", "r.deleted_at", "s.text"])
    .where("r.id", "=", id)
    .executeTakeFirst();
  return row && !row.deleted_at && row.kind === "document"
    ? documentProjection(row)
    : undefined;
}

async function scopedDocuments(
  db: DB,
  actor: Actor,
  scoped: ResourceSearchQuery,
  ids: readonly string[],
) {
  const content = createContent(db);
  const items: Awaited<ReturnType<typeof content.list>>["items"] = [];
  let cursor: string | undefined;
  do {
    const page = await content.list(actor, {
      ...scoped,
      q: undefined,
      cursor,
      offset: undefined,
      kind: "document",
      matchedIds: [...ids],
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < ids.length);
  return items;
}

export function createDocumentSource(db: DB): SearchSource<SearchQueryContext> {
  return {
    descriptor: documentSearchSource,
    prepareQuery({ context }) {
      if (context.kind !== "documents") return null;
      return {
        query: context.retrievalQuery,
        candidateIds: context.candidateIds,
        limit: context.candidateIds.length,
        semantic: context.semantic,
        rankingScoreThreshold: context.semantic
          ? context.minScore
          : undefined,
      };
    },
    async authorize({ context, candidateIds }) {
      if (context.kind !== "documents") return [];
      return (
        await scopedDocuments(db, context.actor, context.scoped, candidateIds)
      ).map((item) => item.id);
    },
    async hydrate({ context, ids }) {
      if (context.kind !== "documents") return new Map();
      const visible = await scopedDocuments(
        db,
        context.actor,
        context.scoped,
        ids,
      );
      const summarized = await searchSummaries(
        db,
        context.actor,
        visible,
        context.highlight,
      );
      return new Map(summarized.map((item) => [item.id, item]));
    },
    async *projections() {
      let cursor = "";
      for (;;) {
        const rows = await db
          .selectFrom("resources")
          .leftJoin(
            "document_states",
            "document_states.resource_id",
            "resources.id",
          )
          .select(["resources.id", "resources.title", "document_states.text"])
          .where("resources.kind", "=", "document")
          .where("resources.deleted_at", "is", null)
          .where("resources.id", ">", cursor)
          .orderBy("resources.id")
          .limit(100)
          .execute();
        if (!rows.length) break;
        yield rows.map(documentProjection);
        cursor = rows.at(-1)!.id;
      }
    },
  };
}

export function createFileSource(db: DB): SearchSource<SearchQueryContext> {
  return {
    descriptor: fileSearchSource,
    prepareQuery({ context }) {
      if (context.kind !== "files") return null;
      const objectIds = [
        ...new Set(context.mappings.map((row) => row.storage_object_id)),
      ];
      const candidates = [
        ...objectIds.map(fileObjectDocumentId),
        ...context.mappings.map((row) => fileItemDocumentId(row.id)),
      ];
      return {
        query: context.retrievalQuery,
        candidateIds: candidates,
        limit: candidates.length,
        semantic: context.semantic,
        rankingScoreThreshold: context.semantic
          ? context.minScore
          : undefined,
      };
    },
    async authorize({ context, candidateIds }) {
      if (context.kind !== "files") return [];
      const allowed = new Set(context.allowedFileIds);
      const current = await db
        .selectFrom("file_items")
        .select(["id", "storage_object_id"])
        .where("id", "in", [...allowed])
        .where("deleted_at", "is", null)
        .execute();
      const byObject = new Set(current.map((row) => row.storage_object_id));
      const indexedItems = new Set(
        current.map((row) => fileItemDocumentId(row.id)),
      );
      return candidateIds.filter(
        (id) =>
          indexedItems.has(id) ||
          current.some(
            (row) =>
              byObject.has(row.storage_object_id) &&
              fileObjectDocumentId(row.storage_object_id) === id,
          ),
      );
    },
    async hydrate({ context, ids }) {
      if (context.kind !== "files") return new Map();
      const allowed = new Set(context.allowedFileIds);
      const current = await db
        .selectFrom("file_items")
        .select(["id", "storage_object_id"])
        .where("id", "in", [...allowed])
        .where("deleted_at", "is", null)
        .execute();
      const values = new Map<string, { fileIds: string[]; objectId: string }>();
      for (const indexedId of ids) {
        const item = current.find(
          (row) => fileItemDocumentId(row.id) === indexedId,
        );
        const objectId =
          item?.storage_object_id ??
          current.find(
            (row) => fileObjectDocumentId(row.storage_object_id) === indexedId,
          )?.storage_object_id;
        if (!objectId) continue;
        const fileIds = current
          .filter((row) => row.storage_object_id === objectId)
          .map((row) => row.id);
        if (item) {
          const index = fileIds.indexOf(item.id);
          if (index > 0)
            fileIds.unshift(...fileIds.splice(index, 1));
        }
        values.set(indexedId, { fileIds, objectId });
      }
      return values;
    },
    async *projections() {
      let cursor = "";
      for (;;) {
        const objects = await db
          .selectFrom("file_storage_objects")
          .select("id")
          .where("id", ">", cursor)
          .orderBy("id")
          .limit(100)
          .execute();
        if (!objects.length) break;
        const projections = (
          await Promise.all(
            objects.map((object) => fileProjectionsForObject(db, object.id)),
          )
        ).flat();
        if (projections.length) yield projections;
        cursor = objects.at(-1)!.id;
      }
    },
  };
}

export function createKnowledgeSource(db: DB): SearchSource<SearchQueryContext> {
  const visibleIds = async (tokens: readonly string[], ids?: readonly string[]) => {
    if (!tokens.length) return [] as string[];
    let query = db
      .selectFrom("knowledge_chunks")
      .select(["id", "reader_ids"])
      .where((eb) =>
        eb.or(tokens.map((token) => eb("reader_ids", "like", `%"${token}"%`))),
      );
    if (ids) query = query.where("id", "in", [...ids]);
    const rows = await query.limit(ids ? Math.max(ids.length, 1) : 400).execute();
    const allowed = new Set(tokens);
    return rows
      .filter((row) =>
        (JSON.parse(row.reader_ids) as string[]).some((id) => allowed.has(id)),
      )
      .map((row) => row.id);
  };
  return {
    descriptor: knowledgeSearchSource,
    async prepareQuery({ context, query }) {
      if (context.kind !== "knowledge") return null;
      const candidateIds = await visibleIds(context.tokens);
      return {
        query,
        candidateIds,
        limit: Math.min(candidateIds.length, 20),
        semantic: true,
      };
    },
    async authorize({ context, candidateIds }) {
      return context.kind === "knowledge"
        ? visibleIds(context.tokens, candidateIds)
        : [];
    },
    async hydrate({ context, ids }) {
      if (context.kind !== "knowledge") return new Map();
      const visible = new Set(await visibleIds(context.tokens, ids));
      return new Map(ids.filter((id) => visible.has(id)).map((id) => [id, id]));
    },
    async *projections() {
      let cursor = "";
      for (;;) {
        const rows = await db
          .selectFrom("knowledge_chunks")
          .select(["id", "title", "text", "reader_ids"])
          .where("id", ">", cursor)
          .orderBy("id")
          .limit(100)
          .execute();
        if (!rows.length) break;
        yield rows.map((row) => ({
          id: row.id,
          text: row.text,
          metadata: {
            title: row.title,
            reader_ids: JSON.parse(row.reader_ids),
          },
        }));
        cursor = rows.at(-1)!.id;
      }
    },
  };
}

export function createBuiltinSearchSources(
  db: DB,
  options: {
    documents?: boolean;
    files?: boolean;
    knowledge?: boolean;
  } = {},
): readonly SearchSource<SearchQueryContext>[] {
  return [
    ...(options.documents === false ? [] : [createDocumentSource(db)]),
    ...(options.files === false ? [] : [createFileSource(db)]),
    ...(options.knowledge === false ? [] : [createKnowledgeSource(db)]),
  ];
}
