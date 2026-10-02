import { createHash } from "node:crypto";
import { sql } from "kysely";
import type {
  DirectorySource,
  DirectoryRelation,
} from "@smartdoca/plugin-contracts";
import type { DB } from "../../../../db/src/index.js";
import { readSnapshot } from "../../../../db/src/transactions.js";

async function documentRelations(
  db: DB,
  principalId: string,
): Promise<DirectoryRelation[]> {
  const read = async (db: DB) => {
    const rows = await sql<{
      id: string;
      resource_id: string;
      revision: number;
    }>`with recursive
    memberships as (
      select g.resource_id, g.user_id from grants g where g.status = 'active'
    ),
    owned_nodes as (
      select r.* from resources r where r.owner_id = ${principalId}
      union select r.* from resources r join memberships m on m.resource_id = r.id where m.user_id = ${principalId}
      union select r.* from resources r join resources l on r.library_id = l.id where l.owner_id = ${principalId}
    ),
    descendants as (
      select * from owned_nodes
      union select c.* from resources c join descendants p on coalesce(c.parent_id, c.library_id) = p.id where c.access_mode = 'inherit'
    ),
    nodes as (
      select * from descendants
      union select p.* from resources p join nodes c on p.id = coalesce(c.parent_id, c.library_id) where c.access_mode = 'inherit'
    ),
    live as (select n.* from nodes n where n.deleted_at is null and not exists(select 1 from resources l where l.id = n.library_id and l.deleted_at is not null)),
    participants as (
      select n.owner_id as id, n.id as resource_id, n.authz_revision as revision from live n
      union select l.owner_id, l.id, l.authz_revision from live n join resources l on l.id = n.library_id
      union select m.user_id, n.id, n.authz_revision from memberships m join live n on n.id = m.resource_id
    ) select u.id, p.resource_id, p.revision from users u join participants p on p.id = u.id where u.status = 'active' order by u.id, p.resource_id, p.revision`.execute(
      db,
    );

    const byUser = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) {
      const facts = byUser.get(row.id) ?? [];
      facts.push(row);
      byUser.set(row.id, facts);
    }
    return [...byUser].map(([userId, facts]) => ({
      userId,
      relationId: `participant:${userId}`,
      revision: createHash("sha256")
        .update(JSON.stringify(facts))
        .digest("hex"),
    }));
  };
  return db.isTransaction ? read(db) : readSnapshot(db, read);
}

function source(
  id: string,
  read: (principalId: string) => Promise<DirectoryRelation[]>,
): DirectorySource {
  return {
    id,
    schemaVersion: 1,
    async related(principalId, input) {
      input.signal.throwIfAborted();
      const rows = (await read(principalId)).sort((a, b) =>
        a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
      );
      input.signal.throwIfAborted();
      const remaining =
        input.cursor === null
          ? rows
          : rows.filter((row) => row.userId > input.cursor!);
      return {
        items: remaining.slice(0, input.limit),
        cursor:
          remaining.length > input.limit
            ? remaining[input.limit - 1]!.userId
            : null,
      };
    },
    async verify(principalId, candidates, signal) {
      signal.throwIfAborted();
      const current = new Map(
        (await read(principalId)).map((row) => [row.userId, row]),
      );
      signal.throwIfAborted();
      return candidates
        .filter((row) => {
          const fresh = current.get(row.userId);
          return (
            fresh?.relationId === row.relationId &&
            fresh.revision === row.revision
          );
        })
        .map((row) => row.userId);
    },
  };
}

export function builtinDirectorySources(database: () => DB): DirectorySource[] {
  return [
    source("doca.documents.directory", (principalId) =>
      documentRelations(database(), principalId),
    ),
    source("doca.files.directory", async (principalId) => {
      const db = database();
      const rows = await db
        .selectFrom("file_folders as f")
        .leftJoin("file_folder_shares as own", (join) =>
          join
            .onRef("own.folder_id", "=", "f.id")
            .on("own.user_id", "=", principalId),
        )
        .leftJoin("file_folder_shares as member", "member.folder_id", "f.id")
        .select([
          "f.id",
          "f.owner_id",
          "f.version",
          "member.user_id",
          "member.role",
        ])
        .where("f.deleted_at", "is", null)
        .where("f.parent_id", "=", "shared")
        .where((eb) =>
          eb.or([
            eb("f.owner_id", "=", principalId),
            eb("own.user_id", "=", principalId),
          ]),
        )
        .orderBy("f.id")
        .orderBy("member.user_id")
        .execute();
      const byUser = new Map<string, typeof rows>();
      for (const row of rows)
        for (const id of [row.owner_id, row.user_id]) {
          if (!id) continue;
          const facts = byUser.get(id) ?? [];
          facts.push(row);
          byUser.set(id, facts);
        }
      return [...byUser].map(([userId, facts]) => ({
        userId,
        relationId: `shared-folder:${userId}`,
        revision: createHash("sha256")
          .update(JSON.stringify(facts))
          .digest("hex"),
      }));
    }),
  ];
}
