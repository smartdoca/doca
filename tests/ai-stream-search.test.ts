import { expect, it, vi } from "vitest";
import { composeWebQuery, normalizeWebSites, searchWeb } from "../apps/server/src/services/ai/web-search.js";
import {
  applyProgressPatch,
  progressPatch,
  type AIProgress,
} from "@core/modules/ai/progress.js";
import {
  aiConfigSchema,
  aiDefaults,
  modelSchema,
} from "@core/modules/ai/config.js";

it("replays progress, appends deltas and resets text between model steps and reconnects", () => {
  const initial: AIProgress = {
    phase: "thinking",
    text: "",
    reasoning: "正在读取",
    sources: [],
  };
  const next = { ...initial, text: "你好", reasoning: "正在读取文档" };
  expect(
    applyProgressPatch(undefined, progressPatch(undefined, initial)),
  ).toEqual(initial);
  const patch = progressPatch(initial, next);
  expect(patch.reasoning).toBe("文档");
  expect(applyProgressPatch(initial, patch)).toEqual(next);
  const reset = { ...next, text: "新的回答" };
  expect(progressPatch(next, reset).appendText).toBe(false);
  expect(applyProgressPatch(next, progressPatch(next, reset))).toEqual(reset);
  expect(applyProgressPatch(next, progressPatch(undefined, reset))).toEqual(
    reset,
  );
});
it("allows long-context and output budgets without a 250k/32k ceiling", () => {
  const fields = modelSchema.pick({ maxInput: true, maxOutput: true });
  expect(fields.parse({ maxInput: 1000000, maxOutput: 128000 })).toEqual({
    maxInput: 1000000,
    maxOutput: 128000,
  });
  expect(
    fields.safeParse({ maxInput: 10000001, maxOutput: 128000 }).success,
  ).toBe(false);
  expect(aiConfigSchema.parse({ ...aiDefaults, maxSteps: 100 }).maxSteps).toBe(
    100,
  );
});
it.each(["tavily", "brave", "searxng"] as const)(
  "normalizes %s sources and sends only a bounded public query",
  async (provider) => {
    const row = {
      title: "公开资料",
      url: "https://example.com/source",
      content: "事实",
      description: "事实",
    };
    const fetcher = vi.fn(async () =>
      Response.json(
        provider === "brave" ? { web: { results: [row] } } : { results: [row] },
      ),
    );
    const result = await searchWeb(
      {
        provider,
        apiKey: "secret",
        ...(provider === "searxng"
          ? { baseUrl: "http://search.internal/searx/" }
          : {}),
      },
      "公开主题",
      undefined,
      fetcher,
    );
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.redirect).toBe("error");
    expect(url).not.toContain("secret");
    expect(result.sources[0]).toMatchObject({
      title: "公开资料",
      url: row.url,
      snippet: "事实",
    });
    expect(result.sources[0]?.retrievedAt).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("secret");
    if (provider === "searxng")
      expect(url).toContain("http://search.internal/searx/search?");
  },
);
it("adds site, exclusion, time and language limits without fetching those sites", async () => {
  expect(composeWebQuery("经营周报", { sites: ["example.com"], exclude: ["广告"] })).toBe("经营周报 site:example.com -广告");
  expect(normalizeWebSites("https://Example.com/path")).toEqual(["example.com"]);
  expect(() => normalizeWebSites("not a host")).toThrow("域名");
  const fetcher = vi.fn(async () => Response.json({ web: { results: [] } }));
  await searchWeb(
    { provider: "brave", apiKey: "secret" },
    "经营周报",
    undefined,
    fetcher,
    { sites: ["example.com"], exclude: ["广告"], freshness: "month", language: "zh", limit: 8 },
  );
  const [url] = fetcher.mock.calls[0] as unknown as [string];
  expect(url).toContain("site%3Aexample.com");
  expect(url).toContain("freshness=pm");
  expect(url).toContain("search_lang=zh-hans");
  expect(url).toContain("count=8");
  expect(url).not.toContain("https://example.com");
});
it("allows an uncredentialed self-hosted endpoint and rejects missing hosted credentials", async () => {
  const fetcher = vi.fn(async () => Response.json({ results: [] }));
  await expect(
    searchWeb(
      { provider: "searxng", baseUrl: "http://127.0.0.1:8080/", apiKey: null },
      "hello",
      undefined,
      fetcher,
    ),
  ).resolves.toMatchObject({ sources: [] });
  await expect(
    searchWeb(
      { provider: "tavily", apiKey: null },
      "hello",
      undefined,
      fetcher,
    ),
  ).rejects.toThrow("尚未配置");
  await expect(
    searchWeb(undefined, "hello", undefined, fetcher),
  ).rejects.toThrow("尚未配置");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("distinguishes failed upstream engines from a successful empty search", async () => {
  const config = { provider: "searxng" as const, baseUrl: "http://search.internal/", apiKey: "" };
  await expect(searchWeb(config, "阿凡达", undefined, async () => Response.json({
    results: [], unresponsive_engines: [["brave", "timeout"], ["wikipedia", "timeout"]],
  }))).rejects.toThrow("上游引擎超时或不可用");
  await expect(searchWeb(config, "无匹配主题", undefined, async () => Response.json({
    results: [], unresponsive_engines: [],
  }))).resolves.toMatchObject({ sources: [] });
  await expect(searchWeb(config, "阿凡达", undefined, async () => Response.json({
    results: [{ url: "https://example.com/", title: "电影" }], unresponsive_engines: [["brave", "timeout"]],
  }))).resolves.toMatchObject({ sources: [{ title: "电影" }] });
  await expect(searchWeb(config, "阿凡达", undefined, async () => Response.json(null)))
    .rejects.toThrow("无效结果");
});

it("fills the source limit from usable links and rejects wholly invalid results", async () => {
  const config = { provider: "tavily" as const, apiKey: "secret" };
  await expect(searchWeb(config, "电影", undefined, async () => Response.json({
    results: [{ url: "javascript:bad" }, { url: "https://example.com/" }],
  }), { limit: 1 })).resolves.toMatchObject({ sources: [{ url: "https://example.com/" }] });
  await expect(searchWeb(config, "电影", undefined, async () => Response.json({
    results: [{ url: "javascript:bad" }],
  }))).rejects.toThrow("有效的网页链接");
});

it("drops unsafe links and never forwards provider secrets or errors", async () => {
  const config = { provider: "tavily" as const, apiKey: "secret" };
  const fetcher = vi.fn(async () =>
    Response.json({
      results: [
        { url: "javascript:alert(1)" },
        { url: "https://user:pass@example.com/" },
        { url: "https://example.com/", content: "a".repeat(7000) },
      ],
    }),
  );
  expect(
    (await searchWeb(config, "主题", undefined, fetcher)).sources,
  ).toHaveLength(1);
  expect(
    (await searchWeb(config, "主题", undefined, fetcher)).sources[0]?.snippet,
  ).toHaveLength(6000);
  await expect(
    searchWeb(
      config,
      "主题",
      undefined,
      async () => new Response("secret", { status: 401 }),
    ),
  ).rejects.toThrow("认证失败");
  await expect(
    searchWeb(config, "主题", undefined, async () => new Response("secret")),
  ).rejects.toThrow("无效结果");
  await expect(
    searchWeb(
      config,
      "主题",
      undefined,
      async () => new Response("x".repeat(1024 * 1024 + 1)),
    ),
  ).rejects.toThrow("结果过大");
});
