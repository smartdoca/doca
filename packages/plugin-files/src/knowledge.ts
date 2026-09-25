import { stableId, type FilesServiceV1 } from "@doca/files-capability";
import {
  createValidatedKnowledgeSourceEffect,
  type KnowledgeSourceEffect,
} from "@doca/knowledge-capability";

export interface FilesKnowledgeSourceConfig {
  readonly folderId: string | null;
}

export type FilesKnowledgeSourceCursor = {
  readonly cursor: string | null;
};

const filesConfigSchema = {
  id: "doca.files.knowledge.config.v1",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      folderId: { type: ["string", "null"] },
    },
  },
  parse(input: unknown): FilesKnowledgeSourceConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Files knowledge config must be an object");
    }
    const value = input as { folderId?: unknown };
    if (
      value.folderId !== undefined &&
      value.folderId !== null &&
      (typeof value.folderId !== "string" || !value.folderId.trim())
    ) {
      throw new TypeError("folderId must be a stable ID or null");
    }
    return {
      folderId:
        value.folderId === undefined ? null : (value.folderId as string | null),
    };
  },
} as const;

export function createFilesKnowledgeSource(
  files: FilesServiceV1,
): KnowledgeSourceEffect<
  FilesKnowledgeSourceConfig,
  FilesKnowledgeSourceCursor
> {
  return createValidatedKnowledgeSourceEffect<
    FilesKnowledgeSourceConfig,
    FilesKnowledgeSourceCursor
  >({
    version: 1,
    ownerPlugin: "doca.files",
    sourceType: "files",
    configRendererId: "doca.files.knowledge.settings",
    configSchema: filesConfigSchema,
    async validate({ config }, context) {
      if (!config.folderId) return { valid: true, config, issues: [] };
      const folder = await files.folders.get(
        { principalId: context.principalId, signal: context.signal },
        { folderId: stableId(config.folderId, "folder") },
      );
      return folder
        ? { valid: true, config, issues: [] }
        : {
            valid: false,
            issues: [
              {
                path: ["folderId"],
                message: "Folder is unavailable",
              },
            ],
          };
    },
    async preview({ config }, context) {
      if (!config.folderId) {
        return {
          title: "Files",
          description: "Files visible to the source principal",
        };
      }
      const folder = await files.folders.get(
        { principalId: context.principalId, signal: context.signal },
        { folderId: stableId(config.folderId, "folder") },
      );
      if (!folder) throw new Error("Folder is unavailable");
      return {
        title: folder.name,
        description: `Files in ${folder.name}`,
      };
    },
    async pull({ config, cursor, limit }, context) {
      const page = await files.files.list(
        { principalId: context.principalId, signal: context.signal },
        {
          folderId: config.folderId
            ? stableId(config.folderId, "folder")
            : null,
          cursor: cursor?.cursor.cursor ?? null,
          limit,
        },
      );
      return {
        records: page.items.map((file) => ({
          externalId: file.id,
          externalVersion: String(file.version),
          title: file.name,
          payload: {
            kind: "file",
            fileId: file.id,
            folderId: file.folderId,
            name: file.name,
            mime: file.mime,
            size: file.size,
            version: file.version,
          },
          provenance: {
            ownerPlugin: "doca.files",
            sourceType: "files",
            externalId: file.id,
            uri: `doca://files/${encodeURIComponent(file.id)}`,
            observedAt: file.updatedAt,
          },
          readers: [
            {
              externalReaderId: context.principalId,
              readerId: context.principalId,
            },
          ],
          fileIds: [file.id],
        })),
        nextCursor: page.cursor ? { cursor: page.cursor } : null,
        done: page.cursor === null,
      };
    },
  });
}
