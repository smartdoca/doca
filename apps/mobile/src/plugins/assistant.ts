import {
  createPluginAssistantClient,
  type AssistantLaunchDraft,
  type PluginAssistantOpenResult,
} from "@smartdoca/plugin-sdk/web";
import { validateNativeRequest } from "@smartdoca/plugin-sdk/native";
import { loadSession, type Session } from "../session";
import { uuid } from "../api";

export async function preparePluginAssistant(
  value: unknown,
  account: Session,
  pluginId: string,
  signal: AbortSignal,
) {
  const request = validateNativeRequest(value, pluginId);
  if (request.operation !== "assistant.open")
    throw new Error("Invalid assistant operation");
  async function authorized() {
    signal.throwIfAborted();
    const current = await loadSession();
    if (current?.origin !== account.origin || current.token !== account.token)
      throw new Error("Native session changed");
  }
  let launch:
    | { draft: AssistantLaunchDraft | null; result: PluginAssistantOpenResult }
    | undefined;
  const assistant = createPluginAssistantClient(
    pluginId,
    async <T>(path: string, body?: unknown): Promise<T> => {
      await authorized();
      const response = await fetch(`${account.origin}/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: {
          Authorization: `Bearer ${account.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data?.message ?? `Assistant request failed (${response.status})`,
        );
      await authorized();
      return data as T;
    },
    (draft, result) => {
      launch = { draft, result };
    },
    uuid,
  );
  await assistant.open(request.input.assistant);
  await authorized();
  return launch!;
}
