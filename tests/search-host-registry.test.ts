import { describe, expect, it, vi } from "vitest";
import {
  DuplicateSearchSourceError,
  InMemorySearchProvider,
  SearchSourceRegistry,
  createSearchHost,
  type SearchSource,
} from "../packages/search-host/src/index.js";

interface QueryContext {
  readonly userId: string;
}

const descriptor = {
  pluginId: "documents",
  sourceId: "pages",
  schemaVersion: 3,
  renderer: { kind: "document-card", version: 1 },
} as const;

describe("SearchSourceRegistry", () => {
  it("rejects duplicates, rolls back their effects, and owns disposal", async () => {
    const registry = new SearchSourceRegistry<QueryContext>();
    let firstDisposals = 0;
    let duplicateDisposals = 0;
    const source: SearchSource<QueryContext> = {
      descriptor,
      authorize: ({ candidateIds }) => candidateIds,
      hydrate: ({ ids }) => new Map(ids.map((id) => [id, { id }])),
    };
    const first = registry.register(source, () => {
      firstDisposals++;
    });

    await expect(
      registry.install({
        acquire: () => ({
          source,
          dispose: () => {
            duplicateDisposals++;
          },
        }),
      }),
    ).rejects.toBeInstanceOf(DuplicateSearchSourceError);
    expect(duplicateDisposals).toBe(1);
    expect(registry.size).toBe(1);

    await first.dispose();
    await first.dispose();
    expect(firstDisposals).toBe(1);
    expect(registry.size).toBe(0);

    let registryDisposals = 0;
    await registry.install({
      acquire: () => ({
        source,
        dispose: () => {
          registryDisposals++;
        },
      }),
    });
    await registry.dispose();
    await registry.dispose();
    expect(registryDisposals).toBe(1);
  });
});

describe("SearchHost source boundary", () => {
  it("treats provider candidates as a first filter and source authorization as a mandatory second filter", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<QueryContext>(provider);
    const authorize = vi.fn(
      ({
        candidateIds,
      }: Parameters<SearchSource<QueryContext>["authorize"]>[0]) =>
        candidateIds.filter((id) => id === "still-visible"),
    );
    host.registry.register({
      descriptor,
      prepareQuery: ({ query }) => ({
        query,
        candidateIds: ["still-visible", "revoked"],
      }),
      authorize,
      hydrate: ({ ids }) => new Map(ids.map((id) => [id, { id }])),
    });
    await host.upsertProjections({
      source: descriptor,
      projections: [
        { id: "still-visible", text: "needle" },
        { id: "revoked", text: "needle needle" },
        { id: "outside-scope", text: "needle needle needle" },
      ],
    });

    const result = await host.query({
      query: "needle",
      context: { userId: "reader" },
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: ["revoked", "still-visible"],
      }),
    );
    expect(result.items.map((item) => item.id)).toEqual(["still-visible"]);
    await host.dispose();
  });

  it("authorizes and hydrates every returned result, then removes disposed sources", async () => {
    const provider = new InMemorySearchProvider();
    const host = createSearchHost<QueryContext>(provider);
    const authorize = vi.fn(
      ({
        context,
        candidateIds,
      }: Parameters<SearchSource<QueryContext>["authorize"]>[0]) =>
        candidateIds.filter(
          (id) => id === "public" || context.userId === "admin",
        ),
    );
    const hydrate = vi.fn(
      ({ ids }: Parameters<SearchSource<QueryContext>["hydrate"]>[0]) =>
        new Map(ids.map((id) => [id, { title: `hydrated:${id}` }])),
    );
    let disposed = 0;
    const lease = host.registry.register(
      { descriptor, authorize, hydrate },
      () => {
        disposed++;
      },
    );
    await host.upsertProjections({
      source: descriptor,
      projections: [
        { id: "public", text: "needle public index-only text" },
        { id: "secret", text: "needle needle MUST_NOT_LEAK" },
      ],
    });

    const result = await host.query({
      query: "needle",
      context: { userId: "member" },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate.mock.calls[0]?.[0].ids).toEqual(["public"]);
    expect(result).toMatchObject({
      total: 1,
      failures: [],
      items: [
        {
          id: "public",
          renderer: { kind: "document-card", version: 1 },
          value: { title: "hydrated:public" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAK");

    await lease.dispose();
    expect(disposed).toBe(1);
    expect(
      await host.query({
        query: "needle",
        context: { userId: "admin" },
      }),
    ).toMatchObject({ total: 0, items: [], failures: [] });
    await host.dispose();
  });
});
