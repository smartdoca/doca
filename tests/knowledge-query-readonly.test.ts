import { it, expect, vi } from "vitest";
import { MeilisearchSearchProvider } from "../apps/server/src/services/search/meilisearch-provider.js";
it("queries a prepared hybrid index without queuing embedder updates after restart", async () => {
  const request = vi.fn(async () => ({
      hits: [{ id: "chunk", _rankingScore: 0.9 }],
    })),
    waitTask = vi.fn();
  const provider = new MeilisearchSearchProvider({
    config: async () => ({
      endpoint: "http://search",
      index_name: "documents",
    }),
    request,
    waitTask,
    queryEmbedder: async () => "default",
  });
  expect(
    await provider.queryIndex("knowledge", {
      query: "DNS TTL",
      candidateIds: ["chunk"],
      semantic: true,
      limit: 12,
    }),
  ).toEqual([{ id: "chunk", score: 0.9 }]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual([
    expect.anything(),
    expect.stringMatching(/\/search$/),
    "POST",
    expect.objectContaining({
      hybrid: { embedder: "default", semanticRatio: 0.8 },
    }),
  ]);
  expect(waitTask).not.toHaveBeenCalled();
});
