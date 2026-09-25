import { expect, expectTypeOf, it } from "vitest";
import {
  DuplicateKnowledgeSourceEffectError,
  createKnowledgeSourceCursorRecord,
  createKnowledgeSourceEffectRegistry,
  type KnowledgeSourceEffect,
} from "../packages/knowledge-capability/src/index.js";
import { stableId } from "../packages/files-capability/src/index.js";

type FeedConfig = { readonly feed: string };
type FeedCursor = { readonly page: number };

const effect: KnowledgeSourceEffect<FeedConfig, FeedCursor> = {
  version: 1,
  ownerPlugin: "example.plugin",
  sourceType: "feed",
  configRendererId: "example.feed.settings",
  configSchema: {
    id: "example.feed.config.v1",
    jsonSchema: {
      type: "object",
      required: ["feed"],
      properties: { feed: { type: "string" } },
    },
    parse(input) {
      if (
        !input ||
        typeof input !== "object" ||
        typeof (input as { feed?: unknown }).feed !== "string"
      ) {
        throw new TypeError("feed is required");
      }
      return { feed: (input as { feed: string }).feed };
    },
  },
  async validate({ config }) {
    return {
      valid: config.feed.startsWith("https://"),
      config,
      issues: config.feed.startsWith("https://")
        ? []
        : [{ path: ["feed"], message: "HTTPS is required" }],
    };
  },
  async preview({ config }) {
    return { title: config.feed, estimatedRecords: 1 };
  },
  async pull({ cursor }, context) {
    const page = cursor?.cursor.page ?? 0;
    return {
      records: [
        {
          externalId: "article-42",
          externalVersion: `revision-${page + 1}`,
          title: "Capability seams",
          payload: { text: "Registry-provided source" },
          provenance: {
            ownerPlugin: "example.plugin",
            sourceType: "feed",
            externalId: "article-42",
            uri: "https://example.test/articles/42",
            observedAt: "2026-09-25T04:00:00.000Z",
          },
          readers: [
            {
              externalReaderId: "reader@example.test",
              readerId: context.principalId,
            },
          ],
          fileIds: [stableId("file-42", "file")],
        },
      ],
      nextCursor: { page: page + 1 },
      done: false,
    };
  },
};

it("registers dynamic source effects and enforces duplicate disposal rules", () => {
  const registry = createKnowledgeSourceEffectRegistry();
  const registration = registry.register(effect);

  expect(registry.require(effect)).toBe(effect);
  expect(registry.list()).toEqual([effect]);
  expect(() => registry.register(effect)).toThrow(
    DuplicateKnowledgeSourceEffectError,
  );
  expect(registration.dispose()).toBe(true);
  expect(registration.dispose()).toBe(false);
  expect(registry.has(effect)).toBe(false);

  const replacement = registry.register(effect);
  expect(registration.dispose()).toBe(false);
  expect(registry.require(effect)).toBe(effect);
  expect(replacement.dispose()).toBe(true);
});

it("passes persisted cursor records through pull and preserves source identity", async () => {
  const cursor = createKnowledgeSourceCursorRecord({
    effect,
    installationId: "installation-01",
    cursor: { page: 3 },
    updatedAt: "2026-09-25T03:00:00.000Z",
  });
  const page = await effect.pull(
    {
      config: { feed: "https://example.test/feed" },
      cursor,
      limit: 20,
    },
    {
      installationId: "installation-01",
      principalId: "user-01",
    },
  );

  expect(cursor).toEqual({
    effect: {
      ownerPlugin: "example.plugin",
      sourceType: "feed",
    },
    installationId: "installation-01",
    cursor: { page: 3 },
    updatedAt: "2026-09-25T03:00:00.000Z",
  });
  expect(page.nextCursor).toEqual({ page: 4 });
  expect(page.records[0]).toMatchObject({
    externalId: "article-42",
    externalVersion: "revision-4",
    provenance: {
      ownerPlugin: "example.plugin",
      sourceType: "feed",
      externalId: "article-42",
    },
    readers: [
      {
        externalReaderId: "reader@example.test",
        readerId: "user-01",
      },
    ],
    fileIds: ["file-42"],
  });
  expectTypeOf(page.records[0]!.externalId).toEqualTypeOf<string>();
});
