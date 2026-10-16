import { beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@db/index.js";
import { AppError, systemErrorReason } from "@core/shared/errors.js";
import { knowledgeBookRuntime } from "../apps/server/src/services/ai/knowledge-book-runtime.js";
const fixture = vi.hoisted(() => ({
  stream: vi.fn(),
  access: vi.fn(),
  webHTML: vi.fn(),
  webPage: vi.fn(),
  config: vi.fn(),
  validateSource: vi.fn(),
  modelName: "kimi-k3",
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
      model: fixture.modelName,
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
  writingBranchCount: 1,
});
function response(text: string, finish = true, finishReason = "stop") {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: text });
        if (finish)
          controller.enqueue({
            type: "finish",
            finishReason: { unified: finishReason },
          });
        controller.close();
      },
    }),
  };
}
function plannedAcceptance(data: any, globalIds: string[] = []) {
  return response(
    JSON.stringify({
      rules: data.criteria.map((criterion: any) => ({
        criterionId: criterion.id,
        localChecks: globalIds.includes(criterion.id)
          ? []
          : [
              "Verify support, detail and conditions of assertions presented in this batch",
            ],
        globalChecks: globalIds.includes(criterion.id)
          ? ["Verify whole-book length and required diagram coverage"]
          : ["Verify complete book coverage using detailed reviews"],
      })),
    }),
  );
}
function tracedAcceptance(
  data: any,
  passed = true,
  reason = "Observed mechanism and case components",
) {
  return response(
    JSON.stringify({
      assertions: data.requiredAssertions.map((assertion: any) => ({
        assertionId: assertion.id,
        failedCriterionIds: passed
          ? []
          : data.criteria.map((criterion: any) => criterion.id),
        reason: reason.slice(0, 300),
      })),
      observations: data.criteria.map((criterion: any) => ({
        criterionId: criterion.id,
        reason,
      })),
    }),
  );
}
beforeEach(() => {
  fixture.modelName = "kimi-k3";
  fixture.access.mockReset();
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

it.each([
  { goal: "Tutorial", allowance: false, wrong: false },
  { goal: "Tutorial", allowance: true, wrong: false },
  { goal: "Tutorial", allowance: true, wrong: true },
  { goal: "20000字", allowance: false, wrong: false },
  { goal: "20000字", allowance: true, wrong: false },
  { goal: "20000字", allowance: true, wrong: true },
])(
  "preserves criterion policy through $goal inspection (allowance=$allowance, wrong=$wrong)",
  async ({ goal, allowance, wrong }) => {
    const description = allowance
      ? "Allow accurate established industry knowledge beyond Manual sources. Reject wrong arithmetic and protocol contradictions."
      : "Every factual assertion must be supported by supplied Manual sources.";
    const criteria = [{ id: "grounded", required: true, description }];
    const claims = Array.from({ length: 42 }, (_, i) => ({
      id: `c${i}`,
      statement: "Ethernet",
      evidenceIds: ["source"],
      evidenceQuotes: [{ evidenceId: "source", quote: "Ethernet" }],
      reason: "Source",
      confidence: 1,
    }));
    const pages = [0, 1].map((i) => ({
      id: `page${i}`,
      title: `Chapter ${i}`,
      path: [],
      paragraphs: [
        {
          id: `paragraph${i}`,
          markdown: wrong
            ? "2 + 2 = 5."
            : "An accurate background fact absent from the Manual.",
          claimIds: claims.slice(i * 21, i * 21 + 21).map((c) => c.id),
          reason: "Background",
        },
      ],
    }));
    const scopes = new Set<string>();
    const passed = allowance && !wrong;
    fixture.stream.mockImplementation(async (options) => {
      const system = options.prompt[0].content;
      expect(system).toContain(
        "criterion IDs are opaque identifiers, not built-in policies",
      );
      expect(system).toContain(
        "absence from those sources alone does not violate that criterion",
      );
      expect(system).toContain(
        "when a criterion requires source support, require that support",
      );
      expect(system).not.toContain(
        "Missing evidence or missing required detail means failure.",
      );
      expect(system).not.toContain(
        "New external protocol or implementation facts remain unsupported.",
      );
      const data = JSON.parse(options.prompt[1].content[0].text);
      scopes.add(data.acceptanceScope);
      const original = data.originalCriteria ?? data.criteria;
      expect(original).toEqual(criteria);
      if (data.acceptanceScope === "plan")
        return response(
          JSON.stringify({
            rules: [
              {
                criterionId: "grounded",
                localChecks: [description],
                globalChecks: [description],
              },
            ],
          }),
        );
      if (data.acceptanceScope === "trace")
        return tracedAcceptance(
          data,
          passed,
          wrong ? "Wrong arithmetic" : "Configured evidence policy",
        );
      return response(
        JSON.stringify({
          checks: [
            {
              criterionId: "grounded",
              passed,
              reason: wrong ? "Wrong arithmetic" : "Configured evidence policy",
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
      "acceptance",
      {
        ...input([evidence("source", "Ethernet")]),
        goal,
        claims,
        pages,
        criteria,
      },
      new AbortController().signal,
    );
    expect(scopes.has("plan")).toBe(true);
    expect(scopes.has(goal === "20000字" ? "trace" : "batch")).toBe(true);
    expect(result.checks[0].passed).toBe(passed);
  },
);

it.each(["doubao-seed-2.1-lite", "doubao-seed-2-1-lite-260915"])(
  "requests native thinking for substantive inspection on %s without storing reasoning",
  async (modelName) => {
    fixture.modelName = modelName;
    fixture.stream.mockImplementation(async (options) => {
      expect(options.responseFormat).toEqual({ type: "json" });
      expect(options.providerOptions.doca.thinking).toEqual({
        type: "enabled",
      });
      return response(
        '{"checks":[{"criterionId":"facts","passed":false,"reason":"Incorrect calculation"}]}',
      );
    });
    const output: any = await knowledgeBookRuntime(
      {} as DB,
      "user",
      "run",
      "model",
    ).generate(
      "acceptance",
      {
        ...input([]),
        criteria: [
          { id: "facts", required: true, description: "Correct arithmetic" },
        ],
      },
      new AbortController().signal,
    );
    expect(output).toEqual({
      checks: [
        {
          criterionId: "facts",
          passed: false,
          reason: "Incorrect calculation",
        },
      ],
    });
  },
);

it.each([
  { statusCode: 401, calls: 1 },
  { statusCode: 503, calls: 3 },
])(
  "classifies plain stream error objects safely ($statusCode)",
  async ({ statusCode, calls }) => {
    fixture.stream.mockImplementation(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", delta: '{"checks":[' });
          controller.enqueue({
            type: "error",
            error: {
              statusCode,
              message: "provider-secret-response",
              requestHeaders: { authorization: "private-key" },
            },
          });
          controller.close();
        },
      }),
    }));
    const error = await knowledgeBookRuntime({} as DB, "user", "run", "model")
      .generate(
        "acceptance",
        {
          ...input([]),
          criteria: [
            { id: "grounded", required: true, description: "Factual accuracy" },
          ],
        },
        new AbortController().signal,
      )
      .then(
        () => {
          throw Error("Expected failure");
        },
        (error) => error,
      );
    expect(error).toBeInstanceOf(AppError);
    expect(systemErrorReason(error)?.code).toBe(
      statusCode === 401 ? "model_auth_failed" : "model_provider_unavailable",
    );
    expect(error.message).not.toMatch(
      /object Object|provider-secret-response|private-key/,
    );
    expect(fixture.stream).toHaveBeenCalledTimes(calls);
  },
);

it("retries a broken successful-response stream without retaining partial JSON or changing a negative verdict", async () => {
  const transport = Object.assign(
    new Error("Failed to process successful response"),
    {
      name: "AI_APICallError",
      statusCode: 200,
      isRetryable: false,
    },
  );
  const cancel = vi.fn();
  fixture.stream
    .mockResolvedValueOnce({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "text-delta",
            delta: '{"checks":[{"criterionId":"facts","passed":true',
          });
          controller.enqueue({ type: "error", error: transport });
        },
        cancel,
      }),
    })
    .mockImplementation(async (options) => {
      expect(options.prompt).toHaveLength(2);
      expect(JSON.stringify(options.prompt)).not.toContain('"passed":true');
      return response(
        '{"checks":[{"criterionId":"facts","passed":false,"reason":"Wrong arithmetic"}]}',
      );
    });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([]),
      criteria: [
        { id: "facts", required: true, description: "Correct arithmetic" },
      ],
    },
    new AbortController().signal,
  );
  expect(output.checks[0].passed).toBe(false);
  expect(fixture.stream).toHaveBeenCalledTimes(2);
  expect(fixture.access).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds repeated SDK response-processing failures to three calls", async () => {
  const transport = Object.assign(
    new Error("Failed to process successful response"),
    { name: "AI_APICallError", statusCode: 200 },
  );
  fixture.stream.mockRejectedValue(transport);
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([]),
      new AbortController().signal,
    ),
  ).rejects.toBe(transport);
  expect(fixture.stream).toHaveBeenCalledTimes(3);
  expect(fixture.access).toHaveBeenCalledTimes(3);
});

