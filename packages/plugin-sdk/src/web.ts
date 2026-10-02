import type {
  ResourceType,
  TemplateSelection,
} from "@smartdoca/plugin-contracts";
import type { PluginExtensionUI } from "@smartdoca/web-plugin-registry";
export { createPluginPlatformClient } from "./client.js";
export type { PluginPlatformClient } from "./client.js";
import type { PluginPlatformClient } from "./client.js";
import type { PluginNativeCapabilities } from "./native.js";
export type * from "@smartdoca/web-plugin-registry";
export interface PluginFileReference {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}
export interface PluginFilePickerProps {
  close(): void;
  select?(file: PluginFileReference): void | Promise<void>;
  selectFolder?(folder: { id: string; name: string }): void | Promise<void>;
  accept?(file: PluginFileReference): boolean;
}
export interface PluginTemplatePickerProps {
  close(): void;
  contract: ResourceType;
  contentType?: ResourceType;
  select(selection: TemplateSelection): void | Promise<void>;
  blank?(): void | Promise<void>;
}
export interface PluginMaterialPickerProps {
  close(): void;
  contentType?: ResourceType;
  select(file: PluginFileReference): void | Promise<void>;
  accept?(file: PluginFileReference): boolean;
}
/** Host-injected React is the only supported renderer instance. */
export interface PluginWebHost<
  ReactRuntime = unknown,
  Component = (props: PluginFilePickerProps) => any,
> {
  readonly React: ReactRuntime;
  readonly apiBase: string;
  readonly platform: PluginPlatformClient;
  readonly ui: PluginExtensionUI;
  readonly native: PluginNativeCapabilities | null;
  useEnvironment(): {
    locale: "zh" | "en";
    theme: "light" | "soft";
    target: "web" | "mobile";
  };
  navigate(path: string): void;
  toast(message: string, tone?: "info" | "success" | "warning" | "error"): void;
  confirm(message: string): Promise<boolean>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  readonly FilePicker: Component;
  readonly TemplatePicker: (props: PluginTemplatePickerProps) => any;
  readonly MaterialPicker: (props: PluginMaterialPickerProps) => any;
}
export interface PluginHttpError extends Error {
  readonly status: number;
  readonly requestId?: string;
}
