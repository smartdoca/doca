import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { authorize } from "../access/queries.js";
import { documentContentStats } from "../documents/content-stats.js";
import { type Actor } from "../identity/passwords.js";
export function createInteractionReads(db: DB) {
  async function access(
    tx: DB | Transaction<Schema>,
    actor: Actor | null,
    id: string,
    minimum = 1,
  ) {
    return (await authorize(tx, actor, id, minimum)).resource;
  }
  async function locked<T>(fn: (tx: Transaction<Schema>) => Promise<T>) {
    return transact(db, async (tx) => {
      return fn(tx);
    });
  }
  return {
    async likes(actor: Actor | null, id: string, offset = 0) {
      await access(db, actor, id);
      const base = db
        .selectFrom("reactions as r")
        .innerJoin("users as u", "u.id", "r.user_id")
        .where("r.resource_id", "=", id)
        .where("r.kind", "=", "like");
      const total = Number(
        (
          await base
            .select((eb) => eb.fn.countAll().as("n"))
            .executeTakeFirstOrThrow()
        ).n,
      );
      return {
        total,
        items: await base
          .select(["u.id", "u.display_name"])
          .orderBy("u.display_name")
          .orderBy("u.id")
          .offset(offset)
          .limit(100)
          .execute(),
        nextOffset: offset + 100 < total ? offset + 100 : null,
      };
    },
    async info(actor: Actor | null, id: string, tab: string, offset = 0) {
      const r = await access(db, actor, id, tab === "stats" ? 1 : 4);
      if (tab === "stats") {
        const count = async (
          table: "visit_events" | "comments" | "reactions",
          kind?: "like" | "favorite",
        ) => {
          let q = db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as("n"))
            .where("resource_id", "=", id);
          if (kind) q = q.where("kind", "=", kind);
          if (table === "comments") q = q.where("deleted_at", "is", null);
          return Number((await q.executeTakeFirstOrThrow()).n);
        };
        const content = await documentContentStats(db, id, r.format);
        return {
          title: r.title,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          pageWidth: r.page_width ?? "a4",
          words: content.words,
          images: content.images,
          attachments: content.attachments,
          visits: await count("visit_events"),
          likes: await count("reactions", "like"),
          favorites: await count("reactions", "favorite"),
          comments: await count("comments"),
        };
      }
      const rows =
        tab === "visits"
          ? await db
              .selectFrom("visit_events as e")
              .innerJoin("users as u", "u.id", "e.user_id")
              .selectAll("e")
              .select(["u.id as userId", "u.display_name as name"])
              .where("e.resource_id", "=", id)
              .orderBy("e.created_at", "desc")
              .orderBy("e.id", "desc")
              .offset(offset)
              .limit(101)
              .execute()
          : await db
              .selectFrom("audit_events as e")
              .innerJoin("users as u", "u.id", "e.actor_id")
              .selectAll("e")
              .select(["u.id as userId", "u.display_name as name"])
              .where("e.resource_id", "=", id)
              .orderBy("e.created_at", "desc")
              .orderBy("e.id", "desc")
              .offset(offset)
              .limit(101)
              .execute();
      return {
        items: rows.slice(0, 100),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    },
  };
}
