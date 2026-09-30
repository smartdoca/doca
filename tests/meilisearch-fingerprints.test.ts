import { expect, it } from "vitest";
import {
  MeilisearchSearchProvider,
  SearchRequestError,
} from "@server/services/search/meilisearch-provider.js";
import type { SearchProjection } from "@smartdoca/search-host";

it("compares only fingerprints with bounded concurrency and writes changed entries in source order", async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const writes: unknown[] = [];
  const projections: SearchProjection[] = Array.from(
    { length: 21 },
    (_, i) => ({
      id: `doc-${i}`,
      text: `Text ${i}`,
      metadata: { title: `Title ${i}`, content_hash: "current" },
    }),
  );
  projections.push({ id: "unversioned", text: "Text" });
  const provider = new MeilisearchSearchProvider({
    config: async () => ({
      endpoint: "http://localhost:7700",
      index_name: "test",
    }),
    async request(_config, path, method, body) {
      if (method === "POST") {
        writes.push(body);
        return { taskUid: 1 };
      }
      expect(path.endsWith("?fields=id,content_hash")).toBe(true);
      reads++;
      active++;
      peak = Math.max(peak, active);
      const id = path.split("/documents/")[1]!.split("?")[0]!;
      const index = Number(id.slice(4));
      try {
        await new Promise((resolve) => setTimeout(resolve, (index % 3) + 1));
        if (index === 20) throw new SearchRequestError(404);
        return { id, content_hash: index % 2 ? "old" : "current" };
      } finally {
        active--;
      }
    },
    async waitTask() {
      expect(active).toBe(0);
    },
  });
  await provider.upsertProjections("test", projections);
  expect(peak).toBe(8);
  expect(reads).toBe(21);
  expect(writes).toHaveLength(1);
  expect((writes[0] as { id: string }[]).map((x) => x.id)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => `doc-${i * 2 + 1}`),
    "doc-20",
    "unversioned",
  ]);
});

it("does not write a partial batch when fingerprint lookup fails", async () => {
  let active = 0,
    calls = 0,
    writes = 0;
  const provider = new MeilisearchSearchProvider({
    config: async () => ({
      endpoint: "http://localhost:7700",
      index_name: "test",
    }),
    async request(_config, _path, method) {
      if (method === "POST") {
        writes++;
        return {};
      }
      const index = calls++;
      active++;
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, index === 1 ? 1 : 5),
        );
        if (index === 1) throw new SearchRequestError(503);
        return { content_hash: "old" };
      } finally {
        active--;
      }
    },
    async waitTask() {},
  });
  await expect(
    provider.upsertProjections(
      "test",
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        text: "Body",
        metadata: { content_hash: "current" },
      })),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(active).toBe(0);
  expect(calls).toBe(8);
  expect(writes).toBe(0);
});

it("does not submit an index task when all fingerprints match", async () => {
  let writes = 0;
  const provider = new MeilisearchSearchProvider({
    config: async () => ({
      endpoint: "http://localhost:7700",
      index_name: "test",
    }),
    async request(_config, _path, method) {
      if (method === "POST") writes++;
      return { content_hash: "same" };
    },
    async waitTask() {
      throw new Error("Unexpected indexing task");
    },
  });
  await provider.upsertProjections("test", [
    { id: "1", text: "Body", metadata: { content_hash: "same" } },
  ]);
  expect(writes).toBe(0);
});
