import { expect, it, vi } from "vitest";
import {
  fetchWebPage,
  fetchWebFile,
  extractWebText,
  isPublicAddress,
  publicWebUrl,
  type PageTransport,
} from "../apps/server/src/services/ai/web-fetch.js";
import {
  aiConfig,
  aiConfigSchema,
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { openTestDatabase } from "./database.js";
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const page = (
  html: string,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body: Buffer.from(html),
});
it("extracts article content, entities and links without scripts or navigation", () => {
  const result = extractWebText(
    '<title>文章 &amp; 标题</title><nav>导航</nav><main><h1>标题</h1><p>第一段 &lt;code&gt;</p><script>secret()</script><p hidden>隐藏</p><a href="/next">下一页</a><pre>a\nb</pre></main><footer>底部</footer>',
    "https://example.com/article",
  );
  expect(result.title).toBe("文章 & 标题");
  expect(result.text).toContain("第一段 <code>");
  expect(result.text).toContain("a\nb");
  expect(result.text).not.toMatch(/secret|隐藏|底部|导航/);
  expect(result.links).toEqual([
    { title: "下一页", url: "https://example.com/next" },
  ]);
});
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "192.168.1.1",
  "172.20.0.1",
  "0.0.0.0",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
  "2001:db8::1",
  "100.64.0.1",
  "224.0.0.1",
])("blocks non-public address %s", (address) =>
  expect(isPublicAddress(address)).toBe(false),
);
it("validates every redirect before connecting and pins resolved addresses", async () => {
  const request = vi.fn<PageTransport>(async (url, address) => {
    expect(address.address).toBe("93.184.216.34");
    return page("", 302, { location: "http://127.0.0.1/admin" });
  });
  await expect(
    fetchWebPage("https://example.com", undefined, {
      resolve: publicDns,
      request,
    }),
  ).rejects.toThrow("内网");
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects mixed public/private DNS responses without connecting", async () => {
  const request = vi.fn<PageTransport>();
  await expect(
    fetchWebPage("https://example.com", undefined, {
      resolve: async () => [
        ...(await publicDns()),
        { address: "10.0.0.1", family: 4 },
      ],
      request,
    }),
  ).rejects.toThrow("内网");
  expect(request).not.toHaveBeenCalled();
});
it("returns redirect destination and bounded text with a retrieval timestamp", async () => {
  const request: PageTransport = async (url) =>
    url.pathname === "/"
      ? page("", 301, { location: "/article" })
      : page("<main>" + "a".repeat(200010) + "</main>");
  const result = await fetchWebPage("https://example.com", undefined, {
    resolve: publicDns,
    request,
  });
  expect(result.url).toBe("https://example.com/article");
  expect(result.text.length).toBe(200000);
  expect(result.truncated).toBe(true);
  expect(result.retrievedAt).toBeTruthy();
});
it("rejects login pages, files, empty pages and oversized responses honestly", async () => {
  for (const [response, error] of [
    [page("secret", 403), "登录"],
    [page("", 200, { "content-type": "application/pdf" }), "附件"],
    [page("<script>run()</script>"), "正文"],
    [page("x".repeat(2 * 1024 * 1024 + 1)), "过大"],
  ] as const)
    await expect(
      fetchWebPage("https://example.com", undefined, {
        resolve: publicDns,
        request: async () => response,
      }),
    ).rejects.toThrow(error);
});
it("downloads binary files that page fetch would reject", async () => {
  const body = Buffer.from("%PDF-1.7\nfixture");
  const result = await fetchWebFile("https://example.com/report.pdf", undefined, {
    resolve: publicDns,
    request: async () => ({
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
      },
      body,
    }),
  });
  expect(result.filename).toBe("report.pdf");
  expect(result.mime).toBe("application/pdf");
  expect(result.body.equals(body)).toBe(true);
  await expect(
    fetchWebFile("https://example.com/secret.bin", undefined, {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      request: async () => {
        throw new Error("should not connect");
      },
    }),
  ).rejects.toThrow("内网");
});
it("does not accept credentials or non-web schemes", () => {
  for (const url of [
    "file:///etc/passwd",
    "https://user:password@example.com",
    "javascript:alert(1)",
  ])
    expect(() => publicWebUrl(url)).toThrow();
});