it("retries an SDK stream ending without a finish reason and discards its text", async () => {
  const incomplete = Object.assign(
    new Error("Response stream ended without a finish reason."),
    { name: "AI_InvalidResponseDataError" },
  );
  fixture.stream
    .mockResolvedValueOnce({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", delta: '{"claims":[]' });
          controller.enqueue({ type: "error", error: incomplete });
          controller.close();
        },
      }),
    })
    .mockResolvedValue(response('{"claims":[]}'));
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate("extract", input([]), new AbortController().signal);
  expect(output.claims).toEqual([]);
  expect(fixture.stream).toHaveBeenCalledTimes(2);
  expect(fixture.access).toHaveBeenCalledTimes(2);
});

it.each([
  "model_provider_unavailable",
  "model_timeout",
  "model_connection_failed",
  "model_rate_limited",
])("retries the host's translated transient reason %s", async (code) => {
  fixture.stream
    .mockRejectedValueOnce(new AppError(502, "Safe provider error", { code }))
    .mockResolvedValue(response('{"claims":[]}'));
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate("extract", input([]), new AbortController().signal);
  expect(output.claims).toEqual([]);
  expect(fixture.stream).toHaveBeenCalledTimes(2);
  expect(fixture.access).toHaveBeenCalledTimes(2);
});

it("does not retry the host's translated authentication failure", async () => {
  const error = new AppError(502, "Safe authentication error", {
    code: "model_auth_failed",
  });
  fixture.stream.mockRejectedValue(error);
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([]),
      new AbortController().signal,
    ),
  ).rejects.toBe(error);
  expect(fixture.stream).toHaveBeenCalledOnce();
});

it.each([400, 401, 402, 403, 404, 413, 422])(
  "does not retry rejected parameters, authorization or payload status %s",
  async (statusCode) => {
    const rejected = Object.assign(new Error("Provider rejected request"), {
      name: "AI_APICallError",
      statusCode,
      isRetryable: true,
    });
    fixture.stream.mockRejectedValue(rejected);
    await expect(
      knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
        "extract",
        input([]),
        new AbortController().signal,
      ),
    ).rejects.toBe(rejected);
    expect(fixture.stream).toHaveBeenCalledOnce();
  },
);

it("honors cancellation before a transient retry", async () => {
  const controller = new AbortController();
  fixture.stream.mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error("Failed to process successful response"), {
      name: "AI_APICallError",
      statusCode: 200,
    });
  });
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "extract",
      input([]),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.stream).toHaveBeenCalledOnce();
});

it("repairs missing assertion coverage and retains a concrete rejection despite a positive overall observation", async () => {
  let calls = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.acceptanceScope).toBe("trace");
    if (calls++)
      expect(options.prompt.at(-1).content[0].text).toContain(
        "every requiredAssertions.id exactly once",
      );
    return response(
      JSON.stringify({
        assertions:
          calls === 1
            ? [
                {
                  assertionId: "a0",
                  failedCriterionIds: [],
                  reason: "Incomplete review",
                },
              ]
            : [
                {
                  assertionId: "a0",
                  failedCriterionIds: ["facts"],
                  reason: "12800 is smaller than 65536",
                },
                {
                  assertionId: "a1",
                  failedCriterionIds: [],
                  reason: "Valid chosen initial state",
                },
              ],
        observations: [{ criterionId: "facts", reason: "Overall good" }],
      }),
    );
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([]),
      acceptanceScope: "trace",
      pages: [
        {
          id: "page",
          title: "Case",
          path: [],
          paragraphs: [
            {
              id: "paragraph",
              markdown: "12800 > 65536。初始状态。",
              claimIds: [],
              reason: "Teaching simulation",
            },
          ],
        },
      ],
      requiredAssertions: [
        { id: "a0", paragraphId: "paragraph", excerpt: "12800 > 65536" },
        { id: "a1", paragraphId: "paragraph", excerpt: "初始状态" },
      ],
      criteria: [
        { id: "facts", required: true, description: "Correct numeric steps" },
      ],
    },
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(output.checks[0].passed).toBe(false);
  expect(output.checks[0].reason).toContain("paragraph: 12800 > 65536");
  expect(output.checks[0].reason).toContain("smaller");
  expect(Object.keys(output.checks[0]).sort()).toEqual([
    "criterionId",
    "passed",
    "reason",
  ]);
});

it("does not combine a disabled planning request with a native reasoning effort", async () => {
  fixture.modelName = "doubao-seed-2.1-lite";
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(options.providerOptions.doca.thinking).toEqual({ type: "disabled" });
    expect(options.providerOptions.doca).not.toHaveProperty("reasoningEffort");
    return plannedAcceptance(data, ["length"]);
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([]),
      acceptanceScope: "plan",
      criteria: [{ id: "length", required: true, description: "Total length" }],
    },
    new AbortController().signal,
  );
  expect(result.rules[0].criterionId).toBe("length");
});

it("evaluates an assertion once and rejects only its associated criteria", async () => {
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.requiredAssertions).toHaveLength(1);
    return response(
      JSON.stringify({
        assertions: [
          {
            assertionId: "a0",
            failedCriterionIds: ["facts"],
            reason: "12800 is smaller than 65536",
          },
        ],
        observations: [
          { criterionId: "facts", reason: "Other facts supported" },
          { criterionId: "layout", reason: "Correct layout" },
        ],
      }),
    );
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([]),
      acceptanceScope: "trace",
      requiredAssertions: [
        { id: "a0", paragraphId: "p", excerpt: "12800 > 65536" },
      ],
      criteria: [
        { id: "facts", required: true, description: "Correct arithmetic" },
        { id: "layout", required: true, description: "Correct layout" },
      ],
    },
    new AbortController().signal,
  );
  expect(
    output.checks.map((check: any) => [check.criterionId, check.passed]),
  ).toEqual([
    ["facts", false],
    ["layout", true],
  ]);
  expect(output.checks[0].reason).toContain("12800 > 65536");
});

it("retains full local diagnostics for matching candidate repair without reusing acceptance verdicts", async () => {
  const pages = [0, 1].map((index) => ({
    id: `page_${String(index).repeat(32)}`,
    title: `Chapter ${index}`,
    path: [],
    paragraphs: [
      {
        id: `paragraph_${String(index).repeat(32)}`,
        markdown: "Actual case. ".repeat(600).trim(),
        claimIds: ["fact0"],
        reason: "Source",
      },
    ],
  }));
  let repaired = 0,
    inspections = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (data.acceptanceScope === "trace") {
      inspections++;
      return tracedAcceptance(data, false, "SOURCE_DEFECT");
    }
    repaired++;
    expect(
      data.priorReviews.some(
        (review: any) =>
          review.reason.includes("SOURCE_DEFECT") &&
          review.reason.includes(data.pages[0].paragraphs[0].id),
      ),
    ).toBe(true);
    return response(
      JSON.stringify({
        pages: data.pages.map((page: any) => ({
          ...page,
          paragraphs: page.paragraphs.map((paragraph: any) => ({
            ...paragraph,
            markdown: paragraph.markdown + " repaired",
          })),
        })),
      }),
    );
  });
  const rt = knowledgeBookRuntime({} as DB, "user", "run", "model");
  const base = {
    ...input([evidence("source", "TCP")]),
    goal: "20000字",
    claims: depthClaims(1),
    pages,
  };
  const rejected: any = await rt.generate(
    "acceptance",
    {
      ...base,
      criteria: [{ id: "facts", required: true, description: "Correct facts" }],
    },
    new AbortController().signal,
  );
  expect(rejected.checks[0].passed).toBe(false);
  const output: any = await rt.generate(
    "organize",
    { ...base, priorReviewPages: pages, priorReviews: rejected.checks },
    new AbortController().signal,
  );
  expect(inspections).toBe(2);
  expect(repaired).toBe(2);
  expect(
    output.pages.every((page: any) =>
      page.paragraphs[0].markdown.endsWith(" repaired"),
    ),
  ).toBe(true);
});

