import { beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import { AppError } from "@core/shared/errors.js";
import { knowledgeBookRuntime } from "../apps/server/src/services/ai/knowledge-book-runtime.js";
const fixture = vi.hoisted(() => ({
  stream: vi.fn(),
  access: vi.fn(),
  webHTML: vi.fn(),
  webPage: vi.fn(),
  config: vi.fn(),
  validateSource: vi.fn(),
}));
vi.mock(
  "../apps/server/src/services/ai/web-fetch.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../apps/server/src/services/ai/web-fetch.js")
      >();
    return {
      ...actual,
      fetchWebSourceHTML: (...args: any[]) => fixture.webHTML(...args),
      fetchWebPage: (...args: any[]) => fixture.webPage(...args),
      validatePublicWebSourceUrl: (...args: any[]) =>
        fixture.validateSource(...args),
    };
  },
);
vi.mock("@core/modules/knowledge-books/model-access.js", () => ({
  validateBookModelAccess: (...args: any[]) => fixture.access(...args),
}));
vi.mock("@core/modules/ai/config.js", () => ({
  aiConfig: (...args: any[]) => fixture.config(...args),
  requireModel: async () => ({
    model: {
      maxInput: 200000,
      maxOutput: 32000,
      provider: "compatible",
      model: "kimi-k3",
    },
  }),
}));
vi.mock("../apps/server/src/services/ai/model.js", () => ({
  meteredModel: async () => ({ doStream: fixture.stream }),
}));

const evidence = (id: string, text: string) => ({
  id,
  sourceId: id,
  sourceRevision: 1,
  sourceVersion: "1",
  title: "Protocol source",
  text,
  weight: 1,
  reference: { kind: "manual" },
  blockId: id,
  contentHash: id,
});
const input = (items: any[]) => ({
  goal: "Precise protocol tutorial",
  instructions: "Preserve technical conditions",
  evidence: items,
  claims: [],
  pages: [],
  criteria: [],
  maxDocumentDepth: 4,
});
function response(text: string, finish = true) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: text });
        if (finish)
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" },
          });
        controller.close();
      },
    }),
  };
}
beforeEach(() => {
  fixture.stream.mockReset();
  fixture.webHTML.mockReset();
  fixture.webPage.mockReset();
  fixture.config.mockReset();
  fixture.config.mockResolvedValue({
    webFetch: { provider: "builtin", apiKey: null },
  });
  fixture.validateSource.mockReset();
  fixture.validateSource.mockResolvedValue(undefined);
  fixture.access.mockReset();
  fixture.access.mockResolvedValue(undefined);
});

