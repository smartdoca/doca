import {
  ExtensionViewController,
  type OpenExtensionView,
} from "@smartdoca/web-plugin-registry";
import { webPluginRegistry } from "./registry.js";
export const extensionViews = new ExtensionViewController((id) =>
  webPluginRegistry.views.get(id),
);
/** Transfer a menu's context to the host panel's navigation lifetime. */
export function openExtensionView(pluginId: string, input: OpenExtensionView) {
  input.context.signal.throwIfAborted();
  const controller = new AbortController();
  const leave = () => controller.abort();
  window.addEventListener("hashchange", leave, { once: true });
  let handle: { close(): void };
  try {
    handle = extensionViews.open(pluginId, {
      ...input,
      context: { ...input.context, signal: controller.signal },
    });
  } catch (error) {
    window.removeEventListener("hashchange", leave);
    throw error;
  }
  const panel = extensionViews.snapshot();
  panel?.signal.addEventListener(
    "abort",
    () => {
      window.removeEventListener("hashchange", leave);
      controller.abort();
    },
    { once: true },
  );
  return handle;
}