it("uses concrete paragraph diagnostics to repair only their batch inside a shared chapter", async () => {
  const paragraphs = [
    {
      id: `paragraph_${"1".repeat(32)}`,
      markdown: "Supported content. ".repeat(500).trim(),
      claimIds: ["fact0"],
      reason: "Source",
    },
    {
      id: `paragraph_${"2".repeat(32)}`,
      markdown: "Supported case. ".repeat(600).trim(),
      claimIds: ["fact1"],
      reason: "Source",
    },
  ];
  const pages = [
    { id: `page_${"a".repeat(32)}`, title: "Chapter", path: [], paragraphs },
  ];
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.pages[0].paragraphs).toHaveLength(1);
    expect(data.pages[0].paragraphs[0].id).toBe(paragraphs[1]!.id);
    return response(
      JSON.stringify({
        pages: data.pages.map((page: any) => ({
          ...page,
          paragraphs: page.paragraphs.map((paragraph: any) => ({
            ...paragraph,
            markdown: paragraph.markdown + " corrected",
          })),
        })),
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "organize",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims: depthClaims(2),
      pages,
      priorReviewPages: pages,
      priorReviews: [
        {
          criterionId: "facts",
          passed: false,
          reason: `Pages ${pages[0]!.id}: ${paragraphs[1]!.id} has an incorrect transition`,
        },
      ],
    },
    new AbortController().signal,
  );
  expect(fixture.stream).toHaveBeenCalledOnce();
  expect(result.pages[0].paragraphs[0].markdown).toBe(paragraphs[0]!.markdown);
  expect(result.pages[0].paragraphs[1].markdown.endsWith(" corrected")).toBe(
    true,
  );
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
    async (event) => {
      reports.push(event);
    },
  );
  expect(
    reports
      .filter((event) => event.code === "batch_completed")
      .map((event) => event.value),
  ).toEqual([1, 2]);
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
  expect(fixture.stream).toHaveBeenCalledTimes(3);
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
    return response(
      JSON.stringify({
        claims: [
          {
            id: "tcp",
            statement: "TCP is a byte stream.",
            citationIds: ["e0q0"],
            reason: "Exact definition",
            confidence: 1,
          },
        ],
      }),
    );
  });
  const reports: any[] = [];
  await knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
    "extract",
    input([evidence("source", "TCP is a byte stream.")]),
    new AbortController().signal,
    async (event) => {
      reports.push(event);
    },
  );
  expect(reports.map((event) => event.code)).toEqual(
    expect.arrayContaining([
      "model_request",
      "model_output",
      "model_invalid_json",
      "model_retry",
    ]),
  );
  expect(
    reports
      .filter((event) => event.code === "model_request")
      .map((event) => event.value),
  ).toEqual([1, 2]);
  expect(JSON.stringify(reports)).not.toContain("invalid-json-content");
});

