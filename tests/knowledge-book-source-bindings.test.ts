import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createKnowledgeBook } from "@core/modules/knowledge-books/management.js";
import {
  bookSourceInputSchema,
  type BookSourceBinding,
} from "@core/modules/knowledge-books/protocol.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import { readKnowledgeBook } from "@core/modules/knowledge-books/reads.js";
import {
  readBookSource,
  validateBookEvidence,
} from "@core/modules/knowledge-books/sources.js";
import {
  readBookForAssistant,
  readBookSourceForAssistant,
} from "@core/modules/knowledge-books/assistant-reads.js";
import { createContentService } from "@core/modules/content/service.js";
import {
  createContentSubscription,
  contentSubscriptionInventory,
} from "@core/modules/knowledge/content-subscriptions.js";
import { createBookProvenance } from "@core/modules/knowledge-books/engine.js";
import { defaultBookConfiguration } from "@core/modules/knowledge-books/protocol.js";
import { fail } from "@core/shared/errors.js";

let db: DB, owner: Actor, contributor: Actor, bookId: string;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: randomUUID() },
      { bootstrap: true },
    )),
    admin: 1,
  };
  contributor = {
    ...(await createUser(
      db,
      {
        login: "contributor",
        displayName: "Contributor",
        password: randomUUID(),
      },
      { actor: owner },
    )),
    admin: 0,
  };
  bookId = (await createKnowledgeBook(db, owner, "Network tutorial")).id;
  const book = await db
    .selectFrom("resources")
    .select("authz_revision")
    .where("id", "=", bookId)
    .executeTakeFirstOrThrow();
  await createContent(db).member(owner, bookId, contributor.id, {
    revision: book.authz_revision!,
    role: "editor",
    includeDescendants: true,
  });
});
afterEach(async () => {
  await db.destroy();
});
const group = (items: BookSourceBinding[]) => ({ version: 1, items });
async function save(
  items: BookSourceBinding[],
  extra: Record<string, unknown> = {},
) {
  return executeBookCommand(
    db,
    contributor,
    bookId,
    {
      operation: "source.save",
      expectedRevision: 0,
      title: "Combined source",
      configuration: group(items),
      status: "active",
      ...extra,
    },
    "manual",
    runtime,
  ) as Promise<{ id: string; revision: number }>;
}
async function row(id: string) {
  return db
    .selectFrom("knowledge_book_sources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}
const runtime = {
  async readFile() {
    throw new Error("Unexpected file");
  },
  async readWeb(url: string) {
    return { title: url, text: "TCP provides a reliable ordered byte stream." };
  },
};

it("accepts only the uniform versioned binding list, rejects old single inputs, duplicates, nested groups and excess bindings", () => {
  const item: BookSourceBinding = {
    id: "tcp",
    kind: "url",
    url: "https://example.com/tcp",
  };
  expect(bookSourceInputSchema.safeParse(group([item])).success).toBe(true);
  for (const value of [
    { kind: "url", url: item.url },
    { items: [item] },
    { version: 2, items: [item] },
    group([]),
    group([item, { ...item, id: "tcp2" }]),
    group([item, { id: "tcp", kind: "url", url: "https://example.com/udp" }]),
    { version: 1, items: [{ id: "nest", kind: "collection", items: [item] }] },
    group(
      Array.from({ length: 51 }, (_, index) => ({
        id: `url${index}`,
        kind: "url",
        url: `https://example.com/${index}`,
      })),
    ),
  ])
    expect(bookSourceInputSchema.safeParse(value).success).toBe(false);
  expect(
    bookSourceInputSchema.safeParse(
      group([
        {
          id: "a",
          kind: "content",
          sourceId: "example.protocols",
          config: { a: 1, b: 2 },
        },
        {
          id: "b",
          kind: "content",
          sourceId: "example.protocols",
          config: { b: 2, a: 1 },
        },
      ]),
    ).success,
  ).toBe(false);
});

it("reads mixed documents, URLs and registered plugin bindings with leaf-specific evidence, including identical documents", async () => {
  const content = createContent(db);
  const a = await content.create(contributor, {
    kind: "document",
    format: "markdown",
    title: "TCP A",
    markdown: "TCP has ordered bytes.",
    private: true,
  });
  const b = await content.create(contributor, {
    kind: "document",
    format: "markdown",
    title: "TCP B",
    markdown: "TCP has ordered bytes.",
    private: true,
  });
  const service = createContentService(db);
  const release = service.register({
    id: "example.protocols",
    pluginId: "example",
    version: 1,
    title: { zh: "协议来源", en: "Protocols" },
    contentTypes: ["text"],
    purposes: ["knowledge"],
    capabilities: { search: false },
    configSchema: {
      type: "object",
      properties: { scope: { type: "string" } },
      required: ["scope"],
      additionalProperties: false,
    },
    async list(ctx) {
      expect(ctx.principalId).toBe(contributor.id);
      return {
        items: [
          {
            ref: {
              sourceId: "example.protocols",
              resourceId: "tcp",
              blockId: "one",
            },
            title: "Plugin TCP",
            fingerprint: "1",
          },
        ],
        snapshot: "1",
        nextCursor: null,
      };
    },
    async read(ctx) {
      expect(ctx.principalId).toBe(contributor.id);
      return {
        ref: {
          sourceId: "example.protocols",
          resourceId: "tcp",
          blockId: "one",
        },
        title: "Plugin TCP",
        fingerprint: "1",
        text: "TCP has ordered bytes.",
      };
    },
    async resolve() {
      return { path: "/plugins/example/tcp", fingerprint: "1" };
    },
  });
  try {
    const source = await save([
      { id: "doc-a", kind: "document", resourceId: a.id },
      { id: "doc-b", kind: "document", resourceId: b.id },
      { id: "web", kind: "url", url: "https://example.com/tcp" },
      {
        id: "plugin-a",
        kind: "content",
        sourceId: "example.protocols",
        config: { scope: "a" },
      },
      {
        id: "plugin-b",
        kind: "content",
        sourceId: "example.protocols",
        config: { scope: "b" },
      },
    ]);
    const evidence = await readBookSource(db, await row(source.id), runtime);
    expect(evidence).toHaveLength(5);
    expect(new Set(evidence.map((item) => item.id)).size).toBe(5);
    expect(evidence.map((item) => item.reference.kind)).toEqual([
      "document",
      "document",
      "url",
      "content",
      "content",
    ]);
    expect(evidence[0]!.reference).toMatchObject({ resourceId: a.id });
    expect(evidence[1]!.reference).toMatchObject({ resourceId: b.id });
    expect(evidence[3]!.contentRef).toMatchObject({
      sourceId: "example.protocols",
      resourceId: "tcp",
      blockId: "one",
    });
    expect(evidence.every((item) => item.sourceId === source.id)).toBe(true);
    await validateBookEvidence(db, bookId, evidence, runtime);
    const library = await content.create(contributor, {
      kind: "library",
      format: "markdown",
      title: "Native library subscriptions",
      private: true,
    });
    const subscription = await createContentSubscription(
      db,
      contributor,
      library.id,
      {
        sourceId: "example.protocols",
        title: "Same generic provider",
        config: { scope: "a" },
      },
    );
    const subscriptionRow = await db
      .selectFrom("knowledge_subscriptions")
      .selectAll()
      .where("id", "=", subscription.id)
      .executeTakeFirstOrThrow();
    const inventory = await contentSubscriptionInventory(
      db,
      contributor,
      subscriptionRow,
    );
    expect(inventory.items[0]!.ref).toEqual(evidence[3]!.contentRef);
    const graph = createBookProvenance(
      randomUUID(),
      defaultBookConfiguration(),
      { pages: [], checks: [], claims: [], evidence },
    );
    expect(
      graph.nodes
        .filter(
          (node) =>
            node.kind === "source" &&
            (node.detail.reference as any).kind === "document",
        )
        .map((node) => (node.detail.reference as any).resourceId),
    ).toEqual([a.id, b.id]);
  } finally {
    release();
  }
});

it("rejects the entire save when one binding is unauthorized and exposes no partial source row", async () => {
  const content = createContent(db);
  const own = await content.create(contributor, {
    kind: "document",
    format: "markdown",
    title: "Own",
    markdown: "Own",
    private: true,
  });
  const secret = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Private",
    markdown: "Secret",
    private: true,
  });
  await expect(
    save([
      { id: "own", kind: "document", resourceId: own.id },
      { id: "secret", kind: "document", resourceId: secret.id },
    ]),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    await db.selectFrom("knowledge_book_sources").selectAll().execute(),
  ).toHaveLength(0);
});

