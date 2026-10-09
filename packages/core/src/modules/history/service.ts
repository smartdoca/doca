import { requireCapability } from "../access/operation-policy.js";
import { sql, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { applyUpdate, Doc, encodeStateAsUpdate } from "@smartdoca/slate/yjs";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
import type { Action } from "../access/policy.js";
import { authorize } from "../access/queries.js";
import { recordAudit as audit } from "../audit/events.js";
import {
  b64,
  plainText,
  restoreDocument,
  unb64,
} from "../collaboration/documents.js";
import {
  restoreMarkdown,
  validateMarkdown,
} from "../documents/codecs/markdown.js";
import { DocaYjsDocument as YjsDocument } from "../documents/codecs/rich-runtime.js";
import { restoreSurface } from "../documents/codecs/surfaces.js";
import { type Actor } from "../identity/passwords.js";
import { recordVersion, recoveryMetadata } from "./repository.js";
import { readHistorySnapshot } from "./archive.js";
export function createHistory(db: DB) {
  async function access(
    tx: DB | Transaction<Schema>,
    actor: Actor | null,
    id: string,
    minimum: number | Action = "read_content",
  ) {
    return (await authorize(tx, actor, id, minimum)).resource;
  }
  async function locked<T>(fn: (tx: Transaction<Schema>) => Promise<T>) {
    return transact(db, async (tx) => {
      return fn(tx);
    });
  }
  return {
    async versions(actor: Actor | null, id: string, cursor?: string) {
      return locked(async (tx) => {
        await access(tx, actor, id, "read_history");
        let query = tx
          .selectFrom("document_versions as v")
          .innerJoin("users as u", "u.id", "v.author_id")
          .select([
            "v.id",
            "v.seq",
            "v.title",
            "v.created_at",
            "v.author_id",
            "v.recovery_json",
            "u.display_name",
          ])
          .where("v.resource_id", "=", id);
        let archiveQuery = tx
          .selectFrom("document_version_archives as a")
          .innerJoin("users as u", "u.id", "a.author_id")
          .select([
            "a.id",
            "a.seq",
            "a.title",
            "a.created_at",
            "a.author_id",
            "a.is_ai",
            "u.display_name",
          ])
          .where("a.resource_id", "=", id);
        const fingerprint = cursorFingerprint({ kind: "versions", id });
        if (cursor) {
          const c = decodePageCursor(cursor, fingerprint);
          query = query.where(
            sql<boolean>`(v.created_at < ${c.value} or (v.created_at = ${c.value} and v.id < ${c.id}))`,
          );
          archiveQuery = archiveQuery.where(
            sql<boolean>`(a.created_at < ${c.value} or (a.created_at = ${c.value} and a.id < ${c.id}))`,
          );
        }
        const recent = await query
          .orderBy("v.created_at", "desc")
          .orderBy("v.id", "desc")
          .limit(101)
          .execute();
        const archived = await archiveQuery
          .orderBy("a.created_at", "desc")
          .orderBy("a.id", "desc")
          .limit(101)
          .execute();
        const rows = [
          ...recent.map(({ recovery_json, ...row }) => ({
            ...row,
            is_ai: !!recovery_json && JSON.parse(recovery_json).origin === "ai",
          })),
          ...archived.map((row) => ({ ...row, is_ai: !!row.is_ai })),
        ].sort((a, b) =>
          a.created_at === b.created_at
            ? a.id < b.id
              ? 1
              : a.id > b.id
                ? -1
                : 0
            : a.created_at < b.created_at
              ? 1
              : -1,
        );
        const items = rows.slice(0, 100);
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > 100 && last
              ? encodePageCursor(fingerprint, last.created_at, last.id)
              : null,
        };
      });
    },
    async snapshot(actor: Actor, id: string) {
      return locked(async (tx) => {
        const r = await access(tx, actor, id, "create_history");
        await requireCapability(tx, actor.id, "history.create");
        await requireCapability(tx, r.owner_id, "history.create");
        if (["spreadsheet", "canvas", "presentation"].includes(r.format)) {
          const loaded = await restoreSurface(tx, id, r.format),
            snapshotId = randomUUID();
          await recordVersion(tx, {
            id: snapshotId,
            resource_id: id,
            seq: loaded.state.seq,
            checkpoint: b64(loaded.update),
            title: r.title,
            author_id: actor.id,
            created_at: new Date().toISOString(),
          });
          await audit(tx, actor, id, "document.snapshot_created");
          return { id: snapshotId };
        }
        if (
          !["rich_text", "markdown"].includes(r.format) ||
          r.kind !== "document"
        )
          fail(409, "当前类型尚不支持内容快照");
        const loaded =
          r.format === "markdown"
            ? await restoreMarkdown(tx, id)
            : await restoreDocument(tx, id);
        try {
          if (!loaded.state) fail(409, "请先打开文档以初始化内容");
          const row = {
            id: randomUUID(),
            resource_id: id,
            seq: loaded.state.seq,
            checkpoint: b64(encodeStateAsUpdate(loaded.doc)),
            title: r.title,
            author_id: actor.id,
            created_at: new Date().toISOString(),
          };
          await recordVersion(tx, row);
          await audit(tx, actor, id, "document.snapshot_created");
          return { id: row.id };
        } finally {
          loaded.destroy();
        }
      });
    },
    async version(actor: Actor | null, id: string, versionId: string) {
      const resource = await access(db, actor, id, "read_history");
      const row = await readHistorySnapshot(db, id, versionId);
      if (!row) fail(404, "版本不存在");
      const metadata = recoveryMetadata(row);
      if (metadata.format !== resource.format)
        fail(409, "历史版本格式与当前文档不一致");
      if (["spreadsheet", "canvas", "presentation"].includes(resource.format)) {
        const loaded = await restoreSurface(db, id, resource.format);
        return {
          id: row.id,
          title: row.title,
          createdAt: row.created_at,
          currentSeq: loaded.state.seq,
          canRestore: false,
          surface: {
            format: resource.format,
            epochId: metadata.epochId,
            baseline: metadata.baseline,
            update: row.checkpoint,
          },
          text: "",
        };
      }
      if (resource.format === "markdown") {
        const doc = new Doc();
        try {
          applyUpdate(doc, unb64(row.checkpoint, 16 * 1024 * 1024));
          validateMarkdown(doc);
          return {
            id: row.id,
            title: row.title,
            createdAt: row.created_at,
            markdown: doc.getText("markdown").toString(),
            text: doc.getText("markdown").toString(),
            currentSeq:
              (
                await db
                  .selectFrom("document_states")
                  .select("seq")
                  .where("resource_id", "=", id)
                  .executeTakeFirst()
              )?.seq ?? 0,
          };
        } finally {
          doc.destroy();
        }
      }
      const doc = new Doc(),
        runtime = new YjsDocument(doc);
      try {
        applyUpdate(doc, unb64(row.checkpoint, 16 * 1024 * 1024));
        return {
          id: row.id,
          title: row.title,
          createdAt: row.created_at,
          text: plainText(runtime.getValue()),
          value: runtime.getValue(),
          currentSeq:
            (
              await db
                .selectFrom("document_states")
                .select("seq")
                .where("resource_id", "=", id)
                .executeTakeFirst()
            )?.seq ?? 0,
        };
      } finally {
        runtime.destroy();
        doc.destroy();
      }
    },
  };
}
