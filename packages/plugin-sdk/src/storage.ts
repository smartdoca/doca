import { defineService } from "./index.js";

/** Portable relational values. Serialize application JSON explicitly into text. */
export type PluginDataValue = string | number | null;
export type PluginDataRow = Readonly<Record<string, PluginDataValue>>;
export interface PluginDatabaseSchema {
  readonly version: 1;
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly columns: Readonly<
          Record<
            string,
            {
              readonly type: "text" | "integer" | "real";
              readonly nullable: boolean;
            }
          >
        >;
        readonly primaryKey: readonly string[];
        readonly unique: readonly (readonly string[])[];
      }
    >
  >;
}
export interface PluginDataFilter {
  readonly column: string;
  readonly operator: "=" | "!=" | "<" | "<=" | ">" | ">=";
  readonly value: PluginDataValue;
}
export interface PluginDataQuery {
  readonly where?: readonly PluginDataFilter[];
  readonly orderBy?: readonly {
    readonly column: string;
    readonly direction: "asc" | "desc";
  }[];
  readonly limit?: number;
}
export interface PluginDatabaseTransaction {
  select(
    table: string,
    query?: PluginDataQuery,
  ): Promise<readonly PluginDataRow[]>;
  insert(table: string, rows: readonly PluginDataRow[]): Promise<void>;
  update(
    table: string,
    values: PluginDataRow,
    where: readonly PluginDataFilter[],
  ): Promise<number>;
  remove(table: string, where: readonly PluginDataFilter[]): Promise<number>;
}
export interface PluginDatabaseServiceV1 extends PluginDatabaseTransaction {
  /** Create a declared structure once, or verify an exact existing structure. Changes are rejected. */
  defineSchema(schema: PluginDatabaseSchema): Promise<void>;
  /** Runs once, commits atomically, rolls back on failure. Do not perform external side effects here. */
  transaction<T>(
    run: (transaction: PluginDatabaseTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface PluginStoredObject {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
}
export interface PluginObjectStorageServiceV1 {
  /** Special private data only; ordinary files belong in files.v1. Maximum 32 MiB. */
  put(input: {
    readonly data: Uint8Array;
    readonly mime: string;
  }): Promise<PluginStoredObject>;
  get(id: string): Promise<{
    readonly object: PluginStoredObject;
    readonly data: Uint8Array;
  } | null>;
  remove(id: string): Promise<void>;
}
export interface PluginCredentialMetadata {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Server-only secrets. Authorize the business account before using this service; never return values to browsers or AI prompts. */
export interface PluginCredentialServiceV1 {
  /** A non-empty UTF-8 string, at most 64 KiB. Serialize OAuth bundles explicitly. */
  create(input: { readonly value: string }): Promise<PluginCredentialMetadata>;
  inspect(id: string): Promise<PluginCredentialMetadata | null>;
  get(
    id: string,
  ): Promise<{
    readonly credential: PluginCredentialMetadata;
    readonly value: string;
  } | null>;
  /** Compare-and-swap. Concurrent refreshes cannot silently overwrite one another. */
  update(input: {
    readonly id: string;
    readonly value: string;
    readonly expectedRevision: number;
  }): Promise<PluginCredentialMetadata>;
  /** Repeating a successful deletion is harmless; a changed revision is rejected. */
  remove(input: {
    readonly id: string;
    readonly expectedRevision: number;
  }): Promise<void>;
}
/** Bound to the installed plugin identity by the host. No database selector, raw SQL, paths or backend connection credentials. */
export const pluginDatabaseToken =
  defineService<PluginDatabaseServiceV1>("storage.sql.v1");
export const pluginObjectStorageToken =
  defineService<PluginObjectStorageServiceV1>("storage.objects.v1");
export const pluginCredentialToken = defineService<PluginCredentialServiceV1>(
  "storage.credentials.v1",
);