it("writes all synthesis batches as substantive chapters with globally distinct paragraph IDs", async () => {
  const claims = Array.from({ length: 85 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(options.prompt[0].content).toContain("real fenced mermaid diagrams");
    return response(
      JSON.stringify({
        pages: [
          {
            id: "chapter",
            title: "TCP mechanisms",
            path: ["Transport"],
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown:
                `## ${claim.statement}\n\nSupported detail.\n\n` +
                "```mermaid\nflowchart LR\n A[Sender] --> B[Receiver]\n```",
              claimIds: [claim.id],
              reason: "Supported mechanism",
            })),
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
    "synthesize",
    { ...input([evidence("source", "TCP")]), claims },
    new AbortController().signal,
  );
  expect(fixture.stream).toHaveBeenCalledTimes(3);
  const paragraphs = result.pages.flatMap((page: any) => page.paragraphs);
  expect(paragraphs).toHaveLength(85);
  expect(new Set(paragraphs.map((paragraph: any) => paragraph.id)).size).toBe(
    85,
  );
  expect(
    new Set(paragraphs.flatMap((paragraph: any) => paragraph.claimIds)),
  ).toEqual(new Set(claims.map((claim) => claim.id)));
  expect(
    paragraphs.every((paragraph: any) =>
      paragraph.markdown.includes("```mermaid"),
    ),
  ).toBe(true);
});

it("repairs syntactically valid organization which drops supported knowledge", async () => {
  const claims = ["a", "b"].map((id) => ({
    id,
    statement: `Distinct mechanism ${id}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  let calls = 0;
  fixture.stream.mockImplementation(async () => {
    calls++;
    return response(
      JSON.stringify({
        pages: [
          {
            id: "chapter",
            title: "TCP",
            path: [],
            paragraphs: [
              {
                id: "p",
                markdown: "## Mechanisms\n\nDetailed explanation.",
                claimIds: calls === 1 ? ["c0"] : ["c0", "c1"],
                reason: "Supported",
              },
            ],
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
    "organize",
    {
      ...input([evidence("source", "TCP")]),
      claims,
      pages: [
        {
          id: "candidate",
          title: "TCP",
          path: [],
          paragraphs: [
            {
              id: "p",
              markdown: "Supported mechanisms",
              claimIds: ["a", "b"],
              reason: "Source",
            },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(result.pages[0].paragraphs[0].claimIds).toEqual(["a", "b"]);
});

it("repairs long unsectioned chapters and keeps supplied diagrams through organization", async () => {
  const claims = [
    {
      id: "claim",
      statement: "TCP is a byte stream.",
      evidenceIds: ["source"],
      evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
      reason: "Source",
      confidence: 1,
    },
  ];
  const diagram = "```mermaid\nflowchart LR\n A[Sender] --> B[Receiver]\n```";
  let calls = 0;
  fixture.stream.mockImplementation(async () => {
    calls++;
    const markdown =
      calls === 1
        ? "Supported explanation."
        : calls === 2
          ? "## Mechanism\n\nSupported explanation."
          : `## Mechanism\n\nSupported explanation.\n\n${diagram}`;
    return response(
      JSON.stringify({
        pages: [
          {
            id: "page",
            title: "TCP",
            path: [],
            paragraphs: Array.from({ length: 3 }, (_, index) => ({
              id: `p${index}`,
              markdown,
              claimIds: ["c0"],
              reason: "Source",
            })),
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
    "organize",
    {
      ...input([evidence("source", "TCP")]),
      claims,
      pages: [
        {
          id: "candidate",
          title: "TCP",
          path: [],
          paragraphs: [
            {
              id: "p",
              markdown: diagram,
              claimIds: ["claim"],
              reason: "Source",
            },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  expect(calls).toBe(3);
  expect(result.pages[0].paragraphs[0].markdown).toContain("```mermaid");
});

it("splits a large generated chapter without dropping paragraphs at the current page limit", async () => {
  const claims = Array.from({ length: 241 }, (_, index) => ({
    id: `claim${index}`,
    statement: `Supported mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    return response(
      JSON.stringify({
        pages: [
          {
            id: "chapter",
            title: "TCP",
            path: [],
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown: `## Mechanisms\n\n${claim.statement}`,
              claimIds: [claim.id],
              reason: "Source",
            })),
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
    "synthesize",
    { ...input([evidence("source", "TCP")]), claims },
    new AbortController().signal,
  );
  expect(result.pages.map((page: any) => page.paragraphs.length)).toEqual([
    200, 41,
  ]);
  expect(new Set(result.pages.map((page: any) => page.title)).size).toBe(2);
  expect(
    result.pages.flatMap((page: any) =>
      page.paragraphs.flatMap((paragraph: any) => paragraph.claimIds),
    ),
  ).toHaveLength(241);
});

it("organizes a large single page in bounded batches without changing its input or dropping sections", async () => {
  const claims = Array.from({ length: 85 }, (_, index) => ({
    id: `claim${index}`,
    statement: `Supported mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const pages = [
    {
      id: "chapter",
      title: "TCP",
      path: [],
      paragraphs: claims.map((claim, index) => ({
        id: `p${index}`,
        markdown: `## Mechanism ${index}\n\n${claim.statement}`,
        claimIds: [claim.id],
        reason: "Source",
      })),
    },
  ];
  const before = structuredClone(pages);
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.claims.length).toBeLessThanOrEqual(40);
    return response(JSON.stringify({ pages: data.pages }));
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "organize",
    { ...input([evidence("source", "TCP")]), claims, pages },
    new AbortController().signal,
  );
  expect(fixture.stream).toHaveBeenCalledTimes(3);
  expect(result.pages[0].paragraphs).toHaveLength(85);
  expect(pages).toEqual(before);
});

it("subdivides truncated detailed synthesis even below forty claims and retains over 100,000 characters", async () => {
  const claims = Array.from({ length: 19 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.claims.length > 2) return response('{"pages":[', true, "length");
    return response(
      JSON.stringify({
        pages: [
          {
            id: "chapter",
            title: "TCP",
            path: [],
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown:
                `## ${claim.statement}\n\n` +
                "Supported detailed mechanisms. ".repeat(220),
              claimIds: [claim.id],
              reason: "Source",
            })),
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
    "synthesize",
    { ...input([evidence("source", "TCP")]), claims },
    new AbortController().signal,
  );
  const paragraphs = result.pages.flatMap((page: any) => page.paragraphs);
  expect(paragraphs).toHaveLength(19);
  expect(
    paragraphs.reduce(
      (sum: number, paragraph: any) => sum + paragraph.markdown.length,
      0,
    ),
  ).toBeGreaterThan(100000);
  expect(
    new Set(paragraphs.flatMap((paragraph: any) => paragraph.claimIds)),
  ).toEqual(new Set(claims.map((claim) => claim.id)));
  expect(new Set(paragraphs.map((paragraph: any) => paragraph.id)).size).toBe(
    19,
  );
  expect(fixture.stream.mock.calls.length).toBeLessThan(38);
});

it("subdivides truncated organization at whole paragraphs without breaking Mermaid or mutating candidates", async () => {
  const claims = Array.from({ length: 4 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const diagram = "```mermaid\nflowchart LR\n A[Sender] --> B[Receiver]\n```";
  const pages = [
    {
      id: "chapter",
      title: "TCP",
      path: [],
      paragraphs: claims.map((claim, index) => ({
        id: `p${index}`,
        markdown: `## Mechanism ${index}\n\n${diagram}`,
        claimIds: [claim.id],
        reason: "Source",
      })),
    },
  ];
  const before = structuredClone(pages);
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    return data.pages.flatMap((page: any) => page.paragraphs).length > 1
      ? response("{}", true, "length")
      : response(JSON.stringify({ pages: data.pages }));
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "organize",
    { ...input([evidence("source", "TCP")]), claims, pages },
    new AbortController().signal,
  );
  expect(
    result.pages[0].paragraphs.map((paragraph: any) => paragraph.markdown),
  ).toEqual(before[0]!.paragraphs.map((paragraph) => paragraph.markdown));
  expect(pages).toEqual(before);
  expect(fixture.stream).toHaveBeenCalledTimes(7);
});

it("reports an indivisible request limit precisely and does not retry truncated partial JSON as complete", async () => {
  const claim = {
    id: "fact",
    statement: "TCP",
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  };
  fixture.stream.mockResolvedValue(response('{"pages":[', true, "length"));
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "synthesize",
      { ...input([evidence("source", "TCP")]), claims: [claim] },
      new AbortController().signal,
    ),
  ).rejects.toThrow("output token limit");
  expect(fixture.stream).toHaveBeenCalledTimes(1);
});

it("subdivides invalid complex writing output at whole claims instead of exhausting full-batch retries", async () => {
  const claims = Array.from({ length: 8 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.claims.length > 2) return response('{"pages":[{"bad":');
    return response(
      JSON.stringify({
        pages: [
          {
            id: "chapter",
            title: "TCP",
            path: [],
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown: `## ${claim.statement}\n\nSupported detailed explanation.`,
              claimIds: [claim.id],
              reason: "Source",
            })),
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
    "synthesize",
    { ...input([evidence("source", "TCP")]), claims },
    new AbortController().signal,
  );
  expect(result.pages.flatMap((page: any) => page.paragraphs)).toHaveLength(8);
  expect(fixture.stream).toHaveBeenCalledTimes(7);
  expect(
    new Set(
      result.pages.flatMap((page: any) =>
        page.paragraphs.flatMap((paragraph: any) => paragraph.claimIds),
      ),
    ),
  ).toEqual(new Set(claims.map((claim) => claim.id)));
});

it("accepts over 100,000 characters with bounded detail batches and a global metrics review", async () => {
  const claims = Array.from({ length: 24 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: [`source${index}`],
    evidenceQuotes: [{ evidenceId: `source${index}`, quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const pages = claims.map((claim, index) => ({
    id: `page${index}`,
    title: `Chapter ${index}`,
    path: ["Mechanisms"],
    paragraphs: [
      {
        id: `p${index}`,
        markdown: `## Mechanism\n\n${"Detailed supported content. ".repeat(190)}\n\n\`\`\`mermaid\nflowchart LR\n A --> B\n\`\`\``,
        claimIds: [claim.id],
        reason: "Source",
      },
    ],
  }));
  const items = claims.map((_, index) => evidence(`source${index}`, "TCP"));
  const criteria = [
    { id: "grounded", required: true, description: "Supported local detail" },
    {
      id: "global",
      required: true,
      description: "At least 100,000 characters and a diagram somewhere",
    },
  ];
  const before = structuredClone(pages);
  let detailed = 0,
    summaries = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan")
      return plannedAcceptance(data, ["global"]);
    if (data.acceptanceScope === "batch") {
      detailed++;
      expect(
        data.pages
          .flatMap((page: any) => page.paragraphs)
          .reduce(
            (sum: number, paragraph: any) => sum + paragraph.markdown.length,
            0,
          ),
      ).toBeLessThanOrEqual(16000);
      expect(data.evidence).toHaveLength(data.claims.length);
      expect(data.criteria.map((criterion: any) => criterion.id)).toEqual([
        "grounded",
      ]);
      expect(options.prompt[0].content).toContain("ONLY LOCAL criteria");
    } else {
      summaries++;
      expect(data.pages).toEqual([]);
      expect(data.evidence).toEqual([]);
      expect(data.accessEvidence).toBeUndefined();
      expect(data.criteria).toHaveLength(1);
      expect(data.bookMetrics.markdownCharacters).toBeGreaterThan(100000);
      expect(data.bookMetrics.diagramCount).toBe(24);
      expect(data.batchReviews).toHaveLength(
        data.criteria[0].id === "grounded" ? detailed : 0,
      );
    }
    return response(
      JSON.stringify({
        checks: data.criteria.map((criterion: any) => ({
          criterionId: criterion.id,
          passed: true,
          reason:
            "Current batch fact check or complete host counts support the criterion",
        })),
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    { ...input(items), claims, pages, criteria },
    new AbortController().signal,
  );
  expect(detailed).toBeGreaterThan(1);
  expect(summaries).toBe(2);
  expect(result.checks.map((check: any) => check.criterionId)).toEqual([
    "grounded",
    "global",
  ]);
  expect(pages).toEqual(before);
  expect(fixture.access).toHaveBeenCalledWith(
    expect.anything(),
    "user",
    "run",
    items,
  );
});

it("does not let a global acceptance summary overturn a factual defect in any batch", async () => {
  const claim = {
    id: "fact",
    statement: "TCP",
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  };
  const pages = [0, 1].map((index) => ({
    id: `page${index}`,
    title: "TCP",
    path: [],
    paragraphs: [
      {
        id: `p${index}`,
        markdown: "Detailed explanation. ".repeat(550),
        claimIds: ["fact"],
        reason: "Source",
      },
    ],
  }));
  const criteria = [{ id: "facts", description: "Grounded", required: true }];
  let call = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "facts",
            passed: ++call !== 2,
            reason:
              call === 2
                ? "Unsupported assertion in second batch"
                : "Supported",
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
    "acceptance",
    { ...input([evidence("source", "TCP")]), claims: [claim], pages, criteria },
    new AbortController().signal,
  );
  expect(call).toBe(2);
  expect(result.checks).toEqual([
    {
      criterionId: "facts",
      passed: false,
      reason: "Batch 2: Pages page1: Unsupported assertion in second batch",
    },
  ]);
});

it("retries incomplete acceptance coverage before accepting a batch", async () => {
  fixture.stream
    .mockResolvedValueOnce(response('{"checks":[]}'))
    .mockResolvedValueOnce(
      response(
        '{"checks":[{"criterionId":"facts","passed":true,"reason":"Supported"}]}',
      ),
    );
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      criteria: [{ id: "facts", description: "Grounded", required: true }],
    },
    new AbortController().signal,
  );
  expect(result.checks).toHaveLength(1);
  expect(fixture.stream).toHaveBeenCalledTimes(2);
});

it("allocates the global character goal across writing branches", async () => {
  const claims = Array.from({ length: 10 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.batchCharacterTarget).toBe(1000);
    return response(
      JSON.stringify({
        pages: [
          {
            id: "page",
            title: "TCP",
            path: [],
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown: "## Mechanism\n\n" + "Supported detail. ".repeat(8),
              claimIds: [claim.id],
              reason: "Source",
            })),
          },
        ],
      }),
    );
  });
  await knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
    "synthesize",
    {
      ...input([evidence("source", "TCP")]),
      goal: "2000字",
      writingBranchCount: 2,
      claims,
    },
    new AbortController().signal,
  );
  expect(fixture.stream).toHaveBeenCalledTimes(1);
});

it("does not inflate a prose target using diagram code or Markdown formatting", async () => {
  const claim = {
    id: "fact",
    statement: "TCP",
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  };
  fixture.stream.mockImplementation(async () =>
    response(
      JSON.stringify({
        pages: [
          {
            id: "page",
            title: "TCP",
            path: [],
            paragraphs: [
              {
                id: "p",
                markdown:
                  "## TCP\n\nShort prose.\n\n```mermaid\nflowchart LR\n" +
                  " A --> B\n".repeat(350) +
                  "```",
                claimIds: ["c0"],
                reason: "Source",
              },
            ],
          },
        ],
      }),
    ),
  );
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "synthesize",
      {
        ...input([evidence("source", "TCP")]),
        goal: "2000字",
        claims: [claim],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("actual body characters");
  expect(fixture.stream).toHaveBeenCalledTimes(3);
});

it("hierarchically consolidates many batch reviews without a growing final model payload", async () => {
  const claim = {
    id: "fact",
    statement: "TCP",
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  };
  const pages = Array.from({ length: 25 }, (_, index) => ({
    id: `page${index}`,
    title: `TCP ${index}`,
    path: [],
    paragraphs: [
      {
        id: `p${index}`,
        markdown: "Detailed supported content. ".repeat(400),
        claimIds: ["fact"],
        reason: "Source",
      },
    ],
  }));
  let merges = 0,
    final = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (data.acceptanceScope !== "batch") {
      expect(data.batchReviews.length).toBeLessThanOrEqual(12);
      expect(data.pages).toEqual([]);
      if (data.acceptanceScope === "merge") merges++;
      else final++;
    }
    return response(
      '{"checks":[{"criterionId":"facts","passed":true,"reason":"Supported topics and conditions retained"}]}',
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      claims: [claim],
      pages,
      criteria: [{ id: "facts", description: "Grounded", required: true }],
    },
    new AbortController().signal,
  );
  expect(merges).toBe(3);
  expect(final).toBe(1);
  expect(result.checks[0].passed).toBe(true);
});

it("rechecks all source grants before sending a global review of derived content", async () => {
  const items = [evidence("a", "TCP"), evidence("b", "TCP")];
  const claims = items.map((item) => ({
    id: item.id,
    statement: "TCP",
    evidenceIds: [item.id],
    evidenceQuotes: [{ evidenceId: item.id, quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const pages = claims.map((claim) => ({
    id: claim.id,
    title: "TCP",
    path: [],
    paragraphs: [
      {
        id: claim.id,
        markdown: "Supported detailed content. ".repeat(400),
        claimIds: [claim.id],
        reason: "Source",
      },
    ],
  }));
  fixture.access.mockImplementation(async (_db, _user, _run, evidence) => {
    if (evidence.length === 2 && fixture.stream.mock.calls.length >= 3)
      throw new AppError(403, "Source access revoked");
  });
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    return response(
      '{"checks":[{"criterionId":"facts","passed":true,"reason":"Supported"}]}',
    );
  });
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "acceptance",
      {
        ...input(items),
        claims,
        pages,
        criteria: [{ id: "facts", description: "Grounded", required: true }],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Source access revoked");
  expect(fixture.stream).toHaveBeenCalledTimes(3);
});

it("rejects an acceptance plan that drops configured criteria before inspecting any batch", async () => {
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.acceptanceScope).toBe("plan");
    return response(
      JSON.stringify({
        rules: [
          { criterionId: "invented", localChecks: ["Facts"], globalChecks: [] },
        ],
      }),
    );
  });
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "acceptance",
      {
        ...input([]),
        criteria: [{ id: "configured", description: "Facts", required: true }],
        pages: [
          {
            id: "p",
            title: "Topic",
            path: [],
            paragraphs: [0, 1].map((index) => ({
              id: "p" + index,
              markdown: "Supported detail ".repeat(800),
              claimIds: [],
              reason: "Source",
            })),
          },
        ],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("preserve every configured criterion");
  expect(fixture.stream).toHaveBeenCalledTimes(3);
});

it.each([
  {
    first: "```mermaid\nflowchart LR\nA[客户端(主机)]-->B\n```",
    expectedCalls: 1,
  },
  {
    first:
      "```mermaid\nflowchart LR\nA[客户端(主机)]-->B\nnote over A,B: wrong diagram syntax\n```",
    expectedCalls: 2,
  },
])(
  "repairs generated Mermaid syntax with $expectedCalls model calls",
  async ({ first, expectedCalls }) => {
    let calls = 0;
    fixture.stream.mockImplementation(async (options) => {
      calls++;
      if (calls === 2)
        expect(options.prompt.at(-1).content[0].text).toContain(
          "Invalid Mermaid diagrams",
        );
      return response(
        JSON.stringify({
          pages: [
            {
              id: "page",
              title: "TCP",
              path: [],
              paragraphs: [
                {
                  id: "body",
                  markdown:
                    calls === 1
                      ? first
                      : '```mermaid\nflowchart LR\nA["客户端(主机)"]-->B\n```',
                  claimIds: ["c0"],
                  reason: "Source",
                },
              ],
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
      "synthesize",
      {
        ...input([evidence("source", "TCP")]),
        claims: [
          {
            id: "fact",
            statement: "TCP",
            evidenceIds: ["source"],
            evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
            confidence: 1,
            reason: "Source",
          },
        ],
      },
      new AbortController().signal,
    );
    expect(calls).toBe(expectedCalls);
    expect(result.pages[0].paragraphs[0].markdown).toContain(
      'A["客户端(主机)"]',
    );
  },
  10000,
);

it.each([true, false])(
  "repairs the identified prior candidate only when its authorized claim scope matches (%s)",
  async (matches) => {
    const claim = {
      id: "fact",
      statement: "TCP",
      evidenceIds: ["source"],
      evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
      reason: "Source",
      confidence: 1,
    };
    const page = (id: string, body: string, claimId: string) => ({
      id,
      title: "TCP",
      path: [],
      paragraphs: [
        {
          id: id + "-body",
          markdown: body,
          claimIds: [claimId],
          reason: "Source",
        },
      ],
    });
    fixture.stream.mockImplementation(async (options) => {
      const data = JSON.parse(options.prompt[1].content[0].text);
      expect(data.priorReviewPages).toBeUndefined();
      expect(data.pages[0].id).toBe(matches ? "reviewed" : "upstream");
      expect(data.priorReviews).toHaveLength(1);
      return response(
        JSON.stringify({
          pages: [
            {
              ...data.pages[0],
              paragraphs: [
                {
                  ...data.pages[0].paragraphs[0],
                  markdown: "Corrected supported TCP explanation",
                },
              ],
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
      "organize",
      {
        ...input([evidence("source", "TCP")]),
        claims: [claim],
        pages: [page("upstream", "Earlier writing", "fact")],
        priorReviewPages: [
          page(
            "reviewed",
            "Candidate with a specific defect",
            matches ? "fact" : "other-scope",
          ),
        ],
        priorReviews: [
          {
            criterionId: "facts",
            passed: false,
            reason: "reviewed contains a specific incorrect definition",
          },
        ],
      },
      new AbortController().signal,
    );
    expect(result.pages[0].paragraphs[0].markdown).toBe(
      "Corrected supported TCP explanation",
    );
  },
);

it("re-evaluates acceptance independently without carrying stale failure reasons into current judgments", async () => {
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.priorReviews).toEqual([]);
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "facts",
            passed: true,
            reason: "Current content supports the criterion",
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
    "acceptance",
    {
      ...input([]),
      criteria: [
        { id: "facts", description: "Supported facts", required: true },
      ],
      priorReviews: [
        {
          criterionId: "facts",
          passed: false,
          reason: "An old version was missing a different diagram type",
        },
      ],
    },
    new AbortController().signal,
  );
  expect(result.checks[0].passed).toBe(true);
});

it("preserves unaffected reviewed paragraphs instead of paying to rewrite them during focused repair", async () => {
  const claims = [0, 1].map((index) => ({
    id: "fact" + index,
    statement: "TCP " + index,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const pages = claims.map((claim, index) => ({
    id: "page_" + (index ? "bbbbbbbb" : "aaaaaaaa"),
    title: "Topic " + index,
    path: [],
    paragraphs: [
      {
        id: "body" + index,
        markdown: String(index).repeat(10000),
        claimIds: [claim.id],
        reason: "Source",
      },
    ],
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.pages.map((page: any) => page.id)).toEqual(["page_aaaaaaaa"]);
    return response(
      JSON.stringify({
        pages: data.pages.map((page: any) => ({
          ...page,
          paragraphs: page.paragraphs.map((paragraph: any) => ({
            ...paragraph,
            markdown: paragraph.markdown + " corrected",
          })),
        })),
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "organize",
    {
      ...input([evidence("source", "TCP")]),
      claims,
      pages,
      priorReviewPages: pages,
      priorReviews: [
        {
          criterionId: "facts",
          passed: false,
          reason: "page_aaaaaaaa contains a local defect",
        },
      ],
    },
    new AbortController().signal,
  );
  expect(fixture.stream).toHaveBeenCalledOnce();
  expect(
    result.pages.find((page: any) => page.title === "Topic 1").paragraphs[0]
      .markdown,
  ).toBe(pages[1]!.paragraphs[0]!.markdown);
  expect(
    result.pages.find((page: any) => page.title === "Topic 0").paragraphs[0]
      .markdown,
  ).toContain("corrected");
});

const depthClaims = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `fact${index}`,
    statement: `Mechanism ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));

it.each(
  [true, false].flatMap((supported) =>
    [
      "该检查范围只有事件标签，无法确认状态表动作",
      "Only the event label is supplied; the corresponding state/action table is not available in this view",
    ].map((initialReason) => ({ supported, initialReason })),
  ),
)(
  "rechecks bounded support regardless of rejection wording without waiving actual defects ($supported, $initialReason)",
  async ({ supported, initialReason }) => {
    const items = [
      { ...evidence("source", "TCP"), sourceId: "rfc" },
      { ...evidence("near", "x".repeat(23990)), sourceId: "rfc" },
      {
        ...evidence(
          "rule",
          "On packet buffer overflow replace the oldest queued packet.",
        ),
        sourceId: "rfc",
      },
    ];
    const claims = depthClaims(14);
    const pages = [
      {
        id: "page",
        title: "Queue case",
        path: [],
        paragraphs: [
          {
            id: "queue",
            markdown: supported
              ? "队列溢出时替换最旧条目。"
              : "队列溢出时替换最旧条目。12800 > 65536。",
            claimIds: claims.slice(0, 7).map((c) => c.id),
            reason: "Source",
          },
          {
            id: "other",
            markdown: "其他段落。",
            claimIds: claims.slice(7).map((c) => c.id),
            reason: "Source",
          },
        ],
      },
    ];
    const evidenceAttempts: boolean[] = [];
    fixture.stream.mockImplementation(async (options) => {
      const data = JSON.parse(options.prompt[1].content[0].text);
      if (data.acceptanceScope === "plan") return plannedAcceptance(data);
      if (data.acceptanceScope === "trace") {
        if (!data.pages[0].paragraphs[0].markdown.includes("队列"))
          return tracedAcceptance(data);
        const hasRule = data.evidence.some((item: any) =>
          item.text.includes("oldest"),
        );
        evidenceAttempts.push(hasRule);
        expect(data.priorReviews).toEqual([]);
        return tracedAcceptance(
          data,
          hasRule && supported,
          hasRule
            ? "Independent current-rule assessment; numeric inversion remains wrong when present"
            : initialReason,
        );
      }
      return response(
        JSON.stringify({
          checks: [
            {
              criterionId: "facts",
              passed: true,
              reason: "Whole-book observations",
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
      "acceptance",
      {
        ...input(items),
        goal: "20000字",
        claims,
        pages,
        criteria: [
          {
            id: "facts",
            required: true,
            description: "Supported rules and correct calculations",
          },
        ],
      },
      new AbortController().signal,
    );
    expect(evidenceAttempts).toEqual([false, true]);
    expect(result.checks[0].passed).toBe(supported);
    if (!supported)
      expect(result.checks[0].reason).toContain("numeric inversion");
  },
);

function depthPage(data: any) {
  expect(data.outputSchema.properties.pages.maxItems).toBe(1);
  expect(data.outputSchema.properties.pages.items.properties.title.const).toBe(
    data.fixedChapter.title,
  );
  expect(
    data.outputSchema.properties.pages.items.properties.path.maxItems,
  ).toBe(data.fixedChapter.path.length);
  return response(
    JSON.stringify({
      pages: [
        {
          id: "page",
          title: data.fixedChapter.title,
          path: data.fixedChapter.path,
          paragraphs: [
            {
              id: "p",
              markdown:
                `## ${data.chapterAssignment.section}\n\n` +
                "Supported causal detail. ".repeat(
                  Math.ceil(data.batchCharacterTarget / 24),
                ),
              claimIds: data.claims.map((c: any) => c.id),
              reason: "Source",
            },
          ],
        },
      ],
    }),
  );
}

it("retains real syntax failures as content defects even when the model claims a pass", async () => {
  const pages = [
    {
      id: "page",
      title: "Case",
      path: [],
      paragraphs: [
        {
          id: "text",
          markdown: "Supported detail. ".repeat(190),
          claimIds: ["fact0"],
          reason: "Source",
        },
        {
          id: "broken-figure",
          markdown: "```mermaid\nflowchart TD\nA --> [\n```",
          claimIds: ["fact0"],
          reason: "Source",
        },
      ],
    },
  ];
  let syntaxRejected = false;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (data.acceptanceScope === "trace") {
      if (data.pages[0].paragraphs.some((p: any) => p.id === "broken-figure")) {
        expect(data.diagramSyntaxValidated).toBe(false);
        expect(data.diagramSyntaxError).toContain("broken-figure");
        syntaxRejected = true;
      }
      return tracedAcceptance(data);
    }
    return response(
      JSON.stringify({
        checks: [{ criterionId: "figures", passed: true, reason: "Coverage" }],
      }),
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims: depthClaims(1),
      pages,
      criteria: [
        {
          id: "figures",
          required: true,
          description: "Renderable Mermaid diagrams",
        },
      ],
    },
    new AbortController().signal,
  );
  expect(syntaxRejected).toBe(true);
  expect(result.checks[0].passed).toBe(false);
  expect(result.checks[0].reason).toContain("Invalid Mermaid");
});

it.each([true, false])(
  "uses neighboring figures and real syntax validation without overriding semantic failure ($0)",
  async (semanticsCorrect) => {
    const diagram =
      "```mermaid\nflowchart TD\nA[Handshake] --> B[Secret]\nB -.lifetime limit\nCertificateVerify.-> F[Resumed]\n```";
    const pages = [
      {
        id: "page",
        title: "Case",
        path: [],
        paragraphs: [
          {
            id: "caption",
            markdown: "See the next diagram. ".repeat(160),
            claimIds: ["fact0"],
            reason: "Source",
          },
          {
            id: "figure",
            markdown: diagram,
            claimIds: ["fact0"],
            reason: "Source",
          },
        ],
      },
    ];
    let captionInspected = false;
    fixture.stream.mockImplementation(async (options) => {
      const data = JSON.parse(options.prompt[1].content[0].text);
      if (data.acceptanceScope === "plan") return plannedAcceptance(data);
      if (data.acceptanceScope === "trace") {
        expect(data.diagramSyntaxValidated).toBe(true);
        if (data.pages[0].paragraphs[0].id === "caption") {
          captionInspected = true;
          expect(
            data.supportingParagraphs.some(
              (p: any) => p.paragraphId === "figure" && p.markdown === diagram,
            ),
          ).toBe(true);
          expect(
            data.requiredAssertions.every(
              (a: any) => a.paragraphId === "caption",
            ),
          ).toBe(true);
        }
        return tracedAcceptance(
          data,
          semanticsCorrect,
          semanticsCorrect
            ? "The actual referenced figure is present and syntax is valid"
            : "Incorrect state transition in the figure",
        );
      }
      return response(
        JSON.stringify({
          checks: [
            {
              criterionId: "figures",
              passed: true,
              reason: "Complete figure coverage",
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
      "acceptance",
      {
        ...input([evidence("source", "TCP")]),
        goal: "20000字",
        claims: depthClaims(1),
        pages,
        criteria: [
          {
            id: "figures",
            required: true,
            description: "Real diagrams consistent with their explanations",
          },
        ],
      },
      new AbortController().signal,
    );
    expect(captionInspected).toBe(true);
    expect(result.checks[0].passed).toBe(semanticsCorrect);
  },
);

it("keeps actionable causes and the last failed scope when dozens of batches fail", async () => {
  const pages = Array.from({ length: 83 }, (_, index) => ({
    id: `page_${index.toString(16).padStart(5, "0").padEnd(32, "c")}`,
    title: `Chapter ${index}`,
    path: [],
    paragraphs: [
      {
        id: `paragraph_${index.toString(16).padStart(5, "0").padEnd(32, "d")}`,
        markdown: "Supported detail. ".repeat(190),
        claimIds: ["fact0"],
        reason: "Source",
      },
    ],
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    return tracedAcceptance(
      data,
      false,
      "Wrong count: five fixed fields total eight bytes.",
    );
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims: depthClaims(1),
      pages,
      criteria: [
        { id: "facts", required: true, description: "Correct counts" },
      ],
    },
    new AbortController().signal,
  );
  expect(result.checks[0].passed).toBe(false);
  expect(result.checks[0].reason).toContain("Wrong count");
  expect(result.checks[0].reason).toContain("Batch 83:");
  expect(result.checks[0].reason).toContain("59 additional failed batches");
  expect(result.checks[0].reason.length).toBeLessThanOrEqual(4000);
});

it("plans a compact outline then assigns bounded claims before writing into fixed chapters", async () => {
  const claims = depthClaims(4);
  const phases: string[] = [];
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    phases.push(data.writingScope ?? "write");
    if (data.writingScope === "plan") {
      expect(data.evidence).toEqual([]);
      expect(data.claims).toHaveLength(3);
      expect(data.claims[0]).toEqual({
        id: "c0",
        statement: "Mechanism 0",
        sourceTitles: ["Protocol source"],
      });
      return response(
        JSON.stringify({
          chapters: [
            {
              title: "TCP mechanics",
              path: ["Core"],
              sections: [
                {
                  id: "seq",
                  title: "Sequence derivation",
                  objective: "Work through byte ranges and acknowledgements",
                },
                {
                  id: "diag",
                  title: "Failure diagnosis",
                  objective: "Use evidence to discriminate causes",
                },
                {
                  id: "unused",
                  title: "Unused in this scope",
                  objective: "Reserved for other claims",
                },
              ],
            },
          ],
        }),
      );
    }
    if (data.writingScope === "assign") {
      expect(data.claims).toHaveLength(4);
      expect(data.evidence).toEqual([]);
      expect(data.chapterSections).toHaveLength(3);
      return response(
        JSON.stringify({
          assignments: [
            { sectionId: "seq", claimIds: ["c0", "c1"] },
            { sectionId: "diag", claimIds: ["c2", "c3"] },
            { sectionId: "unused", claimIds: [] },
          ],
        }),
      );
    }
    expect(data.fixedChapter.title).toBe("TCP mechanics");
    expect(data.chapterAssignment.sections).toHaveLength(2);
    return depthPage(data);
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "synthesize",
    { ...input([evidence("source", "TCP")]), goal: "20000字", claims },
    new AbortController().signal,
  );
  expect(phases).toEqual(["plan", "assign", "write", "write"]);
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0].paragraphs).toHaveLength(2);
  expect(
    new Set(result.pages[0].paragraphs.flatMap((p: any) => p.claimIds)),
  ).toEqual(new Set(claims.map((c) => c.id)));
  expect(fixture.access).toHaveBeenCalledTimes(4);
});

it("rejects assignments that duplicate a claim and omit another without starting any writing", async () => {
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    return data.writingScope === "plan"
      ? response(
          JSON.stringify({
            chapters: [
              {
                title: "TCP",
                path: [],
                sections: [
                  { id: "seq", title: "Sequence", objective: "Derive" },
                ],
              },
            ],
          }),
        )
      : response(
          JSON.stringify({
            assignments: [{ sectionId: "seq", claimIds: ["c0", "c0"] }],
          }),
        );
  });
  await expect(
    knowledgeBookRuntime({} as DB, "user", "run", "model").generate(
      "synthesize",
      {
        ...input([evidence("source", "TCP")]),
        goal: "20000字",
        claims: depthClaims(2),
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("every supplied claim exactly once");
  expect(
    fixture.stream.mock.calls.every(([options]) =>
      ["plan", "assign"].includes(
        JSON.parse(options.prompt[1].content[0].text).writingScope,
      ),
    ),
  ).toBe(true);
});

it("subdivides incomplete assignments and restores original IDs across reused local aliases", async () => {
  const sizes: number[] = [];
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.writingScope === "plan")
      return response(
        JSON.stringify({
          chapters: [
            {
              title: "TCP",
              path: [],
              sections: [{ id: "seq", title: "Sequence", objective: "Derive" }],
            },
          ],
        }),
      );
    if (data.writingScope === "assign") {
      sizes.push(data.claims.length);
      if (options.prompt.length > 2)
        expect(options.prompt.at(-1).content[0].text).toContain(
          "Repair only this assignment JSON",
        );
      return response(
        JSON.stringify({
          assignments: [{ sectionId: "seq", claimIds: ["c0"] }],
        }),
      );
    }
    return response(
      JSON.stringify({
        pages: [
          {
            id: "case",
            title: data.fixedChapter.title,
            path: data.fixedChapter.path,
            paragraphs: data.claims.map((claim: any, index: number) => ({
              id: `p${index}`,
              markdown: "## Sequence\n\n" + "Supported detail. ".repeat(560),
              claimIds: [claim.id],
              reason: "Source",
            })),
          },
        ],
      }),
    );
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "synthesize",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims: depthClaims(2),
    },
    new AbortController().signal,
  );
  expect(sizes).toEqual([2, 2, 1, 1]);
  expect(
    output.pages[0].paragraphs.flatMap((paragraph: any) => paragraph.claimIds),
  ).toEqual(["fact0", "fact1"]);
  expect(fixture.access).toHaveBeenCalledTimes(6);
});

it("allocates comparable depth budgets to chapters with unequal section counts", async () => {
  const targets: Record<string, number[]> = {};
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.writingScope === "plan")
      return response(
        JSON.stringify({
          chapters: [
            {
              title: "Many sections",
              path: [],
              sections: [
                { id: "a", title: "Sequence", objective: "Derive" },
                { id: "b", title: "Recovery", objective: "Work a case" },
              ],
            },
            {
              title: "One section",
              path: [],
              sections: [{ id: "c", title: "Window", objective: "Diagnose" }],
            },
          ],
        }),
      );
    if (data.writingScope === "assign")
      return response(
        JSON.stringify({
          assignments: [
            { sectionId: "a", claimIds: ["c0"] },
            { sectionId: "b", claimIds: ["c1"] },
            { sectionId: "c", claimIds: ["c2"] },
          ],
        }),
      );
    (targets[data.fixedChapter.title] ??= []).push(data.batchCharacterTarget);
    return depthPage(data);
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "synthesize",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims: depthClaims(3),
    },
    new AbortController().signal,
  );
  expect(targets).toEqual({
    "Many sections": [5000, 5000],
    "One section": [10000],
  });
  expect(result.pages).toHaveLength(2);
});

it("bounds every assignment request and resolves aliases across batches without losing claims", async () => {
  const sizes: number[] = [];
  const claims = depthClaims(65);
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.writingScope === "plan") {
      expect(data.claims).toHaveLength(3);
      return response(
        JSON.stringify({
          chapters: [
            {
              title: "TCP",
              path: [],
              sections: [
                { id: "seq", title: "Sequence", objective: "Derive" },
                { id: "rec", title: "Recovery", objective: "Work a case" },
              ],
            },
          ],
        }),
      );
    }
    if (data.writingScope === "assign") {
      sizes.push(data.claims.length);
      const groups = new Map<string, string[]>();
      for (const c of data.claims) {
        const id = Number(c.statement.split(" ")[1]) < 32 ? "seq" : "rec";
        groups.set(id, [...(groups.get(id) ?? []), c.id]);
      }
      return response(
        JSON.stringify({
          assignments: [...groups].map(([sectionId, claimIds]) => ({
            sectionId,
            claimIds,
          })),
        }),
      );
    }
    return depthPage(data);
  });
  const result: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "synthesize",
    { ...input([evidence("source", "TCP")]), goal: "20000字", claims },
    new AbortController().signal,
  );
  expect(sizes.sort((a, b) => a - b)).toEqual([1, 32, 32]);
  expect(result.pages).toHaveLength(1);
  expect(
    new Set(result.pages[0].paragraphs.flatMap((p: any) => p.claimIds)),
  ).toEqual(new Set(claims.map((c) => c.id)));
});
it("keeps a long chapter intact during bounded acceptance and reports whole chapter coverage", async () => {
  const claims = Array.from({ length: 60 }, (_, index) => ({
    id: `fact${index}`,
    statement: `Fact ${index}`,
    evidenceIds: ["source"],
    evidenceQuotes: [{ evidenceId: "source", quote: "TCP" }],
    reason: "Source",
    confidence: 1,
  }));
  const pages = [0, 1].map((index) => ({
    id: `page${index}`,
    title: `Chapter ${index}`,
    path: [],
    paragraphs: [
      {
        id: `p${index}`,
        markdown:
          "## Worked case\n\n" + "Supported causal derivation. ".repeat(600),
        claimIds: claims.slice(index * 30, index * 30 + 30).map((c) => c.id),
        reason: "Source",
      },
    ],
  }));
  let batches = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (data.acceptanceScope === "trace") {
      batches++;
      expect(data.pages).toHaveLength(1);
      expect(data.inspectionCoverage[0].completeChapter).toBe(true);
      expect(data.pages[0].paragraphs[0].markdown.length).toBeGreaterThan(
        16000,
      );
    }
    if (data.acceptanceScope === "trace")
      return tracedAcceptance(
        data,
        true,
        "Concrete derivation and observed diagnostic chain",
      );
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "depth",
            passed: true,
            reason: "Concrete derivation and observed diagnostic chain",
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
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      claims,
      pages,
      criteria: [
        {
          id: "depth",
          required: true,
          description: "Complete worked cases in each chapter",
        },
      ],
    },
    new AbortController().signal,
  );
  expect(batches).toBe(2);
  expect(result.checks[0].passed).toBe(true);
});

it("keeps fragment obligations local and retains source context and chapter case observations through aggregation", async () => {
  const items = [
    evidence("source", "Field definition"),
    { ...evidence("context", "Receiving algorithm"), sourceId: "source" },
    evidence("unrelated", "Another protocol"),
  ];
  const claims = depthClaims(1);
  const pages = [
    {
      id: "chapter",
      title: "TCP case",
      path: [],
      paragraphs: Array.from({ length: 13 }, (_, index) => ({
        id: `p${index}`,
        markdown:
          "## Teaching simulation\n\n" + "Causal derivation. ".repeat(330),
        claimIds: ["fact0"],
        reason: "Source",
      })),
    },
  ];
  let inspected = 0,
    merged = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (data.acceptanceScope === "trace") {
      inspected++;
      expect(data.inspectionCoverage[0].completeChapter).toBe(false);
      expect(data.evidence.map((item: any) => item.text)).toEqual([
        "Field definition",
        "Receiving algorithm",
      ]);
      expect(data.originalCriteria[0].description).toBe(
        "One complete case per chapter",
      );
      expect(options.prompt[0].content).toContain(
        "need not appear literally in a source example",
      );
      expect(options.prompt[0].content).toContain(
        "Never require a separate complete case or diagnostic for every mechanism or fragment",
      );
    }
    if (data.acceptanceScope === "merge") {
      merged++;
      expect(data.goal).not.toContain("20000");
      expect(data.reviewCoverage).toEqual({
        wholeBook: false,
        chapters: ["TCP case"],
      });
      expect(data.reviewObligation.description).toBe(
        "One complete case per chapter",
      );
      expect(data.criteria[0].description).toContain(
        "Absence of other chapter groups is deferred",
      );
      expect(data.batchReviews.length).toBeLessThanOrEqual(12);
      expect(
        data.batchReviews.every(
          (review: any) => review.chapters.join() === "TCP case",
        ),
      ).toBe(true);
      expect(data.batchReviews[0].reason.length).toBeGreaterThan(600);
    }
    if (data.acceptanceScope === "summary") {
      expect(data.goal).toBe("20000字");
      expect(data.criteria[0].description).toBe(
        "One complete case per chapter",
      );
      expect(data.batchReviews).toHaveLength(2);
      expect(
        data.batchReviews.every(
          (review: any) => review.chapters.join() === "TCP case",
        ),
      ).toBe(true);
    }
    if (data.acceptanceScope === "trace")
      return tracedAcceptance(
        data,
        true,
        "Initial state, calculated transitions and diagnostic observations. ".repeat(
          15,
        ),
      );
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "depth",
            passed: true,
            reason:
              "Initial state, calculated transitions and diagnostic observations. ".repeat(
                15,
              ),
          },
        ],
      }),
    );
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input(items),
      goal: "20000字",
      claims,
      pages,
      criteria: [
        {
          id: "depth",
          description: "One complete case per chapter",
          required: true,
        },
      ],
    },
    new AbortController().signal,
  );
  expect(inspected).toBe(13);
  expect(merged).toBe(2);
  expect(output.checks[0].passed).toBe(true);
});

it("retains later failed chapter scopes in bounded repair diagnostics", async () => {
  const pages = Array.from({ length: 3 }, (_, index) => ({
    id: `page_${String(index).repeat(32)}`,
    title: `Chapter ${index}`,
    path: [],
    paragraphs: [
      {
        id: `p${index}`,
        markdown: "Actual case. ".repeat(400),
        claimIds: ["fact0"],
        reason: "Source",
      },
    ],
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    expect(data.acceptanceScope).toBe("trace");
    return tracedAcceptance(data, false, "Incorrect transition. ".repeat(35));
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      pages,
      claims: depthClaims(1),
      criteria: [
        {
          id: "facts",
          description: "Correct state transitions",
          required: true,
        },
      ],
    },
    new AbortController().signal,
  );
  expect(output.checks[0].passed).toBe(false);
  expect(output.checks[0].reason.length).toBeLessThanOrEqual(4000);
  for (const page of pages)
    expect(output.checks[0].reason).toContain(page.id.slice(0, 15));
  expect(output.checks[0].reason).toContain("Incorrect transition");
});

it("bounds final review payloads when there are more than twelve complete chapters", async () => {
  const pages = Array.from({ length: 13 }, (_, index) => ({
    id: `page${index}`,
    title: `Chapter ${index}`,
    path: [],
    paragraphs: [
      {
        id: `p${index}`,
        markdown: "Supported mechanism. ".repeat(100),
        claimIds: ["fact0"],
        reason: "Source",
      },
    ],
  }));
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    if (data.acceptanceScope === "plan") return plannedAcceptance(data);
    if (["merge", "summary"].includes(data.acceptanceScope))
      expect(data.batchReviews.length).toBeLessThanOrEqual(12);
    if (data.acceptanceScope === "summary")
      expect(
        new Set(data.batchReviews.flatMap((review: any) => review.chapters)),
      ).toEqual(new Set(pages.map((page) => page.title)));
    if (data.acceptanceScope === "trace") return tracedAcceptance(data);
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "facts",
            passed: true,
            reason: "Observed mechanism and boundaries",
          },
        ],
      }),
    );
  });
  const output: any = await knowledgeBookRuntime(
    {} as DB,
    "user",
    "run",
    "model",
  ).generate(
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      goal: "20000字",
      pages,
      claims: depthClaims(1),
      criteria: [
        { id: "facts", description: "Correct mechanisms", required: true },
      ],
    },
    new AbortController().signal,
  );
  expect(output.checks[0].passed).toBe(true);
});

