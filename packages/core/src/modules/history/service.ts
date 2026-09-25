import { requireCapability } from "../access/operation-policy.js";
import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { applyUpdate, Doc, encodeStateAsUpdate } from "slatetsx-kit-editor/yjs";
import type { DB, Schema } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
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
    async versions(actor: Actor | null, id: string, offset = 0) {
      const resource = await access(db, actor, id, "read_history");
      const rows = await db
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
        .where("v.resource_id", "=", id)
        .orderBy("v.created_at", "desc")
        .orderBy("v.id", "desc")
        .offset(offset)
        .limit(101)
        .execute();
      return {
        items: rows.slice(0, 100).map(({ recovery_json, ...row }) => ({
          ...row,
          is_ai: !!recovery_json && JSON.parse(recovery_json).origin === "ai",
        })),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
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
      const row = await db
        .selectFrom("document_versions")
        .selectAll()
        .where("resource_id", "=", id)
        .where("id", "=", versionId)
        .executeTakeFirst();
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