it("uses short wire aliases, validates exact quotes and maps them back to persisted source IDs", async () => {
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.evidence[0].id).toBe("e0");
    return response(
      JSON.stringify({
        claims: [
          {
            id: "tcp",
            statement: "TCP is a byte stream.",
            citationIds: ["e0q0"],
            reason: "Exact protocol definition",
            confidence: 1,
          },
        ],
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "extract",
    input([evidence("stable-evidence-id", "TCP is a byte stream.")]),
    new AbortController().signal,
  );
  expect(result.claims[0].evidenceIds).toEqual(["stable-evidence-id"]);
  expect(result.claims[0].evidenceQuotes[0].evidenceId).toBe(
    "stable-evidence-id",
  );
});
it("processes every extraction batch and keeps duplicate model claim IDs separate", async () => {
  const reports: any[] = [];
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text),
      item = data.evidence[0];
    return response(
      JSON.stringify({
        claims: [
          {
            id: "same",
            statement: item.passages[0].text.slice(0, 40),
            citationIds: [item.passages[0].citationId],
            reason: "Source excerpt",
            confidence: 1,
          },
        ],
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "extract",
    input([
      evidence("first", "TCP " + "a".repeat(3600)),
      evidence("second", "DNS " + "b".repeat(3600)),
    ]),
    new AbortController().signal,
    async event => { reports.push(event); },
  );
  expect(reports.filter(event => event.code === "batch_completed").map(event => event.value)).toEqual([1, 2]);
  expect(fixture.stream).toHaveBeenCalledTimes(2);
  expect(result.claims).toHaveLength(2);
  expect(new Set(result.claims.map((c: any) => c.id)).size).toBe(2);
  expect(result.claims.flatMap((c: any) => c.evidenceIds)).toEqual([
    "first",
    "second",
  ]);
});
it("repairs invalid citation IDs without accepting invented evidence", async () => {
  fixture.stream.mockImplementation(async () =>
    response(
      JSON.stringify({
        claims: [
          {
            id: "forged",
            statement: "Fabricated",
            citationIds: ["e0q999"],
            reason: "Unsupported",
            confidence: 1,
          },
        ],
      }),
    ),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([evidence("source", "TCP is a byte stream.")]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 502 });
  expect(fixture.stream).toHaveBeenCalledTimes(3);
});
it("rejects a stream with no completion receipt and requires an explicit frozen model", async () => {
  fixture.stream.mockResolvedValue(response('{"claims":[]}', false));
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([evidence("source", "TCP")]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "").generate(
      "extract",
      input([evidence("source", "TCP")]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 503 });
});

it("scopes paragraph IDs by page and still rejects duplicate IDs within one page", async () => {
  const claim = {
    id: "stable-claim",
    statement: "TCP is a byte stream.",
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP is a byte stream." }],
    reason: "Protocol definition",
    confidence: 1,
  };
  const page = (id: string) => ({
    id,
    title: id,
    path: ["Protocol mechanisms"],
    paragraphs: [
      {
        id: "p1",
        markdown: "TCP is a byte stream.",
        claimIds: ["c0"],
        reason: "Use the verified definition",
      },
    ],
  });
  fixture.stream.mockImplementation(async () =>
    response(JSON.stringify({ pages: [page("TCP"), page("Framing")] })),
  );
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "synthesize",
    {
      ...input([evidence("source", "TCP is a byte stream.")]),
      claims: [claim],
    },
    new AbortController().signal,
  );
  expect(
    new Set(
      result.pages.flatMap((p: any) => p.paragraphs.map((q: any) => q.id)),
    ).size,
  ).toBe(2);
  expect(result.pages[0].paragraphs[0].claimIds).toEqual(["stable-claim"]);
  const duplicate = page("TCP");
  duplicate.paragraphs.push({ ...duplicate.paragraphs[0]! });
  fixture.stream.mockImplementation(async () =>
    response(JSON.stringify({ pages: [duplicate] })),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "synthesize",
      {
        ...input([evidence("source", "TCP is a byte stream.")]),
        claims: [claim],
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 502 });
});

it("stops before the next vendor call when a grant is revoked during extraction batches", async () => {
  fixture.access
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      Object.assign(new Error("Source access revoked"), { status: 403 }),
    );
  fixture.stream.mockImplementation(async () =>
    response(
      JSON.stringify({
        claims: [
          {
            id: "tcp",
            statement: "TCP",
            citationIds: ["e0q0"],
            reason: "Verified source",
            confidence: 1,
          },
        ],
      }),
    ),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([
        evidence("first", "a".repeat(3600)),
        evidence("second", "b".repeat(3600)),
      ]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(fixture.stream).toHaveBeenCalledTimes(1);
  expect(fixture.access).toHaveBeenCalledTimes(2);
});

it("reads a complete old RFC heading section without including the following section", async () => {
  fixture.webHTML.mockResolvedValue({
    url: "https://example.test/spec.html",
    html: '<html><body><pre><span id="section-2.7.1">2.7.1</span> Addresses\nSolicited-Node uses the low-order 24 bits.\n<span id="section-2.8">2.8</span> Next section should not be read.</pre></body></html>',
  });
  const result = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).readWeb("https://example.test/spec.html#section-2.7.1");
  expect(result.text).toContain("low-order 24 bits");
  expect(result.text).not.toContain("Next section should not be read");
  expect(fixture.webHTML).toHaveBeenCalledWith(
    "https://example.test/spec.html#section-2.7.1",
    expect.any(AbortSignal),
    {},
    { provider: "builtin", apiKey: null },
  );
});

it.each(["firecrawl", "jina", "tavily"])(
  "reads full source pages through the AI-configured %s reader",
  async (provider) => {
    const config = {
      provider,
      baseUrl: "https://reader.example.test",
      apiKey: "reader-secret",
    };
    fixture.config.mockResolvedValue({ webFetch: config });
    fixture.webPage.mockResolvedValue({
      title: "Rendered page",
      text: "Browser-rendered content",
      truncated: false,
    });
    const result = await knowledgeBookRuntime(
      {} as DB,
      "user",
      "run",
      "model",
    ).readWeb("https://example.test/article");
    expect(result).toEqual({
      title: "Rendered page",
      text: "Browser-rendered content",
    });
    expect(fixture.validateSource).toHaveBeenCalledWith(
      "https://example.test/article",
      expect.any(AbortSignal),
    );
    expect(fixture.webPage).toHaveBeenCalledWith(
      "https://example.test/article",
      expect.any(AbortSignal),
      {},
      config,
    );
    expect(fixture.webHTML).not.toHaveBeenCalled();
  },
);

it("uses the current reader configuration on each source read", async () => {
  const runtime = knowledgeBookRuntime({} as DB, "user", "run", "model");
  fixture.config.mockResolvedValueOnce({ webFetch: { provider: "firecrawl" } });
  fixture.config.mockResolvedValueOnce({ webFetch: { provider: "jina" } });
  fixture.webPage.mockResolvedValue({
    title: "Page",
    text: "Body",
    truncated: false,
  });
  await runtime.readWeb("https://example.test/article");
  await runtime.readWeb("https://example.test/article");
  expect(fixture.webPage.mock.calls.map((call) => call[3].provider)).toEqual([
    "firecrawl",
    "jina",
  ]);
});

it.each(["firecrawl", "jina"])(
  "selects only the requested section from %s HTML",
  async (provider) => {
    const config = { provider, apiKey: "reader-secret" };
    fixture.config.mockResolvedValue({ webFetch: config });
    fixture.webHTML.mockResolvedValue({
      url: "https://example.test/article",
      html: '<main><section id="outside">Unselected facts</section><section id="chosen"><h2>Chosen section</h2><p>Verified facts</p></section><section>Later facts</section></main>',
    });
    const result = await knowledgeBookRuntime(
      {} as DB,
      "user",
      "run",
      "model",
    ).readWeb("https://example.test/article#chosen");
    expect(result.text).toContain("Verified facts");
    expect(result.text).not.toMatch(/Unselected|Later/);
    expect(fixture.webHTML).toHaveBeenCalledWith(
      "https://example.test/article#chosen",
      expect.any(AbortSignal),
      {},
      config,
    );
    expect(fixture.webPage).not.toHaveBeenCalled();
  },
);

it("does not call a configured reader when the source address is private", async () => {
  fixture.config.mockResolvedValue({ webFetch: { provider: "firecrawl" } });
  fixture.validateSource.mockRejectedValue(
    new AppError(400, "Private address"),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").readWeb(
      "http://127.0.0.1/private",
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(fixture.webPage).not.toHaveBeenCalled();
  expect(fixture.webHTML).not.toHaveBeenCalled();
});

it("rejects truncated pages, missing sections and oversized sections", async () => {
  const runtime = knowledgeBookRuntime({} as DB, "user", "run", "model");
  fixture.config.mockResolvedValue({ webFetch: { provider: "firecrawl" } });
  fixture.webPage.mockResolvedValue({
    title: "Large",
    text: "partial",
    truncated: true,
  });
  await expect(
    runtime.readWeb("https://example.test/large"),
  ).rejects.toMatchObject({ status: 413 });
  fixture.webHTML.mockResolvedValue({
    url: "https://example.test/article",
    html: '<section id="other">Body</section>',
  });
  await expect(
    runtime.readWeb("https://example.test/article#chosen"),
  ).rejects.toMatchObject({ status: 404 });
  fixture.webHTML.mockResolvedValue({
    url: "https://example.test/article",
    html: '<section id="chosen">' + "x".repeat(120001) + "</section>",
  });
  await expect(
    runtime.readWeb("https://example.test/article#chosen"),
  ).rejects.toMatchObject({ status: 413 });
});

it("keeps provider errors visible without falling back to another reader", async () => {
  fixture.config.mockResolvedValue({ webFetch: { provider: "tavily" } });
  fixture.webHTML.mockRejectedValue(
    new AppError(422, "Reader cannot preserve sections"),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").readWeb(
      "https://example.test/article#chosen",
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(fixture.webHTML).toHaveBeenCalledOnce();
  expect(fixture.webPage).not.toHaveBeenCalled();
});

it("reports batches, output size and corrective retries while keeping raw model content out of logs", async () => {
  let attempt = 0;
  fixture.stream.mockImplementation(async () => {
    attempt++;
    if (attempt === 1) return response("invalid-json-content");
    return response(JSON.stringify({ claims: [{ id: "tcp", statement: "TCP is a byte stream.", citationIds: ["e0q0"], reason: "Exact definition", confidence: 1 }] }));
  });
  const reports: any[] = [];
  await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("extract", input([evidence("source", "TCP is a byte stream.")]), new AbortController().signal, async event => { reports.push(event); });
  expect(reports.map(event => event.code)).toEqual(expect.arrayContaining(["model_request", "model_output", "model_invalid_json", "model_retry"]));
  expect(reports.filter(event => event.code === "model_request").map(event => event.value)).toEqual([1, 2]);
  expect(JSON.stringify(reports)).not.toContain("invalid-json-content");
});


it("writes all synthesis batches as substantive chapters with globally distinct paragraph IDs", async () => {
  const claims = Array.from({ length: 85 }, (_, index) => ({ id: `fact${index}`, statement: `Mechanism ${index}`, evidenceIds: ["source"], evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }], reason: "Source", confidence: 1 }));
  fixture.stream.mockImplementation(async options => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(options.prompt[0].content).toContain("real fenced mermaid diagrams");
    return response(JSON.stringify({ pages: [{ id: "chapter", title: "TCP mechanisms", path: ["Transport"], paragraphs: data.claims.map((claim: any, index: number) => ({ id: `p${index}`, markdown: `## ${claim.statement}\n\nSupported detail.\n\n` + '```mermaid\nflowchart LR\n A[Sender] --> B[Receiver]\n```', claimIds: [claim.id], reason: "Supported mechanism" })) }] }));
  });
  const result: any = await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("synthesize", { ...input([evidence("source", "TCP")]), claims }, new AbortController().signal);
  expect(fixture.stream).toHaveBeenCalledTimes(3);
  const paragraphs = result.pages.flatMap((page: any) => page.paragraphs);
  expect(paragraphs).toHaveLength(85);
  expect(new Set(paragraphs.map((paragraph: any) => paragraph.id)).size).toBe(85);
  expect(new Set(paragraphs.flatMap((paragraph: any) => paragraph.claimIds))).toEqual(new Set(claims.map(claim => claim.id)));
  expect(paragraphs.every((paragraph: any) => paragraph.markdown.includes("```mermaid"))).toBe(true);
});