it("expands a short but valid complete section before subdividing its related claims", async () => {
  let calls = 0;
  fixture.stream.mockImplementation(async (options) => {
    const data = JSON.parse(options.prompt[1].content[0].text);
    expect(data.claims).toHaveLength(2);
    expect(data.batchCharacterTarget).toBe(2000);
    if (calls)
      expect(options.prompt.at(-1).content[0].text).toContain(
        "complete updated output for the same supplied scope",
      );
    const repetitions = calls++ ? 45 : 30;
    return response(
      JSON.stringify({
        pages: [
          {
            id: "case",
            title: "Complete case",
            path: [],
            paragraphs: data.claims.map((c: any, index: number) => ({
              id: `p${index}`,
              markdown:
                "## Causal case\n\n" +
                "Supported causal detail. ".repeat(repetitions),
              claimIds: [c.id],
              reason: "Source",
            })),
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
    "synthesize",
    {
      ...input([evidence("source", "TCP")]),
      goal: "2000字",
      claims: depthClaims(2),
    },
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0].paragraphs).toHaveLength(2);
});

it.each([
  { characters: 1600, retained: true },
  { characters: 1200, retained: false },
])(
  "limits indivisible quota tolerance to the final repair ($characters characters)",
  async ({ characters, retained }) => {
    let calls = 0;
    fixture.stream.mockImplementation(async (options) => {
      const data = JSON.parse(options.prompt[1].content[0].text);
      expect(data.claims).toHaveLength(1);
      expect(data.batchCharacterTarget).toBe(2000);
      calls++;
      return response(
        JSON.stringify({
          pages: [
            {
              id: "case",
              title: "Indivisible case",
              path: [],
              paragraphs: [
                {
                  id: "p",
                  markdown: "Supported detail. ".repeat(
                    Math.floor(characters / 18),
                  ),
                  claimIds: [data.claims[0].id],
                  reason: "Source",
                },
              ],
            },
          ],
        }),
      );
    });
    const result = knowledgeBookRuntime(
      {} as DB,
      "user",
      "run",
      "model",
    ).generate(
      "synthesize",
      {
        ...input([evidence("source", "TCP")]),
        goal: "2000字",
        claims: depthClaims(1),
      },
      new AbortController().signal,
    );
    if (retained) {
      const output: any = await result;
      expect(output.pages[0].paragraphs[0].markdown.length).toBeLessThan(1800);
      expect(output.pages[0].paragraphs[0].claimIds).toEqual(["fact0"]);
      expect(output.pages[0].paragraphs[0].markdown).not.toContain("padding");
    } else
      await expect(result).rejects.toThrow(
        "below its allocated writing target",
      );
    expect(calls).toBe(3);
  },
);

it("repairs acceptance IDs without converting a factual rejection into a pass", async () => {
  let calls = 0;
  fixture.stream.mockImplementation(async (options) => {
    if (calls++ === 0) return response(JSON.stringify({ checks: [] }));
    expect(options.prompt.at(-1).content[0].text).toContain(
      "Repair only this acceptance JSON",
    );
    expect(options.prompt.at(-1).content[0].text).toContain(
      'Expected IDs: ["grounded"]',
    );
    expect(options.prompt.at(-1).content[0].text).toContain(
      "do not change a failed verdict",
    );
    return response(
      JSON.stringify({
        checks: [
          {
            criterionId: "grounded",
            passed: false,
            reason: "Protocol mismatch",
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
    "acceptance",
    {
      ...input([evidence("source", "TCP")]),
      claims: depthClaims(1),
      pages: [],
      criteria: [
        {
          id: "grounded",
          required: true,
          description: "Source-supported protocol behavior",
        },
      ],
    },
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(result.checks[0]).toEqual({
    criterionId: "grounded",
    passed: false,
    reason: "Protocol mismatch",
  });
});
