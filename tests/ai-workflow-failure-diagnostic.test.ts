import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { workflowFailureDiagnostic } from "../apps/server/src/services/ai/workflow-failure-diagnostic.js";

it("logs the true error class and local frames without provider messages, bodies, headers, URLs or custom accessors", () => {
  const secret = "sk-private-test-secret";
  const error = new TypeError(
    `Provider body: ${secret}; Authorization: Bearer ${secret}`,
  );
  error.stack = [
    `TypeError: Provider body: ${secret}; Authorization: Bearer ${secret}`,
    `responseBody={"secret":"${secret}","request":"private instruction"}`,
    "    at parse (file:///Users/private-owner/doca/apps/server/src/services/ai/model.ts:213:19)",
    "    at stream (/Users/private-owner/doca/node_modules/.pnpm/@mastra+core@1.0.0/node_modules/@mastra/core/dist/agent.js:81:7)",
    `    at remote (https://provider.invalid/node_modules/package/index.js?key=${secret}:12:3)`,
    "    at remote (https://provider.invalid/node_modules/package/index.js:12:3)",
    `    at query (/Users/private-owner/doca/apps/server/src/runner.ts?key=${secret}:12:3)`,
    `    at header Authorization: ${secret}`,
    "    at unrelated (/Users/private-owner/documents/customer.ts:12:3)",
    "    at traversal (/Users/private-owner/doca/apps/server/../../documents/customer.ts:12:3)",
  ].join("\n");
  const accessed = vi.fn(() => {
    throw new Error("must not read");
  });
  Object.defineProperty(error, "name", { get: accessed });
  Object.defineProperty(error, "message", { get: accessed });
  Object.defineProperty(error, "cause", { get: accessed });
  const logged = workflowFailureDiagnostic("fixture-job", "failed", error);
  expect(logged).toEqual({
    jobId: "fixture-job",
    status: "failed",
    errorType: "TypeError",
    stackFrames: [
      "apps/server/src/services/ai/model.ts:213:19",
      "node_modules/.pnpm/@mastra+core@1.0.0/node_modules/@mastra/core/dist/agent.js:81:7",
    ],
  });
  expect(JSON.stringify(logged)).not.toContain(secret);
  expect(JSON.stringify(logged)).not.toMatch(
    /responseBody|Authorization|private-owner|provider\.invalid|private instruction/,
  );
  expect(accessed).not.toHaveBeenCalled();
  expect(
    workflowFailureDiagnostic("fixture-job", "failed", {
      message: secret,
      stack: error.stack,
    }),
  ).toEqual({
    jobId: "fixture-job",
    status: "failed",
    errorType: "object",
    stackFrames: [],
  });
});

it("records only validated own-data SDK facts when a response stream loses its socket", async () => {
  const require = createRequire(
    import.meta.resolve("@ai-sdk/openai-compatible"),
  );
  const { APICallError } = await import(require.resolve("@ai-sdk/provider"));
  const secret = "fixture-key-and-private-body";
  const cause = Object.assign(new Error(secret), {
    code: "UND_ERR_SOCKET",
    address: secret,
    socket: { remoteAddress: secret },
  });
  const error = new APICallError({
    message: secret,
    url: `https://provider.invalid/private?key=${secret}`,
    requestBodyValues: { prompt: secret },
    statusCode: 200,
    responseHeaders: { authorization: secret },
    responseBody: secret,
    data: { private: secret },
    cause,
    isRetryable: true,
  });
  error.stack = "";
  const logged = workflowFailureDiagnostic("job", "failed", error);
  expect(logged).toEqual({
    jobId: "job",
    status: "failed",
    errorType: "APICallError",
    stackFrames: [],
    statusCode: 200,
    isRetryable: true,
    transportCode: "UND_ERR_SOCKET",
  });
  expect(JSON.stringify(logged)).not.toMatch(
    /fixture-key|provider\.invalid|authorization|socket|prompt|private/,
  );
});

it.each([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
])(
  "classifies only the fixed transport code %s, independently of retryability",
  (code) => {
    const error = Object.assign(new Error("ignored"), {
      code,
      isRetryable: false,
    });
    error.stack = "";
    expect(workflowFailureDiagnostic("job", "failed", error)).toMatchObject({
      transportCode: code,
      isRetryable: false,
    });
  },
);

