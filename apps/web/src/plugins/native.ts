import type {
  PluginNativeCapabilities,
  NativeOperation,
} from "@smartdoca/plugin-sdk/native";
export function nativeCapabilities(
  pluginId: string,
): PluginNativeCapabilities | null {
  const bridge = (
    window as unknown as {
      ReactNativeWebView?: { postMessage(value: string): void };
    }
  ).ReactNativeWebView;
  if (!bridge || !location.hash.startsWith(`#/m/plugins/${pluginId}/`))
    return null;
  function call<T>(operation: NativeOperation, input: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("doca-native-response", listener);
        window.removeEventListener("pagehide", cancel);
      };
      const listener = (event: Event) => {
        const response = (event as CustomEvent).detail;
        if (
          response?.id !== id ||
          response?.pluginId !== pluginId ||
          response?.version !== 1
        )
          return;
        cleanup();
        if (response.error) reject(new Error(String(response.error)));
        else resolve(response.result as T);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Native request canceled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Native request timed out"));
      }, 120000);
      window.addEventListener("doca-native-response", listener);
      window.addEventListener("pagehide", cancel, { once: true });
      try {
        bridge!.postMessage(
          JSON.stringify({ version: 1, id, pluginId, operation, input }),
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  return {
    ai: { open: (assistant = {}) => call("assistant.open", { assistant }) },
    storage: {
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      clear: () => call("storage.clear", {}),
    },
    attachments: {
      save: (input) => call("attachment.save", input),
      share: (input) => call("attachment.share", input),
    },
  };
}
