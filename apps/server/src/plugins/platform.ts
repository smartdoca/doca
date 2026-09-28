import { publishPluginNotification, withdrawPluginNotification, pluginNotificationTarget } from "@core/modules/interactions/plugin-notifications.js";
import { filesServiceToken, stableId } from "@doca/plugin-sdk/files";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  notificationsServiceToken, eventsServiceToken, httpServiceToken, permissionsServiceToken, policiesServiceToken, usersServiceToken,
  type PluginPrincipal, type PluginRequestContext, type PluginHttpResponse,
} from "@doca/plugin-sdk/platform";
import type { PluginLifecycleContext } from "@doca/plugin-sdk";
import { activeActor } from "@core/modules/access/queries.js";
import { visibleUsers } from "@core/modules/interactions/community.js";
import { pluginServices, checkOperation } from "@core/shared/plugin-services.js";
import { fail } from "@core/shared/errors.js";
import { publishIntegrationEvents } from "@core/modules/automation/events.js";
import type { ServerRuntimeService } from "./contracts.js";

const identifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
function register<T>(map: Map<string, T>, id: string, value: T) {
  if (!identifier.test(id) || map.has(id)) throw new Error(`Invalid or duplicate registration: ${id}`);
  map.set(id, value);
  return () => { if (map.get(id) === value) map.delete(id); };
}
const actor = (p: PluginPrincipal) => ({ id: p.id, display_name: p.displayName, public_id: p.publicId, admin: Number(p.admin) });

