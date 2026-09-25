/**
 * Storage-agnostic file capability contract.
 *
 * IDs in this contract are durable application references. Object keys,
 * filesystem paths, signed URLs, and upload-session IDs must never be used as
 * substitutes for FileId or FolderId.
 */

export const FILES_SERVICE_VERSION = 1 as const;
export const FILES_SERVICE_ID = "files.v1" as const;

declare const stableIdBrand: unique symbol;

export type StableId<Kind extends string> = string & {
  readonly [stableIdBrand]: Kind;
};

export type FolderId = StableId<"folder">;
export type FileId = StableId<"file">;
export type FileBindingId = StableId<"file-binding">;
export type FileUploadId = StableId<"file-upload">;

export function stableId<Kind extends string>(
  value: string,
  _kind: Kind,
): StableId<Kind> {
  if (!value.trim()) throw new TypeError("A stable ID cannot be empty");
  return value as StableId<Kind>;
}

export interface FilesRequestContext {
  /** Stable authenticated principal ID, or null for an anonymous request. */
  readonly principalId: string | null;
  readonly signal?: AbortSignal;
}

export interface FilePage<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

export interface FileFolder {
  readonly id: FolderId;
  readonly parentId: FolderId | null;
  readonly name: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileRecord {
  readonly id: FileId;
  readonly folderId: FolderId | null;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileFolderOperationsV1 {
  create(
    context: FilesRequestContext,
    input: { parentId: FolderId | null; name: string },
  ): Promise<FileFolder>;
  get(
    context: FilesRequestContext,
    input: { folderId: FolderId },
  ): Promise<FileFolder | null>;
  list(
    context: FilesRequestContext,
    input: {
      parentId: FolderId | null;
      cursor?: string | null;
      limit?: number;
    },
  ): Promise<FilePage<FileFolder>>;
  update(
    context: FilesRequestContext,
    input: {
      folderId: FolderId;
      expectedVersion: number;
      name?: string;
      parentId?: FolderId | null;
    },
  ): Promise<FileFolder>;
  delete(
    context: FilesRequestContext,
    input: {
      folderId: FolderId;
      expectedVersion: number;
      recursive?: boolean;
    },
  ): Promise<void>;
}

export type FileCreateInput = {
  readonly folderId: FolderId | null;
  readonly name: string;
} & (
  | {
      /** A successfully completed upload. */
      readonly uploadId: FileUploadId;
      readonly sourceFileId?: never;
    }
  | {
      /** Create another logical file that refers to the same immutable bytes. */
      readonly sourceFileId: FileId;
      readonly uploadId?: never;
    }
);

export interface FileOperationsV1 {
  create(
    context: FilesRequestContext,
    input: FileCreateInput,
  ): Promise<FileRecord>;
  get(
    context: FilesRequestContext,
    input: { fileId: FileId },
  ): Promise<FileRecord | null>;
  list(
    context: FilesRequestContext,
    input: {
      folderId: FolderId | null;
      cursor?: string | null;
      limit?: number;
    },
  ): Promise<FilePage<FileRecord>>;
  update(
    context: FilesRequestContext,
    input: {
      fileId: FileId;
      expectedVersion: number;
      name?: string;
      folderId?: FolderId | null;
    },
  ): Promise<FileRecord>;
  delete(
    context: FilesRequestContext,
    input: { fileId: FileId; expectedVersion: number },
  ): Promise<void>;
}

export type FileUploadState = "open" | "completed" | "aborted" | "failed";

export interface FileUpload {
  readonly id: FileUploadId;
  readonly filename: string;
  readonly declaredMime?: string;
  readonly declaredSize?: number;
  readonly receivedBytes: number;
  readonly state: FileUploadState;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface FileUploadLifecycleV1 {
  begin(
    context: FilesRequestContext,
    input: {
      filename: string;
      mime?: string;
      size?: number;
      checksum?: string;
    },
  ): Promise<FileUpload>;
  write(
    context: FilesRequestContext,
    input: {
      uploadId: FileUploadId;
      offset: number;
      bytes: Uint8Array;
    },
  ): Promise<FileUpload>;
  complete(
    context: FilesRequestContext,
    input: { uploadId: FileUploadId; checksum?: string },
  ): Promise<FileUpload & { readonly state: "completed" }>;
  abort(
    context: FilesRequestContext,
    input: { uploadId: FileUploadId },
  ): Promise<void>;
  get(
    context: FilesRequestContext,
    input: { uploadId: FileUploadId },
  ): Promise<FileUpload | null>;
}

/**
 * A plugin-owned relationship to a file.
 *
 * The tuple (fileId, ownerPlugin, ownerType, ownerId, role) is unique. bind is
 * idempotent for that tuple; unbind removes only that exact relationship.
 */
export interface FileOwnerBindingTarget {
  readonly ownerPlugin: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly role: string;
}

export function assertFileOwnerBindingTarget(
  owner: FileOwnerBindingTarget,
): FileOwnerBindingTarget {
  for (const [field, value] of Object.entries(owner)) {
    if (!value.trim()) {
      throw new TypeError(`File binding ${field} cannot be empty`);
    }
  }
  return owner;
}

export interface FileOwnerBinding extends FileOwnerBindingTarget {
  readonly id: FileBindingId;
  readonly fileId: FileId;
  readonly createdAt: string;
}

export function fileOwnerBindingKey(
  fileId: FileId,
  owner: FileOwnerBindingTarget,
): string {
  assertFileOwnerBindingTarget(owner);
  return JSON.stringify([
    fileId,
    owner.ownerPlugin,
    owner.ownerType,
    owner.ownerId,
    owner.role,
  ]);
}

export interface FileBindingOperationsV1 {
  bind(
    context: FilesRequestContext,
    input: { fileId: FileId; owner: FileOwnerBindingTarget },
  ): Promise<FileOwnerBinding>;
  unbind(
    context: FilesRequestContext,
    input: { fileId: FileId; owner: FileOwnerBindingTarget },
  ): Promise<{ readonly removed: boolean }>;
  list(
    context: FilesRequestContext,
    input:
      | { fileId: FileId; owner?: never }
      | { fileId?: never; owner: Partial<FileOwnerBindingTarget> },
  ): Promise<readonly FileOwnerBinding[]>;
}

/**
 * Persistence boundary for generic file bindings. Implementations store only
 * file IDs and owner tuples; they never need to import another domain's table.
 */
export interface FileBindingRepositoryV1 {
  get(key: string): Promise<FileOwnerBinding | null>;
  insert(key: string, binding: FileOwnerBinding): Promise<FileOwnerBinding>;
  delete(key: string): Promise<boolean>;
  list(
    filter:
      | { readonly fileId: FileId }
      | { readonly owner: Partial<FileOwnerBindingTarget> },
  ): Promise<readonly FileOwnerBinding[]>;
}

export interface FileBindingPolicyV1 {
  authorize(
    context: FilesRequestContext,
    input: {
      readonly action: "bind" | "unbind" | "list";
      readonly fileId?: FileId;
      readonly owner?: Partial<FileOwnerBindingTarget>;
    },
  ): Promise<void>;
}

/**
 * Implements idempotent, exact-tuple binding semantics over a host-owned
 * repository. The repository may use a database transaction or another
 * durable store; the capability never queries an owner's domain tables.
 */
export function createFileBindingOperationsV1(input: {
  readonly repository: FileBindingRepositoryV1;
  readonly policy: FileBindingPolicyV1;
  readonly createId: () => FileBindingId;
  readonly now?: () => string;
}): FileBindingOperationsV1 {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    async bind(context, request) {
      assertFileOwnerBindingTarget(request.owner);
      await input.policy.authorize(context, {
        action: "bind",
        fileId: request.fileId,
        owner: request.owner,
      });
      const key = fileOwnerBindingKey(request.fileId, request.owner);
      const existing = await input.repository.get(key);
      if (existing) return existing;
      return input.repository.insert(key, {
        id: input.createId(),
        fileId: request.fileId,
        ...request.owner,
        createdAt: now(),
      });
    },
    async unbind(context, request) {
      assertFileOwnerBindingTarget(request.owner);
      await input.policy.authorize(context, {
        action: "unbind",
        fileId: request.fileId,
        owner: request.owner,
      });
      return {
        removed: await input.repository.delete(
          fileOwnerBindingKey(request.fileId, request.owner),
        ),
      };
    },
    async list(context, request) {
      if (request.fileId !== undefined) {
        const fileId = request.fileId;
        await input.policy.authorize(context, {
          action: "list",
          fileId,
        });
        return input.repository.list({ fileId });
      }
      for (const value of Object.values(request.owner)) {
        if (value !== undefined && !value.trim()) {
          throw new TypeError("File binding owner filters cannot be empty");
        }
      }
      await input.policy.authorize(context, {
        action: "list",
        owner: request.owner,
      });
      return input.repository.list({ owner: request.owner });
    },
  };
}

export interface FileAccessResolution {
  readonly fileId: FileId;
  readonly href: string;
  readonly method: "GET";
  readonly headers?: Readonly<Record<string, string>>;
  readonly expiresAt?: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly disposition: "inline" | "attachment";
}

export interface FileByteRange {
  readonly start: number;
  /** Inclusive end offset. */
  readonly end?: number;
}

export interface FileContentRead {
  readonly file: FileRecord;
  readonly body: AsyncIterable<Uint8Array>;
  readonly range?: {
    readonly start: number;
    readonly end: number;
    readonly total: number;
  };
}

export interface FileContentResolutionV1 {
  /**
   * Opens an authorized byte stream. Providers recheck access before returning
   * the stream and must stop reading when context.signal is aborted.
   */
  readonly read?: (
    context: FilesRequestContext,
    input: { fileId: FileId; range?: FileByteRange; bindingId?: FileBindingId },
  ) => Promise<FileContentRead>;
  /**
   * Resolves a permission-checked inline representation at use time.
   * Implementations must not return an address before authorizing context.
   */
  resolveContent(
    context: FilesRequestContext,
    input: { fileId: FileId; variant?: string; bindingId?: FileBindingId },
  ): Promise<FileAccessResolution & { readonly disposition: "inline" }>;
  /**
   * Resolves a permission-checked download at use time. This is intentionally
   * distinct from inline content so callers cannot bypass download policy.
   */
  resolveDownload(
    context: FilesRequestContext,
    input: { fileId: FileId; filename?: string; bindingId?: FileBindingId },
  ): Promise<FileAccessResolution & { readonly disposition: "attachment" }>;
}

export interface FileContentOperationsV1 extends FileContentResolutionV1 {
  read(
    context: FilesRequestContext,
    input: { fileId: FileId; range?: FileByteRange; bindingId?: FileBindingId },
  ): Promise<FileContentRead>;
}

export type FilesWebCapabilityKind =
  "browser" | "picker" | "upload" | "preview" | "download";

export interface FilesWebCapabilityDescriptor {
  readonly id: `files.${FilesWebCapabilityKind}`;
  readonly service: "files";
  readonly serviceVersion: typeof FILES_SERVICE_VERSION;
  readonly kind: FilesWebCapabilityKind;
  readonly requiresAuthorization: true;
}

const webCapability = (
  kind: FilesWebCapabilityKind,
): FilesWebCapabilityDescriptor => ({
  id: `files.${kind}`,
  service: "files",
  serviceVersion: FILES_SERVICE_VERSION,
  kind,
  requiresAuthorization: true,
});

export const FILES_WEB_CAPABILITIES_V1 = Object.freeze(
  (["browser", "picker", "upload", "preview", "download"] as const).map(
    webCapability,
  ),
);

export interface FilesServiceV1 {
  readonly version: typeof FILES_SERVICE_VERSION;
  readonly folders: FileFolderOperationsV1;
  readonly files: FileOperationsV1;
  readonly uploads: FileUploadLifecycleV1;
  readonly bindings: FileBindingOperationsV1;
  readonly content: FileContentResolutionV1;
  readonly webCapabilities: readonly FilesWebCapabilityDescriptor[];
}

export interface FilesProviderAdapterV1 {
  readonly folders: FileFolderOperationsV1;
  readonly files: FileOperationsV1;
  readonly uploads: FileUploadLifecycleV1;
  readonly bindings: FileBindingOperationsV1;
  readonly content: FileContentOperationsV1;
  readonly webCapabilities?: readonly FilesWebCapabilityDescriptor[];
}

/**
 * Creates the concrete files.v1 provider surface from host-owned persistence,
 * storage, and authorization ports.
 */
export function createFilesProviderV1(
  adapter: FilesProviderAdapterV1,
): FilesServiceV1 & { readonly content: FileContentOperationsV1 } {
  return defineFilesServiceV1({
    version: FILES_SERVICE_VERSION,
    folders: adapter.folders,
    files: adapter.files,
    uploads: adapter.uploads,
    bindings: adapter.bindings,
    content: adapter.content,
    webCapabilities: adapter.webCapabilities ?? FILES_WEB_CAPABILITIES_V1,
  });
}

/** Defines a v1 implementation without providing storage or authorization. */
export function defineFilesServiceV1<const Service extends FilesServiceV1>(
  service: Service,
): Service {
  if (service.version !== FILES_SERVICE_VERSION) {
    throw new TypeError(
      `Unsupported files service version: ${service.version}`,
    );
  }
  return service;
}
