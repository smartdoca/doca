import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "@db/index.js";
import { databaseRuntimeScope } from "@db/runtime-scope.js";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type {
  ResourceProvider,
  TemplateProvider,
  MaterialProvider,
  TemplateConsumer,
  TemplatesServiceV1,
  MaterialsServiceV2,
} from "@smartdoca/plugin-sdk/creation-resources";
import {
  validatePluginManifest,
  validatePluginConfig,
  type PluginManifest,
  type ResourceFilter,
  type ResourceRetrievalHit,
  type MaterialCard,
  type MaterialCollectionCard,
  type MaterialRetrievalHit,
  type MaterialCollectionRetrievalHit,
  type MaterialFilter,
  type MaterialQueryFilter,
  type ResourceSearch,
  type CreationResourceCard,
  type ResourceRetrieval,
  type ResourceRetrievalPage,
  type ResourceSourceInfo,
  type CreationResourceRef,
  type ResourceProviderDescriptor,
  type TemplatePayload,
} from "@smartdoca/plugin-contracts";
import { authorizeFileItem } from "../access/file-access.js";
import { fail } from "../../shared/errors.js";
const id = z.string().min(1).max(200);
export const resourceTypeSchema = z
  .object({ id, version: z.number().int().positive() })
  .strict();
export const resourceRefSchema = z
  .object({ providerId: id, id, revision: id })
  .strict();
export const resourceFilterSchema = z
  .object({
    contract: resourceTypeSchema.optional(),
    contentType: resourceTypeSchema.optional(),
    query: z.string().max(1000).optional(),
    tags: z.array(id).max(30).optional(),
    providerIds: z.array(id).max(100).optional(),
    sort: z.enum(["updated", "name", "usage", "popular"]).optional(),
  })
  .strict();
export const resourceSearchSchema = resourceFilterSchema.extend({
  cursor: id.nullable().optional(),
  limit: z.number().int().min(1).max(48).optional(),
});
export const resourceRetrievalSchema = resourceFilterSchema
  .omit({ query: true, sort: true })
  .extend({
    query: z.string().trim().min(1).max(1000),
    mode: z.enum(["auto", "keyword", "semantic", "hybrid"]).optional(),
    topK: z.number().int().min(1).max(20).optional(),
  });
export const materialFilterSchema = resourceFilterSchema.extend({
  collectionRefs: z.array(resourceRefSchema).max(20).optional(),
});
export const materialQueryFilterSchema = materialFilterSchema.extend({
  collectionTags: z.array(id).max(30).optional(),
});
export const materialSearchSchema = materialQueryFilterSchema.extend({
  target: z.enum(["all", "materials", "collections"]).optional(),
  cursors: z
    .object({
      materials: id.nullable().optional(),
      collections: id.nullable().optional(),
    })
    .strict()
    .optional(),
  limit: z.number().int().min(1).max(48).optional(),
});
export const materialRetrievalSchema = materialQueryFilterSchema
  .omit({ query: true, sort: true })
  .extend({
    query: z.string().trim().min(1).max(1000),
    mode: z.enum(["auto", "keyword", "semantic", "hybrid"]).optional(),
    topK: z.number().int().min(1).max(20).optional(),
    target: z.enum(["all", "materials", "collections"]).optional(),
  });
export const materialCollectionItemsSchema = resourceSearchSchema.extend({
  ref: resourceRefSchema,
});
const materialDirectorySearchSchema = materialFilterSchema.extend({
  cursor: id.nullable().optional(),
  limit: z.number().int().min(1).max(48).optional(),
});
const materialDirectoryRetrievalSchema = resourceRetrievalSchema.extend({
  collectionRefs: z.array(resourceRefSchema).max(20).optional(),
});
const retrievalModeSchema = z.enum(["keyword", "semantic", "hybrid"]);
const retrievalHitSchema = z
  .object({
    ref: resourceRefSchema,
    title: z.string().min(1).max(160),
    summary: z.string().max(2000),
    tags: z.array(id).max(30),
    contract: resourceTypeSchema,
    contentType: resourceTypeSchema,
    matchText: z.string().max(500).optional(),
  })
  .strict();