it("reads through Jina Reader and preserves markdown links", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://r.jina.ai/https://example.com/");
    expect(new Headers(init?.headers).get("x-engine")).toBe("browser");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer jina-secret",
    );
    return new Response(
      "# Example\n\n正文内容 [下一页](https://example.com/next)",
      { headers: { "content-type": "text/markdown" } },
    );
  });
  const result = await fetchWebPage(
    "https://example.com",
    undefined,
    { fetcher },
    { provider: "jina", apiKey: "jina-secret" },
  );
  expect(result.title).toBe("Example");
  expect(result.text).toContain("正文内容");
  expect(result.links).toEqual([
    { title: "下一页", url: "https://example.com/next" },
  ]);
});

it("uses a keyless self-hosted Firecrawl over HTTP", async () => {
  const firecrawlFactory = vi.fn((options: any) => ({
    scrape: vi.fn(async () => ({
      markdown: "# Intranet\n\n正文",
      metadata: { title: "内网页面" },
    })),
  }));
  const result = await fetchWebPage(
    "https://example.com",
    undefined,
    { firecrawlFactory: firecrawlFactory as any },
    { provider: "firecrawl", apiKey: "", baseUrl: "http://172.17.0.1:3002" },
  );
  expect(firecrawlFactory).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "",
      apiUrl: "http://172.17.0.1:3002",
    }),
  );
  expect(result.title).toBe("内网页面");
  expect(result.text).toContain("正文");
});

it("uses the Firecrawl SDK with a self-hosted API URL", async () => {
  const firecrawlFactory = vi.fn((options: any) => ({
    scrape: vi.fn(async (url: string, scrapeOptions: any) => {
      expect(options).toMatchObject({
        apiKey: "provider-secret",
        apiUrl: "https://self-hosted.example",
        timeoutMs: 60000,
        maxRetries: 2,
      });
      expect(url).toBe("https://example.com/");
      expect(scrapeOptions).toMatchObject({
        formats: ["markdown"],
        timeout: 60000,
      });
      return { markdown: "# Firecrawl\n\n正文", metadata: { title: "页面标题" } };
    }),
  }));
  const result = await fetchWebPage(
    "https://example.com",
    undefined,
    { firecrawlFactory: firecrawlFactory as any },
    { provider: "firecrawl", apiKey: "provider-secret", baseUrl: "https://self-hosted.example/v2" },
  );
  expect(firecrawlFactory).toHaveBeenCalledOnce();
  expect(result.title).toBe("页面标题");
  expect(result.text).toContain("正文");
});

it("reads the Tavily provider response", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      urls: ["https://example.com/"],
      extract_depth: "advanced",
    });
    return Response.json({
      results: [{ url: "https://example.com", raw_content: "# Tavily\n\n正文" }],
    });
  });
  const result = await fetchWebPage(
    "https://example.com",
    undefined,
    { fetcher },
    {
      provider: "tavily",
      apiKey: "provider-secret",
    },
  );
  expect(result.text).toContain("正文");
});

it("saves Firecrawl HTTP even when an unused search URL is blank", async () => {
  const parsed = aiConfigSchema.safeParse({
    ...aiDefaults,
    webSearch: { provider: "searxng", apiKey: "", baseUrl: "" },
    webFetch: {
      provider: "firecrawl",
      baseUrl: "http://172.17.0.1:3002",
      apiKey: "",
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.webSearch?.baseUrl).toBeUndefined();
    expect(parsed.data.webFetch?.baseUrl).toBe("http://172.17.0.1:3002");
  }
});

it("saves a keyless Firecrawl service on private HTTP and docker hostnames", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    await saveAIConfig(
      db,
      {
        ...aiDefaults,
        webFetch: {
          provider: "firecrawl",
          baseUrl: "http://172.17.0.1:3002",
          apiKey: "",
        },
      },
      0,
    );
    expect((await aiConfig(db)).webFetch).toMatchObject({
      provider: "firecrawl",
      baseUrl: "http://172.17.0.1:3002",
      apiKey: "",
    });
    await saveAIConfig(
      db,
      {
        ...aiDefaults,
        webFetch: {
          provider: "firecrawl",
          baseUrl: "http://firecrawl:3002",
          apiKey: "",
        },
      },
      1,
    );
    expect((await aiConfig(db)).webFetch?.baseUrl).toBe("http://firecrawl:3002");
    await expect(
      saveAIConfig(
        db,
        {
          ...aiDefaults,
          webFetch: {
            provider: "firecrawl",
            baseUrl: "http://8.8.8.8:3002",
            apiKey: "",
          },
        },
        2,
      ),
    ).rejects.toThrow("HTTPS");
  } finally {
    await db.destroy();
  }
});
