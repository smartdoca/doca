import { beforeEach, expect, it, vi } from "vitest";
import {
  createPluginAssistantClient,
  validateAssistantOpenInput,
  type AssistantLaunchDraft,
} from "@smartdoca/plugin-sdk/web";
import { validateNativeRequest } from "@smartdoca/plugin-sdk/native";
import {
  assistantDraft,
  consumeAssistantDraft,
  publishAssistantDraft,
} from "../apps/web/src/features/ai/ai-launch.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { path: string; body: any }[] = [];
  const request = vi.fn(async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body });
    if (Object.hasOwn(overrides, path)) {
      const value = overrides[path];
      if (value instanceof Error) throw value;
      return value as T;
    }
    if (path.endsWith("/users.me")) return { id: "user-a" } as T;
    if (path === "/ai/options")
      return {
        defaultModel: "model",
        preferences: {},
        models: [{ id: "model" }],
        webSearchAvailable: false,
      } as T;
    if (path.endsWith("/documents.get"))
      return {
        id: documentId,
        kind: "document",
        title: "Report",
        format: "markdown",
      } as T;
    if (path.endsWith("/files.files.get"))
      return { id: fileId, name: "a.png", size: 100 } as T;
    if (path.endsWith("/attach"))
      return {
        id: assetId,
        filename: "a.png",
        mime: "image/png",
        size: 100,
        extractStatus: "ready",
      } as T;
    if (path === "/ai/sessions")
      return { id: sessionId, model_id: "model" } as T;
    if (path === `/ai/sessions/${sessionId}`)
      return {
        session: { id: sessionId, model_id: "model", archived: 0 },
      } as T;
    if (path.endsWith("/messages")) return { ok: true } as T;
    throw Error(`Unexpected request: ${path}`);
  });
  const present = vi.fn();
  const client = createPluginAssistantClient(
    "example.mail",
    async <T>(path: string, body?: unknown) => (await request(path, body)) as T,
    present,
    () => jobId,
  );
  return { client, calls, present, request };
}
beforeEach(() => publishAssistantDraft(null));

it("opens a fresh editable draft with authorized document labels and copied attachments, without sending", async () => {
  const f = fixture();
  expect(
    await f.client.open({
      prompt: "Summarize",
      context: "Email body",
      documentIds: [documentId],
      attachmentFileIds: [fileId],
    }),
  ).toEqual({ sessionId });
  expect(
    f.calls.find((call) => call.path === "/ai/sessions")?.body.resourceIds,
  ).toEqual([documentId]);
  expect(f.calls.some((call) => call.path.endsWith("/messages"))).toBe(false);
  expect(f.present).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "user-a",
      text: "Summarize\n\nEmail body",
      sessionId,
      references: [
        { resourceId: documentId, label: "Report", format: "markdown" },
      ],
      attachments: [
        expect.objectContaining({ id: assetId, sourceFileId: fileId }),
      ],
    }),
    { sessionId },
  );
});

it("sends once only when autoSend is explicit and keeps ordinary approval behavior", async () => {
  const f = fixture();
  expect(
    await f.client.open({
      prompt: "Summarize",
      documentIds: [documentId],
      attachmentFileIds: [fileId],
      autoSend: true,
    }),
  ).toEqual({ sessionId, jobId });
  const sent = f.calls.filter((call) => call.path.endsWith("/messages"));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({
    id: jobId,
    text: "Summarize",
    attachments: [assetId],
    modelId: "model",
    scope: "all",
  });
  expect(sent[0]!.body).not.toHaveProperty("skipApprovals");
  expect(f.present).toHaveBeenCalledWith(null, { sessionId, jobId });
});

it("uses an owned existing conversation and preserves its history", async () => {
  const f = fixture();
  await f.client.open({ sessionId, prompt: "Continue" });
  expect(f.calls.some((call) => call.path === "/ai/sessions")).toBe(false);
  expect(f.calls.some((call) => call.path.includes("/messages"))).toBe(false);
});