export const templateSelectionSchema = z
  .object({
    ref: resourceRefSchema,
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
const localized = z
  .object({ zh: z.string().min(1).max(160), en: z.string().min(1).max(160) })
  .strict();
const sorts = z.enum(["updated", "name", "usage", "popular"]);
const descriptorSchema = z.object({
  id,
  pluginId: id,
  version: z.union([z.literal(1), z.literal(2)]),
  title: localized,
  contracts: z.array(resourceTypeSchema).min(1).max(50),
  contentTypes: z.array(resourceTypeSchema).min(1).max(50),
  sorts: z.array(sorts).min(1).max(4),
  description: z
    .object({
      zh: z.string().min(1).max(1000),
      en: z.string().min(1).max(1000),
    })
    .strict()
    .optional(),
  retrieval: z
    .object({ modes: z.array(retrievalModeSchema).min(1).max(3) })
    .strict()
    .optional(),
});
const cardSchema = z
  .object({
    ref: resourceRefSchema,
    title: z.string().min(1).max(160),
    summary: z.string().max(2000),
    tags: z.array(id).max(30),
    updatedAt: z.string().datetime({ offset: true }),
    preview: z
      .string()
      .max(180000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
      .optional(),
    contract: resourceTypeSchema,
    contentType: resourceTypeSchema,
    parameters: z.object({ type: z.literal("object") }).passthrough(),
    usage: z.number().int().nonnegative().optional(),
    popularity: z.number().finite().nonnegative().optional(),
    license: z.string().max(2000),
  })
  .strict();
const materialCardSchema = cardSchema.extend({
  collections: z.array(resourceRefSchema).max(100),
});
const collectionCardSchema = cardSchema
  .omit({ contract: true, contentType: true, parameters: true, license: true })
  .extend({
    contracts: z.array(resourceTypeSchema).min(1).max(50),
    contentTypes: z.array(resourceTypeSchema).min(1).max(50),
    count: z.number().int().nonnegative().optional(),
  });
const materialHitSchema = retrievalHitSchema.extend({
  collections: z.array(resourceRefSchema).max(100),
});
const collectionHitSchema = retrievalHitSchema
  .omit({ contract: true, contentType: true })
  .extend({
    contracts: z.array(resourceTypeSchema).min(1).max(50),
    contentTypes: z.array(resourceTypeSchema).min(1).max(50),
    count: z.number().int().nonnegative().optional(),
  });
type CatalogCard = CreationResourceCard | MaterialCard | MaterialCollectionCard;
type CatalogHit =
  ResourceRetrievalHit | MaterialRetrievalHit | MaterialCollectionRetrievalHit;
type WithSource<C> = C & { source: ResourceSourceInfo };
type WithRank<H> = WithSource<H> & { rank: number };
const sameType = (
  a: { id: string; version: number },
  b: { id: string; version: number },
) => a.id === b.id && a.version === b.version;
const matches = (p: ResourceProviderDescriptor, f: ResourceFilter) =>
  (!f.providerIds || f.providerIds.includes(p.id)) &&
  (!f.contract || p.contracts.some((x) => sameType(x, f.contract!))) &&
  (!f.contentType || p.contentTypes.some((x) => sameType(x, f.contentType!)));
const principalActor = (c: PluginRequestContext) => ({
  id: c.principal.id,
  display_name: c.principal.displayName,
  admin: Number(c.principal.admin),
});
function parsed<T>(schema: z.ZodType<T>, value: unknown, status = 400): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(status, "Invalid creation resource contract");
  return result.data;
}
function bounded(value: unknown, limit: number) {
  if (Buffer.byteLength(JSON.stringify(value)) > limit)
    fail(413, "Creation resource payload too large");
}
interface Stream<C extends CatalogCard> {
  id: string;
  cursor: string | null;
  done: boolean;
  buffer: WithSource<C>[];
  seenCursors: string[];
  seenIds: string[];
  last?: C;
}
interface Session<C extends CatalogCard> {
  user: string;
  key: string;
  generation: number;
  expires: number;
  streams: Stream<C>[];
  failures: string[];
}
function sourceInfo(p: ResourceProviderDescriptor): ResourceSourceInfo {
  return {
    id: p.id,
    pluginId: p.pluginId,
    title: p.title,
    ...(p.description ? { description: p.description } : {}),
  };
}
function directory<
  C extends CatalogCard,
  H extends CatalogHit,
  P extends ResourceProvider<C, H, MaterialFilter>,
>(db: DB, kind: "templates" | "materials" | "collections") {
  const scope = databaseRuntimeScope(db);
  let state = scope.get(`creation-resources:${kind}`) as
    | {
        providers: Map<string, P>;
        generation: number;
        sessions: Map<string, Session<C>>;
      }
    | undefined;
  if (!state) {
    state = { providers: new Map(), generation: 0, sessions: new Map() };
    scope.set(`creation-resources:${kind}`, state);
  }
  const store = state;
  function selectedProviders(f: MaterialFilter) {
    if (f.providerIds?.some((providerId) => !store.providers.has(providerId)))
      fail(404, "Resource source unavailable");
    return [...store.providers.values()].filter(
      (p) =>
        matches(p, f) &&
        (kind !== "materials" ||
          !f.collectionRefs ||
          f.collectionRefs.some((r) => r.providerId === p.id)),
    );
  }
  async function identity(c: PluginRequestContext) {
    c.signal.throwIfAborted();
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", c.principal.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user) fail(403, "Account unavailable");
  }
  async function invoke<T>(
    c: PluginRequestContext,
    providerId: string,
    work: (p: P, c: PluginRequestContext) => Promise<T>,
  ): Promise<T> {
    await identity(c);
    const provider = store.providers.get(providerId);
    if (!provider) fail(404, "Resource provider unavailable");
    const signal = AbortSignal.any([c.signal, AbortSignal.timeout(15000)]);
    let abort = () => {};
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const result = await Promise.race([
        work(provider, { ...c, signal }),
        canceled,
      ]);
      signal.throwIfAborted();
      await identity(c);
      if (store.providers.get(providerId) !== provider)
        fail(409, "Resource provider changed");
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  function validateRecord(
    p: P,
    result: CatalogCard | CatalogHit,
    f?: MaterialFilter,
  ) {
    const contracts =
      "contract" in result ? [result.contract] : result.contracts;
    const contentTypes =
      "contentType" in result ? [result.contentType] : result.contentTypes;
    if (
      result.ref.providerId !== p.id ||
      contracts.some((t) => !p.contracts.some((x) => sameType(x, t))) ||
      contentTypes.some((t) => !p.contentTypes.some((x) => sameType(x, t))) ||
      (f?.contract && !contracts.some((t) => sameType(f.contract!, t))) ||
      (f?.contentType &&
        !contentTypes.some((t) => sameType(f.contentType!, t))) ||
      f?.tags?.some((tag) => !result.tags.includes(tag)) ||
      result.tags.some(
        (tag) =>
          !tag.startsWith("doca.tag.") && !tag.startsWith(p.pluginId + "."),
      )
    )
      fail(502, "Provider returned an incompatible resource");
    if ("collections" in result) {
      if (
        ("collections" in p &&
          p.collections === null &&
          result.collections.length > 0) ||
        result.collections.some((r) => r.providerId !== p.id) ||
        new Set(result.collections.map((r) => r.id)).size !==
          result.collections.length ||
        (f?.collectionRefs &&
          !f.collectionRefs.some((r) =>
            result.collections.some(
              (x) =>
                x.providerId === r.providerId &&
                x.id === r.id &&
                x.revision === r.revision,
            ),
          ))
      )
        fail(502, "Invalid material collection membership");
    }
  }
  function card(p: P, value: unknown, f?: MaterialFilter): WithSource<C> {
    const schema =
      kind === "collections"
        ? collectionCardSchema
        : kind === "materials"
          ? materialCardSchema
          : cardSchema;
    const result = parsed(schema as z.ZodType<CatalogCard>, value, 502) as C;
    if (kind === "templates" && !result.preview)
      fail(502, "Template card must include a style preview image");
    if ("parameters" in result) {
      try {
        validatePluginManifest({
          schemaVersion: 1,
          id: p.pluginId,
          version: "1.0.0",
          displayName: p.id,
          config: result.parameters,
        });
      } catch {
        fail(502, "Invalid template parameter schema");
      }
    }
    validateRecord(p, result, f);
    return { ...result, source: sourceInfo(p) };
  }
  function providerFilter(p: P, f: MaterialFilter): MaterialFilter {
    return {
      ...f,
      providerIds: [p.id],
      ...(f.collectionRefs
        ? {
            collectionRefs: f.collectionRefs.filter(
              (r) => r.providerId === p.id,
            ),
          }
        : {}),
    };
  }
  const compare = (
    a: CatalogCard,
    b: CatalogCard,
    sort: ResourceFilter["sort"],
  ) => {
    let n =
      sort === "name"
        ? a.title.localeCompare(b.title)
        : sort === "usage"
          ? (b.usage ?? -1) - (a.usage ?? -1)
          : sort === "popular"
            ? (b.popularity ?? -1) - (a.popularity ?? -1)
            : Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return (
      n ||
      a.ref.providerId.localeCompare(b.ref.providerId) ||
      a.ref.id.localeCompare(b.ref.id)
    );
  };
  const service = {
    register(p: P) {
      parsed(descriptorSchema, p);
      if (p.version !== (kind === "templates" ? 1 : 2))
        fail(400, "Unsupported resource provider version");
      if (
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(p.pluginId) ||
        !p.id.startsWith(p.pluginId + ".") ||
        store.providers.has(p.id) ||
        store.providers.size >= 100 ||
        !p.sorts.includes("updated") ||
        !p.sorts.includes("name") ||
        !!p.retrieval !== (typeof p.retrieve === "function") ||
        (p.retrieval &&
          new Set(p.retrieval.modes).size !== p.retrieval.modes.length) ||
        [
          "search",
          "tags",
          "describe",
          ...(kind === "templates"
            ? ["read"]
            : kind === "materials"
              ? ["import"]
              : []),
        ].some((k) => typeof (p as any)[k] !== "function")
      )
        fail(400, "Invalid or duplicate resource provider");
      store.providers.set(p.id, p);
      store.generation++;
      store.sessions.clear();
      return () => {
        if (store.providers.get(p.id) === p) {
          store.providers.delete(p.id);
          store.generation++;
          store.sessions.clear();
        }
      };
    },
    async providers(c: PluginRequestContext, filter: ResourceFilter) {
      await identity(c);
      const f = parsed(resourceFilterSchema, filter);
      return selectedProviders(f).map((p) => descriptorSchema.parse(p));
    },
    async tags(c: PluginRequestContext, filter: MaterialFilter) {
      await identity(c);
      const f = parsed(
          kind === "materials" ? materialFilterSchema : resourceFilterSchema,
          filter,
        ),
        tags = new Map<
          string,
          { id: string; title: { zh: string; en: string } }
        >(),
        failures: string[] = [];
      const providers = selectedProviders(f),
        generation = store.generation;
      const results = await Promise.allSettled(
        providers.map(async (p) => ({
          id: p.id,
          items: await invoke(c, p.id, (p, c) =>
            p.tags(c, providerFilter(p, f)),
          ),
        })),
      );
      let i = 0;
      for (const result of results) {
        const provider = providers[i++]!;
        if (result.status === "rejected") {
          c.signal.throwIfAborted();
          failures.push(provider.id);
          continue;
        }
        try {
          const items = parsed(
            z.array(z.object({ id, title: localized }).strict()).max(500),
            result.value.items,
            502,
          );
          for (const tag of items) {
            if (
              !tag.id.startsWith("doca.tag.") &&
              !tag.id.startsWith(provider.pluginId + ".")
            )
              fail(502, "Invalid tag namespace");
            if (!tags.has(tag.id)) tags.set(tag.id, tag);
          }
        } catch {
          failures.push(provider.id);
        }
      }
      await identity(c);
      if (generation !== store.generation)
        fail(409, "Resource providers changed");
      return {
        items: [...tags.values()].sort((a, b) => a.id.localeCompare(b.id)),
        complete: !failures.length,
        failures,
      };
    },
    async describe(c: PluginRequestContext, ref: CreationResourceRef) {
      parsed(resourceRefSchema, ref);
      return invoke(c, ref.providerId, async (p, c) => {
        const value = await p.describe(c, ref);
        if (!value) fail(404, "Resource unavailable");
        const item = card(p, value);
        if (item.ref.id !== ref.id || item.ref.revision !== ref.revision)
          fail(409, "Resource revision changed");
        return item;
      });
    },
    async retrieve(
      context: PluginRequestContext,
      input: ResourceRetrieval & MaterialFilter,
    ): Promise<ResourceRetrievalPage<WithRank<H>>> {
      await identity(context);
      const normalized = parsed(
          kind === "materials"
            ? materialDirectoryRetrievalSchema
            : resourceRetrievalSchema,
          input,
        ) as ResourceRetrieval & MaterialFilter,
        topK = normalized.topK ?? 8,
        mode = normalized.mode ?? "auto";
      const filter = {
        ...normalized,
        tags: [...new Set(normalized.tags ?? [])].sort(),
        ...(normalized.providerIds
          ? { providerIds: [...new Set(normalized.providerIds)].sort() }
          : {}),
      };
      const generation = store.generation;
      const providers = selectedProviders(filter).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const deadline = AbortSignal.timeout(15000),
        workContext = {
          ...context,
          signal: AbortSignal.any([context.signal, deadline]),
        };
      const results: {
        items: WithRank<H>[];
        source?: ResourceRetrievalPage["sources"][number];
        failure?: ResourceRetrievalPage["failures"][number];
      }[] = new Array(providers.length);
      let next = 0;
      const worker = async () => {
        while (next < providers.length) {
          const index = next++,
            provider = providers[index]!;
          if (
            !provider.retrieval ||
            !provider.retrieve ||
            (mode !== "auto" && !provider.retrieval.modes.includes(mode))
          ) {
            results[index] = {
              items: [],
              failure: { providerId: provider.id, code: "unsupported" },
            };
            continue;
          }
          try {
            const perProvider =
              providers.length === 1 ? topK : Math.min(topK, 5);
            const result = await invoke(
              workContext,
              provider.id,
              async (p, c) => {
                const value = await p.retrieve!(c, {
                  ...providerFilter(p, filter),
                  query: filter.query,
                  mode,
                  topK: perProvider,
                });
                bounded(value, 100000);
                const page = parsed(
                  z
                    .object({
                      items: z
                        .array(
                          (kind === "collections"
                            ? collectionHitSchema
                            : kind === "materials"
                              ? materialHitSchema
                              : retrievalHitSchema) as unknown as z.ZodType<H>,
                        )
                        .max(perProvider),
                      mode: retrievalModeSchema,
                      hasMore: z.boolean(),
                    })
                    .strict(),
                  value,
                  502,
                );
                if (
                  !p.retrieval!.modes.includes(page.mode) ||
                  (mode !== "auto" && mode !== page.mode)
                )
                  fail(502, "Invalid resource retrieval mode");
                const seen = new Set<string>();
                for (const hit of page.items) {
                  if (seen.has(hit.ref.id))
                    fail(502, "Duplicate resource retrieval hit");
                  validateRecord(p, hit, filter);
                  seen.add(hit.ref.id);
                }
                return page;
              },
            );
            const items: WithRank<H>[] = [];
            for (let rank = 0; rank < result.items.length; rank++) {
              const hit = result.items[rank]!;
              try {
                const current = await service.describe(workContext, hit.ref);
                validateRecord(provider, current, filter);
                const base = {
                  ref: current.ref,
                  title: current.title,
                  summary: current.summary,
                  tags: current.tags,
                };
                const metadata: CatalogCard = current;
                const lightweight: CatalogHit =
                  "contract" in metadata
                    ? {
                        ...base,
                        contract: metadata.contract,
                        contentType: metadata.contentType,
                        ...("collections" in metadata
                          ? { collections: metadata.collections }
                          : {}),
                      }
                    : {
                        ...base,
                        contracts: metadata.contracts,
                        contentTypes: metadata.contentTypes,
                        ...(metadata.count !== undefined
                          ? { count: metadata.count }
                          : {}),
                      };
                if (
                  "contract" in hit &&
                  "contract" in metadata &&
                  (!sameType(hit.contract, metadata.contract) ||
                    !sameType(hit.contentType, metadata.contentType))
                )
                  fail(409, "Resource metadata changed");
                items.push({
                  ...lightweight,
                  source: current.source,
                  ...(hit.matchText ? { matchText: hit.matchText } : {}),
                  rank: rank + 1,
                } as unknown as WithRank<H>);
              } catch (error) {
                context.signal.throwIfAborted();
                if ((error as any).status === 404) continue;
                throw error;
              }
            }
            bounded(items, 100000);
            results[index] = {
              items,
              source: {
                source: sourceInfo(provider),
                mode: result.mode,
                count: items.length,
                truncated: result.hasMore,
              },
            };
          } catch {
            context.signal.throwIfAborted();
            results[index] = {
              items: [],
              failure: {
                providerId: provider.id,
                code: deadline.aborted ? "timeout" : "failed",
              },
            };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, providers.length) }, worker),
      );
      await identity(context);
      if (generation !== store.generation)
        fail(409, "Resource providers changed");
      const candidates = results
        .flatMap((result) => result.items)
        .sort(
          (a, b) =>
            a.rank - b.rank || a.ref.providerId.localeCompare(b.ref.providerId),
        );
      const sources = results.flatMap((result) =>
          result.source ? [result.source] : [],
        ),
        failures = results.flatMap((result) =>
          result.failure ? [result.failure] : [],
        );
      return {
        items: candidates.slice(0, topK),
        sources,
        failures,
        complete: !failures.length,
        truncated:
          candidates.length > topK ||
          sources.some((source) => source.truncated),
      };
    },
    async search(
      c: PluginRequestContext,
      input: ResourceSearch & MaterialFilter,
    ) {
      c = {
        ...c,
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
      };
      await identity(c);
      const normalized = parsed(
        kind === "materials"
          ? materialDirectorySearchSchema
          : resourceSearchSchema,
        input,
      ) as ResourceSearch & MaterialFilter;
      const { cursor, limit = 24, ...rest } = normalized;
      const f: MaterialFilter = {
        ...rest,
        ...(rest.collectionRefs
          ? {
              collectionRefs: [
                ...new Map(
                  rest.collectionRefs.map((r) => [JSON.stringify(r), r]),
                ).values(),
              ].sort(
                (a, b) =>
                  a.providerId.localeCompare(b.providerId) ||
                  a.id.localeCompare(b.id) ||
                  a.revision.localeCompare(b.revision),
              ),
            }
          : {}),
        query: rest.query?.trim() ?? "",
        tags: [...new Set(rest.tags ?? [])].sort(),
        ...(rest.providerIds
          ? { providerIds: [...new Set(rest.providerIds)].sort() }
          : {}),
        sort: rest.sort ?? "updated",
      };
      if (
        (f.sort === "usage" || f.sort === "popular") &&
        f.providerIds?.length !== 1
      )
        fail(400, "Usage/popularity require one provider");
      const providers = selectedProviders(f);
      if (providers.some((p) => !p.sorts.includes(f.sort!)))
        fail(400, "Resource sort unsupported by provider");
      const key = JSON.stringify(f);
      const now = Date.now();
      for (const [id, s] of store.sessions)
        if (s.expires < now) store.sessions.delete(id);
      let session: Session<C>;
      if (cursor) {
        const old = store.sessions.get(cursor);
        if (!old || old.expires < now) fail(410, "Resource cursor expired");
        if (
          old.user !== c.principal.id ||
          old.key !== key ||
          old.generation !== store.generation
        )
          fail(400, "Resource cursor mismatch");
        session = structuredClone(old);
      } else
        session = {
          user: c.principal.id,
          key,
          generation: store.generation,
          expires: now + 15 * 60 * 1000,
          streams: providers.map((p) => ({
            id: p.id,
            cursor: null,
            done: false,
            buffer: [],
            seenCursors: [],
            seenIds: [],
          })),
          failures: [],
        };
      const items: WithSource<C>[] = [];
      let calls = 0;
      while (items.length < limit) {
        for (const stream of session.streams) {
          if (stream.done && !stream.buffer.length) continue;
          try {
            while (!stream.buffer.length && !stream.done) {
              if (++calls > 100)
                fail(502, "Resource pagination budget exceeded");
              const page = await invoke(c, stream.id, async (p, c) => {
                const result = await p.search(c, {
                  ...providerFilter(p, f),
                  cursor: stream.cursor,
                  limit: 24,
                });
                if (
                  !Array.isArray(result.items) ||
                  result.items.length > 24 ||
                  (result.nextCursor !== null &&
                    (typeof result.nextCursor !== "string" ||
                      !result.nextCursor ||
                      result.nextCursor.length > 16000 ||
                      stream.seenCursors.includes(result.nextCursor)))
                )
                  fail(502, "Invalid resource pagination");
                return {
                  items: result.items.map((x) => card(p, x, f)),
                  nextCursor: result.nextCursor,
                };
              });
              for (const item of page.items) {
                if (
                  stream.seenIds.includes(item.ref.id) ||
                  (stream.last && compare(stream.last, item, f.sort) > 0)
                )
                  fail(502, "Duplicate or unsorted resource page");
                stream.seenIds.push(item.ref.id);
                stream.last = item;
              }
              if (stream.seenIds.length > 10000)
                fail(502, "Resource traversal limit exceeded");
              stream.buffer = page.items;
              stream.cursor = page.nextCursor;
              stream.done = page.nextCursor === null;
              if (page.nextCursor) stream.seenCursors.push(page.nextCursor);
            }
            // Buffered entries are never authority: check current visibility/revision on every page.
            while (stream.buffer.length) {
              try {
                const current = await service.describe(
                  c,
                  stream.buffer[0]!.ref,
                );
                validateRecord(store.providers.get(stream.id)!, current, f);
                stream.buffer[0] = current;
                break;
              } catch (error) {
                c.signal.throwIfAborted();
                if ((error as any).status === 404) {
                  stream.buffer.shift();
                  continue;
                }
                throw error;
              }
            }
          } catch {
            c.signal.throwIfAborted();
            stream.done = true;
            stream.buffer = [];
            if (!session.failures.includes(stream.id))
              session.failures.push(stream.id);
          }
        }
        const candidates = session.streams
          .filter((s) => s.buffer.length)
          .sort((a, b) => compare(a.buffer[0]!, b.buffer[0]!, f.sort));
        if (!candidates.length) {
          if (session.streams.some((s) => !s.done)) continue;
          break;
        }
        items.push(candidates[0]!.buffer.shift()!);
      }
      await identity(c);
      if (session.generation !== store.generation)
        fail(409, "Resource providers changed");
      let nextCursor: string | null = null;
      if (session.streams.some((s) => !s.done || s.buffer.length)) {
        if (store.sessions.size >= 500) fail(429, "Too many resource queries");
        nextCursor = randomUUID();
        store.sessions.set(nextCursor, session);
      }
      return {
        items,
        nextCursor,
        complete: !session.failures.length,
        failures: session.failures,
      };
    },
  };
  return { service, invoke, identity, store };
}
export function createMaterialsService(db: DB): MaterialsServiceV2 {
  const assets = directory<
    MaterialCard,
    MaterialRetrievalHit,
    MaterialProvider
  >(db, "materials");
  type CollectionProvider = ResourceProvider<
    MaterialCollectionCard,
    MaterialCollectionRetrievalHit
  >;
  const groups = directory<
    MaterialCollectionCard,
    MaterialCollectionRetrievalHit,
    CollectionProvider
  >(db, "collections");
  const emptyPage = () => ({
    items: [],
    nextCursor: null,
    complete: true,
    failures: [],
  });
  const emptyRetrieval = () => ({
    items: [],
    sources: [],
    complete: true,
    truncated: false,
    failures: [],
  });
  // A rejected group must not leave its sibling using the database after return.
  async function catalogPair<A, B>(
    left: A | Promise<A>,
    right: B | Promise<B>,
  ): Promise<[A, B]> {
    const [first, second] = await Promise.allSettled([left, right] as const);
    if (first.status === "rejected") throw first.reason;
    if (second.status === "rejected") throw second.reason;
    return [first.value, second.value];
  }
  async function filters(c: PluginRequestContext, f: MaterialQueryFilter) {
    // Always validate selected source IDs in the full directory before narrowing.
    const generation = assets.store.generation,
      collectionGeneration = groups.store.generation;
    const checkRegistration = () => {
      if (
        generation !== assets.store.generation ||
        collectionGeneration !== groups.store.generation
      )
        fail(409, "Resource providers changed");
    };
    const sources = await assets.service.providers(
      c,
      (({ collectionRefs: _refs, collectionTags: _tags, ...rest }) => rest)(f),
    );
    if (
      f.collectionRefs?.some(
        (r) => f.providerIds && !f.providerIds.includes(r.providerId),
      )
    )
      fail(400, "Collection outside selected sources");
    if (f.collectionRefs)
      await Promise.all(
        f.collectionRefs.map((r) => groups.service.describe(c, r)),
      );
    checkRegistration();
    const collectionIds = sources
      .filter((p) => assets.store.providers.get(p.id)!.collections !== null)
      .map((p) => p.id);
    const { collectionRefs, collectionTags, tags, ...common } = f;
    return {
      checkRegistration,
      materials: { ...common, tags, collectionRefs },
      collections: {
        ...common,
        tags: collectionTags,
        providerIds: collectionIds,
      },
    };
  }
  async function checkScopes(c: PluginRequestContext, f: MaterialFilter) {
    if (f.collectionRefs)
      await Promise.all(
        f.collectionRefs.map((r) => groups.service.describe(c, r)),
      );
  }
  return {
    register(p) {
      if (
        p.collections === undefined ||
        (p.collections !== null && typeof p.collections !== "object")
      )
        fail(400, "Explicit collection capability required");
      if (
        p.collections &&
        Object.keys(p.collections).some(
          (k) =>
            !["search", "describe", "tags", "retrieve", "retrieval"].includes(
              k,
            ),
        )
      )
        fail(400, "Invalid collection capability");
      const disposeAssets = assets.service.register(p);
      let disposeGroups: (() => void) | undefined;
      try {
        if (p.collections !== null) {
          const { retrieval: _retrieval, ...descriptor } =
            descriptorSchema.parse(p);
          disposeGroups = groups.service.register({
            ...descriptor,
            ...p.collections,
          });
        }
      } catch (error) {
        disposeAssets();
        throw error;
      }
      return () => {
        disposeGroups?.();
        disposeAssets();
      };
    },
    async providers(c, f) {
      const sources = await assets.service.providers(c, f);
      return sources.map((p) => ({
        ...p,
        version: 2 as const,
        collections:
          assets.store.providers.get(p.id)!.collections === null
            ? null
            : {
                ...(assets.store.providers.get(p.id)!.collections!.retrieval
                  ? {
                      retrieval: assets.store.providers.get(p.id)!.collections!
                        .retrieval,
                    }
                  : {}),
              },
      }));
    },
    async tags(c, input) {
      const f = parsed(materialQueryFilterSchema, input),
        scoped = await filters(c, f);
      const [materials, collections] = await catalogPair(
        assets.service.tags(c, scoped.materials),
        groups.service.tags(c, scoped.collections),
      );
      await checkScopes(c, f);
      scoped.checkRegistration();
      return { materials, collections };
    },
    async search(c, input) {
      c = {
        ...c,
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
      };
      const {
          target = "all",
          cursors,
          limit,
          ...f
        } = parsed(materialSearchSchema, input),
        scoped = await filters(c, f);
      if (f.collectionRefs && target !== "materials")
        fail(400, "Collection membership query must target materials");
      const [materials, collections] = await catalogPair(
        target === "collections"
          ? emptyPage()
          : assets.service.search(c, {
              ...scoped.materials,
              cursor: cursors?.materials,
              limit,
            }),
        target === "materials"
          ? emptyPage()
          : groups.service.search(c, {
              ...scoped.collections,
              cursor: cursors?.collections,
              limit,
            }),
      );
      await checkScopes(c, f);
      scoped.checkRegistration();
      return { materials, collections };
    },
    async retrieve(c, input) {
      c = {
        ...c,
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
      };
      const {
          target = "all",
          topK,
          mode,
          ...f
        } = parsed(materialRetrievalSchema, input),
        scoped = await filters(c, f);
      if (f.collectionRefs && target !== "materials")
        fail(400, "Collection membership query must target materials");
      const [materials, collections] = await catalogPair(
        target === "collections"
          ? emptyRetrieval()
          : assets.service.retrieve(c, {
              ...scoped.materials,
              query: f.query,
              topK,
              mode,
            }),
        target === "materials"
          ? emptyRetrieval()
          : groups.service.retrieve(c, {
              ...scoped.collections,
              query: f.query,
              topK,
              mode,
            }),
      );
      await checkScopes(c, f);
      scoped.checkRegistration();
      return { materials, collections };
    },
    describe: assets.service.describe,
    collectionDescribe: groups.service.describe,
    async collectionItems(c, input) {
      c = {
        ...c,
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
      };
      const { ref, cursor, limit, ...f } = parsed(
        materialCollectionItemsSchema,
        input,
      );
      const scope = { ...f, collectionRefs: [ref] },
        scoped = await filters(c, scope);
      const page = await assets.service.search(c, {
        ...scoped.materials,
        cursor,
        limit,
      });
      await checkScopes(c, scope);
      scoped.checkRegistration();
      return page;
    },
    async import(c, input) {
      parsed(resourceRefSchema, input.ref);
      if (
        !input.operationKey ||
        input.operationKey.length > 200 ||
        /[\x00-\x1f]/.test(input.operationKey)
      )
        fail(400, "Invalid material operation key");
      const descriptor = await assets.service.describe(c, input.ref);
      const result = await assets.invoke(c, input.ref.providerId, (p, c) =>
        p.import(c, input),
      );
      const file = await authorizeFileItem(
        db,
        principalActor(c),
        parsed(z.object({ fileId: z.string().uuid() }).strict(), result, 502)
          .fileId,
      );
      await assets.service.describe(c, input.ref);
      return {
        source: descriptor.source,
        fileId: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
      };
    },
  };
}
/** Capture a registration identity without calling plugin code inside a write transaction. */
export function templateProviderGuard(db: DB, providerId: string) {
  const store = databaseRuntimeScope(db).get("creation-resources:templates") as
    { providers: Map<string, TemplateProvider> } | undefined;
  const provider = store?.providers.get(providerId);
  if (!provider) fail(404, "Template provider unavailable");
  return () => {
    if (store?.providers.get(providerId) !== provider)
      fail(409, "Template provider changed");
  };
}
export function createTemplatesService(db: DB): TemplatesServiceV1 {
  const { service, invoke, identity } = directory<
      CreationResourceCard,
      ResourceRetrievalHit,
      TemplateProvider
    >(db, "templates"),
    scope = databaseRuntimeScope(db);
  let consumers = scope.get("creation-resource-consumers") as
    Map<string, TemplateConsumer> | undefined;
  if (!consumers) {
    consumers = new Map();
    scope.set("creation-resource-consumers", consumers);
  }
  const registry = consumers;
  return {
    ...service,
    async read(c, input) {
      parsed(templateSelectionSchema, input);
      bounded(input.parameters, 100000);
      const item = await service.describe(c, input.ref);
      let parameters;
      try {
        parameters = validatePluginConfig(
          {
            id: input.ref.providerId,
            config: item.parameters,
          } as PluginManifest,
          input.parameters,
        );
      } catch {
        fail(400, "Invalid template parameters");
      }
      const payload = await invoke(c, input.ref.providerId, (p, c) =>
        p.read(c, { ref: input.ref, parameters }),
      );
      bounded(payload, 768 * 1024);
      if (
        !sameType(payload.contract, item.contract) ||
        !sameType(payload.contentType, item.contentType) ||
        !Array.isArray(payload.assets) ||
        payload.assets.length > 100
      )
        fail(502, "Invalid template payload");
      const keys = new Set<string>();
      for (const a of payload.assets) {
        parsed(resourceRefSchema, a.ref, 502);
        if (!/^[a-zA-Z0-9._-]{1,80}$/.test(a.key) || keys.has(a.key))
          fail(502, "Invalid template asset key");
        keys.add(a.key);
      }
      const descriptor = await service.describe(c, input.ref);
      return { ...structuredClone(payload), source: descriptor.source };
    },
    registerConsumer(consumer) {
      if (
        !consumer.id.startsWith(consumer.pluginId + ".") ||
        registry.has(consumer.id) ||
        typeof consumer.execute !== "function" ||
        consumer.version !== 1 ||
        !consumer.accepts.length
      )
        fail(400, "Invalid template consumer");
      parsed(
        z.object({
          id,
          pluginId: id,
          version: z.literal(1),
          inputSchema: z.object({ type: z.literal("object") }).passthrough(),
          title: localized,
          accepts: z
            .array(
              z
                .object({
                  contract: resourceTypeSchema,
                  contentType: resourceTypeSchema,
                })
                .strict(),
            )
            .min(1)
            .max(100),
        }),
        consumer,
      );
      try {
        validatePluginManifest({
          schemaVersion: 1,
          id: consumer.pluginId,
          version: "1.0.0",
          displayName: consumer.id,
          config: consumer.inputSchema,
        });
      } catch {
        fail(400, "Invalid consumer input schema");
      }
      registry.set(consumer.id, consumer);
      return () => {
        if (registry.get(consumer.id) === consumer)
          registry.delete(consumer.id);
      };
    },
    async consumers(c) {
      await identity(c);
      return [...registry.values()].map(
        ({ id, pluginId, version, inputSchema, title, accepts }) => ({
          id,
          pluginId,
          version,
          inputSchema,
          title,
          accepts,
        }),
      );
    },
    async consume(c, input) {
      await identity(c);
      const consumer = registry.get(input.consumerId);
      if (!consumer) fail(404, "Template consumer unavailable");
      const payload: TemplatePayload = await createTemplatesService(db).read(
        c,
        input.selection,
      );
      if (
        !consumer.accepts.some(
          (a) =>
            sameType(a.contract, payload.contract) &&
            sameType(a.contentType, payload.contentType),
        )
      )
        fail(400, "Template consumer type mismatch");
      bounded(input.input, 100000);
      let consumerInput;
      try {
        consumerInput = validatePluginConfig(
          {
            id: consumer.pluginId,
            config: consumer.inputSchema,
          } as PluginManifest,
          input.input,
        );
      } catch {
        fail(400, "Invalid consumer input");
      }
      c.signal.throwIfAborted();
      const result = await consumer.execute(c, {
        template: payload,
        selection: input.selection,
        input: consumerInput,
      });
      bounded(result, 2 * 1024 * 1024);
      await identity(c);
      if (registry.get(consumer.id) !== consumer)
        fail(409, "Template consumer changed");
      return result;
    },
  };
}
