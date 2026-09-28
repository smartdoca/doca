import { expect, it, vi } from "vitest";
import {
  assertKnowledgeSourceRecord,
  createKnowledgeSourceCursorRecord,
  createValidatedKnowledgeSourceEffect,
  type KnowledgeSourceRecord,
} from "../packages/knowledge-capability/src/index.js";

const effectRef = {
  ownerPlugin: "example.source",
  sourceType: "articles",
};

const validRecord = {
  externalId: "article-01",
  externalVersion: "revision-01",
  title: "Plugin capability extraction",
  payload: { text: "Capability-owned provenance" },
  provenance: {
    ...effectRef,
    externalId: "article-01",
    observedAt: "2026-09-25T06:00:00.000Z",
  },
  readers: [
    {
      externalReaderId: "reader@example.test",
      readerId: "user-01",
    },
  ],
  fileIds: [],
} satisfies KnowledgeSourceRecord;

it("rejects mismatched provenance and duplicate external readers", () => {
  expect(() =>
    assertKnowledgeSourceRecord(effectRef, validRecord),
  ).not.toThrow();
  expect(() =>
    assertKnowledgeSourceRecord(effectRef, {
      ...validRecord,
      provenance: {
        ...validRecord.provenance,
        ownerPlugin: "another.plugin",
      },
    }),
  ).toThrow(/provenance/);
  expect(() =>
    assertKnowledgeSourceRecord(effectRef, {
      ...validRecord,
      readers: [validRecord.readers[0]!, validRecord.readers[0]!],
    }),
  ).toThrow(/Duplicate knowledge external reader/);
});

it("prevents persisted cursors from crossing effects or installations", async () => {
  const pull = vi.fn(async () => ({
    records: [validRecord],
    nextCursor: null,
    done: true,
  }));
  const effect = createValidatedKnowledgeSourceEffect<
    Record<string, never>,
    { readonly page: number }
  >({
    version: 1,
    ...effectRef,
    configRendererId: "example.source.settings",
    configSchema: {
      id: "example.source.config.v1",
      jsonSchema: { type: "object" },
      parse: () => ({}),
    },
    async validate({ config }) {
      return { valid: true, config, issues: [] };
    },
    async preview() {
      return { title: "Articles" };
    },
    pull,
  });
  const cursor = createKnowledgeSourceCursorRecord({
    effect,
    installationId: "installation-01",
    cursor: { page: 2 },
    updatedAt: "2026-09-25T06:00:00.000Z",
  });

  await expect(
    effect.pull(
      { config: {}, cursor },
      {
        installationId: "installation-02",
        principalId: "user-01",
      },
    ),
  ).rejects.toThrow(/another installation/);
  expect(pull).not.toHaveBeenCalled();

  await expect(
    effect.pull(
      {
        config: {},
        cursor: {
          ...cursor,
          effect: {
            ownerPlugin: "another.plugin",
            sourceType: "articles",
          },
        },
      },
      {
        installationId: "installation-01",
        principalId: "user-01",
      },
    ),
  ).rejects.toThrow(/another effect/);
  expect(pull).not.toHaveBeenCalled();
});
