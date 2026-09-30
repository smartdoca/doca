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
/** Host-injected React is the only supported renderer instance. */
export interface PluginWebHost<
  ReactRuntime = unknown,
  Component = (props: PluginFilePickerProps) => any,
> {
  readonly React: ReactRuntime;
  readonly apiBase: string;
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
}
export interface PluginHttpError extends Error {
  readonly status: number;
  readonly requestId?: string;
}
