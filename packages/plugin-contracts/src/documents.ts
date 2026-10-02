export interface PublicResource {
  readonly id: string;
  readonly kind: "document" | "library";
  readonly title: string;
  readonly format: string;
  readonly parentId: string | null;
  readonly libraryId: string | null;
  readonly version: number;
  readonly role: string;
}
export interface DocumentReadInput {
  readonly documentId: string;
}
export interface DocumentSnapshot extends DocumentReadInput {
  readonly format: string;
  readonly codec: string;
  readonly schemaVersion: number;
  /** Opaque content identity. Not the resource's business metadata version. */
  readonly revision: string;
  /** Null when persisted content exists but no collaboration session has established an epoch. */
  readonly epochId: string | null;
  readonly seq: number;
  readonly content: unknown;
  readonly assets: readonly { fileId: string; name: string; mime: string }[];
}
export interface DocumentCapabilities {
  readonly readSnapshot: boolean;
  readonly comment: boolean;
  readonly edit: boolean;
  readonly manage: boolean;
}
export interface PublicResourcePage {
  readonly items: readonly PublicResource[];
  readonly nextCursor: string | null;
}
export interface LibraryChildrenInput {
  readonly libraryId: string;
  readonly parentId: string | null;
  readonly cursor?: string | null;
}
