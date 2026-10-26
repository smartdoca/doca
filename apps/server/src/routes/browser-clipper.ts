import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { tokenHash, type Actor } from "@core/modules/identity/passwords.js";
import { securityAudit } from "@core/modules/identity/accounts.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import { createContent } from "@core/workflows/resources.js";
import {
  authenticateBrowserConnection,
  cancelBrowserJobs,
} from "@core/modules/browser-clipper/access.js";
import { fail } from "@core/shared/errors.js";
import type { StorageRuntime } from "../adapters/storage.js";
import {
  createBrowserClipper,
  publicProfile,
  validateClipperTarget,
  describeClipperProfile,
} from "../services/browser-clipper.js";
import {
  captureInput,
  profileInput,
  parseClipper,
} from "../services/browser-clipper-protocol.js";
import {
  browserExtensionPackage,
  browserExtensionRelease,
} from "../services/browser-clipper-package.js";
import { uploadLimits } from "../services/storage-policy.js";
import {
  createBrowserQuickNote,
  quickNoteInput,
  quickNoteCommit,
} from "../services/browser-quick-note.js";

export const browserClipperRoute = { config: { docaBrowserClipper: true } };
const idSchema = z.object({ id: z.string().uuid() }).strict();
const revisionSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();
const publicConnection = ({
  token_hash: _secret,
  ...row
}: Schema["browser_clipper_connections"]) => row;

