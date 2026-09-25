import type {
  FileBindingOperationsV1,
  FileContentResolutionV1,
  FileId,
  FileOperationsV1,
  FileOwnerBindingTarget,
  FilesServiceV1,
  FileUploadLifecycleV1,
  StableId,
} from "../../files-capability/src/index.js";
import { stableId } from "../../files-capability/src/index.js";

export const DOCUMENTS_SERVICE_VERSION = 1 as const;
export const DOCUMENTS_SERVICE_ID = "documents.v1" as const;
export const DOCUMENT_FILE_OWNER_PLUGIN = "@doca/documents-capability";

export type DocumentResourceId = StableId<"document-resource">;

export interface DocumentsRequestContext {
  readonly principalId: string | null;
  readonly signal?: AbortSignal;
}

export interface DocumentResource {
  readonly id: DocumentResourceId;
  readonly kind: "document" | "library";
  /** Dynamic format identifier owned by the selected codec/editor package. */
  readonly format: string;
  readonly title: string;
  readonly ownerId: string;
  readonly parentId: DocumentResourceId | null;
  readonly libraryId: DocumentResourceId | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentResourcePage {
  readonly items: readonly DocumentResource[];
  readonly cursor: string | null;
}

export interface DocumentResourceOperationsV1 {
  create(
    context: DocumentsRequestContext,
    input: {
      kind: DocumentResource["kind"];
      format: string;
      title: string;
      parentId?: DocumentResourceId | null;
      libraryId?: DocumentResourceId | null;
    },
  ): Promise<DocumentResource>;
  get(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId; includeDeleted?: boolean },
  ): Promise<DocumentResource | null>;
  list(
    context: DocumentsRequestContext,
    input: {
      parentId?: DocumentResourceId | null;
      libraryId?: DocumentResourceId | null;
      cursor?: string | null;
      limit?: number;
    },
  ): Promise<DocumentResourcePage>;
  update(
    context: DocumentsRequestContext,
    input: {
      resourceId: DocumentResourceId;
      expectedVersion: number;
      title?: string;
    },
  ): Promise<DocumentResource>;
  move(
    context: DocumentsRequestContext,
    input: {
      resourceId: DocumentResourceId;
      expectedVersion: number;
      parentId: DocumentResourceId | null;
      libraryId: DocumentResourceId | null;
    },
  ): Promise<DocumentResource>;
  copy(
    context: DocumentsRequestContext,
    input: {
      resourceId: DocumentResourceId;
      parentId?: DocumentResourceId | null;
      libraryId?: DocumentResourceId | null;
      includeChildren?: boolean;
    },
  ): Promise<DocumentResource>;
  trash(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId; expectedVersion: number },
  ): Promise<DocumentResource>;
  restore(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId; expectedVersion: number },
  ): Promise<DocumentResource>;
  purge(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId; expectedVersion: number },
  ): Promise<void>;
}

export type DocumentAccessRole =
  "reader" | "commenter" | "editor" | "manager" | "owner";

export type DocumentAccessAction =
  "read" | "comment" | "edit" | "manage" | "own";

export interface DocumentAccessDecision {
  readonly resourceId: DocumentResourceId;
  readonly principalId: string | null;
  readonly action: DocumentAccessAction;
  readonly allowed: boolean;
  readonly role: DocumentAccessRole | null;
}

export interface DocumentAccessGrant {
  readonly resourceId: DocumentResourceId;
  readonly principalId: string;
  readonly role: Exclude<DocumentAccessRole, "owner">;
  readonly version: number;
}

export interface DocumentAccessOperationsV1 {
  authorize(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId; action: DocumentAccessAction },
  ): Promise<DocumentAccessDecision>;
  listGrants(
    context: DocumentsRequestContext,
    input: { resourceId: DocumentResourceId },
  ): Promise<readonly DocumentAccessGrant[]>;
  putGrant(
    context: DocumentsRequestContext,
    input: {
      resourceId: DocumentResourceId;
      principalId: string;
      role: Exclude<DocumentAccessRole, "owner">;
      expectedVersion?: number;
    },
  ): Promise<DocumentAccessGrant>;
  revokeGrant(
    context: DocumentsRequestContext,
    input: {
      resourceId: DocumentResourceId;
      principalId: string;
      expectedVersion: number;
    },
  ): Promise<void>;
}

export interface DocumentCollaborationContext extends DocumentsRequestContext {
  /** Server-issued identity for one connection, not merely one account. */
  readonly sessionId: string;
}

export interface DocumentCodecSupport {
  readonly codec: string;
  readonly schemaVersions: readonly number[];
}

export interface DocumentCollaborationState {
  readonly protocolVersion: 1;
  readonly resourceId: DocumentResourceId;
  readonly codec: string;
  readonly schemaVersion: number;
  readonly epochId: string;
  readonly seq: number;
  readonly checkpointSeq: number;
  readonly vector: Uint8Array;
  readonly update: Uint8Array;
  readonly readOnly: boolean;
}

