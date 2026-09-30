import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import type { ContentReference } from "@smartdoca/plugin-sdk/content";
import { contentSubscriptionInventory } from "./content-subscriptions.js";
import { contentReferenceKey } from "../content/service.js";

const checking = new AsyncLocalStorage<ReadonlySet<string>>();
const decisions = new AsyncLocalStorage<Map<string, boolean>>();
const signature = (
  entry: {
    id: string;
    source_refs: string;
    review_state: string;
    status: string;
  },
  reader?: Actor | null,
) =>
  JSON.stringify([
    entry.id,
    entry.status,
    entry.source_refs,
    entry.review_state,
    reader === undefined ? "provenance" : (reader?.id ?? "anonymous"),
  ]);
/** Resolve external authorization before entering a database transaction. */
export async function withContentDocumentAccess<T>(
  db: DB,
  reader: Actor | null | undefined,
  run: () => Promise<T>,
  targetIds?: readonly string[],
): Promise<T> {
  if (decisions.getStore()) return run();
  return decisions.run(new Map(), async () => {
    const entries = await db
      .selectFrom("knowledge_entries")
      .select(["review_state", "library_id"])
      .where("status", "in", ["published", "deleted"])
      .where("source_refs", "like", '%"contentRef"%')
      .execute();
    const ids = entries
      .map((entry) => JSON.parse(entry.review_state).nodeId)
      .filter((id): id is string => typeof id === "string");
    const candidates = ids.length
      ? await db
          .selectFrom("resources")
          .select(["id", "library_id"])
          .where("id", "in", ids)
          .execute()
      : [];
    const resources = candidates.filter(
      (row) =>
        !targetIds ||
        targetIds.includes(row.id) ||
        (!!row.library_id && targetIds.includes(row.library_id)),
    );
    await blockedContentDocuments(db, resources, reader);
    // Canonical snapshots use provenance-only checks within the same operation.
    if (reader !== undefined) await blockedContentDocuments(db, resources);
    return run();
  });
}
/** Live guard, no deletion or rewriting of retained content. Errors fail closed for this response. */
export async function blockedContentDocuments(
  db: DB,
  resources: readonly { id: string; library_id: string | null }[],
  reader?: Actor | null,
) {
  const blocked = new Set<string>();
  if (!resources.length) return blocked;
  const targets = new Set(resources.map((r) => r.id));
  const entries = await db
    .selectFrom("knowledge_entries")
    .select(["id", "library_id", "review_state", "source_refs", "status"])
    .where("source_refs", "like", '%"contentRef"%')
    .where("status", "in", ["published", "deleted"])
    .execute();
  const inventories = new Map<string, Promise<Map<string, string>>>();
  for (const entry of entries) {
    const nodeId = JSON.parse(entry.review_state).nodeId;
    if (typeof nodeId !== "string" || !targets.has(nodeId)) continue;
    const refs = JSON.parse(entry.source_refs) as {
      subscriptionId: string;
      contentRef?: ContentReference;
      version: string;
    }[];
    const contentRefs = refs.filter((ref) => ref.contentRef);
    if (!contentRefs.length) continue;
    const key = signature(entry, reader);
    if (entry.status === "deleted") {
      blocked.add(nodeId);
      decisions.getStore()?.set(key, true);
      continue;
    }
    const known = decisions.getStore()?.get(key);
    if (known !== undefined) {
      if (known) blocked.add(nodeId);
      continue;
    }
    if (db.isTransaction) {
      blocked.add(nodeId);
      continue;
    }

    if (reader === null || checking.getStore()?.has(entry.id)) {
      blocked.add(nodeId);
      continue;
    }
    await checking.run(
      new Set([...(checking.getStore() ?? []), entry.id]),
      async () => {
        for (const ref of contentRefs) {
          try {
            const source = await db
              .selectFrom("knowledge_subscriptions")
              .selectAll()
              .where("id", "=", ref.subscriptionId)
              .where("library_id", "=", entry.library_id)
              .executeTakeFirst();
            if (
              !source ||
              source.status === "detached" ||
              source.source_kind !== "content" ||
              !source.creator_id
            ) {
              blocked.add(nodeId);
              break;
            }
            const owner = await db
              .selectFrom("users")
              .select(["id", "display_name", "admin"])
              .where("id", "=", source.creator_id)
              .where("status", "=", "active")
              .executeTakeFirst();
            if (!owner) {
              blocked.add(nodeId);
              break;
            }
            const principals =
              reader && reader.id !== owner.id ? [owner, reader] : [owner];
            for (const principal of principals) {
              const key = JSON.stringify([source.id, principal.id]);
              let inventory = inventories.get(key);
              if (!inventory) {
                inventory = contentSubscriptionInventory(
                  db,
                  principal,
                  source,
                ).then(
                  (result) =>
                    new Map(
                      result.items.map((item) => [
                        contentReferenceKey(item.ref),
                        item.fingerprint,
                      ]),
                    ),
                );
                inventories.set(key, inventory);
              }
              if (
                (await inventory).get(contentReferenceKey(ref.contentRef!)) !==
                ref.version
              ) {
                blocked.add(nodeId);
                break;
              }
            }
            if (blocked.has(nodeId)) break;
          } catch {
            blocked.add(nodeId);
            break;
          }
        }
      },
    );
    decisions.getStore()?.set(key, blocked.has(nodeId));
  }
  return blocked;
}
