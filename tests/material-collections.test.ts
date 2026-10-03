import { beforeEach, afterEach, it, expect } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { resourceRequest } from "@core/modules/creation-resources/document-template.js";
import {
  createMaterialsService,
  createTemplatesService,
} from "@core/modules/creation-resources/service.js";
import type { DB } from "@db/index.js";
import { installMaterialCollections } from "./material-collection-fixtures.js";
import { createCreationResourceQueryTools } from "@server/services/ai/creation-resource-tools.js";
import { createPluginPlatformClient } from "@smartdoca/plugin-sdk/web";
let db: DB, context: ReturnType<typeof resourceRequest>;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const user = await createUser(
    db,
    {
      login: "collections",
      displayName: "Collections",
      password: "collections-test-only",
    },
    { bootstrap: true },
  );
  context = resourceRequest({ ...user, admin: 1 });
});
afterEach(() => db.destroy());

it("returns independent paginated metadata groups, including multi-collection and ungrouped assets", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  const first = await service.search(context, { limit: 1 });
  expect(first.materials.items[0]!.collections).toHaveLength(2);
  expect(first.collections.items[0]).not.toHaveProperty("items");
  expect(first.collections.items[0]).not.toHaveProperty("parameters");
  expect(first.materials.items[0]!.source.id).toBe(f.provider.id);
  expect(first.materials.nextCursor).toBeTruthy();
  expect(first.collections.nextCursor).toBeTruthy();
  const next = await service.search(context, {
    limit: 1,
    cursors: {
      materials: first.materials.nextCursor,
      collections: first.collections.nextCursor,
    },
  });
  expect(next.materials.items[0]!.ref.id).toBe("asset1");
  expect(next.collections.items[0]!.ref.id).toBe("group1");
  expect(next.collections.nextCursor).toBeNull();
  const last = await service.search(context, {
    target: "materials",
    limit: 1,
    cursors: { materials: next.materials.nextCursor },
  });
  expect(last.materials.items[0]!.collections).toEqual([]);
  expect(last.collections.items).toEqual([]);
  await expect(
    service.search(context, {
      target: "collections",
      cursors: { collections: first.materials.nextCursor },
    }),
  ).rejects.toThrow("expired");
  await expect(
    service.search(context, { cursor: first.materials.nextCursor } as any),
  ).rejects.toThrow("contract");
});

it("keeps asset and collection tags independent, deduplicated only within each group", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  const tags = await service.tags(context, {});
  expect(tags.materials.items.map((t) => t.id)).toEqual(["doca.tag.color"]);
  expect(tags.collections.items.map((t) => t.id)).toEqual(["doca.tag.theme"]);
  const page = await service.search(context, {
    tags: ["doca.tag.theme"],
    collectionTags: ["doca.tag.theme"],
  });
  expect(page.materials.items).toEqual([]);
  expect(page.collections.items).toHaveLength(2);
  const scoped = await service.collectionItems(context, {
    ref: f.groups[0]!.ref,
    tags: ["doca.tag.color"],
  });
  expect(scoped.items).toHaveLength(2);
  expect(scoped.items.every((x) => !x.tags.includes("doca.tag.theme"))).toBe(
    true,
  );
});

it("fetches members only after selection and restricts OR membership to selected sources", async () => {
  const a = installMaterialCollections(db),
    b = installMaterialCollections(db, "example.palette.other"),
    service = createMaterialsService(db);
  const meta = await service.collectionDescribe(context, a.groups[0]!.ref);
  expect(meta.count).toBe(2);
  expect(a.materialSearch).not.toHaveBeenCalled();
  const page = await service.collectionItems(context, {
    ref: meta.ref,
    limit: 1,
  });
  expect(page.items[0]!.ref.id).toBe("asset0");
  expect(page.nextCursor).toBeTruthy();
  expect(b.materialSearch).not.toHaveBeenCalled();
  const next = await service.collectionItems(context, {
    ref: meta.ref,
    cursor: page.nextCursor,
    limit: 1,
  });
  expect(next.items[0]!.ref.id).toBe("asset1");
  expect(next.nextCursor).toBeNull();
  const union = await service.search(context, {
    target: "materials",
    collectionRefs: a.groups.map((g) => g.ref),
  });
  expect(union.materials.items.map((x) => x.ref.id)).toEqual([
    "asset0",
    "asset1",
  ]);
  await expect(
    service.collectionItems(context, {
      ref: meta.ref,
      providerIds: [b.provider.id],
    }),
  ).rejects.toThrow("outside selected");
  await expect(
    service.collectionItems(context, {
      ref: a.groups[1]!.ref,
      cursor: page.nextCursor,
    }),
  ).rejects.toThrow("mismatch");
  expect(
    (await service.search(context, { target: "materials", collectionRefs: [] }))
      .materials.items,
  ).toEqual([]);
});

