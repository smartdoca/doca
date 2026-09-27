import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { activeActor, accessibleQuery } from "../access/queries.js";
import { sql } from "kysely";
import { createTickets } from "../tickets/service.js";
import { reconcileHumanTasks } from "../knowledge/human-tasks.js";
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
      const libs = await db
        .selectFrom("resources as r")
        .select("r.id")
        .where("r.kind", "=", "library")
        .where("r.ai_curated", "=", 1)
        .where(accessibleQuery(sql.ref("r.id"), actor, 4))
        .execute();
      const items = [];
      for (const lib of libs) {
        for (const x of await reconcileHumanTasks(db, actor, lib.id))
          items.push({
            id: x.id,
            title: x.title,
            updatedAt: x.updated_at,
            href: `#/r/${lib.id}?view=system`,
          });
      }
      return { kind: "curation", more: false, items };
    })(),
  ]);
  return {
    ownedDocuments: Number(owned.n),
    libraries: Number(libraries.n),
    todos: results.map((result, i) =>
      result.status === "fulfilled"
        ? { ...result.value, status: "ready" }
        : {
            kind: i === 0 ? "tickets" : "curation",
            status: "error",
            more: false,
            items: [],
          },
    ),
  };
}
