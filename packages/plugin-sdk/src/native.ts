/** Explicitly available only inside the authenticated native plugin container. */
import { validateAssistantOpenInput, type PluginAssistantClient, type PluginAssistantOpenInput } from "./assistant.js";
export interface PluginNativeCapabilities {
  readonly ai: PluginAssistantClient;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    clear(): Promise<void>;
  };
  attachments: {
    save(input: {
      path: string;
      name: string;
      mime: string;
    }): Promise<{ status: "completed" | "canceled" | "presented" }>;
    share(input: {
      path: string;
      name: string;
      mime: string;
    }): Promise<{ status: "completed" | "canceled" | "presented" }>;
  };
}
export type NativeOperation =
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.clear"
  | "attachment.save"
  | "attachment.share"
  | "assistant.open";
export interface PluginNativeRequest {
  version: 1;
  id: string;
  pluginId: string;
  operation: NativeOperation;
  input: {
    key?: string;
    value?: string;
    path?: string;
    name?: string;
    mime?: string;
    assistant?: PluginAssistantOpenInput;
  };
}
export function validateNativeRequest(
  value: unknown,
  pluginId: string,
): PluginNativeRequest {
  const request = value as PluginNativeRequest;
  if (
    !request ||
    request.version !== 1 ||
    request.pluginId !== pluginId ||
    typeof request.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(request.id) ||
    !request.input ||
    typeof request.input !== "object"
  )
    throw new Error("Invalid native request");
  if (
    ![
      "storage.get",
      "storage.set",
      "storage.remove",
      "storage.clear",
      "attachment.save",
      "attachment.share",
      "assistant.open",
    ].includes(request.operation)
  )
    throw new Error("Unsupported native operation");
  if (request.operation === "assistant.open") {
    if (Object.keys(request.input).some(key => key !== "assistant"))
      throw new Error("Invalid native assistant input");
    validateAssistantOpenInput(request.input.assistant);
  }
  if (
    ["storage.get", "storage.set", "storage.remove"].includes(
      request.operation,
    ) &&
    (typeof request.input.key !== "string" ||
      !request.input.key ||
      request.input.key.length > 200)
  )
    throw new Error("Invalid storage key");
  if (
    request.operation === "storage.set" &&
    (typeof request.input.value !== "string" ||
      request.input.value.length > 2_000_000)
  )
    throw new Error("Storage value exceeds limit");
  if (request.operation.startsWith("attachment.")) {
    const { path, name, mime } = request.input;
    if (
      typeof path !== "string" ||
      path.length > 4000 ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\x00-\x20#]/.test(path) ||
      /%2e|%2f|%5c|%25/i.test(path) ||
      path.split(/[/?]/).includes("..") ||
      path.split(/[/?]/).includes(".")
    )
      throw new Error("Invalid attachment path");
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 200 ||
      /[\\/\x00-\x1f]/.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new Error("Invalid attachment name");
    if (typeof mime !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mime))
      throw new Error("Invalid attachment MIME type");
  }
  return request;
}
