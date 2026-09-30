import { nativeCapabilities } from "./native.js";
import * as React from "react";
import { FolderFilePicker } from "@web/features/files/files.js";
import { notifyFeedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import type { PluginWebHost } from "@smartdoca/plugin-sdk/web";

export function createWebHost(
  pluginId: string,
): PluginWebHost<typeof React, typeof FolderFilePicker> {
  const apiBase = `/api/v1/plugins/${pluginId}`;
  return Object.freeze({
    React,
    apiBase,
    get native() {
      return nativeCapabilities(pluginId);
    },
    FilePicker: FolderFilePicker,
    useEnvironment() {
      const { locale } = useI18n();
      const theme = React.useSyncExternalStore(
        (listener) => {
          const observer = new MutationObserver(listener);
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
          });
          return () => observer.disconnect();
        },
        () =>
          document.documentElement.dataset.theme === "soft"
            ? ("soft" as const)
            : ("light" as const),
      );
      return {
        locale,
        theme,
        target: location.hash.startsWith("#/m/plugins/")
          ? ("mobile" as const)
          : ("web" as const),
      };
    },
    navigate(path: string) {
      const url = new URL(path, location.origin);
      if (
        url.origin !== location.origin ||
        !path.startsWith("/") ||
        path.startsWith("//")
      )
        throw new Error("Navigation must use a local path");
      if (location.hash.startsWith("#/m/plugins/")) {
        if (!path.startsWith(`/plugins/${pluginId}/`))
          throw new Error("Mobile navigation must stay within the plugin");
        location.hash = `/m${path}`;
      } else location.hash = path;
    },
    toast: notifyFeedback,
    async confirm(message: string) {
      return window.confirm(message);
    },
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (
        !path.startsWith("/") ||
        /[\\\\]/.test(path) ||
        path.split(/[/?#]/).includes("..") ||
        /%2e|%2f|%5c/i.test(path)
      )
        throw new Error("Invalid plugin API path");
      const response = await fetch(apiBase + path, {
        ...init,
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw Object.assign(new Error(body?.message ?? response.statusText), {
          status: response.status,
          requestId: body?.requestId,
        });
      return body as T;
    },
  });
}

class PluginBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function Fallback() {
  const { t } = useI18n();
  return <div role="alert">{t("plugin.renderFailed")}</div>;
}
function RenderContribution({
  render,
  args,
}: {
  render: (...args: any[]) => React.ReactNode;
  args: any[];
}) {
  return render(...args);
}
/** Invoke render inside React so both synchronous and descendant errors are contained. */
export function isolatePluginBundle<T extends Record<string, any>>(
  bundle: T,
): T {
  const result = { ...bundle } as Record<string, any>;
  for (const key of [
    "routes",
    "adminPanels",
    "settingsFields",
    "aiBlocks",
    "searchResults",
    "knowledgeSources",
    "filePickers",
  ]) {
    if (!Array.isArray(bundle[key])) continue;
    result[key] = bundle[key].map((item: any) => ({
      ...item,
      render: (...args: any[]) => (
        <PluginBoundary key={item.id} fallback={<Fallback />}>
          <RenderContribution render={item.render} args={args} />
        </PluginBoundary>
      ),
    }));
  }
  return result as T;
}
