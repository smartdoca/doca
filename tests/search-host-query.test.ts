import { describe, expect, it } from "vitest";
import {
  InMemorySearchProvider,
  createSearchHost,
  searchSourceKey,
  type SearchProjection,
  type SearchSource,
  type SearchSourceDescriptor,
} from "../packages/search-host/src/index.js";

type Context = { readonly actor: string };

function source(
  descriptor: SearchSourceDescriptor,
): SearchSource<Context, { label: string }> {
  return {
    descriptor,
    authorize: ({ candidateIds }) => candidateIds,
    hydrate: ({ ids }) =>
      new Map(ids.map((id) => [id, { label: `${descriptor.sourceId}:${id}` }])),
  };
}

const alpha = {
  pluginId: "alpha",
  sourceId: "records",
  schemaVersion: 1,
  renderer: { kind: "alpha-result" },
} as const;

const bravo = {
  pluginId: "bravo",
  sourceId: "records",
  schemaVersion: 2,
  renderer: { kind: "bravo-result" },
} as const;

describe("federated SearchHost queries", () => {
  it("keeps healthy sources queryable when an optional mail source is absent", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<Context>(provider);
    host.registry.register(source(alpha));
    await host.upsertProjections({
      source: alpha,
      projections: [{ id: "document", text: "shared term" }],
    });

    const result = await host.query({
      query: "term",
      context: { actor: "reader" },
    });
    expect(result.items.map((item) => item.id)).toEqual(["document"]);
    expect(result.failures).toEqual([]);
    await host.dispose();
  });

  it("isolates a source failure while returning healthy source results", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<Context>(provider);
    host.registry.register(source(alpha));
    host.registry.register(source(bravo));
    await host.upsertProjections({
      source: alpha,
      projections: [{ id: "healthy", text: "shared term" }],
    });
    await host.upsertProjections({
      source: bravo,
      projections: [{ id: "broken", text: "shared term" }],
    });
    const failedIndex = await provider.resolveAlias(
      host.indexNames(bravo).alias,
    );
    provider.setQueryFailure(failedIndex!, new Error("provider unavailable"));

    const result = await host.query({
      query: "term",
      context: { actor: "reader" },
    });
    expect(result.items.map((item) => item.id)).toEqual(["healthy"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      source: bravo,
      stage: "query",
    });
    await host.dispose();
  });

  it("normalizes each source and merges ties deterministically before pagination", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<Context>(provider);
    host.registry.register(source(alpha));
    host.registry.register(source(bravo));
    await host.upsertProjections({
      source: alpha,
      projections: [
        { id: "a-top", text: "term term term" },
        { id: "a-low", text: "term" },
      ],
    });
    await host.upsertProjections({
      source: bravo,
      projections: [
        { id: "b-top", text: "term term" },
        { id: "b-low", text: "term" },
      ],
    });

    const all = await host.query({
      query: "term",
      context: { actor: "reader" },
      limit: 10,
    });
    expect(all.items.map(({ id, score }) => [id, score])).toEqual([
      ["a-top", 1],
      ["b-top", 1],
      ["a-low", 0],
      ["b-low", 0],
    ]);
    const page = await host.query({
      query: "term",
      context: { actor: "reader" },
      offset: 1,
      limit: 2,
    });
    expect(page).toMatchObject({ offset: 1, limit: 2, total: 4 });
    expect(page.items.map((item) => item.id)).toEqual(["b-top", "a-low"]);
    expect(
      (
        await host.query({
          query: "term",
          context: { actor: "reader" },
          limit: 10,
        })
      ).items.map((item) => item.id),
    ).toEqual(all.items.map((item) => item.id));
    await host.dispose();
  });
});