it("repairs syntactically valid organization which drops supported knowledge", async () => {
  const claims = ["a", "b"].map(id => ({ id, statement: `Distinct mechanism ${id}`, evidenceIds: ["source"], evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }], reason: "Source", confidence: 1 }));
  let calls = 0;
  fixture.stream.mockImplementation(async () => {
    calls++;
    return response(JSON.stringify({ pages: [{ id: "chapter", title: "TCP", path: [], paragraphs: [{ id: "p", markdown: "## Mechanisms\n\nDetailed explanation.", claimIds: calls === 1 ? ["c0"] : ["c0", "c1"], reason: "Supported" }] }] }));
  });
  const result: any = await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("organize", { ...input([evidence("source", "TCP")]), claims, pages: [{ id: "candidate", title: "TCP", path: [], paragraphs: [{ id: "p", markdown: "Supported mechanisms", claimIds: ["a", "b"], reason: "Source" }] }] }, new AbortController().signal);
  expect(calls).toBe(2);
  expect(result.pages[0].paragraphs[0].claimIds).toEqual(["a", "b"]);
});

it("repairs long unsectioned chapters and keeps supplied diagrams through organization", async () => {
  const claims = [{ id: "claim", statement: "TCP is a byte stream.", evidenceIds: ["source"], evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }], reason: "Source", confidence: 1 }];
  const diagram = '```mermaid\nflowchart LR\n A[Sender] --> B[Receiver]\n```';
  let calls = 0;
  fixture.stream.mockImplementation(async () => {
    calls++;
    const markdown = calls === 1 ? "Supported explanation." : calls === 2 ? "## Mechanism\n\nSupported explanation." : `## Mechanism\n\nSupported explanation.\n\n${diagram}`;
    return response(JSON.stringify({ pages: [{ id: "page", title: "TCP", path: [], paragraphs: Array.from({ length: 3 }, (_, index) => ({ id: `p${index}`, markdown, claimIds: ["c0"], reason: "Source" })) }] }));
  });
  const result: any = await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("organize", { ...input([evidence("source", "TCP")]), claims, pages: [{ id: "candidate", title: "TCP", path: [], paragraphs: [{ id: "p", markdown: diagram, claimIds: ["claim"], reason: "Source" }] }] }, new AbortController().signal);
  expect(calls).toBe(3);
  expect(result.pages[0].paragraphs[0].markdown).toContain("```mermaid");
});

