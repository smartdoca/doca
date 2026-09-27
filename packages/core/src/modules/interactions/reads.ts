import { sql, type Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
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
    async likes(actor: Actor | null, id: string, offset = 0, cursor?: string) {
      await access(db, actor, id);
      let base = db
        .selectFrom("reactions as r")
        .innerJoin("users as u", "u.id", "r.user_id")
        .where("r.resource_id", "=", id)
        .where("r.kind", "=", "like");
      const fingerprint = cursorFingerprint({ kind: "likes", id });
      if (cursor) {
        const c = decodePageCursor(cursor, fingerprint);
        base = base.where(
          sql<boolean>`(u.display_name > ${c.value} or (u.display_name = ${c.value} and u.id > ${c.id}))`,
        );
      }
      const total = cursor
        ? null
        : Number(
            (
              await base
                .select((eb) => eb.fn.countAll().as("n"))
                .executeTakeFirstOrThrow()
            ).n,
          );
      const rows = await base
        .select(["u.id", "u.display_name"])
        .orderBy("u.display_name")
        .orderBy("u.id")
        .offset(cursor ? 0 : offset)
        .limit(101)
        .execute();
      const items = rows.slice(0, 100);
      const last = items.at(-1);
      return {
        total,
        items,
        nextOffset: rows.length > 100 ? offset + 100 : null,
        nextCursor:
          rows.length > 100 && last
            ? encodePageCursor(fingerprint, last.display_name, last.id)
            : null,
      };
    },
    async info(
      actor: Actor | null,
      id: string,
      tab: string,
      offset = 0,
      cursor?: string,
    ) {
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
      const fingerprint = cursorFingerprint({ kind: "document-info", id, tab });
      const c = cursor ? decodePageCursor(cursor, fingerprint) : null;
      let visitQuery = db
        .selectFrom("visit_events as e")
        .innerJoin("users as u", "u.id", "e.user_id")
        .selectAll("e")
        .select(["u.id as userId", "u.display_name as name"])
        .where("e.resource_id", "=", id);
      let auditQuery = db
        .selectFrom("audit_events as e")
        .innerJoin("users as u", "u.id", "e.actor_id")
        .selectAll("e")
        .select(["u.id as userId", "u.display_name as name"])
        .where("e.resource_id", "=", id);
      if (c) {
        const after = sql<boolean>`(e.created_at < ${c.value} or (e.created_at = ${c.value} and e.id < ${c.id}))`;
        visitQuery = visitQuery.where(after);
        auditQuery = auditQuery.where(after);
      }
      const rows =
        tab === "visits"
          ? await visitQuery
              .orderBy("e.created_at", "desc")
              .orderBy("e.id", "desc")
              .offset(cursor ? 0 : offset)
              .limit(101)
              .execute()
          : await auditQuery
              .orderBy("e.created_at", "desc")
              .orderBy("e.id", "desc")
              .offset(cursor ? 0 : offset)
              .limit(101)
              .execute();
      const items = rows.slice(0, 100);
      const last = items.at(-1);
      return {
        items,
        nextOffset: rows.length > 100 ? offset + 100 : null,
        nextCursor:
          rows.length > 100 && last
            ? encodePageCursor(fingerprint, last.created_at, last.id)
            : null,
      };
    },
  };
}