it("preserves binding identities on edits, freezes new source versions and rejects concurrent replacement", async () => {
  const bindings: BookSourceBinding[] = [
    { id: "one", kind: "manual", markdown: "TCP is a stream." },
    { id: "two", kind: "url", url: "https://example.com/udp" },
  ];
  const source = await save(bindings);
  await save([...bindings].reverse(), { id: source.id, expectedRevision: 1 });
  const versions = await db
    .selectFrom("knowledge_book_source_versions")
    .selectAll()
    .where("source_id", "=", source.id)
    .orderBy("revision")
    .execute();
  expect(
    JSON.parse(versions[0]!.configuration).items.map((item: any) => item.id),
  ).toEqual(["one", "two"]);
  expect(
    JSON.parse(versions[1]!.configuration).items.map((item: any) => item.id),
  ).toEqual(["two", "one"]);
  await expect(
    save(bindings, { id: source.id, expectedRevision: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await row(source.id)).revision).toBe(2);
});

it("stops reading an entire group after a contributor loses book permission, and denies a revoked plugin binding", async () => {
  let available = true;
  const release = createContentService(db).register({
    id: "example.revocable",
    pluginId: "example",
    version: 1,
    title: { zh: "测试", en: "Test" },
    contentTypes: ["text"],
    purposes: ["knowledge"],
    capabilities: { search: false },
    configSchema: {},
    async list() {
      if (!available) fail(403, "Revoked");
      return { items: [], nextCursor: null, snapshot: "1" };
    },
    async read() {
      return null;
    },
    async resolve() {
      return null;
    },
  });
  try {
    const source = await save([
      { id: "manual", kind: "manual", markdown: "Public explanation." },
      {
        id: "plugin",
        kind: "content",
        sourceId: "example.revocable",
        config: {},
      },
    ]);
    available = false;
    await expect(
      readBookSource(db, await row(source.id), runtime),
    ).rejects.toMatchObject({ status: 403 });
    const view = await readKnowledgeBook(db, contributor, bookId);
    expect(view.sources[0]!.configuration).toBeNull();
    expect(view.sources[0]!.bindings).toEqual([]);
    const book = await db
      .selectFrom("resources")
      .select("authz_revision")
      .where("id", "=", bookId)
      .executeTakeFirstOrThrow();
    await createContent(db).member(owner, bookId, contributor.id, {
      revision: book.authz_revision!,
      role: null,
      includeDescendants: true,
    });
    await expect(
      readBookSource(db, await row(source.id), runtime),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    release();
  }
});

it("bounds group content without truncation and paginates each manual binding without dumping sibling bodies", async () => {
  const source = await save([
    { id: "one", kind: "manual", markdown: "a".repeat(50000) },
    { id: "two", kind: "manual", markdown: "b".repeat(50000) },
    { id: "three", kind: "manual", markdown: "c".repeat(50000) },
  ]);
  await expect(
    readBookSource(db, await row(source.id), runtime),
  ).rejects.toMatchObject({ status: 413 });
  const manifest = await readBookForAssistant(db, contributor, bookId);
  expect(
    manifest.sources[0]!.configuration!.items.every(
      (item) => item.kind != "manual" || item.markdown === null,
    ),
  ).toBe(true);
  const segment = await readBookSourceForAssistant(
    db,
    contributor,
    bookId,
    source.id,
    4000,
    "two",
  );
  expect(segment).toMatchObject({
    binding: { id: "two" },
    offset: 4000,
    contentLength: 50000,
    nextOffset: 8000,
  });
  expect("markdownSegment" in segment && segment.markdownSegment).toBe(
    "b".repeat(4000),
  );
  expect(JSON.stringify(segment)).not.toContain("a".repeat(10));
});

it("validates every active URL before saving atomically; paused sources may be retained but reactivation validates again", async () => {
  const items: BookSourceBinding[] = [
    { id: "good", kind: "url", url: "https://example.com/good" },
    { id: "bad", kind: "url", url: "https://example.com/missing" },
  ];
  const calls: string[] = [];
  const unavailable = {
    ...runtime,
    async readWeb(url: string) {
      calls.push(url);
      if (url.endsWith("missing")) fail(404, "Page missing");
      return { title: url, text: "TCP has an ordered byte stream." };
    },
  };
  const command = {
    operation: "source.save",
    expectedRevision: 0,
    title: "Web sources",
    configuration: group(items),
    status: "active",
  };
  await expect(
    executeBookCommand(db, contributor, bookId, command, "manual", unavailable),
  ).rejects.toThrow("Page missing");
  expect(calls).toEqual([
    "https://example.com/good",
    "https://example.com/missing",
  ]);
  expect(
    await db.selectFrom("knowledge_book_sources").selectAll().execute(),
  ).toHaveLength(0);
  expect(
    await db.selectFrom("knowledge_book_source_versions").selectAll().execute(),
  ).toHaveLength(0);
  calls.length = 0;
  const saved = (await executeBookCommand(
    db,
    contributor,
    bookId,
    { ...command, status: "paused" },
    "manual",
    unavailable,
  )) as { id: string; revision: number };
  expect(calls).toHaveLength(0);
  await expect(
    executeBookCommand(
      db,
      contributor,
      bookId,
      { ...command, id: saved.id, expectedRevision: saved.revision },
      "manual",
      unavailable,
    ),
  ).rejects.toThrow("Page missing");
  const source = await row(saved.id);
  expect(source.status).toBe("paused");
  expect(source.revision).toBe(saved.revision);
  expect(
    await db.selectFrom("knowledge_book_source_versions").selectAll().execute(),
  ).toHaveLength(1);
});