it("splits a large generated chapter without dropping paragraphs at the current page limit", async () => {
  const claims = Array.from({ length: 241 }, (_, index) => ({ id: `claim${index}`, statement: `Supported mechanism ${index}`, evidenceIds: ["source"], evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }], reason: "Source", confidence: 1 }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    return response(JSON.stringify({ pages: [{ id: "chapter", title: "TCP", path: [], paragraphs: data.claims.map((claim: any, index: number) => ({ id: `p${index}`, markdown: `## Mechanisms\n\n${claim.statement}`, claimIds: [claim.id], reason: "Source" })) }] }));
  });
  const result: any = await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("synthesize", { ...input([evidence("source", "TCP")]), claims }, new AbortController().signal);
  expect(result.pages.map((page: any) => page.paragraphs.length)).toEqual([200, 41]);
  expect(new Set(result.pages.map((page: any) => page.title)).size).toBe(2);
  expect(result.pages.flatMap((page: any) => page.paragraphs.flatMap((paragraph: any) => paragraph.claimIds))).toHaveLength(241);
});

it("organizes a large single page in bounded batches without changing its input or dropping sections", async () => {
  const claims = Array.from({ length: 85 }, (_, index) => ({ id: `claim${index}`, statement: `Supported mechanism ${index}`, evidenceIds: ["source"], evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }], reason: "Source", confidence: 1 }));
  const pages = [{ id: "chapter", title: "TCP", path: [], paragraphs: claims.map((claim, index) => ({ id: `p${index}`, markdown: `## Mechanism ${index}\n\n${claim.statement}`, claimIds: [claim.id], reason: "Source" })) }];
  const before = structuredClone(pages);
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.claims.length).toBeLessThanOrEqual(40);
    return response(JSON.stringify({ pages: data.pages }));
  });
  const result: any = await knowledgeBookRuntime({} as DB, "user", "run", "model").generate("organize", { ...input([evidence("source", "TCP")]), claims, pages }, new AbortController().signal);
  expect(fixture.stream).toHaveBeenCalledTimes(3);
  expect(result.pages[0].paragraphs).toHaveLength(85);
  expect(pages).toEqual(before);
});
