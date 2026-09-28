import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import {
  noteOwner,
  presentNote,
  listNotes,
  saveNote,
  trashNote,
} from "@core/modules/quick-notes/service.js";
import {
  compilation,
  generateCompilation,
  publishCompilation,
} from "../services/notes/compile.js";

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    fail(400, "参数无效：" + parsed.error.issues[0]?.message);
  return parsed.data;
};
const idParams = z.object({ id: z.string().uuid() });
export function registerQuickNotes(
  api: FastifyInstance,
  db: DB,
  auth: (r: FastifyRequest) => Actor,
  fetcher?: typeof fetch,
) {
  const base = "/api/v1/quick-notes";
  const idOf = (req: FastifyRequest) => parse(idParams, req.params).id;
  api.get(base, async (req) => {
    const actor = auth(req);
    const q = parse(
      z.object({
        q: z.string().max(200).default(""),
        trash: z.enum(["0", "1"]).default("0"),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      }),
      req.query,
    );
    return listNotes(db, actor.id, q.q, q.trash === "1", q.offset);
  });
  api.get(base + "/compilations", async (req) => {
    const actor = auth(req);
    const rows = await db
      .selectFrom("quick_note_compilations")
      .select([
        "id",
        "status",
        "document_id",
        "created_at",
        "updated_at",
        "error",
      ])
      .where("owner_id", "=", actor.id)
      .orderBy("created_at", "desc")
      .limit(30)
      .execute();
    return { items: rows };
  });
  api.post(base + "/compilations", { bodyLimit: 16384 }, async (req) => {
    const actor = auth(req);
    const input = parse(
      z
        .object({
          id: z.string().uuid(),
          notes: z
            .array(
              z
                .object({
                  id: z.string().uuid(),
                  version: z.number().int().positive(),
                })
                .strict(),
            )
            .min(1)
            .max(20),
          instruction: z.string().max(2000).default(""),
          modelId: z.string().min(1).max(160),
        })
        .strict(),
      req.body,
    );
    return generateCompilation(db, actor, input, fetcher);
  });
  api.get(base + "/compilations/:id", async (req) => {
    const row = await compilation(db, auth(req).id, idOf(req));
    return row.status === "running" &&
      Date.now() - Date.parse(row.updated_at) > 120000
      ? {
          ...row,
          status: "failed",
          error: "整理已中断或超时，请重新发起；原始记录仍然保留",
        }
      : row;
  });
  api.post(
    base + "/compilations/:id/document",
    { bodyLimit: 256 * 1024 },
    async (req) => {
      const actor = auth(req);
      const { markdown } = parse(
        z.object({ markdown: z.string().trim().min(1).max(60000) }).strict(),
        req.body,
      );
      return publishCompilation(db, actor, idOf(req), markdown);
    },
  );
  api.get(base + "/:id", async (req) =>
    presentNote(db, await noteOwner(db, auth(req).id, idOf(req), true)),
  );
  api.put(base + "/:id", { bodyLimit: 160 * 1024 }, async (req) =>
    saveNote(db, auth(req).id, idOf(req), req.body),
  );
  api.patch(base + "/:id", { bodyLimit: 160 * 1024 }, async (req) => {
    const actor = auth(req);
    const { version, ...body } = parse(
      z
        .object({
          version: z.number().int().positive(),
          content: z.unknown(),
          assetIds: z.unknown(),
        })
        .strict(),
      req.body,
    );
    return saveNote(db, actor.id, idOf(req), body, version);
  });
  api.post(base + "/:id/trash", async (req) => {
    const actor = auth(req);
    const input = parse(
      z
        .object({ version: z.number().int().positive(), deleted: z.boolean() })
        .strict(),
      req.body,
    );
    return trashNote(db, actor.id, idOf(req), input.version, input.deleted);
  });
}
