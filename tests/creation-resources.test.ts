import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { resourceRequest } from "@core/modules/creation-resources/document-template.js";
import {
  createTemplatesService,
  createMaterialsService,
} from "@core/modules/creation-resources/service.js";
import { installTemplate } from "./creation-resource-fixtures.js";
import type {
  CreationResourceCard,
  MaterialCard,
  JsonValue,
} from "@smartdoca/plugin-contracts";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import { templatesServiceToken } from "@smartdoca/plugin-sdk/creation-resources";
let db: DB, user: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  user = {
    ...(await createUser(
      db,
      {
        login: "resources",
        displayName: "Resources",
        password: "resources-test-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());
it("merges sorted streams across pages, binds cursors to queries and rechecks buffered permissions", async () => {
  const a = installTemplate(db, "markdown", "A", "example.templates.a"),
    b = installTemplate(db, "markdown", "B", "example.templates.b");
  const cards = (base: CreationResourceCard, dates: number[]) =>
    dates.map((n) => ({
      ...base,
      ref: { ...base.ref, id: String(n) },
      title: String(n),
      updatedAt: `2026-10-0${n}T00:00:00Z`,
    }));
  const lists = new Map([
    [a.provider.id, cards(a.card, [5, 3, 1])],
    [b.provider.id, cards(b.card, [4, 2])],
  ]);
  const hidden = new Set<string>();
  for (const p of [a.provider, b.provider]) {
    p.search = async (_c, input) => {
      const start = Number(input.cursor ?? 0);
      const list = lists.get(p.id)!;
      return {
        items: list.slice(start, start + 2),
        nextCursor: start + 2 < list.length ? String(start + 2) : null,
      };
    };
    p.describe = async (_c, ref) =>
      hidden.has(ref.id)
        ? null
        : lists.get(p.id)!.find((x) => x.ref.id === ref.id)!;
  }
  const service = createTemplatesService(db),
    ctx = resourceRequest(user);
  const first = await service.search(ctx, { limit: 2 });
  expect(first.items.map((x) => x.title)).toEqual(["5", "4"]);
  expect(first.complete).toBe(true);
  await expect(
    service.search(ctx, {
      limit: 2,
      cursor: first.nextCursor,
      query: "different",
    }),
  ).rejects.toThrow("mismatch");
  hidden.add("3");
  const next = await service.search(ctx, {
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(next.items.map((x) => x.title)).toEqual(["2", "1"]);
  expect(next.nextCursor).toBeNull();
  a.dispose();
  await expect(
    service.search(ctx, { cursor: first.nextCursor }),
  ).rejects.toThrow("expired");
});
it("deduplicates public tags, preserves custom namespaces and reports failed sources", async () => {
  const a = installTemplate(db, "markdown", "A", "example.templates.a"),
    b = installTemplate(db, "markdown", "B", "example.templates.b");
  const service = createTemplatesService(db),
    ctx = resourceRequest(user);
  expect((await service.tags(ctx, {})).items).toHaveLength(1);
  b.provider.search = async () => {
    throw Error("offline");
  };
  const page = await service.search(ctx, {});
  expect(page.items).toHaveLength(1);
  expect(page.complete).toBe(false);
  expect(page.failures).toEqual([b.provider.id]);
  await expect(service.search(ctx, { sort: "usage" })).rejects.toThrow(
    "one provider",
  );
  a.provider.tags = async () => [
    { id: "foreign.secret", title: { zh: "隐藏", en: "Hidden" } },
  ];
  expect((await service.tags(ctx, {})).failures).toEqual([a.provider.id]);
});
it("rejects repeated cursors and invalid or stale references without returning bodies", async () => {
  const a = installTemplate(db, "markdown", "A");
  a.provider.search = async (_c, input) => ({ items: [], nextCursor: "loop" });
  const service = createTemplatesService(db),
    ctx = resourceRequest(user);
  const result = await service.search(ctx, {});
  expect(result.complete).toBe(false);
  a.provider.describe = async () => ({
    ...a.card,
    ref: { ...a.card.ref, revision: "2" },
  });
  await expect(service.read(ctx, a.selection)).rejects.toThrow("revision");
});
it("validates parameter schemas and consumer contract/input before executing", async () => {
  const a = installTemplate(db, "markdown", "A");
  (a.card as any).parameters = {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
    additionalProperties: false,
  };
  a.provider.read = async (_c, input) => ({
    contract: a.card.contract,
    contentType: a.card.contentType,
    content: String(input.parameters.name),
    assets: [],
  });
  const service = createTemplatesService(db),
    ctx = resourceRequest(user);
  await expect(service.read(ctx, a.selection)).rejects.toThrow("parameters");
  const execute = vi.fn(async () => ({ ok: true }) as JsonValue);
  const dispose = service.registerConsumer({
    id: "example.consumer.use",
    pluginId: "example.consumer",
    version: 1,
    title: { zh: "消费", en: "Consume" },
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
      additionalProperties: false,
    },
    accepts: [{ contract: a.card.contract, contentType: a.card.contentType }],
    execute,
  });
  const selection = { ...a.selection, parameters: { name: "Team" } };
  await expect(
    service.consume(ctx, {
      consumerId: "example.consumer.use",
      selection,
      input: {},
    }),
  ).rejects.toThrow("consumer input");
  expect(execute).not.toHaveBeenCalled();
  await service.consume(ctx, {
    consumerId: "example.consumer.use",
    selection,
    input: { destination: "target" },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  dispose();
  await expect(
    service.consume(ctx, {
      consumerId: "example.consumer.use",
      selection,
      input: { destination: "target" },
    }),
  ).rejects.toThrow("unavailable");
});
it("denies disabled accounts and isolates registries across host databases", async () => {
  installTemplate(db, "markdown", "A");
  const other = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const otherUser = {
      ...(await createUser(
        other,
        {
          login: "other",
          displayName: "Other",
          password: "other-resource-test",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    expect(
      (
        await createTemplatesService(other).search(
          resourceRequest(otherUser),
          {},
        )
      ).items,
    ).toEqual([]);
  } finally {
    await other.destroy();
  }
  await db
    .updateTable("users")
    .set({ status: "disabled" })
    .where("id", "=", user.id)
    .execute();
  await expect(
    createTemplatesService(db).search(resourceRequest(user), {}),
  ).rejects.toThrow("Account");
});
it("scopes registration to the injected plugin and holds its disposer", async () => {
  const a = installTemplate(db, "markdown", "A");
  a.dispose();
  const service = createTemplatesService(db),
    effects: Array<() => void> = [];
  const plugin = scopeInstalledPlugin({
    manifest: {
      schemaVersion: 1,
      id: "example.templates",
      version: "1.0.0",
      displayName: "Test",
    },
    async mount(c) {
      const s = c.inject(templatesServiceToken);
      s.register(a.provider);
      expect(() =>
        s.register({
          ...a.provider,
          id: "foreign.source",
          pluginId: "foreign",
        }),
      ).toThrow("namespace");
    },
  });
  await plugin.mount!({
    inject: () => service,
    effect: (create: () => () => void) => {
      const dispose = create();
      effects.push(dispose);
      return dispose;
    },
  } as any);
  expect(await service.providers(resourceRequest(user), {})).toHaveLength(1);
  effects.forEach((f) => f());
  expect(await service.providers(resourceRequest(user), {})).toEqual([]);
});
it("imports materials with current file permissions and binds template assets durably to the new document", async () => {
  const now = new Date().toISOString(),
    profileId = crypto.randomUUID(),
    objectId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  await db
    .insertInto("storage_profiles")
    .values({
      id: profileId,
      active: 1,
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profileId,
      object_key: "isolated/test.png",
      sha256: "a".repeat(64),
      size: 10,
      mime: "image/png",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id: fileId,
      owner_id: user.id,
      parent_type: "system",
      parent_id: "ai",
      storage_object_id: objectId,
      name: "Test.png",
      mime: "image/png",
      size: 10,
      metadata: "{}",
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  const materialRef = {
    providerId: "example.materials.images",
    id: "image",
    revision: "1",
  };
  const card: MaterialCard = {
    collections: [],
    ref: materialRef,
    title: "Image",
    summary: "Test",
    tags: [],
    updatedAt: now,
    contract: { id: "doca.material.image", version: 1 },
    contentType: { id: "image/png", version: 1 },
    parameters: { type: "object" },
    license: "Test",
  };
  const imports = vi.fn(async () => ({ fileId }));
  const dispose = createMaterialsService(db).register({
    id: materialRef.providerId,
    pluginId: "example.materials",
    version: 2,
    collections: null,
    title: { zh: "图", en: "Image" },
    contracts: [card.contract],
    contentTypes: [card.contentType],
    sorts: ["updated", "name"],
    async search() {
      return { items: [card], nextCursor: null };
    },
    async describe() {
      return card;
    },
    async tags() {
      return [];
    },
    import: imports,
  });
  const template = installTemplate(db, "rich_text", [
    {
      id: crypto.randomUUID(),
      type: "image",
      path: "material:hero",
      children: [{ text: "" }],
    },
  ]);
  template.provider.read = async () => ({
    contract: template.card.contract,
    contentType: template.card.contentType,
    content: [
      {
        id: crypto.randomUUID(),
        type: "image",
        path: "material:hero",
        children: [{ text: "" }],
      },
    ],
    assets: [{ key: "hero", ref: materialRef }],
  });
  const { createContent } = await import("@core/workflows/resources.js");
  expect(
    (
      await createMaterialsService(db).import(resourceRequest(user), {
        ref: materialRef,
        operationKey: "source-metadata-check",
      })
    ).source,
  ).toMatchObject({ id: materialRef.providerId, title: { zh: "图" } });
  const doc = await createContent(db).create(user, {
    kind: "document",
    format: "rich_text",
    title: "Image template",
    template: template.selection,
  });
  const assets = await db
    .selectFrom("assets")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .execute();
  expect(assets).toHaveLength(1);
  expect(assets[0]!.object_key).toBe("isolated/test.png");
  const { restoreDocument } =
    await import("@core/modules/collaboration/documents.js");
  const loaded = await restoreDocument(db, doc.id);
  try {
    expect(JSON.stringify(loaded.runtime.getValue())).toContain(assets[0]!.id);
    expect(JSON.stringify(loaded.runtime.getValue())).not.toContain(
      "material:hero",
    );
  } finally {
    loaded.destroy();
  }
  dispose();
  expect(
    await db
      .selectFrom("assets")
      .selectAll()
      .where("resource_id", "=", doc.id)
      .execute(),
  ).toHaveLength(1);
  const other = {
    ...(await createUser(
      db,
      {
        login: "outsider",
        displayName: "Other",
        password: "outsider-resource-test",
      },
      { actor: user },
    )),
    admin: 0,
  };
  createMaterialsService(db).register({
    id: materialRef.providerId,
    pluginId: "example.materials",
    version: 2,
    collections: null,
    title: { zh: "图", en: "Image" },
    contracts: [card.contract],
    contentTypes: [card.contentType],
    sorts: ["updated", "name"],
    async search() {
      return { items: [card], nextCursor: null };
    },
    async describe() {
      return card;
    },
    async tags() {
      return [];
    },
    import: imports,
  });
  await expect(
    createMaterialsService(db).import(resourceRequest(other), {
      ref: materialRef,
      operationKey: "test-import",
    }),
  ).rejects.toThrow("文件不存在");
});

it("requires style preview images on template cards", async () => {
  const source = installTemplate(db, "markdown", "# Report");
  const { preview: _preview, ...missing } = source.card;
  source.provider.search = async () => ({ items: [missing], nextCursor: null });
  source.provider.describe = async () => missing;
  const service = createTemplatesService(db),
    context = resourceRequest(user);
  const page = await service.search(context, {});
  expect(page.items).toHaveLength(0);
  expect(page.failures).toEqual([source.provider.id]);
  await expect(service.describe(context, source.card.ref)).rejects.toThrow(
    "style preview",
  );
});
it("calls database-backed providers outside document writes and preserves AI receipts after uninstall", async () => {
  const source = installTemplate(db, "markdown", "# Database template");
  source.provider.describe = async () => {
    await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    return source.card;
  };
  source.provider.read = async () => {
    await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    return {
      contract: source.card.contract,
      contentType: source.card.contentType,
      content: "# Database template",
      assets: [],
    };
  };
  const { createContent } = await import("@core/workflows/resources.js");
  const document = await createContent(db).create(user, {
    kind: "document",
    format: "markdown",
    title: "Manual",
    template: source.selection,
  });
  expect(document.id).toBeTruthy();
  const { createAIDocument } = await import("@core/workflows/ai-documents.js");
  const operation = crypto.randomUUID(),
    input = {
      kind: "document" as const,
      format: "markdown" as const,
      title: "AI",
      template: source.selection,
    };
  const created = await createAIDocument(db, { actor: user }, input, operation);
  source.dispose();
  expect(
    (await createAIDocument(db, { actor: user }, input, operation)).id,
  ).toBe(created.id);
});