it("honors current collection visibility and rejects changed membership versions before/after paging", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  const ref = { ...f.groups[0]!.ref };
  const page = await service.collectionItems(context, { ref, limit: 1 });
  f.hidden.add(ref.id);
  await expect(
    service.collectionItems(context, { ref, cursor: page.nextCursor }),
  ).rejects.toThrow("unavailable");
  f.hidden.clear();
  f.groups[0] = { ...f.groups[0]!, ref: { ...ref, revision: "2" } };
  await expect(
    service.collectionItems(context, { ref, cursor: page.nextCursor }),
  ).rejects.toThrow("revision changed");
  f.groups[0] = { ...f.groups[0]!, ref };
  f.materialSearch.mockImplementationOnce(async () => {
    f.groups[0] = { ...f.groups[0]!, ref: { ...ref, revision: "3" } };
    return { items: [f.cards[0]!], nextCursor: null };
  });
  await expect(service.collectionItems(context, { ref })).rejects.toThrow(
    "revision changed",
  );
});

it("queries both indexed result groups once, with per-group budgets and no browse fallback", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  const page = await service.retrieve(context, { query: "palette", topK: 1 });
  expect(page.materials.items).toHaveLength(1);
  expect(page.collections.items).toHaveLength(1);
  expect(page.materials.truncated).toBe(true);
  expect(page.collections.truncated).toBe(true);
  expect(f.materialRetrieve).toHaveBeenCalledTimes(1);
  expect(f.groupRetrieve).toHaveBeenCalledTimes(1);
  expect(f.materialSearch).not.toHaveBeenCalled();
  expect(f.groupSearch).not.toHaveBeenCalled();
  expect(page.materials.items[0]).not.toHaveProperty("preview");
  expect(page.materials.items[0]).not.toHaveProperty("parameters");
  const scoped = await service.retrieve(context, {
    query: "red",
    target: "materials",
    collectionRefs: [f.groups[1]!.ref],
  });
  expect(scoped.materials.items.map((x) => x.title)).toEqual(["Red"]);
  expect(f.materialRetrieve).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ collectionRefs: [f.groups[1]!.ref] }),
  );
  expect(f.groupRetrieve).toHaveBeenCalledTimes(1);
  expect(f.importer).not.toHaveBeenCalled();
  f.dispose();
  const {
    retrieve: _retrieve,
    retrieval: _retrieval,
    ...browse
  } = f.provider.collections!;
  service.register({ ...f.provider, collections: browse });
  const unsupported = await service.retrieve(context, {
    query: "palette",
    target: "collections",
  });
  expect(unsupported.collections.failures).toEqual([
    { providerId: f.provider.id, code: "unsupported" },
  ]);
  expect(unsupported.collections.complete).toBe(false);
  expect(f.groupSearch).not.toHaveBeenCalled();
});

it("does not call excluded sources, and validates empty/unknown source selections", async () => {
  const a = installMaterialCollections(db),
    b = installMaterialCollections(db, "example.palette.other"),
    service = createMaterialsService(db);
  const page = await service.retrieve(context, {
    query: "palette",
    providerIds: [a.provider.id],
  });
  expect(page.collections.items).toHaveLength(2);
  expect(b.groupRetrieve).not.toHaveBeenCalled();
  expect(b.materialRetrieve).not.toHaveBeenCalled();
  const empty = await service.search(context, { providerIds: [] });
  expect(empty.materials.items).toEqual([]);
  expect(empty.collections.items).toEqual([]);
  await expect(
    service.search(context, {
      providerIds: ["example.palette.missing"],
      target: "collections",
    }),
  ).rejects.toThrow("source unavailable");
  b.dispose();
  service.register({ ...b.provider, collections: null });
  expect(
    (await service.providers(context, { providerIds: [b.provider.id] }))[0]!
      .collections,
  ).toBeNull();
  expect(
    (await service.search(context, { providerIds: [b.provider.id] }))
      .collections,
  ).toMatchObject({ items: [], complete: true });
});

