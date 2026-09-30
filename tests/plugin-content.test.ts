import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { ContentSource, ContentItem } from "@smartdoca/plugin-sdk/content";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import { createContentService } from "@core/modules/content/service.js";

let db: DB;
const user = randomUUID();
const request = (): PluginRequestContext => ({
  requestId: randomUUID(),
  signal: new AbortController().signal,
  principal: { id: user, displayName: "Test", publicId: "", admin: false },
});
const record: ContentItem = {
  ref: { sourceId: "example.content", resourceId: "a", blockId: "a" },
  title: "A",
  fingerprint: "1",
};
const input = {
  sourceId: "example.content",
  purpose: "analysis" as const,
  config: {},
  cursor: null,
  limit: 10,
};
function source(extra: Partial<ContentSource> = {}): ContentSource {
  return {
    id: "example.content",
    pluginId: "example",
    version: 1,
    title: { zh: "测试", en: "Test" },
    contentTypes: ["test"],
    purposes: ["analysis"],
    configSchema: {},
    capabilities: { search: false },
    async list() {
      return { items: [record], nextCursor: null, snapshot: "1" };
    },
    async read() {
      return { ...record, text: "body" };
    },
    async resolve() {
      return { path: "/plugins/example/a", fingerprint: "1" };
    },
    ...extra,
  };
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await db
    .insertInto("users")
    .values({
      id: user,
      public_id: "12345678",
      login: "content-test",
      display_name: "Test",
      password_hash: "unused",
      admin: 0,
      status: "active",
      created_at: new Date().toISOString(),
    })
    .execute();
});
afterEach(async () => {
  await db.destroy();
});
it("reads by authenticated identity, declares capabilities and refuses implicit fallbacks", async () => {
  const service = createContentService(db);
  service.register(
    source({
      async list(ctx) {
        expect(ctx.principalId).toBe(user);
        return { items: [record], snapshot: "1", nextCursor: null };
      },
    }),
  );
  expect((await service.sources(request(), "analysis"))[0]?.id).toBe(
    "example.content",
  );
  expect(await service.sources(request(), "knowledge")).toEqual([]);
  expect((await service.list(request(), input)).items).toEqual([record]);
  await expect(
    service.search(request(), { ...input, query: "body" }),
  ).rejects.toThrow("does not support");
  await expect(
    service.list(request(), { ...input, purpose: "knowledge" }),
  ).rejects.toThrow("unavailable");
});
it("rejects mismatched capability declarations and duplicate registrations", () => {
  const service = createContentService(db);
  expect(() =>
    service.register(
      source({
        capabilities: { search: true },
      }),
    ),
  ).toThrow("capabilities");
  service.register(source());
  expect(() => service.register(source())).toThrow("duplicate");
});
it("denies disabled users even after a source request starts", async () => {
  const service = createContentService(db);
  service.register(
    source({
      async list() {
        await db
          .updateTable("users")
          .set({ status: "disabled" })
          .where("id", "=", user)
          .execute();
        return { items: [record], snapshot: "1", nextCursor: null };
      },
    }),
  );
  await expect(service.list(request(), input)).rejects.toThrow("denied");
});
it("does not return in-flight content after the source is disposed", async () => {
  const service = createContentService(db);
  let dispose: () => void;
  dispose = service.register(
    source({
      async list() {
        dispose();
        return { items: [record], snapshot: "1", nextCursor: null };
      },
    }),
  );
  await expect(service.list(request(), input)).rejects.toThrow("unavailable");
});
it("rejects duplicate records, foreign references and external resolve URLs", async () => {
  const service = createContentService(db);
  let dispose = service.register(
    source({
      async list() {
        return { items: [record, record], snapshot: "1", nextCursor: null };
      },
    }),
  );
  await expect(service.list(request(), input)).rejects.toThrow("Duplicate");
  dispose();
  dispose = service.register(
    source({
      async list() {
        return {
          items: [
            { ...record, ref: { ...record.ref, sourceId: "foreign.source" } },
          ],
          snapshot: "1",
          nextCursor: null,
        };
      },
    }),
  );
  await expect(service.list(request(), input)).rejects.toThrow("reference");
  dispose();
  service.register(
    source({
      async resolve() {
        return { path: "//evil.example", fingerprint: "1" };
      },
    }),
  );
  await expect(
    service.resolve(request(), { ref: record.ref, purpose: "analysis" }),
  ).rejects.toThrow("location");
});
it("cancels a source that ignores the cancellation signal", async () => {
  const service = createContentService(db);
  const controller = new AbortController();
  service.register(
    source({
      async list() {
        controller.abort(new Error("Canceled"));
        return new Promise(() => {});
      },
    }),
  );
  await expect(
    service.list({ ...request(), signal: controller.signal }, input),
  ).rejects.toThrow("Canceled");
});