export function registerBrowserClipper(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  origin: string,
  storage: StorageRuntime,
  notify: (id: string) => Promise<unknown>,
  limit: (key: string, max?: number) => Promise<void>,
) {
  const management = "/api/v1/me/browser-clipper",
    external = "/api/v1/browser-clipper";
  const service = createBrowserClipper(db, storage, notify);
  const quickNote = createBrowserQuickNote(db, origin, notify);
  api.get(`${external}/release`, async () => browserExtensionRelease());
  api.get(`${external}/quick-note/targets`, browserClipperRoute, (req) =>
    quickNote.targets(req.headers.authorization),
  );
  api.post(
    `${external}/quick-note/prepare`,
    { ...browserClipperRoute, bodyLimit: 100 * 1024 },
    async (req) => {
      const { actor } = await authenticateBrowserConnection(db, req.headers.authorization);
      await limit(`clipper-quick-note:${actor.id}`, 60);
      return quickNote.prepare(req.headers.authorization, parseClipper(quickNoteInput, req.body));
    },
  );
  api.post(`${external}/quick-note/commit`, browserClipperRoute, (req) =>
    quickNote.commit(req.headers.authorization, parseClipper(quickNoteCommit, req.body)),
  );
  async function owned(req: FastifyRequest, tx = db) {
    const actor = auth(req),
      id = parseClipper(idSchema, req.params).id;
    const row = await tx
      .selectFrom("browser_clipper_connections")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (!row) fail(404, "clipper_connection_missing");
    return row;
  }
  api.get(`${management}/profiles`, async (req) => ({
    items: await Promise.all(
      (
        await db
          .selectFrom("browser_clipper_profiles")
          .selectAll()
          .where("user_id", "=", auth(req).id)
          .orderBy("created_at")
          .execute()
      ).map((profile) => describeClipperProfile(db, auth(req), profile)),
    ),
  }));
  for (const method of ["POST", "PUT"] as const)
    api.route({
      method,
      url: management + "/profiles" + (method === "PUT" ? "/:id" : ""),
      async handler(req) {
        const actor = auth(req),
          input = parseClipper(
            method === "PUT"
              ? profileInput.extend({ revision: z.number().int().positive() })
              : profileInput,
            req.body,
          );
        const bodyRevision =
          method === "PUT"
            ? parseClipper(revisionSchema.passthrough(), req.body).revision
            : 0;
        return transact(db, async (tx) => {
          await lockAIUser(tx, actor.id);
          if (input.enabled) await validateClipperTarget(tx, actor, input);
          const id =
              method === "PUT"
                ? parseClipper(idSchema, req.params).id
                : randomUUID(),
            now = new Date().toISOString();
          const old = await tx
            .selectFrom("browser_clipper_profiles")
            .selectAll()
            .where("id", "=", id)
            .where("user_id", "=", actor.id)
            .executeTakeFirst();
          if (method === "PUT" && (!old || old.revision !== bodyRevision))
            fail(409, "clipper_profile_changed");
          if (input.isDefault)
            await tx
              .updateTable("browser_clipper_profiles")
              .set({ is_default: 0 })
              .where("user_id", "=", actor.id)
              .execute();
          const row: Schema["browser_clipper_profiles"] = {
            id,
            user_id: actor.id,
            name: input.name,
            enabled: Number(input.enabled),
            is_default: Number(input.isDefault),
            strategy: input.strategy,
            library_id: input.libraryId,
            parent_id: input.parentId,
            target_id: input.targetId,
            title_template: input.titleTemplate,
            ai_instruction: input.aiInstruction,
            revision: (old?.revision ?? 0) + 1,
            created_at: old?.created_at ?? now,
            updated_at: now,
          };
          if (old)
            await tx
              .updateTable("browser_clipper_profiles")
              .set(row)
              .where("id", "=", id)
              .execute();
          else
            await tx
              .insertInto("browser_clipper_profiles")
              .values(row)
              .execute();
          return publicProfile(row);
        });
      },
    });
  api.get(`${management}/destinations`, async (req) => {
    const query = parseClipper(
      z
        .object({
          q: z.string().max(160).optional(),
          cursor: z.string().max(4000).optional(),
          kind: z.enum(["document", "library"]).optional(),
          libraryId: z.string().uuid().optional(),
        })
        .strict(),
      req.query,
    );
    const page = await createContent(db).list(auth(req), {
      ...query,
      scope: "all",
    });
    const books = new Set(
      (await db.selectFrom("knowledge_books").select("id").execute()).map(
        (book) => book.id,
      ),
    );
    return {
      items: page.items
        .filter(
          (item) =>
            ["owner", "manager", "editor"].includes(item.role) &&
            !books.has(item.id) &&
            (!item.library_id || !books.has(item.library_id)),
        )
        .map((item) => ({
          id: item.id,
          title: item.title,
          kind: item.kind,
          format: item.format,
          libraryId: item.library_id,
          parentId: item.parent_id,
        })),
      nextCursor: page.nextCursor,
    };
  });
  api.get(`${management}/connections`, async (req) => ({
    items: await Promise.all(
      (
        await db
          .selectFrom("browser_clipper_connections")
          .selectAll()
          .where("user_id", "=", auth(req).id)
          .orderBy("created_at", "desc")
          .execute()
      ).map(async (row) => {
        const live = await db
          .selectFrom("browser_clipper_web_sessions as b")
          .innerJoin("sessions as s", "s.id", "b.website_session_id")
          .select("s.id")
          .where("b.connection_id", "=", row.id)
          .where("s.user_id", "=", row.user_id)
          .where("s.expires_at", ">", new Date().toISOString())
          .executeTakeFirst();
        return { ...publicConnection(row), signedIn: !!live };
      }),
    ),
  }));
  api.post(`${management}/download`, async (_req, reply) => {
    auth(_req);
    const release = await browserExtensionRelease();
    const pack = await browserExtensionPackage();
    return reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${release.filename}"`,
      )
      .send(pack({ version: 2, origin }));
  });
  api.get(`${management}/config`, async (req) => {
    auth(req);
    return { config: { version: 2, origin } };
  });
  api.post(`${management}/authorize`, async (req) => {
    const actor = auth(req);
    const websiteToken = /(?:^|;\s*)doca_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie ?? "",
    )?.[1];
    if (
      !websiteToken ||
      req.headers.authorization ||
      req.headers.origin !== origin
    )
      fail(401, "clipper_login_required");
    const websiteSessionId = tokenHash(websiteToken);
    const input = parseClipper(
      z
        .object({
          version: z.literal(2),
          installationId: z.string().uuid(),
          challenge: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      req.body,
    );
    await limit(`clipper-login:${actor.id}`, 120);
    return transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const website = await tx
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", websiteSessionId)
        .where("user_id", "=", actor.id)
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (!website) fail(401, "clipper_login_required");
      let binding = await tx
        .selectFrom("browser_clipper_web_sessions")
        .selectAll()
        .where("user_id", "=", actor.id)
        .where("installation_id", "=", input.installationId)
        .executeTakeFirst();
      const now = new Date().toISOString();
      if (!binding) {
        const connectionId = randomUUID();
        await tx
          .insertInto("browser_clipper_connections")
          .values({
            id: connectionId,
            user_id: actor.id,
            name: "Doca Browser",
            token_hash: null,
            token_hint: null,
            assistant_enabled: 1,
            revoked_at: null,
            expires_at: null,
            revision: 1,
            created_at: now,
            updated_at: now,
          })
          .execute();
        binding = {
          connection_id: connectionId,
          user_id: actor.id,
          installation_id: input.installationId,
          website_session_id: websiteSessionId,
          token_hash: null,
          expires_at: null,
          created_at: now,
          updated_at: now,
        };
        await securityAudit(
          tx,
          actor.id,
          actor.id,
          "browser.connection.created",
          { connectionId },
        );
        await tx
          .insertInto("browser_clipper_web_sessions")
          .values(binding)
          .execute();
      }
      const connection = await tx
        .selectFrom("browser_clipper_connections")
        .selectAll()
        .where("id", "=", binding.connection_id)
        .executeTakeFirstOrThrow();
      if (connection.revoked_at) fail(403, "clipper_connection_revoked");
      const code = randomBytes(32).toString("hex"),
        expiresAt = new Date(Date.now() + 60_000).toISOString();
      await tx
        .insertInto("browser_clipper_login_codes")
        .values({
          code_hash: tokenHash(code),
          connection_id: connection.id,
          website_session_id: websiteSessionId,
          challenge: input.challenge,
          expires_at: expiresAt,
          consumed_at: null,
          created_at: now,
        })
        .execute();
      return { version: 2, code, expiresAt };
    });
  });
  api.post(`${management}/connections/:id/restore`, async (req) => {
    const actor = auth(req),
      input = parseClipper(revisionSchema, req.body);
    return transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const connection = await owned(req, tx);
      if (connection.revision !== input.revision)
        fail(409, "clipper_connection_changed");
      await tx
        .updateTable("browser_clipper_connections")
        .set({
          revoked_at: null,
          revision: connection.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", connection.id)
        .execute();
      await securityAudit(
        tx,
        actor.id,
        actor.id,
        "browser.connection.restored",
        { connectionId: connection.id },
      );
      return { restored: true };
    });
  });
  api.put(`${management}/connections/:id`, async (req) => {
    const actor = auth(req),
      input = parseClipper(
        z
          .object({
            revision: z.number().int().positive(),
            name: z.string().trim().min(1).max(80),
            assistantEnabled: z.boolean(),
          })
          .strict(),
        req.body,
      );
    return transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const row = await owned(req, tx);
      if (row.revision !== input.revision)
        fail(409, "clipper_connection_changed");
      await tx
        .updateTable("browser_clipper_connections")
        .set({
          name: input.name,
          assistant_enabled: Number(input.assistantEnabled),
          revision: row.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", row.id)
        .execute();
      if (!input.assistantEnabled) await cancelBrowserJobs(tx, [row.id]);
      return { saved: true };
    });
  });
  async function revoke(req: FastifyRequest, all: boolean) {
    const actor = auth(req);
    return transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      const rows = all
        ? await tx
            .selectFrom("browser_clipper_connections")
            .selectAll()
            .where("user_id", "=", actor.id)
            .where("revoked_at", "is", null)
            .execute()
        : [await owned(req, tx)];
      if (
        !all &&
        rows[0]!.revision !== parseClipper(revisionSchema, req.body).revision
      )
        fail(409, "clipper_connection_changed");
      const ids = rows.map((row) => row.id),
        now = new Date().toISOString();
      for (const row of rows)
        await tx
          .updateTable("browser_clipper_connections")
          .set({
            token_hash: null,
            revoked_at: now,
            revision: row.revision + 1,
            updated_at: now,
          })
          .where("id", "=", row.id)
          .execute();
      if (ids.length)
        await tx
          .updateTable("browser_clipper_activations")
          .set({ consumed_at: now })
          .where("connection_id", "in", ids)
          .where("consumed_at", "is", null)
          .execute();
      if (ids.length) {
        await tx
          .updateTable("browser_clipper_web_sessions")
          .set({ token_hash: null, expires_at: null })
          .where("connection_id", "in", ids)
          .execute();
        await tx
          .updateTable("browser_clipper_login_codes")
          .set({ consumed_at: now })
          .where("connection_id", "in", ids)
          .where("consumed_at", "is", null)
          .execute();
      }
      await cancelBrowserJobs(tx, ids);
      await securityAudit(
        tx,
        actor.id,
        actor.id,
        all ? "browser.connections.revoked" : "browser.connection.revoked",
        { connectionIds: ids },
      );
      return { revoked: ids.length };
    });
  }
  api.post(`${management}/connections/:id/revoke`, (req) => revoke(req, false));
  api.post(`${management}/revoke-all`, (req) => revoke(req, true));
  api.post(`${external}/token`, browserClipperRoute, async (req) => {
    const input = parseClipper(
      z
        .object({
          version: z.literal(2),
          code: z.string().regex(/^[a-f0-9]{64}$/),
          verifier: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      req.body,
    );
    await limit(`clipper-exchange:${req.ip}`, 120);
    const codeHash = tokenHash(input.code);
    const candidate = await db
      .selectFrom("browser_clipper_login_codes as c")
      .innerJoin("browser_clipper_connections as b", "b.id", "c.connection_id")
      .select("b.user_id")
      .where("c.code_hash", "=", codeHash)
      .executeTakeFirst();
    if (!candidate) fail(401, "clipper_login_invalid");
    return transact(db, async (tx) => {
      await lockAIUser(tx, candidate.user_id);
      const code = await tx
        .selectFrom("browser_clipper_login_codes")
        .selectAll()
        .where("code_hash", "=", codeHash)
        .executeTakeFirst();
      if (
        !code ||
        code.consumed_at ||
        code.expires_at <= new Date().toISOString() ||
        code.challenge !== tokenHash(input.verifier)
      )
        fail(401, "clipper_login_invalid");
      const connection = await tx
        .selectFrom("browser_clipper_connections")
        .selectAll()
        .where("id", "=", code.connection_id)
        .executeTakeFirstOrThrow();
      if (connection.revoked_at) fail(403, "clipper_connection_revoked");
      const website = await tx
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .select("sessions.id")
        .where("sessions.id", "=", code.website_session_id)
        .where("sessions.user_id", "=", connection.user_id)
        .where("sessions.expires_at", ">", new Date().toISOString())
        .where("users.status", "=", "active")
        .executeTakeFirst();
      if (!website) fail(401, "clipper_login_required");
      const binding = await tx
        .selectFrom("browser_clipper_web_sessions")
        .selectAll()
        .where("connection_id", "=", connection.id)
        .executeTakeFirstOrThrow();
      if (binding.website_session_id !== website.id)
        await cancelBrowserJobs(tx, [connection.id]);
      const token = "doca_browser_v2_" + randomBytes(32).toString("hex"),
        now = new Date().toISOString(),
        expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await tx
        .updateTable("browser_clipper_web_sessions")
        .set({
          website_session_id: website.id,
          token_hash: tokenHash(token),
          expires_at: expiresAt,
          updated_at: now,
        })
        .where("connection_id", "=", connection.id)
        .execute();
      await tx
        .updateTable("browser_clipper_login_codes")
        .set({ consumed_at: now })
        .where("code_hash", "=", codeHash)
        .execute();
      await securityAudit(
        tx,
        connection.user_id,
        connection.user_id,
        "browser.connection.signed_in",
        { connectionId: connection.id },
      );
      return {
        version: 2,
        origin,
        userId: connection.user_id,
        connectionId: connection.id,
        token,
        expiresAt,
      };
    });
  });
  api.post(`${external}/disconnect`, browserClipperRoute, async (req) => {
    const { actor, connection } = await authenticateBrowserConnection(
      db,
      req.headers.authorization,
    );
    return transact(db, async (tx) => {
      await lockAIUser(tx, actor.id);
      await tx
        .updateTable("browser_clipper_web_sessions")
        .set({ token_hash: null, expires_at: null })
        .where("connection_id", "=", connection.id)
        .execute();
      await cancelBrowserJobs(tx, [connection.id]);
      return { disconnected: true };
    });
  });
  api.get(`${external}/session`, browserClipperRoute, async (req) => {
    const { connection } = await authenticateBrowserConnection(
      db,
      req.headers.authorization,
    );
    const raw = /(?:^|;\s*)doca_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie ?? "",
    )?.[1];
    const binding = await db
      .selectFrom("browser_clipper_web_sessions")
      .select("website_session_id")
      .where("connection_id", "=", connection.id)
      .executeTakeFirstOrThrow();
    if (!raw || tokenHash(raw) !== binding.website_session_id)
      fail(401, "clipper_login_required");
    return { authenticated: true };
  });
  api.get(`${external}/me`, browserClipperRoute, async (req) => {
    const { actor, connection } = await authenticateBrowserConnection(
      db,
      req.headers.authorization,
    );
    return {
      version: 1,
      origin,
      user: { id: actor.id, name: actor.display_name },
      connection: publicConnection(connection),
    };
  });
  api.get(`${external}/profiles`, browserClipperRoute, async (req) => ({
    items: await Promise.all(
      (
        await db
          .selectFrom("browser_clipper_profiles")
          .selectAll()
          .where("user_id", "=", auth(req).id)
          .where("enabled", "=", 1)
          .orderBy("created_at")
          .execute()
      ).map((profile) => describeClipperProfile(db, auth(req), profile)),
    ),
  }));
  api.post(
    `${external}/clips`,
    { ...browserClipperRoute, bodyLimit: 800 * 1024 },
    async (req) => {
      const { actor, connection } = await authenticateBrowserConnection(
        db,
        req.headers.authorization,
      );
      await limit(`clipper-write:${actor.id}`, 60);
      return service.prepare(
        actor,
        connection.id,
        parseClipper(captureInput, req.body),
      );
    },
  );
  const taskId = z.object({ id: z.string().uuid() }).strict();
  api.get(`${external}/clips/:id`, browserClipperRoute, async (req) => {
    const { actor, connection } = await authenticateBrowserConnection(
      db,
      req.headers.authorization,
    );
    return service.status(
      actor,
      connection.id,
      parseClipper(taskId, req.params).id,
    );
  });
  api.put(
    `${external}/clips/:id/images/:imageId`,
    { ...browserClipperRoute, bodyLimit: uploadLimits.asset },
    async (req) => {
      const { actor, connection } = await authenticateBrowserConnection(
        db,
        req.headers.authorization,
      );
      const ids = parseClipper(
        taskId.extend({ imageId: z.string().uuid() }),
        req.params,
      );
      if (!Buffer.isBuffer(req.body)) fail(400, "clipper_image_invalid");
      return service.upload(
        actor,
        connection.id,
        ids.id,
        ids.imageId,
        req.body,
      );
    },
  );
  api.post(`${external}/clips/:id/commit`, browserClipperRoute, async (req) => {
    const { actor, connection } = await authenticateBrowserConnection(
      db,
      req.headers.authorization,
    );
    return service.commit(
      actor,
      connection.id,
      parseClipper(taskId, req.params).id,
    );
  });
  let cleaning: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    cleaning ??= service
      .cleanup()
      .then(async () => {
        await db
          .deleteFrom("browser_clipper_login_codes")
          .where(
            "expires_at",
            "<",
            new Date(Date.now() - 24 * 3600_000).toISOString(),
          )
          .execute();
      })
      .catch((error) =>
        api.log.error({ err: error }, "Browser capture cleanup failed"),
      )
      .finally(() => {
        cleaning = undefined;
      });
  }, 60_000);
  timer.unref();
  api.addHook("onClose", async () => {
    clearInterval(timer);
    quickNote.close();
    await cleaning;
  });
}
