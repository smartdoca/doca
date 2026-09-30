export interface NpmRelease {
  registry: string;
  name: string;
  version: string;
  integrity: string;
  size: number;
}
export interface StoreRelease {
  changelog: string;
  pluginId: string;
  version: string;
  sdkRange: string;
  dataVersion: string;
  targets: ("web" | "mobile")[];
  mobileHostRange?: string;
  dependencies: { id: string; range: string; optional?: boolean }[];
  review: "approved" | "withdrawn";
  reviewedAt: string;
  publishedAt: string;
  npm: NpmRelease;
}
export interface StorePlugin {
  official: boolean;
  id: string;
  name: string;
  summary: string;
  author: { name: string; url: string | null };
  categoryId: string;
  icon: string | null;
  detailPath: string;
  targets: ("web" | "mobile")[];
  review: "approved" | "suspended";
  latestVersion: string | null;
  downloads: {
    count: number | null;
    period: "last30Days";
    source: "npm";
    asOf: string | null;
  };
  likes: { count: number | null; asOf: string | null };
  updatedAt: string;
}
export interface StorePage<T> {
  protocolVersion: 1;
  items: T[];
  page: { nextCursor: string | null; total: number | null; snapshotAt: string };
}
export type StoreCatalog = StorePage<StorePlugin>;
export interface StoreDetail {
  protocolVersion: 1;
  plugin: StorePlugin;
  description: { format: string; version: number; nodes: unknown[] };
}
export interface StoreUpdate {
  id: string;
  installedVersion: string;
  status: "update_available" | "up_to_date" | "incompatible" | "unknown";
  currentReview: "approved" | "withdrawn" | "unknown";
  latestVersion: string | null;
  release: StoreRelease | null;
  reason: string | null;
}
export interface ManagedPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  dataVersion: string;
  source: "local" | "store" | "npm";
  npm?: NpmRelease;
  enabled: boolean;
  runningVersion: string | null;
  pending: boolean;
  removing: boolean;
}
export interface PluginInventory {
  plugins: ManagedPlugin[];
  restartRequired: boolean;
  storeUrl: string;
}
