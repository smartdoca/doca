import { validateNativeRequest } from "@smartdoca/plugin-sdk/native";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DB } from "@db/index.js";
import { tokenHash, type Actor } from "@core/modules/identity/passwords.js";
import { fail } from "@core/shared/errors.js";
import type { NavigationEntry } from "@smartdoca/web-plugin-registry";
export function registerPluginMobileSessions(
  api: FastifyInstance,
  db: DB,
  auth: (req: FastifyRequest) => Actor,
  entries: NavigationEntry[],
  secure: boolean,
) {
  api.post<{
    Body: { pluginId: string; path: string; name: string; mime: string };
  }>(
    "/api/v1/plugins-mobile/attachment",
    { bodyLimit: 10000 },
    async (req, reply) => {
      const actor = auth(req);
      const pluginId = req.body?.pluginId;
      if (
        !entries.some(
          (entry) =>
            entry.pluginId === pluginId &&
            entry.mobile &&
            (!entry.adminOnly || actor.admin),
        )
      )
        fail(404, "Mobile plugin unavailable");
      if (!/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization ?? ""))
        fail(403, "Native session required");
      try {
        validateNativeRequest(
          {
            version: 1,
            id: "attachment",
            pluginId,
            operation: "attachment.save",
            input: req.body,
          },
          pluginId,
        );
      } catch {
        fail(400, "Invalid attachment request");
      }
      // Internal dispatch never follows redirects, and the native token is never sent to a plugin-selected external URL.
      const response = await api.inject({
        method: "GET",
        url: `/api/v1/plugins/${pluginId}${req.body.path}`,
        headers: { authorization: req.headers.authorization! },
      });
      if (response.statusCode < 200 || response.statusCode >= 300)
        fail(
          response.statusCode >= 300 && response.statusCode < 400
            ? 400
            : response.statusCode,
          "Attachment unavailable",
        );
      if (response.rawPayload.length > 32 * 1024 * 1024)
        fail(413, "Attachment exceeds download limit");
      reply.header("Cache-Control", "no-store");
      return { base64: response.rawPayload.toString("base64") };
    },
  );
  api.post<{ Body: { entryId: string } }>(
    "/api/v1/plugins-mobile/ticket",
    async (req) => {
      const actor = auth(req),
        entry = entries.find(
          (e) =>
            e.id === req.body?.entryId &&
            e.mobile &&
            (!e.adminOnly || actor.admin),
        );
      if (!entry?.pluginId) fail(404, "Mobile plugin unavailable");
      const token = /^Bearer ([a-f0-9]{64})$/.exec(
        req.headers.authorization ?? "",
      )?.[1];
      if (!token) fail(403, "Native session required");
      const parent = await db
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", tokenHash(token))
        .where("user_id", "=", actor.id)
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (!parent) fail(401, "Session expired");
      const ticket = randomBytes(32).toString("hex");
      await db
        .deleteFrom("plugin_webview_auth")
        .where("expires_at", "<=", new Date().toISOString())
        .execute();
      await db
        .insertInto("plugin_webview_auth")
        .values({
          id: tokenHash(ticket),
          kind: "ticket",
          plugin_id: entry.pluginId,
          parent_session: parent.id,
          expires_at: new Date(Date.now() + 60000).toISOString(),
        })
        .execute();
      return { ticket };
    },
  );
  api.post<{ Body: { ticket: string } }>(
    "/api/v1/plugins-mobile/redeem",
    async (req, reply) => {
      if (!/^[a-f0-9]{64}$/.test(req.body?.ticket ?? ""))
        fail(400, "Invalid ticket");
      const row = await db
        .selectFrom("plugin_webview_auth")
        .selectAll()
        .where("id", "=", tokenHash(req.body.ticket))
        .where("kind", "=", "ticket")
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (
        !row ||
        !entries.some((e) => e.pluginId === row.plugin_id && e.mobile)
      )
        fail(401, "Ticket expired");
      const parent = await db
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .select("sessions.id")
        .where("sessions.id", "=", row.parent_session)
        .where("sessions.expires_at", ">", new Date().toISOString())
        .where("users.status", "=", "active")
        .executeTakeFirst();
      if (!parent) fail(401, "Session expired");
      const token = randomBytes(32).toString("hex");
      await db.transaction().execute(async (tx) => {
        const removed = await tx
          .deleteFrom("plugin_webview_auth")
          .where("id", "=", row.id)
          .executeTakeFirst();
        if (!removed.numDeletedRows) fail(401, "Ticket already consumed");
        await tx
          .insertInto("plugin_webview_auth")
          .values({
            ...row,
            id: tokenHash(token),
            kind: "session",
            expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
          })
          .execute();
      });
      reply.header(
        "Set-Cookie",
        `doca_plugin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${secure ? "; Secure" : ""}`,
      );
      return { pluginId: row.plugin_id };
    },
  );
}
export async function pluginMobileActor(
  db: DB,
  token: string,
  pluginIds: string[],
) {
  const row = await db
    .selectFrom("plugin_webview_auth")
    .innerJoin("sessions", "sessions.id", "plugin_webview_auth.parent_session")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "users.id",
      "users.display_name",
      "users.admin",
      "plugin_webview_auth.plugin_id",
    ])
    .where("plugin_webview_auth.id", "=", tokenHash(token))
    .where("plugin_webview_auth.kind", "=", "session")
    .where("plugin_webview_auth.expires_at", ">", new Date().toISOString())
    .where("sessions.expires_at", ">", new Date().toISOString())
    .where("users.status", "=", "active")
    .executeTakeFirst();
  if (!row || !pluginIds.includes(row.plugin_id))
    fail(401, "Plugin session expired");
  return row;
}