describe("SearchHost rebuild lifecycle", () => {
  it("atomically publishes a new schema while retaining the prior index", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<Context>(provider);
    const firstDescriptor = {
      pluginId: "documents",
      sourceId: "pages",
      schemaVersion: 1,
      renderer: { kind: "document" },
    } as const;
    const firstLease = host.registry.register({
      descriptor: firstDescriptor,
      authorize: ({ candidateIds }) => candidateIds,
      hydrate: ({ ids }) => new Map(ids.map((id) => [id, { id }])),
      projections: () => [{ id: "old", text: "schema term" }],
    });
    const first = await host.rebuild({
      source: firstDescriptor,
      context: { actor: "system" },
      version: "schema-one",
      retainPrevious: true,
    });
    await firstLease.dispose();

    const secondDescriptor = {
      ...firstDescriptor,
      schemaVersion: 2,
    } as const;
    host.registry.register({
      descriptor: secondDescriptor,
      authorize: ({ candidateIds }) => candidateIds,
      hydrate: ({ ids }) => new Map(ids.map((id) => [id, { id }])),
      projections: () => [{ id: "new", text: "schema term" }],
    });
    const second = await host.rebuild({
      source: secondDescriptor,
      context: { actor: "system" },
      version: "schema-two",
      retainPrevious: true,
    });

    expect(second.alias).toBe(first.alias);
    expect(second.previousIndex).toBe(first.indexName);
    expect(
      (
        await host.query({
          query: "term",
          context: { actor: "reader" },
        })
      ).items.map((item) => item.id),
    ).toEqual(["new"]);
    await expect(
      host.switchIndex({
        source: secondDescriptor,
        indexName: first.indexName,
      }),
    ).rejects.toThrow("different source or schema");
    await host.dispose();
  });

  it("applies tombstones, atomically switches versions, and can switch back", async () => {
    const provider = new InMemorySearchProvider({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    const host = createSearchHost<Context>(provider);
    const descriptor = {
      pluginId: "wiki",
      sourceId: "articles",
      schemaVersion: 4,
      renderer: { kind: "wiki-article" },
    } as const;
    let snapshot: readonly SearchProjection[] = [
      { id: "old", text: "topic old" },
      { id: "doomed", text: "topic deleted" },
    ];
    host.registry.register({
      descriptor,
      authorize: ({ candidateIds }) => candidateIds,
      hydrate: ({ ids }) =>
        ids.map((id) => ({ id, value: { title: `hydrated:${id}` } })),
      async *projections() {
        yield snapshot;
      },
    });

    const first = await host.rebuild({
      source: descriptor,
      context: { actor: "system" },
      version: "one",
      retainPrevious: true,
    });
    expect(await provider.resolveAlias(first.alias)).toBe(first.indexName);
    await host.deleteProjections({
      source: descriptor,
      documentIds: ["doomed"],
    });
    expect(await provider.listTombstones(searchSourceKey(descriptor))).toEqual([
      expect.objectContaining({ documentId: "doomed" }),
    ]);

    snapshot = [
      { id: "old", text: "topic old refreshed" },
      { id: "doomed", text: "topic stale snapshot" },
      { id: "new", text: "topic new" },
    ];
    const second = await host.rebuild({
      source: descriptor,
      context: { actor: "system" },
      version: "two",
      retainPrevious: true,
    });
    expect(second.previousIndex).toBe(first.indexName);
    expect(second.projectionCount).toBe(3);
    expect(await provider.resolveAlias(second.alias)).toBe(second.indexName);
    expect(provider.getProjection(second.indexName, "doomed")).toBeUndefined();
    expect(
      (
        await host.query({
          query: "topic",
          context: { actor: "reader" },
        })
      ).items.map((item) => item.id),
    ).toEqual(["new", "old"]);

    await host.switchIndex({
      source: descriptor,
      indexName: first.indexName,
    });
    expect(
      (
        await host.query({
          query: "topic",
          context: { actor: "reader" },
        })
      ).items.map((item) => item.id),
    ).toEqual(["old"]);
    await host.switchIndex({
      source: descriptor,
      indexName: second.indexName,
      deletePrevious: true,
    });
    expect(provider.listIndexes()).toEqual([second.indexName]);

    await host.upsertProjections({
      source: descriptor,
      projections: [{ id: "doomed", text: "topic recreated" }],
    });
    expect(await provider.listTombstones(searchSourceKey(descriptor))).toEqual(
      [],
    );
    expect(
      (
        await host.query({
          query: "recreated",
          context: { actor: "reader" },
        })
      ).items.map((item) => item.id),
    ).toEqual(["doomed"]);
    await host.dispose();
  });
});