export interface DocumentCollaborationAck {
  readonly protocolVersion: 1;
  readonly resourceId: DocumentResourceId;
  readonly messageId: string;
  readonly epochId: string;
  /** Sequence assigned only after the update is durably committed. */
  readonly seq: number;
  readonly changed: boolean;
}

export interface DocumentPresenceMessage {
  readonly resourceId: DocumentResourceId;
  readonly sessionId: string;
  /**
   * Codec-owned temporary payload. It is never document content or a durable
   * comment anchor.
   */
  readonly payload: Readonly<Record<string, unknown>> | null;
}

export interface DocumentCollaborationOperationsV1 {
  join(
    context: DocumentCollaborationContext,
    input: {
      resourceId: DocumentResourceId;
      supportedCodecs: readonly DocumentCodecSupport[];
      knownEpochId?: string;
      vector?: Uint8Array;
    },
  ): Promise<DocumentCollaborationState>;
  /**
   * Synchronizes remote state. A sync response is deliberately not a durable
   * acknowledgement and cannot clear an outbox entry.
   */
  sync(
    context: DocumentCollaborationContext,
    input: {
      resourceId: DocumentResourceId;
      epochId: string;
      vector: Uint8Array;
    },
  ): Promise<DocumentCollaborationState>;
  /**
   * Commits one local codec update. Implementations recheck access and return
   * an ACK only after persistence succeeds.
   */
  commit(
    context: DocumentCollaborationContext,
    input: {
      protocolVersion: 1;
      resourceId: DocumentResourceId;
      messageId: string;
      codec: string;
      schemaVersion: number;
      epochId: string;
      update: Uint8Array;
    },
  ): Promise<DocumentCollaborationAck>;
  publishPresence(
    context: DocumentCollaborationContext,
    message: DocumentPresenceMessage,
  ): Promise<void>;
  leave(
    context: DocumentCollaborationContext,
    input: { resourceId: DocumentResourceId },
  ): Promise<void>;
}

/**
 * The only file surface required by documents. It intentionally depends on
 * capability interfaces, not storage adapters or deployment URLs.
 */
export interface DocumentFilesPortV1 {
  readonly version: FilesServiceV1["version"];
  readonly files: Pick<FileOperationsV1, "create" | "get" | "delete">;
  readonly uploads: FileUploadLifecycleV1;
  readonly bindings: Pick<FileBindingOperationsV1, "bind" | "unbind" | "list">;
  readonly content: FileContentResolutionV1;
}

export function createDocumentFilesPortV1(
  files: FilesServiceV1,
): DocumentFilesPortV1 {
  return Object.freeze({
    version: files.version,
    files: {
      create: files.files.create.bind(files.files),
      get: files.files.get.bind(files.files),
      delete: files.files.delete.bind(files.files),
    },
    uploads: files.uploads,
    bindings: {
      bind: files.bindings.bind.bind(files.bindings),
      unbind: files.bindings.unbind.bind(files.bindings),
      list: files.bindings.list.bind(files.bindings),
    },
    content: files.content,
  });
}

export function documentFileOwner(
  resourceId: DocumentResourceId,
  role: string,
): FileOwnerBindingTarget {
  if (!role.trim()) throw new TypeError("A document file role cannot be empty");
  return {
    ownerPlugin: DOCUMENT_FILE_OWNER_PLUGIN,
    ownerType: "document",
    ownerId: resourceId,
    role,
  };
}

export interface DocumentResourceUploadInput {
  readonly filename: string;
  readonly mime?: string;
  readonly bytes: Uint8Array;
  readonly checksum?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (input: {
    readonly loaded: number;
    readonly total: number;
  }) => void;
}