it("does not classify retryable HTTP or arbitrary provider/body codes as connection interruption", () => {
  const rateLimited = Object.assign(
    new Error("ECONNRESET appears only in prose"),
    {
      statusCode: 429,
      isRetryable: true,
      code: "provider_rate_limit",
      responseBody: { code: "ECONNRESET" },
    },
  );
  rateLimited.stack = "";
  const logged = workflowFailureDiagnostic("job", "failed", rateLimited);
  expect(logged).toMatchObject({ statusCode: 429, isRetryable: true });
  expect(logged).not.toHaveProperty("transportCode");
  const plainCause = new Error("ignored", { cause: { code: "ECONNRESET" } });
  plainCause.stack = "";
  expect(
    workflowFailureDiagnostic("job", "failed", plainCause),
  ).not.toHaveProperty("transportCode");
  expect(
    workflowFailureDiagnostic("job", "failed", {
      code: "ECONNRESET",
      isRetryable: true,
    }),
  ).not.toHaveProperty("transportCode");
});

it("never invokes accessors for transport facts or follows an accessor cause", () => {
  const error = new Error("private-message");
  error.stack = "";
  const accessed = vi.fn(() => {
    throw new Error("private-getter-result");
  });
  for (const key of [
    "message",
    "cause",
    "code",
    "statusCode",
    "status",
    "isRetryable",
    "url",
    "responseBody",
    "responseHeaders",
  ])
    Object.defineProperty(error, key, { get: accessed });
  expect(workflowFailureDiagnostic("job", "failed", error)).toEqual({
    jobId: "job",
    status: "failed",
    errorType: "Error",
    stackFrames: [],
  });
  const nested = new Error("ignored");
  nested.stack = "";
  for (const key of ["code", "cause", "message"])
    Object.defineProperty(nested, key, { get: accessed });
  const wrapper = new Error("ignored", { cause: nested });
  wrapper.stack = "";
  expect(
    workflowFailureDiagnostic("job", "failed", wrapper),
  ).not.toHaveProperty("transportCode");
  expect(accessed).not.toHaveBeenCalled();
});

it.each([
  { statusCode: "200", isRetryable: "true", code: "ECONNRESET private-key" },
  { statusCode: NaN, isRetryable: 1, code: { code: "ECONNRESET" } },
  { statusCode: Infinity, isRetryable: null, code: "UND_ERR_UNKNOWN" },
  { statusCode: 99, isRetryable: undefined },
  { statusCode: 600 },
  { statusCode: 200.5 },
])("omits malformed or non-allowlisted facts %j", (facts) => {
  const error = Object.assign(new Error("ignored"), facts);
  error.stack = "";
  const logged = workflowFailureDiagnostic("job", "failed", error);
  expect(logged).not.toHaveProperty("statusCode");
  expect(logged).not.toHaveProperty("isRetryable");
  expect(logged).not.toHaveProperty("transportCode");
});

it("bounds own-data cause traversal to three hops and handles cycles", () => {
  const fourth = Object.assign(new Error("ignored"), { code: "ECONNRESET" });
  const third = new Error("ignored", { cause: fourth });
  const second = new Error("ignored", { cause: third });
  const first = new Error("ignored", { cause: second });
  const root = new Error("ignored", { cause: first });
  root.stack = "";
  expect(workflowFailureDiagnostic("job", "failed", root)).not.toHaveProperty(
    "transportCode",
  );
  Object.assign(third, { code: "UND_ERR_BODY_TIMEOUT" });
  expect(workflowFailureDiagnostic("job", "failed", root).transportCode).toBe(
    "UND_ERR_BODY_TIMEOUT",
  );

  const cyclic = Object.assign(new Error("ignored"), { cause: root });
  cyclic.stack = "";
  Object.assign(root, { cause: cyclic });
  expect(workflowFailureDiagnostic("job", "failed", root)).not.toHaveProperty(
    "transportCode",
  );
  Object.assign(cyclic, { code: "EPIPE" });
  expect(workflowFailureDiagnostic("job", "failed", root).transportCode).toBe(
    "EPIPE",
  );
});

it("does not treat inherited transport facts as own error evidence", () => {
  class InheritedError extends Error {}
  Object.assign(InheritedError.prototype, {
    code: "ECONNRESET",
    statusCode: 200,
    status: 409,
    isRetryable: true,
  });
  const error = new InheritedError("ignored");
  error.stack = "";
  const logged = workflowFailureDiagnostic("job", "failed", error);
  expect(logged).not.toHaveProperty("transportCode");
  expect(logged).not.toHaveProperty("statusCode");
  expect(logged).not.toHaveProperty("errorStatus");
  expect(logged).not.toHaveProperty("isRetryable");
});

it.each(["409", NaN, Infinity, 99, 600, 409.5, { status: 409 }])(
  "does not log a malformed own host status %j or classify it as transport evidence",
  (status) => {
    const error = Object.assign(new Error("private body"), { status });
    error.stack = "";
    const logged = workflowFailureDiagnostic("job", "failed", error);
    expect(logged).not.toHaveProperty("errorStatus");
    expect(logged).not.toHaveProperty("transportCode");
  },
);
