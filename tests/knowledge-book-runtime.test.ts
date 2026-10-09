import { beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import { knowledgeBookRuntime } from "../apps/server/src/services/ai/knowledge-book-runtime.js";
const fixture = vi.hoisted(() => ({
  stream: vi.fn(),
  access: vi.fn(),
  webFile: vi.fn(),
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
      fetchWebFile: (...args: any[]) => fixture.webFile(...args),
    };
  },
);
vi.mock("@core/modules/knowledge-books/model-access.js", () => ({
  validateBookModelAccess: (...args: any[]) => fixture.access(...args),
}));
vi.mock("@core/modules/ai/config.js", () => ({
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
  fixture.webFile.mockReset();
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
  fixture.webFile.mockResolvedValue({
    url: "https://example.test/spec.html",
    mime: "text/html",
    body: Buffer.from(
      '<html><body><pre><span id="section-2.7.1">2.7.1</span> Addresses\nSolicited-Node uses the low-order 24 bits.\n<span id="section-2.8">2.8</span> Next section should not be read.</pre></body></html>',
    ),
  });
  const result = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).readWeb("https://example.test/spec.html#section-2.7.1");
  expect(result.text).toContain("low-order 24 bits");
  expect(result.text).not.toContain("Next section should not be read");
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
