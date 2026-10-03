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
  MaterialsServiceV1,
} from "@smartdoca/plugin-sdk/creation-resources";
import {
  validatePluginManifest,
  validatePluginConfig,
  type PluginManifest,
  type ResourceFilter,
  type ResourceSearch,
  type CreationResourceCard,
  type CreationResourceResult,
  type ResourceRetrieval,
  type ResourceRetrievalPage,
  type ResourceRetrievalResult,
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
  version: z.literal(1),
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
interface Stream {
  id: string;
  cursor: string | null;
  done: boolean;
  buffer: CreationResourceResult[];
  seenCursors: string[];
  seenIds: string[];
  last?: CreationResourceCard;
}
interface Session {
  user: string;
  key: string;
  generation: number;
  expires: number;
  streams: Stream[];
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
function directory<P extends ResourceProvider>(db: DB, kind: string) {
  const scope = databaseRuntimeScope(db);
  let state = scope.get(`creation-resources:${kind}`) as
    | {
        providers: Map<string, P>;
        generation: number;
        sessions: Map<string, Session>;
      }
    | undefined;
  if (!state) {
    state = { providers: new Map(), generation: 0, sessions: new Map() };
    scope.set(`creation-resources:${kind}`, state);
  }
  const store = state;
  function selectedProviders(f: ResourceFilter) {
    if (f.providerIds?.some((providerId) => !store.providers.has(providerId)))
      fail(404, "Resource source unavailable");
    return [...store.providers.values()].filter((p) => matches(p, f));
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
  function card(
    p: P,
    value: unknown,
    f?: ResourceFilter,
  ): CreationResourceResult {
    const result = parsed(cardSchema, value, 502) as CreationResourceCard;
    if (kind === "templates" && !result.preview)
      fail(502, "Template card must include a style preview image");
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
    if (
      result.tags.some(
        (tag) =>
          !tag.startsWith("doca.tag.") && !tag.startsWith(p.pluginId + "."),
      )
    )
      fail(502, "Invalid resource tag namespace");
    if (
      result.ref.providerId !== p.id ||
      !matches(p, {
        contract: result.contract,
        contentType: result.contentType,
      }) ||
      (f?.contract && !sameType(f.contract, result.contract)) ||
      (f?.contentType && !sameType(f.contentType, result.contentType)) ||
      f?.tags?.some((tag) => !result.tags.includes(tag))
    )
      fail(502, "Provider returned an incompatible resource");
    return { ...result, source: sourceInfo(p) };
  }
  const compare = (
    a: CreationResourceCard,
    b: CreationResourceCard,
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
          kind === "templates" ? "read" : "import",
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
    async tags(c: PluginRequestContext, filter: ResourceFilter) {
      await identity(c);
      const f = parsed(resourceFilterSchema, filter),
        tags = new Map<
          string,
          { id: string; title: { zh: string; en: string } }
        >(),
        failures: string[] = [];
      const results = await Promise.allSettled(
        selectedProviders(f).map(async (p) => ({
          id: p.id,
          items: await invoke(c, p.id, (p, c) => p.tags(c, f)),
        })),
      );
      let i = 0;
      const providers = selectedProviders(f);
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
      input: ResourceRetrieval,
    ): Promise<ResourceRetrievalPage> {
      await identity(context);
      const normalized = parsed(resourceRetrievalSchema, input),
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
        items: ResourceRetrievalResult[];
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
                  ...filter,
                  providerIds: [p.id],
                  mode,
                  topK: perProvider,
                });
                bounded(value, 100000);
                const page = parsed(
                  z
                    .object({
                      items: z.array(retrievalHitSchema).max(perProvider),
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
                  if (
                    hit.ref.providerId !== p.id ||
                    seen.has(hit.ref.id) ||
                    !matches(p, {
                      contract: hit.contract,
                      contentType: hit.contentType,
                    }) ||
                    (filter.contract &&
                      !sameType(filter.contract, hit.contract)) ||
                    (filter.contentType &&
                      !sameType(filter.contentType, hit.contentType)) ||
                    filter.tags.some((tag) => !hit.tags.includes(tag)) ||
                    hit.tags.some(
                      (tag) =>
                        !tag.startsWith("doca.tag.") &&
                        !tag.startsWith(p.pluginId + "."),
                    )
                  )
                    fail(502, "Invalid resource retrieval hit");
                  seen.add(hit.ref.id);
                }
                return page;
              },
            );
            const items: ResourceRetrievalResult[] = [];
            for (let rank = 0; rank < result.items.length; rank++) {
              const hit = result.items[rank]!;
              try {
                const current = await service.describe(workContext, hit.ref);
                if (
                  !sameType(current.contract, hit.contract) ||
                  !sameType(current.contentType, hit.contentType) ||
                  filter.tags.some((tag) => !current.tags.includes(tag))
                )
                  fail(409, "Resource metadata changed");
                // Use current metadata and source identity; never forward thumbnails to AI.
                items.push({
                  ...hit,
                  title: current.title,
                  summary: current.summary,
                  tags: current.tags,
                  source: current.source,
                  rank: rank + 1,
                });
              } catch (error) {
                context.signal.throwIfAborted();
                if ((error as any).status === 404) continue;
                throw error;
              }
            }
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
    async search(c: PluginRequestContext, input: ResourceSearch) {
      c = {
        ...c,
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(30000)]),
      };
      await identity(c);
      const normalized = parsed(resourceSearchSchema, input);
      const { cursor, limit = 24, ...rest } = normalized;
      const f: ResourceFilter = {
        ...rest,
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
      let session: Session;
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
      const items: CreationResourceResult[] = [];
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
                  ...f,
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
                await service.describe(c, stream.buffer[0]!.ref);
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
export function createMaterialsService(db: DB): MaterialsServiceV1 {
  const { service, invoke } = directory<MaterialProvider>(db, "materials");
  return {
    ...service,
    async import(c, input) {
      parsed(resourceRefSchema, input.ref);
      if (
        !input.operationKey ||
        input.operationKey.length > 200 ||
        /[\x00-\x1f]/.test(input.operationKey)
      )
        fail(400, "Invalid material operation key");
      const descriptor = await service.describe(c, input.ref);
      const result = await invoke(c, input.ref.providerId, (p, c) =>
        p.import(c, input),
      );
      const file = await authorizeFileItem(
        db,
        principalActor(c),
        parsed(z.object({ fileId: z.string().uuid() }).strict(), result, 502)
          .fileId,
      );
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
  const { service, invoke, identity } = directory<TemplateProvider>(
      db,
      "templates",
    ),
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
