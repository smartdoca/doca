import {
  searchExcerpt,
  textMatches,
  queryCoverage,
  type SearchMatch,
} from "@core/modules/discovery/search-excerpts.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { readSnapshot } from "@db/transactions.js";
import { authorize } from "@core/modules/access/queries.js";

/** Return current source text only after checking current permissions in the same snapshot. */
export async function searchSummaries<T extends { id: string; title?: string }>(
  db: DB,
  actor: Actor,
  items: T[],
  query = "",
) {
  return readSnapshot(db, async (tx) => {
    const result: (T & {
      summary: string;
      summaryMatches: SearchMatch[];
      titleMatches: SearchMatch[];
      searchCoverage: number;
    })[] = [];
    for (const item of items) {
      try {
        await authorize(tx, actor, item.id, 1);
        const state = await tx
          .selectFrom("document_states")
          .select("text")
          .where("resource_id", "=", item.id)
          .executeTakeFirst();
        const resource = await tx.selectFrom("resources").select(["library_id", "kind", "ai_curated"]).where("id", "=", item.id).executeTakeFirst();
        const library = resource?.library_id
          ? await tx.selectFrom("resources").select("ai_curated").where("id", "=", resource.library_id).executeTakeFirst()
          : undefined;
        result.push({
          ...item,
          aiCurated: Number(resource?.kind === "library" ? resource.ai_curated : library?.ai_curated) === 1,
          ...searchExcerpt(state?.text ?? "", query, 180),
          titleMatches: textMatches(item.title ?? "", query),
          searchCoverage: queryCoverage(
            (item.title ?? "") + "\n" + (state?.text ?? ""),
            query,
          ),
        });
      } catch (error) {
        if (![403, 404].includes((error as { status?: number }).status ?? 0))
          throw error;
      }
    }
    return result;
  });
}
