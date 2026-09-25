import {
  DOCUMENT_FILE_OWNER_PLUGIN,
  type DocumentResourceId,
  type DocumentsServiceV1,
} from "@doca/documents-capability";
import { stableId } from "@doca/files-capability";
import {
  createValidatedKnowledgeSourceEffect,
  type KnowledgeSourceEffect,
} from "@doca/knowledge-capability";

export interface DocumentsKnowledgeSourceConfig {
  readonly libraryId: string | null;
  readonly parentId: string | null;
}

export type DocumentsKnowledgeSourceCursor = {
  readonly cursor: string | null;
};

const documentsConfigSchema = {
  id: "doca.documents.knowledge.config.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      libraryId: { type: ["string", "null"] },
      parentId: { type: ["string", "null"] },
    },
  },
  parse(input: unknown): DocumentsKnowledgeSourceConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Documents knowledge config must be an object");
    }
    const record = input as Record<string, unknown>;
    for (const key of ["libraryId", "parentId"] as const) {
      const value = record[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || !value.trim())
      ) {
        throw new TypeError(`${key} must be a stable ID or null`);
      }
    }
    return {
      libraryId: (record.libraryId as string | null | undefined) ?? null,
      parentId: (record.parentId as string | null | undefined) ?? null,
    };
  },
} as const;

const resourceId = (value: string): DocumentResourceId =>
  stableId(value, "document-resource");

export function createDocumentsKnowledgeSource(
  documents: DocumentsServiceV1,
): KnowledgeSourceEffect<
  DocumentsKnowledgeSourceConfig,
  DocumentsKnowledgeSourceCursor
> {
  return createValidatedKnowledgeSourceEffect({
    version: 1,
    ownerPlugin: "doca.documents",
    sourceType: "documents",
    configRendererId: "doca.documents.knowledge.settings",
    configSchema: documentsConfigSchema,
    async validate({ config }, context) {
      const selected = config.libraryId ?? config.parentId;
      if (!selected) return { valid: true, config, issues: [] };
      const resource = await documents.resources.get(
        { principalId: context.principalId, signal: context.signal },
        { resourceId: resourceId(selected) },
      );
      return resource
        ? { valid: true, config, issues: [] }
        : {
            valid: false,
            issues: [
              {
                path: [config.libraryId ? "libraryId" : "parentId"],
                message: "Document location is unavailable",
              },
            ],
          };
    },
    async preview({ config }, context) {
      const selected = config.libraryId ?? config.parentId;
      if (!selected) {
        return {
          title: "Documents",
          description: "Documents visible to the source principal",
        };
      }
      const resource = await documents.resources.get(
        { principalId: context.principalId, signal: context.signal },
        { resourceId: resourceId(selected) },
      );
      if (!resource) throw new Error("Document location is unavailable");
      return {
        title: resource.title,
        description:
          resource.kind === "library"
            ? `Documents in ${resource.title}`
            : `Children of ${resource.title}`,
      };
    },
    async pull({ config, cursor, limit }, context) {
      const requestContext = {
        principalId: context.principalId,
        signal: context.signal,
      };
      const page = await documents.resources.list(requestContext, {
        parentId: config.parentId ? resourceId(config.parentId) : undefined,
        libraryId: config.libraryId ? resourceId(config.libraryId) : undefined,
        cursor: cursor?.cursor.cursor ?? null,
        limit,
      });
      const records = await Promise.all(
        page.items.map(async (resource) => {
          const [grants, bindings] = await Promise.all([
            documents.access.listGrants(requestContext, {
              resourceId: resource.id,
            }),
            documents.files.bindings.list(requestContext, {
              owner: {
                ownerPlugin: DOCUMENT_FILE_OWNER_PLUGIN,
                ownerType: "document",
                ownerId: resource.id,
              },
            }),
          ]);
          const readers = new Map<string, string | null>([
            [resource.ownerId, resource.ownerId],
          ]);
          for (const grant of grants) {
            readers.set(grant.principalId, grant.principalId);
          }
          return {
            externalId: resource.id,
            externalVersion: String(resource.version),
            title: resource.title,
            payload: {
              kind: resource.kind,
              format: resource.format,
              title: resource.title,
              parentId: resource.parentId,
              libraryId: resource.libraryId,
              version: resource.version,
              deletedAt: resource.deletedAt,
            },
            provenance: {
              ownerPlugin: "doca.documents",
              sourceType: "documents",
              externalId: resource.id,
              uri: `doca://documents/${encodeURIComponent(resource.id)}`,
              observedAt: resource.updatedAt,
              parentExternalIds: [resource.parentId, resource.libraryId].filter(
                (id): id is DocumentResourceId => id !== null,
              ),
            },
            readers: [...readers].map(([externalReaderId, readerId]) => ({
              externalReaderId,
              readerId,
            })),
            fileIds: [...new Set(bindings.map((binding) => binding.fileId))],
            ...(resource.deletedAt ? { deleted: true } : {}),
          };
        }),
      );
      return {
        records,
        nextCursor: page.cursor ? { cursor: page.cursor } : null,
        done: page.cursor === null,
      };
    },
  });
}