it.each([
  `/plugin-platform/example.mail/users.me`,
  `/plugin-platform/example.mail/documents.get`,
  `/plugin-platform/example.mail/files.files.get`,
])(
  "propagates authorization denial at %s before creating a session or sending",
  async (path) => {
    const f = fixture({
      [path]: Object.assign(new Error("Denied"), { status: 403 }),
    });
    await expect(
      f.client.open({
        prompt: "Summarize",
        documentIds: [documentId],
        attachmentFileIds: [fileId],
        autoSend: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      f.calls.some(
        (call) =>
          call.path === "/ai/sessions" ||
          call.path.endsWith("/messages") ||
          call.path.endsWith("/attach"),
      ),
    ).toBe(false);
    expect(f.present).not.toHaveBeenCalled();
  },
);

it.each([new Error("Not owned"), { session: { id: sessionId, archived: 1 } }])(
  "rejects an unavailable or archived conversation",
  async (value) => {
    const f = fixture({ [`/ai/sessions/${sessionId}`]: value });
    await expect(
      f.client.open({ sessionId, prompt: "Continue", autoSend: true }),
    ).rejects.toThrow();
    expect(
      f.calls.some(
        (call) =>
          call.path === "/ai/sessions" || call.path.endsWith("/messages"),
      ),
    ).toBe(false);
  },
);

it("rejects oversized attachments before copying files", async () => {
  const f = fixture({
    "/plugin-platform/example.mail/files.files.get": {
      id: fileId,
      size: 26 * 1024 * 1024,
    },
  });
  await expect(f.client.open({ attachmentFileIds: [fileId] })).rejects.toThrow(
    /size limit/,
  );
  expect(f.calls.some((call) => call.path.endsWith("/attach"))).toBe(false);
});

it("keeps pending extraction in drafts and refuses premature auto-send", async () => {
  const f = fixture({
    [`/files/items/${fileId}/attach`]: {
      id: assetId,
      size: 100,
      extractStatus: "pending",
    },
  });
  await f.client.open({ attachmentFileIds: [fileId] });
  expect(f.present.mock.calls[0]![0].attachments[0].extractStatus).toBe(
    "pending",
  );
  f.calls.length = 0;
  await expect(
    f.client.open({
      prompt: "Analyze",
      attachmentFileIds: [fileId],
      autoSend: true,
    }),
  ).rejects.toThrow(/parsed/);
  expect(f.calls.some((call) => call.path.endsWith("/messages"))).toBe(false);
});

it("propagates message failure without presenting a false success and allows a later launch", async () => {
  const f = fixture({
    [`/ai/sessions/${sessionId}/messages`]: new Error("Offline"),
  });
  await expect(f.client.open({ prompt: "Hi", autoSend: true })).rejects.toThrow(
    "Offline",
  );
  expect(f.present).not.toHaveBeenCalled();
  await expect(f.client.open({ prompt: "Retry as draft" })).resolves.toEqual({
    sessionId,
  });
});

it("rejects repeated launches while authorization is in progress", async () => {
  let release!: (value: { id: string }) => void;
  const f = fixture();
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = f.client.open({ prompt: "Hi" });
  await expect(f.client.open({ prompt: "Hi" })).rejects.toThrow(/in progress/);
  release({ id: "user-a" });
  await first;
  expect(f.present).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  [],
  { systemPrompt: "Override" },
  { prompt: 1 },
  { autoSend: "true" },
  { autoSend: true },
  { sessionId: "../../other" },
  { modelId: "" },
  { documentIds: [documentId, documentId] },
  { attachmentFileIds: Array(9).fill(fileId) },
  { prompt: "x".repeat(15_000), context: "x".repeat(6_000) },
])("rejects invalid launch parameters %j", (input) => {
  expect(() => validateAssistantOpenInput(input)).toThrow();
});

it("accepts the scoped native operation and refuses forged identity and unknown fields", () => {
  const request = {
    version: 1,
    id: "request-1",
    pluginId: "example.mail",
    operation: "assistant.open",
    input: { assistant: { prompt: "Hello" } },
  };
  expect(validateNativeRequest(request, "example.mail")).toEqual(request);
  expect(() => validateNativeRequest(request, "other.plugin")).toThrow();
  expect(() =>
    validateNativeRequest(
      { ...request, input: { assistant: { prompt: "Hi", userId: "another" } } },
      "example.mail",
    ),
  ).toThrow();
  expect(() =>
    validateNativeRequest(
      { ...request, input: { assistant: {}, token: "secret" } },
      "example.mail",
    ),
  ).toThrow();
});

it("transfers drafts only to their account and target conversation and consumes each once", () => {
  const draft: AssistantLaunchDraft = {
    userId: "user-a",
    sessionId,
    text: "Private",
    modelId: "model",
    references: [],
    attachments: [],
  };
  publishAssistantDraft(draft);
  expect(assistantDraft("user-b", sessionId)).toBeNull();
  expect(assistantDraft("user-a", jobId)).toBeNull();
  expect(assistantDraft("user-a", sessionId)).toBe(draft);
  consumeAssistantDraft(draft);
  expect(assistantDraft("user-a", sessionId)).toBeNull();
});
