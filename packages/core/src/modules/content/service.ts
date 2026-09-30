import type {
  ContentServiceV1,
  ContentSource,
  ContentSourceDescriptor,
  ContentContext,
  ContentItem,
  ContentReference,
  ContentPurpose,
  ContentPage,
} from "@smartdoca/plugin-sdk/content";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type { DB } from "@db/index.js";
import { pluginServices } from "../../shared/plugin-services.js";
import { fail } from "../../shared/errors.js";

const purposes = new Set(["knowledge", "analysis", "search"]);
export const contentReferenceKey = (ref: ContentReference) =>
  JSON.stringify([ref.sourceId, ref.resourceId, ref.blockId]);
function reference(source: ContentSource, ref: ContentReference) {
  if (
    !ref ||
    ref.sourceId !== source.id ||
    typeof ref.resourceId !== "string" ||
    !ref.resourceId ||
    ref.resourceId.length > 1000 ||
    typeof ref.blockId !== "string" ||
    !ref.blockId ||
    ref.blockId.length > 1000
  )
    fail(502, "Invalid content reference");
}
function item(source: ContentSource, value: ContentItem) {
  reference(source, value.ref);
  if (
    typeof value.fingerprint !== "string" ||
    !value.fingerprint ||
    value.fingerprint.length > 1000 ||
    typeof value.title !== "string" ||
    value.title.length > 1000 ||
    (value.excerpt !== undefined &&
      (typeof value.excerpt !== "string" || value.excerpt.length > 1000)) ||
    (value.order !== undefined &&
      (!Number.isSafeInteger(value.order) || value.order < 0))
  )
    fail(502, "Invalid content item");
}
function cursor(value: unknown) {
  if (
    value !== null &&
    (typeof value !== "string" || !value || value.length > 16000)
  )
    fail(400, "Invalid content cursor");
}
function descriptor(source: ContentSource): ContentSourceDescriptor {
  const {
    id,
    pluginId,
    version,
    title,
    contentTypes,
    purposes,
    capabilities,
    configSchema,
  } = source;
  return structuredClone({
    id,
    pluginId,
    version,
    title,
    contentTypes,
    purposes,
    capabilities,
    configSchema,
  });
}
function pageResult(
  source: ContentSource,
  page: ContentPage,
  input: { limit: number; cursor: string | null },
) {
  if (!Array.isArray(page.items) || page.items.length > input.limit)
    fail(502, "Invalid content page size");
  const seen = new Set<string>();
  for (const entry of page.items) {
    item(source, entry);
    if ("text" in entry)
      fail(502, "Content inventory must not include body text");
    const key = contentReferenceKey(entry.ref);
    if (seen.has(key)) fail(502, "Duplicate content reference");
    seen.add(key);
  }
  cursor(page.nextCursor);
  if (
    typeof page.snapshot !== "string" ||
    !page.snapshot ||
    page.snapshot.length > 16000 ||
    (input.cursor !== null && page.nextCursor === input.cursor)
  )
    fail(502, "Invalid content pagination");
  return page;
}
export function createContentService(db: DB): ContentServiceV1 {
  const registry = pluginServices(db).content;
  async function identity(request: PluginRequestContext) {
    request.signal.throwIfAborted();
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", request.principal.id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user) fail(403, "Content access denied");
  }
  async function invoke<T>(
    request: PluginRequestContext,
    sourceId: string,
    purpose: ContentPurpose,
    run: (source: ContentSource, context: ContentContext) => Promise<T>,
  ) {
    await identity(request);
    if (!purposes.has(purpose)) fail(400, "Invalid content purpose");
    const source = registry.get(sourceId);
    if (!source || !source.purposes.includes(purpose))
      fail(404, "Content source unavailable");
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(20_000),
    ]);
    let abort: () => void = () => {};
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const result = await Promise.race([
        run(source, { principalId: request.principal.id, purpose, signal }),
        canceled,
      ]);
      signal.throwIfAborted();
      await identity(request);
      if (registry.get(sourceId) !== source)
        fail(404, "Content source unavailable");
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  function inputPage(input: { limit: number; cursor: string | null }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      fail(400, "Content limit must be between 1 and 100");
    cursor(input.cursor);
  }
  return {
    register(input) {
      if (
        !/^[a-z][a-z0-9.-]*$/.test(input.pluginId) ||
        !input.id.startsWith(input.pluginId + ".") ||
        input.version !== 1 ||
        registry.has(input.id) ||
        typeof input.list !== "function" ||
        typeof input.read !== "function" ||
        typeof input.resolve !== "function"
      )
        fail(400, "Invalid or duplicate content source");
      if (
        !input.purposes.length ||
        input.purposes.some((p) => !purposes.has(p))
      )
        fail(400, "Invalid content purposes");
      if (
        typeof input.capabilities.search !== "boolean" ||
        input.capabilities.search !== (typeof input.search === "function")
      )
        fail(400, "Content capabilities do not match implementations");
      const source: ContentSource = Object.freeze({
        ...descriptor(input),
        list: input.list.bind(input),
        read: input.read.bind(input),
        resolve: input.resolve.bind(input),
        ...(input.search ? { search: input.search.bind(input) } : {}),
      });
      registry.set(source.id, source);
      return () => {
        if (registry.get(source.id) === source) registry.delete(source.id);
      };
    },
    async sources(request, purpose) {
      await identity(request);
      if (!purposes.has(purpose)) fail(400, "Invalid content purpose");
      return [...registry.values()]
        .filter((s) => s.purposes.includes(purpose))
        .map(descriptor);
    },
    list(request, input) {
      inputPage(input);
      return invoke(
        request,
        input.sourceId,
        input.purpose,
        async (source, ctx) =>
          pageResult(source, await source.list(ctx, input), input),
      );
    },
    read(request, input) {
      return invoke(
        request,
        input.sourceId,
        input.purpose,
        async (source, ctx) => {
          reference(source, input.ref);
          if (
            typeof input.fingerprint !== "string" ||
            !input.fingerprint ||
            input.fingerprint.length > 1000
          )
            fail(400, "Content fingerprint is required");
          const result = await source.read(ctx, input);
          if (!result) return null;
          item(source, result);
          if (
            contentReferenceKey(result.ref) !== contentReferenceKey(input.ref)
          )
            fail(502, "Unexpected content reference");
          if (result.fingerprint !== input.fingerprint)
            fail(409, "Content fingerprint changed; enumerate again");
          if (typeof result.text !== "string" || result.text.length > 2_000_000)
            fail(502, "Invalid content body size");
          return result;
        },
      );
    },
    resolve(request, input) {
      return invoke(
        request,
        input.ref.sourceId,
        input.purpose,
        async (source, ctx) => {
          reference(source, input.ref);
          const result = await source.resolve(ctx, input.ref);
          if (!result) return null;
          const url = new URL(result.path, "https://content.invalid");
          if (
            !result.fingerprint ||
            !result.path.startsWith("/") ||
            result.path.startsWith("//") ||
            /[\\\x00-\x1f]/.test(result.path) ||
            url.origin !== "https://content.invalid"
          )
            fail(502, "Invalid content location");
          return result;
        },
      );
    },
    search(request, input) {
      inputPage(input);
      if (!input.query.trim() || input.query.length > 2000)
        fail(400, "Invalid content query");
      return invoke(
        request,
        input.sourceId,
        input.purpose,
        async (source, ctx) => {
          if (!source.search)
            fail(422, "Content source does not support search");
          return pageResult(source, await source.search(ctx, input), input);
        },
      );
    },
  };
}
