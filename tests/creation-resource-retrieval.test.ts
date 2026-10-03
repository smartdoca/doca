import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { resourceRequest } from "@core/modules/creation-resources/document-template.js";
import {
  createTemplatesService,
  createMaterialsService,
} from "@core/modules/creation-resources/service.js";
import type { DB } from "@db/index.js";
import type { MaterialProvider } from "@smartdoca/plugin-sdk/creation-resources";
import { installTemplate } from "./creation-resource-fixtures.js";
import { createCreationResourceQueryTools } from "@server/services/ai/creation-resource-tools.js";
let db: DB, user: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  user = {
    ...(await createUser(
      db,
      {
        login: "retrieval",
        displayName: "Retrieval",
        password: "resource-retrieval-test",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());
function searchable(id = "example.templates.web") {
  const fixture = installTemplate(db, "markdown", "# Template", id);
  fixture.dispose();
  Object.assign(fixture.provider, {
    description: { zh: "网络来源", en: "Web source" },
    retrieval: { modes: ["keyword", "hybrid"] },
  });
  fixture.provider.retrieve = vi.fn(async (_context, input) => {
    const { ref, title, summary, tags, contract, contentType } = fixture.card;
    return {
      items: [
        {
          ref,
          title,
          summary,
          tags,
          contract,
          contentType,
          matchText: input.query,
        },
      ],
      mode: "hybrid" as const,
      hasMore: false,
    };
  });
  fixture.provider.search = vi.fn(fixture.provider.search);
  const dispose = createTemplatesService(db).register(fixture.provider);
  return { ...fixture, dispose };
}
it("selects multiple named sources for browsing and tags without invoking excluded sources", async () => {
  const a = searchable("example.templates.a"),
    b = searchable("example.templates.b"),
    c = searchable("example.templates.c");
  b.provider.tags = vi.fn(async () => [
    { id: "doca.tag.hidden", title: { zh: "隐藏", en: "Hidden" } },
  ]);
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const page = await service.search(context, {
    providerIds: [c.provider.id, a.provider.id],
  });
  expect(page.items.map((item) => item.ref.providerId)).toEqual([
    a.provider.id,
    c.provider.id,
  ]);
  expect(page.items[0]!.source.description?.zh).toBe("网络来源");
  expect(b.provider.search).not.toHaveBeenCalled();
  expect(
    (
      await service.tags(context, {
        providerIds: [a.provider.id, c.provider.id],
      })
    ).items.map((tag) => tag.id),
  ).toEqual(["doca.tag.report"]);
  expect(b.provider.tags).not.toHaveBeenCalled();
  expect((await service.search(context, { providerIds: [] })).items).toEqual(
    [],
  );
  expect(await service.providers(context, { providerIds: [] })).toEqual([]);
  expect(await service.providers(context, {})).toHaveLength(3);
  await expect(
    service.search(context, { providerIds: ["example.templates.missing"] }),
  ).rejects.toThrow("source unavailable");
  for (const operation of [service.search, service.tags, service.providers])
    await expect(
      operation(context, { providerId: a.provider.id } as any),
    ).rejects.toThrow("contract");
});
it("forwards natural-language queries only to selected retrievers and returns lightweight source-enriched results", async () => {
  const web = searchable(),
    ppt = searchable("example.templates.ppt");
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const query = "找一个适合向管理层汇报季度经营情况的简洁模板";
  const result = await service.retrieve(context, {
    query,
    providerIds: [web.provider.id],
    topK: 8,
  });
  expect(web.provider.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({
      principal: expect.objectContaining({ id: user.id }),
    }),
    expect.objectContaining({
      query,
      mode: "auto",
      providerIds: [web.provider.id],
    }),
  );
  expect(ppt.provider.retrieve).not.toHaveBeenCalled();
  expect(web.provider.search).not.toHaveBeenCalled();
  expect(result.items[0]).toMatchObject({
    source: { id: web.provider.id, description: { zh: "网络来源" } },
    rank: 1,
    matchText: query,
  });
  expect(result.items[0]).not.toHaveProperty("preview");
  expect(result.items[0]).not.toHaveProperty("parameters");
  expect(result.complete).toBe(true);
  expect((await service.describe(context, web.card.ref)).source.id).toBe(
    web.provider.id,
  );
  expect((await service.read(context, web.selection)).source.title.en).toBe(
    "Test",
  );
  expect(
    (await service.retrieve(context, { query, providerIds: [] })).items,
  ).toEqual([]);
  await expect(
    service.retrieve(context, { query, providerId: web.provider.id } as any),
  ).rejects.toThrow("contract");
  await expect(service.retrieve(context, { query: "   " })).rejects.toThrow(
    "contract",
  );
  await expect(service.retrieve(context, { query, topK: 21 })).rejects.toThrow(
    "contract",
  );
});
it("declares unsupported and failed sources explicitly without silently falling back or expanding scope", async () => {
  const web = searchable(),
    unavailable = searchable("example.templates.offline"),
    old = installTemplate(db, "markdown", "# Old", "example.templates.browse");
  old.provider.search = vi.fn(old.provider.search);
  unavailable.provider.retrieve = vi.fn(async () => {
    throw Error("backend offline");
  });
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const result = await service.retrieve(context, { query: "季度汇报" });
  expect(result.items).toHaveLength(1);
  expect(result.complete).toBe(false);
  expect(result.failures).toEqual([
    { providerId: old.provider.id, code: "unsupported" },
    { providerId: unavailable.provider.id, code: "failed" },
  ]);
  expect(old.provider.search).not.toHaveBeenCalled();
  const semantic = await service.retrieve(context, {
    query: "季度汇报",
    mode: "semantic",
    providerIds: [web.provider.id],
  });
  expect(semantic.failures).toEqual([
    { providerId: web.provider.id, code: "unsupported" },
  ]);
  expect(web.provider.retrieve).toHaveBeenCalledTimes(1);
  web.provider.retrieve = vi.fn(async () => ({
    items: [],
    mode: "hybrid" as const,
    hasMore: false,
  }));
  const empty = await service.retrieve(context, {
    query: "不存在",
    providerIds: [web.provider.id],
  });
  expect(empty.items).toEqual([]);
  expect(empty.complete).toBe(true);
  expect(unavailable.provider.retrieve).toHaveBeenCalledTimes(1);
});
it("bounds indexed retrieval without paging and keeps source-local ordering explicit", async () => {
  const a = searchable("example.templates.a"),
    b = searchable("example.templates.b");
  for (const source of [a, b]) {
    const cards = Array.from({ length: 8 }, (_, index) => ({
      ...source.card,
      ref: { ...source.card.ref, id: `template-${index}` },
      title: `Template ${index}`,
    }));
    source.provider.describe = async (_context, ref) =>
      cards.find((card) => card.ref.id === ref.id) ?? null;
    source.provider.retrieve = vi.fn(async (_context, input) => ({
      items: cards.slice(0, input.topK).map((card) => {
        const { ref, title, summary, tags, contract, contentType } = card;
        return { ref, title, summary, tags, contract, contentType };
      }),
      mode: "hybrid" as const,
      hasMore: input.topK < cards.length,
    }));
  }
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const merged = await service.retrieve(context, { query: "report", topK: 8 });
  expect(merged.items).toHaveLength(8);
  expect(merged.items.map((item) => [item.source.id, item.rank])).toEqual(
    [1, 2, 3, 4].flatMap((rank) => [
      [a.provider.id, rank],
      [b.provider.id, rank],
    ]),
  );
  expect(merged).toMatchObject({ complete: true, truncated: true });
  expect(merged.sources.map((source) => source.count)).toEqual([5, 5]);
  for (const source of [a, b]) {
    expect(source.provider.retrieve).toHaveBeenCalledTimes(1);
    expect(source.provider.retrieve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ topK: 5 }),
    );
    expect(source.provider.search).not.toHaveBeenCalled();
  }
  const single = await service.retrieve(context, {
    query: "report",
    providerIds: [a.provider.id],
    topK: 8,
  });
  expect(single.items).toHaveLength(8);
  expect(single.truncated).toBe(false);
});
it("validates declared capabilities, retrieval modes, duplicates and current access", async () => {
  const source = searchable();
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  source.dispose();
  expect(() =>
    service.register({ ...source.provider, retrieval: undefined }),
  ).toThrow("Invalid");
  expect(() =>
    service.register({ ...source.provider, retrieve: undefined }),
  ).toThrow("Invalid");
  service.register(source.provider);
  const original = source.provider.retrieve!;
  source.provider.retrieve = async (ctx, input) => ({
    ...(await original(ctx, input)),
    mode: "semantic",
  });
  expect(
    (await service.retrieve(context, { query: "汇报" })).failures[0]?.code,
  ).toBe("failed");
  source.provider.retrieve = async (ctx, input) => {
    const result = await original(ctx, input);
    return { ...result, items: [...result.items, ...result.items] };
  };
  expect(
    (await service.retrieve(context, { query: "汇报" })).failures[0]?.code,
  ).toBe("failed");
  source.provider.retrieve = original;
  source.provider.describe = async () => null;
  expect((await service.retrieve(context, { query: "汇报" })).items).toEqual(
    [],
  );
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", user.id)
    .execute();
  await expect(service.retrieve(context, { query: "汇报" })).rejects.toThrow(
    "Account unavailable",
  );
});
it("supports material retrieval without importing files, and AI tools expose both resource kinds and source constraints", async () => {
  const template = searchable(),
    materials = createMaterialsService(db);
  const card = {
    ...template.card,
    ref: { ...template.card.ref, providerId: "example.images.web" },
    preview: undefined,
  };
  const {
    preview: _preview,
    parameters: _parameters,
    updatedAt: _updated,
    license: _license,
    ...hit
  } = card;
  const importer = vi.fn(async () => ({ fileId: crypto.randomUUID() }));
  const provider: MaterialProvider = {
    ...template.provider,
    id: card.ref.providerId,
    pluginId: "example.images",
    title: { zh: "网络图片", en: "Web images" },
    retrieve: vi.fn(async () => ({
      items: [hit],
      mode: "keyword" as const,
      hasMore: false,
    })),
    describe: async () => card,
    import: importer,
  };
  materials.register(provider);
  const tools = createCreationResourceQueryTools(
    { templates: createTemplatesService(db), materials },
    resourceRequest(user),
  );
  const input = {
    kind: "materials" as const,
    query: "科技风背景图",
    providerIds: [provider.id],
  };
  const result = (await tools.creation_resource_retrieve.execute!(
    input,
    {} as any,
  )) as any;
  expect(result.items[0].source.title.zh).toBe("网络图片");
  expect(importer).not.toHaveBeenCalled();
  expect(template.provider.retrieve).not.toHaveBeenCalled();
  expect(result.items[0]).not.toHaveProperty("preview");
  const templateResult = (await tools.creation_resource_retrieve.execute!(
    {
      kind: "templates",
      query: "quarterly report",
      providerIds: [template.provider.id],
    },
    {} as any,
  )) as any;
  expect(templateResult.items[0].source.id).toBe(template.provider.id);
  expect(template.provider.retrieve).toHaveBeenCalledTimes(1);
  expect(provider.retrieve).toHaveBeenCalledTimes(1);
  const sources = (await tools.creation_resource_providers.execute!(
    { kind: "templates" },
    {} as any,
  )) as any;
  expect(sources[0].retrieval.modes).toEqual(["keyword", "hybrid"]);
  const list = (await tools.creation_resource_search.execute!(
    { kind: "templates", providerIds: [template.provider.id] },
    {} as any,
  )) as any;
  expect(list.items[0]).not.toHaveProperty("preview");
  expect(list.items[0]).not.toHaveProperty("parameters");
});
it("binds browsing cursors to normalized source selections", async () => {
  const a = searchable("example.templates.a"),
    b = searchable("example.templates.b");
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const first = await service.search(context, {
    providerIds: [b.provider.id, a.provider.id],
    limit: 1,
  });
  expect(first.nextCursor).toBeTruthy();
  const next = await service.search(context, {
    providerIds: [a.provider.id, b.provider.id, a.provider.id],
    cursor: first.nextCursor,
    limit: 1,
  });
  expect(next.items[0]?.ref.providerId).toBe(b.provider.id);
  await expect(
    service.search(context, {
      providerIds: [a.provider.id],
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow("mismatch");
});
it("honors cancellation and does not return stale results after provider disposal", async () => {
  const source = searchable(),
    service = createTemplatesService(db);
  const abort = new AbortController();
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  source.provider.retrieve = async () => {
    began();
    return await new Promise(() => {});
  };
  const running = service.retrieve(resourceRequest(user, abort.signal), {
    query: "汇报",
  });
  await started;
  abort.abort();
  await expect(running).rejects.toThrow();
  source.provider.retrieve = async () => {
    source.dispose();
    return { items: [], mode: "keyword", hasMore: false };
  };
  await expect(
    service.retrieve(resourceRequest(user), { query: "汇报" }),
  ).rejects.toThrow("providers changed");
});
