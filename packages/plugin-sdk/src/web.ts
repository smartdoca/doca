export type * from "@doca/web-plugin-registry";
/** Host-injected React is the only supported renderer instance. */
export interface PluginWebHost<ReactRuntime = unknown, Component = unknown> {
  readonly React: ReactRuntime;
  readonly apiBase: string;
  useEnvironment(): { locale: "zh" | "en"; theme: "light" | "soft" };
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