export async function providePlatform(context: PluginLifecycleContext, runtime: ServerRuntimeService) {
  const { db, api } = runtime;
  const services = pluginServices(db);
  context.effect(() => () => { services.directories.clear(); services.permissions.clear(); services.policies.clear(); services.skills.clear(); });
  const verify = async (request: PluginRequestContext) => {
    await activeActor(db, actor(request.principal));
    return db.selectFrom("users").select(["id", "admin"]).where("id", "=", request.principal.id).executeTakeFirstOrThrow();
  };
  api.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/v1/plugin-file-bindings/:id/content", async (request, reply) => {
    const user = runtime.auth(request);
    await activeActor(db, user);
    const binding = await db.selectFrom("file_bindings").selectAll().where("id", "=", request.params.id).executeTakeFirst();
    if (!binding) fail(404, "File binding unavailable");
    const controller = new AbortController();
    reply.raw.on("close", () => controller.abort());
    const result = await context.inject(filesServiceToken).content.read!({ principalId: user.id, signal: controller.signal }, { fileId: stableId(binding.file_id, "file"), bindingId: stableId(binding.id, "file-binding") });
    reply.type(result.file.mime).header("Content-Disposition", `${request.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(result.file.name)}`);
    return reply.send(Readable.from(result.body));
  });
  context.provide(notificationsServiceToken, {
    async publish(pluginId, input) {
      const result = await publishPluginNotification(db, pluginId, input);
      await runtime.realtime.notificationsChanged(input.recipientId);
      return result;
    },
    async withdraw(pluginId, input) {
      await withdrawPluginNotification(db, pluginId, input);
      await runtime.realtime.notificationsChanged(input.recipientId);
    },
  });
  api.get<{ Params: { id: string } }>("/api/v1/notifications/:id/open", async (request, reply) => {
    const user = runtime.auth(request);
    await activeActor(db, user);
    const path = await pluginNotificationTarget(db, user.id, request.params.id);
    await db.updateTable("notifications").set({ read_at: new Date().toISOString() }).where("id", "=", request.params.id).where("user_id", "=", user.id).execute();
    return reply.header("Cache-Control", "no-store").redirect(`/#${path}`, 303);
  });
  context.provide(eventsServiceToken, {
    async read(after, limit = 100) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, "Invalid event cursor or limit");
      await publishIntegrationEvents(db);
      const rows = await db.selectFrom("integration_events").selectAll().where("seq", ">", after).orderBy("seq").limit(limit).execute();
      return rows.map(row => ({ sequence: row.seq, id: row.id, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at }));
    },
  });
  context.provide(usersServiceToken, {
    async status(id) {
      return await db.selectFrom("users").select(["id", "status"]).where("id", "=", id).executeTakeFirst() ?? null;
    },
    async get(request, id) {
      const caller = await verify(request);
      if (caller.id !== id && !caller.admin) fail(403, "User profile access denied");
      const user = await db.selectFrom("users").select(["id", "public_id", "display_name", "login", "status", "admin", "created_at", "profile_metadata", "profile_revision"]).where("id", "=", id).executeTakeFirst();
      if (!user) return null;
      const contacts = await db.selectFrom("user_contacts").select(["kind", "value", "verified_at"]).where("user_id", "=", id).execute();
      return { id: user.id, publicId: user.public_id ?? "", displayName: user.display_name, login: user.login, status: user.status, admin: !!user.admin, createdAt: user.created_at, profile: JSON.parse(user.profile_metadata ?? "{}"), profileRevision: user.profile_revision ?? 1, contacts: contacts.map(c => ({ kind: c.kind, value: c.value, verified: !!c.verified_at })) };
    },
    async list(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, "Invalid user page limit");
      let query = db.selectFrom("users").select(["id", "public_id", "display_name", "login", "status", "admin", "created_at", "profile_metadata", "profile_revision"]).orderBy("id").limit(limit + 1);
      if (input.after) query = query.where("id", ">", input.after);
      const rows = await query.execute();
      const ids = rows.slice(0, limit).map(user => user.id);
      const contacts = ids.length ? await db.selectFrom("user_contacts").select(["user_id", "kind", "value", "verified_at"]).where("user_id", "in", ids).execute() : [];
      const items = rows.slice(0, limit).map(user => ({ id: user.id, publicId: user.public_id ?? "", displayName: user.display_name, login: user.login, status: user.status, admin: !!user.admin, createdAt: user.created_at, profile: JSON.parse(user.profile_metadata ?? "{}"), profileRevision: user.profile_revision ?? 1, contacts: contacts.filter(c => c.user_id === user.id).map(c => ({ kind: c.kind, value: c.value, verified: !!c.verified_at })) }));
      return { items, cursor: rows.length > limit ? items.at(-1)!.id : null };
    },
    async search(request, query) {
      await verify(request);
      return (await visibleUsers(db, actor(request.principal), query)).map(user => ({ ...user, public_id: user.public_id ?? null, avatar_asset_id: user.avatar_asset_id ?? null }));
    },
  });
  context.provide(permissionsServiceToken, {
    register(source) { return register(services.permissions, `${source.pluginId}.${source.resourceType}`, source); },
    registerDirectory(source) { return register(services.directories, source.id, source); },
    async authorize(request, resource, action) {
      await verify(request);
      const source = services.permissions.get(`${resource.pluginId}.${resource.type}`);
      return source ? source.authorize(request.principal.id, resource.id, action) : false;
    },
  });
  context.provide(policiesServiceToken, {
    register(policy) { return register(services.policies, policy.id, policy); },
    check(principalId, action, facts) { return checkOperation(db, principalId, action, facts); },
  });
  const routePath = (pluginId: string, path: string) => {
    if (!identifier.test(pluginId) || !path.startsWith("/") || path.includes("..") || /[?#\\%]/.test(path)) throw new Error("Invalid plugin route");
    return `/api/v1/plugins/${pluginId}${path}`;
  };
  context.provide(httpServiceToken, {
    callbackUrl(pluginId, path) { return new URL(routePath(pluginId, path), runtime.origin).href; },
    async register(pluginId, routes) {
      let enabled = true;
      for (const route of routes) {
        routePath(pluginId, route.path);
        if (route.bodyLimit !== undefined && (!Number.isSafeInteger(route.bodyLimit) || route.bodyLimit < 1 || route.bodyLimit > 32 * 1024 * 1024)) throw new Error("Plugin body limit must be between 1 byte and 32 MiB");
      }
      await api.register(async child => {
        const bodies = new WeakMap<object, Buffer>();
        child.removeAllContentTypeParsers();
        child.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (request, body, done) => {
          const bytes = body as Buffer;
          bodies.set(request, bytes);
          try { done(null, request.headers["content-type"]?.split(";")[0] === "application/json" ? JSON.parse(bytes.toString()) : bytes.toString()); }
          catch { done(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 })); }
        });
        for (const route of routes) child.route({
          method: route.method, url: routePath(pluginId, route.path), schema: route.schema, bodyLimit: route.bodyLimit ?? 1024 * 1024,
          config: { docaPluginExternal: route.auth === "external" },
          async handler(request, reply) {
            if (!enabled) fail(503, "Plugin unavailable");
            const controller = new AbortController();
            const cancel = () => { if (!reply.raw.writableEnded) controller.abort(); };
            reply.raw.on("close", cancel);
            const response: PluginHttpResponse = {
              status(code) { reply.code(code); return response; },
              header(name, value) { reply.header(name, Array.isArray(value) ? [...value] : value); return response; },
              redirect(location, code = 303) { reply.redirect(location, code); },
            };
            const base = { requestId: request.id || randomUUID(), signal: controller.signal,
              params: request.params as Record<string, string>, query: request.query as Record<string, unknown>, body: request.body,
              headers: request.headers, rawBody: bodies.get(request) ?? new Uint8Array(),
            };
            try {
              if (route.auth === "external") {
                const external = { ...base, principal: null };
                if (!await route.verify(external)) fail(401, "External plugin authentication failed");
                return await route.handle(external, response);
              }
              const user = route.admin ? runtime.admin(request) : runtime.auth(request);
              await activeActor(db, user);
              return await route.handle({ ...base,
                principal: { id: user.id, displayName: user.display_name, publicId: user.public_id ?? "", admin: !!user.admin },
              }, response);
            } finally { reply.raw.off("close", cancel); }
          },
        });
      });
      return async () => { enabled = false; };
    },
  });
}