it("rejects old provider versions, missing capability, forged collection descriptors and inline members", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  f.dispose();
  expect(() => service.register({ ...f.provider, version: 1 } as any)).toThrow(
    "version",
  );
  const { collections: _collections, ...missing } = f.provider;
  expect(() => service.register(missing as any)).toThrow("capability");
  expect(() =>
    service.register({
      ...f.provider,
      collections: { ...f.provider.collections, id: "example.palette.forged" },
    } as any),
  ).toThrow("capability");
  service.register({
    ...f.provider,
    collections: {
      ...f.provider.collections!,
      search: async () => ({
        items: [{ ...f.groups[0]!, items: f.cards } as any],
        nextCursor: null,
      }),
    },
  });
  const malformed = await service.search(context, { target: "collections" });
  expect(malformed.collections.complete).toBe(false);
  expect(malformed.collections.items).toEqual([]);
});

it("rechecks buffered member metadata and rejects providers returning out-of-scope members", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  f.materialSearch.mockImplementationOnce(async () => ({
    items: [f.cards[2]!],
    nextCursor: null,
  }));
  const invalid = await service.collectionItems(context, {
    ref: f.groups[0]!.ref,
  });
  expect(invalid.complete).toBe(false);
  expect(invalid.items).toEqual([]);
  const page = await service.collectionItems(context, {
    ref: f.groups[0]!.ref,
    limit: 1,
  });
  f.cards[1] = { ...f.cards[1]!, collections: [] };
  const changed = await service.collectionItems(context, {
    ref: f.groups[0]!.ref,
    cursor: page.nextCursor,
  });
  expect(changed.complete).toBe(false);
  expect(changed.items).toEqual([]);
});

it("exposes lightweight dual groups and scoped members through actual AI tools and SDK transport", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  const tools = createCreationResourceQueryTools(
    { templates: createTemplatesService(db), materials: service },
    context,
  );
  const result = (await tools.creation_resource_search.execute!(
    { kind: "materials" },
    {} as any,
  )) as any;
  expect(result.materials.items[0]).not.toHaveProperty("parameters");
  expect(result.collections.items[0]).not.toHaveProperty("preview");
  const collection = (await tools.material_collection_describe.execute!(
    f.groups[0]!.ref,
    {} as any,
  )) as any;
  expect(collection).not.toHaveProperty("items");
  const members = (await tools.material_collection_items.execute!(
    { ref: f.groups[0]!.ref, query: "red" },
    {} as any,
  )) as any;
  expect(members.items.map((x: any) => x.title)).toEqual(["Red"]);
  const calls: { operation: string; input: unknown }[] = [];
  const client = createPluginPlatformClient(
    async <T>(operation: string, input: unknown) => {
      calls.push({ operation, input });
      return {} as T;
    },
  );
  await client.materials.collectionDescribe(f.groups[0]!.ref);
  await client.materials.collectionItems({ ref: f.groups[0]!.ref, limit: 1 });
  await client.materials.search({
    target: "collections",
    cursors: { collections: "cursor" },
    collectionTags: ["doca.tag.theme"],
  });
  expect(calls.map((x) => x.operation)).toEqual([
    "materials.collectionDescribe",
    "materials.collectionItems",
    "materials.search",
  ]);
});

it("disposes both catalogs together and does not return stale dual-group results", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  f.materialRetrieve.mockImplementationOnce(async () => {
    f.dispose();
    return { items: [], mode: "keyword", hasMore: false };
  });
  await expect(service.retrieve(context, { query: "palette" })).rejects.toThrow(
    "providers changed",
  );
  expect(await service.providers(context, {})).toEqual([]);
  await expect(
    service.collectionDescribe(context, f.groups[0]!.ref),
  ).rejects.toThrow("unavailable");
  service.register({ ...f.provider, collections: null });
  await expect(
    service.collectionDescribe(context, f.groups[0]!.ref),
  ).rejects.toThrow("unavailable");
});

it("rejects collection claims from individual-only sources and bounds refreshed AI metadata", async () => {
  const f = installMaterialCollections(db),
    service = createMaterialsService(db);
  f.dispose();
  const stop = service.register({ ...f.provider, collections: null });
  const invalid = await service.search(context, { target: "materials" });
  expect(invalid.materials.complete).toBe(false);
  expect(invalid.materials.items).toEqual([]);
  stop();
  const refs = Array.from({ length: 100 }, (_, i) => ({
    providerId: f.provider.id,
    id: String(i).padEnd(190, "x"),
    revision: "r".repeat(190),
  }));
  service.register({
    ...f.provider,
    describe: async (_c, r) => ({
      ...f.cards.find((x) => x.ref.id === r.id)!,
      collections: refs,
    }),
  });
  const oversized = await service.retrieve(context, {
    query: "palette",
    target: "materials",
  });
  expect(oversized.materials.failures).toEqual([
    { providerId: f.provider.id, code: "failed" },
  ]);
  expect(oversized.materials.items).toEqual([]);
});
