import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor, accessibleQuery } from "../access/queries.js";
import { sql } from "kysely";
import { createTickets } from "../tickets/service.js";
import { listBookHumanTasks } from "../knowledge-books/human-tasks.js";
import { entryQuery } from "../resources/queries.js";
import { distributionPolicy } from "../deployment/policies.js";
import { distributionBehavior } from "../access/distribution-behavior.js";
export async function homeOverview(db: DB, actor: Actor) {
  await activeActor(db, actor);
  const policy = await distributionPolicy(db);
  const owned = await db
    .selectFrom("resources as r")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("r.owner_id", "=", actor.id)
    .where("r.kind", "=", "document")
    .where(accessibleQuery(sql.ref("r.id"), actor))
    .executeTakeFirstOrThrow();
  const libraries = await db
    .selectFrom("resources as r")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("r.kind", "=", "library")
    .where(
      sql<boolean>`not exists(select 1 from knowledge_books book where book.id = r.id)`,
    )
    .where(accessibleQuery(sql.ref("r.id"), actor))
    .where(
      entryQuery(
        sql.ref("r.id"),
        actor.id,
        distributionBehavior(policy, "library").includeGranted,
      ),
    )
    .executeTakeFirstOrThrow();
  const results = await Promise.allSettled([
    (async () => {
      const page = await createTickets(db).list(actor, {
        onlyMine: true,
        status: "pending",
      });
      return {
        kind: "tickets",
        more: page.nextOffset !== null,
        items: page.items.map((x) => ({
          id: x.id,
          title: x.resource?.title ?? x.message,
          updatedAt: x.updatedAt,
          href: `#/tickets/${x.id}`,
        })),
      };
    })(),
    (async () => {
      const page = await listBookHumanTasks(db, actor, {status:"pending"});
      return {kind:"knowledge-books", more:page.nextOffset !== null, items:page.items.map(task=>({id:task.id,title:task.title || task.book_title,updatedAt:task.updated_at,href:`#/knowledge-books/${task.book_id}?task=${task.id}&run=${task.run_id}`}))};
    })(),
  ]);
  return {
    ownedDocuments: Number(owned.n),
    libraries: Number(libraries.n),
    todos: results.map((result, i) =>
      result.status === "fulfilled"
        ? { ...result.value, status: "ready" }
        : {
            kind: i === 0 ? "tickets" : "knowledge-books",
            status: "error",
            more: false,
            items: [],
          },
    ),
  };
}
