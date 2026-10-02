/** Shared by built-in modules and installed plugins. Discovery does not grant access. */
export type DirectoryMode = "all" | "related" | "none";
export interface DirectoryUser {
  readonly id: string;
  readonly display_name: string;
  readonly public_id: string | null;
  readonly avatar: string | null;
  readonly avatar_asset_id: string | null;
}
export interface DirectorySearchInput {
  readonly query: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}
export interface DirectoryPage {
  readonly items: readonly DirectoryUser[];
  readonly nextCursor: string | null;
  /** False when a relation provider failed; successful providers remain usable. */
  readonly complete: boolean;
}
export interface DirectoryRelation {
  readonly userId: string;
  readonly relationId: string;
  readonly revision: string;
}
export interface DirectorySource {
  readonly id: string;
  readonly schemaVersion: 1;
  related(
    principalId: string,
    input: { cursor: string | null; limit: number; signal: AbortSignal },
  ): Promise<{ items: readonly DirectoryRelation[]; cursor: string | null }>;
  verify(
    principalId: string,
    candidates: readonly DirectoryRelation[],
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}
