import { createHash } from "node:crypto";
import type { DB } from "@db/index.js";
import type {
  ContentContext,
  ContentListInput,
  ContentSource,
  ContentRecord,
} from "@smartdoca/plugin-sdk/content";
import { contentBlocks } from "./blocks.js";
import { authorize } from "../access/queries.js";
import { authorizeFileItem } from "../access/file-access.js";
import { fail, AppError } from "../../shared/errors.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function builtinContentSource(
  db: DB,
  kind: "documents" | "files",
): ContentSource {
  const pluginId = `doca.${kind}`;
  const id = `${pluginId}.content`;
  async function user(ctx: ContentContext) {
    ctx.signal.throwIfAborted();
    return db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", ctx.principalId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
  }
  async function readOne(
    ctx: ContentContext,
    resourceId: string,
  ): Promise<ContentRecord[]> {
    const actor = await user(ctx);
    try {
      if (kind === "documents") {
        const access = await authorize(db, actor, resourceId, 1);
        if (access.resource.kind !== "document" || access.resource.deleted_at)
          return [];
        const state = await db
          .selectFrom("document_states")
          .select(["text", "seq"])
          .where("resource_id", "=", resourceId)
          .executeTakeFirst();
        return contentBlocks(access.resource.title, state?.text ?? "").map(
          (block) => ({
            ...block,
            ref: { sourceId: id, resourceId, blockId: block.blockId },
          }),
        );
      }
      await authorizeFileItem(db, actor, resourceId);
      const file = await db
        .selectFrom("file_items")
        .select(["name", "version", "deleted_at"])
        .where("id", "=", resourceId)
        .executeTakeFirst();
      if (!file || file.deleted_at) return [];
      const chunks = await db
        .selectFrom("knowledge_chunks")
        .select("text")
        .where("source_kind", "=", "file")
        .where("source_id", "=", resourceId)
        .orderBy("ordinal")
        .execute();
      return contentBlocks(
        file.name,
        chunks.map((c) => c.text).join("\n\n"),
      ).map((block) => ({
        ...block,
        ref: { sourceId: id, resourceId, blockId: block.blockId },
      }));
    } catch (error) {
      if (error instanceof AppError && [403, 404].includes(error.status))
        return [];
      throw error;
    }
  }
  return {
    id,
    pluginId,
    version: 1,
    title:
      kind === "documents"
        ? { zh: "文档", en: "Documents" }
        : { zh: "文件", en: "Files" },
    contentTypes: [kind === "documents" ? "document" : "file"],
    purposes: ["knowledge", "analysis"],
    capabilities: { search: false },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        resourceIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 500,
        },
      },
    },
    async list(ctx, input: ContentListInput) {
      if (Object.keys(input.config).some((k) => k !== "resourceIds"))
        fail(400, "Unknown content configuration");
      const selected = input.config.resourceIds;
      if (
        selected !== undefined &&
        (!Array.isArray(selected) ||
          selected.length > 500 ||
          selected.some((x) => typeof x !== "string" || !x))
      )
        fail(400, "Invalid resource selection");
      const ids = selected as string[] | undefined;
      const rows =
        kind === "documents"
          ? await db
              .selectFrom("resources")
              .select("id")
              .where("kind", "=", "document")
              .where("deleted_at", "is", null)
              .orderBy("id")
              .execute()
          : await db
              .selectFrom("file_items")
              .select("id")
              .where("deleted_at", "is", null)
              .orderBy("id")
              .execute();
      const items: ContentRecord[] = [];
      for (const row of rows) {
        ctx.signal.throwIfAborted();
        if (ids && !ids.includes(row.id)) continue;
        if (Array.isArray(selected) && !selected.includes(row.id)) continue;
        items.push(...(await readOne(ctx, row.id)));
      }
      const snapshot = hash([
        ctx.principalId,
        ctx.purpose,
        input.config,
        items.map((item) => [item.ref, item.fingerprint]),
      ]);
      let offset = 0;
      if (input.cursor) {
        let token;
        try {
          token = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        } catch {
          fail(400, "Invalid content cursor");
        }
        if (token.snapshot !== snapshot)
          fail(409, "Content traversal expired; restart from the first page");
        if (
          !Number.isInteger(token.offset) ||
          token.offset < 0 ||
          token.offset > items.length
        )
          fail(400, "Invalid content offset");
        offset = token.offset;
      }
      const page = items.slice(offset, offset + input.limit);
      return {
        items: page.map(({ text, ...item }) => item),
        snapshot,
        nextCursor:
          offset + page.length < items.length
            ? Buffer.from(
                JSON.stringify({ snapshot, offset: offset + page.length }),
              ).toString("base64url")
            : null,
      };
    },
    async read(ctx, input) {
      const selected = input.config.resourceIds;
      if (
        Object.keys(input.config).some((k) => k !== "resourceIds") ||
        (selected !== undefined &&
          (!Array.isArray(selected) ||
            selected.length > 500 ||
            selected.some((x) => typeof x !== "string" || !x)))
      )
        fail(400, "Invalid resource selection");
      if (Array.isArray(selected) && !selected.includes(input.ref.resourceId))
        return null;
      const record = (await readOne(ctx, input.ref.resourceId)).find(
        (item) => item.ref.blockId === input.ref.blockId,
      );
      if (!record) return null;
      if (record.fingerprint !== input.fingerprint)
        fail(409, "Content changed; enumerate again");
      return record;
    },
    async resolve(ctx, ref) {
      const record = (await readOne(ctx, ref.resourceId)).find(
        (item) => item.ref.blockId === ref.blockId,
      );
      if (!record) return null;
      return {
        fingerprint: record.fingerprint,
        path:
          kind === "documents"
            ? `/r/${encodeURIComponent(ref.resourceId)}`
            : `/files?focus=${encodeURIComponent(ref.resourceId)}`,
      };
    },
  };
}