it("only completes a full snapshot after all pages succeed, rejecting inconsistent membership", async () => {
  const { readContentInventory } =
    await import("@core/modules/content/snapshot.js");
  const service = createContentService(db);
  let consistent = true;
  service.register(
    source({
      async list(_ctx, page) {
        return page.cursor === null
          ? { items: [record], nextCursor: "next", snapshot: "v1" }
          : {
              items: [{ ...record, ref: { ...record.ref, resourceId: "b" } }],
              nextCursor: null,
              snapshot: consistent ? "v1" : "v2",
            };
      },
    }),
  );
  expect(
    (await readContentInventory(service, request(), input)).items,
  ).toHaveLength(2);
  consistent = false;
  await expect(readContentInventory(service, request(), input)).rejects.toThrow(
    "changed during traversal",
  );
});

it("uses the same reader for built-in documents and refuses stale traversal cursors", async () => {
  const { builtinContentSource } =
    await import("@core/modules/content/builtin.js");
  const { createContent } = await import("@core/workflows/resources.js");
  const actor = { id: user, display_name: "Test", admin: 0 };
  const documents = createContent(db);
  await documents.create(actor, {
    kind: "document",
    format: "markdown",
    title: "A",
  });
  await documents.create(actor, {
    kind: "document",
    format: "markdown",
    title: "B",
  });
  await db
    .updateTable("document_states")
    .set({ text: "A paragraph" })
    .execute();
  const service = createContentService(db);
  service.register(builtinContentSource(db, "documents"));
  const query = { ...input, sourceId: "doca.documents.content", limit: 1 };
  const first = await service.list(request(), query);
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBeTruthy();
  const second = await service.list(request(), {
    ...query,
    cursor: first.nextCursor,
  });
  expect(second.items[0]?.ref.resourceId).not.toBe(
    first.items[0]?.ref.resourceId,
  );
  await documents.create(actor, {
    kind: "document",
    format: "markdown",
    title: "C",
  });
  await db
    .updateTable("document_states")
    .set({ text: "Changed paragraph" })
    .execute();
  await expect(
    service.list(request(), { ...query, cursor: first.nextCursor }),
  ).rejects.toThrow("expired");
});

it("binds content registrations to the plugin namespace and disposes them with the plugin", async () => {
  const { contentServiceToken } = await import("@smartdoca/plugin-sdk/content");
  const { definePlugin } = await import("@smartdoca/plugin-sdk");
  const { runPluginContractHarness } =
    await import("@smartdoca/plugin-sdk/testing");
  const { scopeInstalledPlugin } = await import("@server/plugins/scope.js");
  const service = createContentService(db);
  await runPluginContractHarness(
    scopeInstalledPlugin(
      definePlugin({
        manifest: {
          schemaVersion: 1,
          id: "example",
          version: "1.0.0",
          displayName: "Content",
        },
        injections: { required: [contentServiceToken] },
        async mount(ctx) {
          const content = ctx.inject(contentServiceToken);
          expect(() =>
            content.register(source({ pluginId: "foreign" })),
          ).toThrow("namespace");
          expect(() =>
            content.register(source({ id: "foreign.content" })),
          ).toThrow("namespace");
          content.register(source());
          expect(await content.sources(request(), "analysis")).toHaveLength(1);
        },
      }),
    ),
    { services: [{ token: contentServiceToken, value: service }] },
  );
  expect(await service.sources(request(), "analysis")).toEqual([]);
});

it("reads only changed block bodies and reports removals only after successful traversal", async () => {
  const { readChangedContent } =
    await import("@core/modules/content/snapshot.js");
  const { contentReferenceKey } =
    await import("@core/modules/content/service.js");
  const service = createContentService(db);
  let reads = 0;
  service.register(
    source({
      async read() {
        reads++;
        return { ...record, text: "body" };
      },
    }),
  );
  const first = await readChangedContent(service, request(), input, new Map());
  expect(reads).toBe(1);
  expect(first.changed).toHaveLength(1);
  const second = await readChangedContent(
    service,
    request(),
    input,
    first.fingerprints,
  );
  expect(reads).toBe(1);
  expect(second.changed).toEqual([]);
  expect(second.removed).toEqual([]);
  const third = await readChangedContent(
    service,
    request(),
    input,
    new Map([
      [contentReferenceKey(record.ref), "old"],
      ["removed", "1"],
    ]),
  );
  expect(reads).toBe(2);
  expect(third.removed).toEqual(["removed"]);
});
