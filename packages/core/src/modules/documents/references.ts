import type { Transaction } from "kysely";
import type { DB, Schema } from "../../../../db/src/index.js";
export function documentReferenceIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const node = n as Record<string, unknown>;
    if (
      node.type === "custom:document-reference" &&
      typeof node.documentId === "string" &&
      /^[a-f0-9-]{36}$/.test(node.documentId)
    )
      ids.add(node.documentId);
    const url =
      node.type === "link"
        ? node.url
        : (node._link as { url?: string } | undefined)?.url;
    if (typeof url === "string") {
      const id = /^#\/r\/([a-f0-9-]{36})(?:\?|$)/i.exec(url)?.[1];
      if (id) ids.add(id.toLowerCase());
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(value);
  return ids;
}
export async function indexDocumentReferences(
  tx: DB | Transaction<Schema>,
  id: string,
  value: unknown,
) {
  await tx
    .deleteFrom("document_references")
    .where("source_id", "=", id)
    .execute();
  const ids = [...documentReferenceIds(value)].filter(
    (target) => target !== id,
  );
  if (ids.length)
    await tx
      .insertInto("document_references")
      .values(ids.map((target) => ({ source_id: id, target_id: target })))
      .execute();
}
