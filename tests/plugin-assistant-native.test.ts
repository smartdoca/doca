import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { preparePluginAssistant } from "../apps/mobile/src/plugins/assistant.js";
import {
  publishAssistantDraft,
  consumeAssistantDraft,
} from "../apps/mobile/src/ai-launch.js";
import type { AssistantLaunchDraft } from "@smartdoca/plugin-sdk/web";

const account = {
  origin: "https://doca.example.test",
  token: "native-only-token",
  name: "User",
};
const sessionId = "33333333-3333-4333-8333-333333333333";
const current = vi.hoisted(() => ({
  account: null as { origin: string; token: string; name: string } | null,
}));
vi.mock("../apps/mobile/src/session", () => ({
  loadSession: async () => current.account,
  removeAccount: vi.fn(),
}));
const request = {
  version: 1,
  id: "launch-1",
  pluginId: "example.mail",
  operation: "assistant.open",
  input: { assistant: { prompt: "Private context" } },
};

beforeEach(() => {
  current.account = account;
  publishAssistantDraft(account, "", null);
});
afterEach(() => vi.unstubAllGlobals());

it("uses native credentials for authorized preparation without putting them in launch data", async () => {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("/users.me")
        ? { id: "user" }
        : url.endsWith("/ai/options")
          ? {
              defaultModel: "model",
              models: [{ id: "model" }],
              webSearchAvailable: false,
            }
          : { id: sessionId },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const launch = await preparePluginAssistant(
    request,
    account,
    "example.mail",
    new AbortController().signal,
  );
  expect(launch.result).toEqual({ sessionId });
  expect(launch.draft?.text).toBe("Private context");
  expect(JSON.stringify(launch)).not.toContain(account.token);
  for (const [url, options] of fetcher.mock.calls as unknown as [
    string,
    RequestInit,
  ][]) {
    expect(url.startsWith(account.origin + "/api/v1/")).toBe(true);
    expect(options.headers).toMatchObject({
      Authorization: `Bearer ${account.token}`,
    });
  }
});

it("cancels before network activity after account switching or plugin-page disposal", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  current.account = { ...account, token: "changed" };
  await expect(
    preparePluginAssistant(
      request,
      account,
      "example.mail",
      new AbortController().signal,
    ),
  ).rejects.toThrow(/session changed/);
  current.account = account;
  await expect(
    preparePluginAssistant(
      request,
      account,
      "example.mail",
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses to navigate if the account changes while a host response is in flight", async () => {
  vi.stubGlobal("fetch", async () => {
    current.account = { ...account, token: "changed" };
    return Response.json({ id: "user" });
  });
  await expect(
    preparePluginAssistant(
      request,
      account,
      "example.mail",
      new AbortController().signal,
    ),
  ).rejects.toThrow(/session changed/);
});

it("consumes native drafts once and refuses a different origin, token, launch key or conversation", () => {
  const draft: AssistantLaunchDraft = {
    userId: "user",
    sessionId,
    text: "Private",
    modelId: "model",
    references: [],
    attachments: [],
  };
  publishAssistantDraft(account, "launch-1", draft);
  expect(
    consumeAssistantDraft(
      { ...account, token: "other" },
      "launch-1",
      sessionId,
    ),
  ).toBeNull();
  expect(
    consumeAssistantDraft(
      { ...account, origin: "https://other.example.test" },
      "launch-1",
      sessionId,
    ),
  ).toBeNull();
  expect(consumeAssistantDraft(account, "launch-2", sessionId)).toBeNull();
  expect(
    consumeAssistantDraft(account, "launch-1", "other-session"),
  ).toBeNull();
  expect(consumeAssistantDraft(account, "launch-1", sessionId)).toBe(draft);
  expect(consumeAssistantDraft(account, "launch-1", sessionId)).toBeNull();
});