export interface DocumentResourceUploadResult {
  /** Stable FileId consumed by the editor as its resource path. */
  readonly path: FileId;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * Host-owned editor resource seam. It deliberately returns stable file IDs;
 * permission-checked addresses are resolved only when content is displayed or
 * downloaded.
 */
export interface DocumentResourceCallbacksV1 {
  uploadImage(
    input: DocumentResourceUploadInput,
  ): Promise<DocumentResourceUploadResult>;
  uploadVideo(
    input: DocumentResourceUploadInput,
  ): Promise<DocumentResourceUploadResult>;
  uploadAttachment(
    input: DocumentResourceUploadInput,
  ): Promise<DocumentResourceUploadResult>;
  resolveUrl(
    path: FileId | string,
    input?: { readonly variant?: string; readonly signal?: AbortSignal },
  ): Promise<string>;
  resolveDownloadUrl(
    path: FileId | string,
    input?: { readonly filename?: string; readonly signal?: AbortSignal },
  ): Promise<string>;
}

/**
 * Adapts files.v1 to the editor callback surface without introducing another
 * autosave or collaboration transport. Uploads are bound to the document only
 * after bytes and logical file creation both succeed.
 */
export function createDocumentResourceCallbacksV1(input: {
  readonly files: DocumentFilesPortV1;
  readonly context: DocumentsRequestContext;
  readonly resourceId: DocumentResourceId;
}): DocumentResourceCallbacksV1 {
  const filesContext = (signal?: AbortSignal) => ({
    principalId: input.context.principalId,
    signal: signal ?? input.context.signal,
  });
  const upload = async (
    role: "image" | "video" | "attachment",
    request: DocumentResourceUploadInput,
  ): Promise<DocumentResourceUploadResult> => {
    const context = filesContext(request.signal);
    let uploadId:
      | Awaited<ReturnType<DocumentFilesPortV1["uploads"]["begin"]>>["id"]
      | null = null;
    let created: Awaited<
      ReturnType<DocumentFilesPortV1["files"]["create"]>
    > | null = null;
    try {
      const begun = await input.files.uploads.begin(context, {
        filename: request.filename,
        mime: request.mime,
        size: request.bytes.byteLength,
        checksum: request.checksum,
      });
      uploadId = begun.id;
      await input.files.uploads.write(context, {
        uploadId,
        offset: 0,
        bytes: request.bytes,
      });
      request.onProgress?.({
        loaded: request.bytes.byteLength,
        total: request.bytes.byteLength,
      });
      await input.files.uploads.complete(context, {
        uploadId,
        checksum: request.checksum,
      });
      created = await input.files.files.create(context, {
        folderId: null,
        name: request.filename,
        uploadId,
      });
      await input.files.bindings.bind(context, {
        fileId: created.id,
        owner: documentFileOwner(input.resourceId, role),
      });
      return {
        path: created.id,
        name: created.name,
        mime: created.mime,
        size: created.size,
      };
    } catch (error) {
      if (created) {
        await input.files.files
          .delete(context, {
            fileId: created.id,
            expectedVersion: created.version,
          })
          .catch(() => undefined);
      } else if (uploadId) {
        await input.files.uploads
          .abort(context, { uploadId })
          .catch(() => undefined);
      }
      throw error;
    }
  };
  const fileId = (path: FileId | string) =>
    typeof path === "string" ? stableId(path, "file") : path;
  const callbacks: DocumentResourceCallbacksV1 = {
    uploadImage: (request) => upload("image", request),
    uploadVideo: (request) => upload("video", request),
    uploadAttachment: (request) => upload("attachment", request),
    async resolveUrl(path, request) {
      const resolved = await input.files.content.resolveContent(
        filesContext(request?.signal),
        { fileId: fileId(path), variant: request?.variant },
      );
      return resolved.href;
    },
    async resolveDownloadUrl(path, request) {
      const resolved = await input.files.content.resolveDownload(
        filesContext(request?.signal),
        { fileId: fileId(path), filename: request?.filename },
      );
      return resolved.href;
    },
  };
  return Object.freeze(callbacks);
}

export interface DocumentsServiceV1 {
  readonly version: typeof DOCUMENTS_SERVICE_VERSION;
  readonly resources: DocumentResourceOperationsV1;
  readonly access: DocumentAccessOperationsV1;
  readonly collaboration: DocumentCollaborationOperationsV1;
  readonly files: DocumentFilesPortV1;
}

export interface DocumentsProviderAdapterV1 {
  readonly resources: DocumentResourceOperationsV1;
  readonly access: DocumentAccessOperationsV1;
  /**
   * Existing collaboration implementation is injected unchanged. The
   * capability adapter does not reinterpret epochs, updates, receipts, or ACKs.
   */
  readonly collaboration: DocumentCollaborationOperationsV1;
  readonly files: DocumentFilesPortV1;
}

export function createDocumentsProviderV1(
  adapter: DocumentsProviderAdapterV1,
): DocumentsServiceV1 {
  return defineDocumentsServiceV1({
    version: DOCUMENTS_SERVICE_VERSION,
    resources: adapter.resources,
    access: adapter.access,
    collaboration: adapter.collaboration,
    files: adapter.files,
  });
}

/**
 * Defines the boundary only. Editors/codecs and file storage implementations
 * are supplied by the host and remain outside this package.
 */
export function defineDocumentsServiceV1<
  const Service extends DocumentsServiceV1,
>(service: Service): Service {
  if (service.version !== DOCUMENTS_SERVICE_VERSION) {
    throw new TypeError(
      `Unsupported documents service version: ${service.version}`,
    );
  }
  if (service.files.version !== 1) {
    throw new TypeError(
      `Unsupported files service version: ${service.files.version}`,
    );
  }
  return service;
}

export type DocumentFileId = FileId;
