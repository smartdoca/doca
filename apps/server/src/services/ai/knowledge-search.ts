import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
import { createContent } from "@core/workflows/resources.js";
import {
  aiSearchHit,
  checkScope,
  type ToolContext,
} from "@core/workflows/ai-documents.js";

export async function searchKnowledge(
  db: DB,
  ctx: ToolContext,
  input: {
    query: string;
    mode?: "auto" | "keyword" | "ai";
    libraryId?: string;
    offset?: number;
  },
  search?: (actor: any, query: any) => Promise<any>,
) {
  if (input.libraryId) await checkScope(db, ctx, input.libraryId);
  let matchedIds: string[] | undefined;
  // Narrow before retrieval and pagination, not after the first page of global results.
  if (ctx.allowedResources !== undefined) {
    matchedIds = ctx.allowedResources.length
      ? (
          await db
            .selectFrom("resources")
            .select("id")
            .where((eb) =>
              eb.or([
                eb("id", "in", ctx.allowedResources!),
                ...(!ctx.exactResources
                  ? [eb("library_id", "in", ctx.allowedResources!)]
                  : []),
              ]),
            )
            .execute()
        ).map((r) => r.id)
      : [];
  }
  if (!search && input.mode === "ai")
    fail(503, "AI 搜索尚未配置，请使用关键词搜索");
  const query = {
    q: input.query,
    kind: "document",
    mode: input.mode ?? "auto",
    libraryIds: input.libraryId ? [input.libraryId] : undefined,
    offset: input.offset ?? 0,
    matchedIds,
  };
  const page = await (search ?? createContent(db).list)(ctx.actor, query);
  const items = [];
  for (const r of page.items) {
    try {
      items.push(await aiSearchHit(db, ctx, r.id, input.query));
    } catch (error) {
      if (![403, 404].includes((error as { status?: number }).status ?? 0))
        throw error;
    }
  }
  return {
    items,
    nextOffset: page.nextOffset,
    engine: page.engine ?? "database",
    mode: page.mode ?? "keyword",
    notice:
      page.notice ?? (!search ? "未配置搜索服务，已使用关键词搜索" : undefined),
  };
}
