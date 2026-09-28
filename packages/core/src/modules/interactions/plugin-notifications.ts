import { createHash, randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { PluginNotificationInput } from "@doca/plugin-sdk/platform";
import { pluginServices } from "../../shared/plugin-services.js";
import { fail } from "../../shared/errors.js";
import { emitIntegrationEvent } from "../automation/events.js";

type Detail = Schema["plugin_notifications"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function key(pluginId: string, recipientId: string, value: string) {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(pluginId) || typeof value !== "string" || !value.length || value.length > 200) fail(400, "Invalid notification identity");
  return `plugin:${digest([pluginId, recipientId, value])}`;
}
export function notificationPath(value: string) {
  if (typeof value !== "string" || value.length > 2048 || !/^\/[a-zA-Z0-9]/.test(value) || /[\\#\x00-\x20\x7f]/.test(value)) fail(400, "Invalid notification route");
  // Reject encoded controls, backslashes and protocol-relative paths as well.
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { fail(400, "Invalid notification route"); }
  if (/[\\\x00-\x1f\x7f]/.test(decoded!) || decoded!.startsWith("//")) fail(400, "Invalid notification route");
  return value;
}
export async function pluginNotificationVisible(db: DB, userId: string, row: Detail) {
  if (row.withdrawn_at) return false;
  const source = pluginServices(db).permissions.get(`${row.plugin_id}.${row.resource_type}`);
  if (!source) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const allowed = await Promise.race([source.authorize(userId, row.resource_id, "notification.read"), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
    return allowed === true && pluginServices(db).permissions.get(`${row.plugin_id}.${row.resource_type}`) === source;
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}
export async function publishPluginNotification(db: DB, pluginId: string, input: PluginNotificationInput) {
  const dedupe = key(pluginId, input.recipientId, input.key);
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.body !== "string" || input.body.length > 2000 || !input.resource?.id || input.resource.id.length > 500 || !/^[a-z][a-z0-9.-]*$/.test(input.resource.type)) fail(400, "Invalid notification content");
  const path = notificationPath(input.path);
  const hash = digest([input.title, input.body, path, input.resource.type, input.resource.id]);
  const detail: Detail = { notification_id: randomUUID(), plugin_id: pluginId, resource_type: input.resource.type, resource_id: input.resource.id, title: input.title, body: input.body, path, request_hash: hash, withdrawn_at: null };
  // Plugin authorization may call other host services. Never invoke it while
  // holding the SQLite transaction connection (reentrant reads would deadlock).
  const source = pluginServices(db).permissions.get(`${pluginId}.${input.resource.type}`);
  if (!await pluginNotificationVisible(db, input.recipientId, detail)) fail(403, "Notification recipient unavailable");
  return transact(db, async tx => {
    await tx.updateTable("users").set({ id: input.recipientId }).where("id", "=", input.recipientId).execute();
    const user = await tx.selectFrom("users").select("status").where("id", "=", input.recipientId).executeTakeFirst();
    if (user?.status !== "active" || pluginServices(tx).permissions.get(`${pluginId}.${input.resource.type}`) !== source) fail(403, "Notification recipient unavailable");
    const old = await tx.selectFrom("notifications as n").innerJoin("plugin_notifications as p", "p.notification_id", "n.id").selectAll("p").where("n.dedupe_key", "=", dedupe).executeTakeFirst();
    if (old) {
      if (old.request_hash !== hash) fail(409, "Notification key already used with different content");
      if (old.withdrawn_at) fail(410, "Notification withdrawn");
      return { id: old.notification_id };
    }
    await tx.insertInto("notifications").values({ id: detail.notification_id, user_id: input.recipientId, resource_id: null, type: "plugin.notification", read_at: null, created_at: new Date().toISOString(), dedupe_key: dedupe }).execute();
    await tx.insertInto("plugin_notifications").values(detail).execute();
    await emitIntegrationEvent(tx, "notification.created", { notificationId: detail.notification_id, userId: input.recipientId });
    return { id: detail.notification_id };
  });
}
export async function withdrawPluginNotification(db: DB, pluginId: string, input: {recipientId:string; key:string}) {
  const row = await db.selectFrom("notifications").select("id").where("user_id", "=", input.recipientId).where("dedupe_key", "=", key(pluginId,input.recipientId,input.key)).executeTakeFirst();
  if (row) await db.updateTable("plugin_notifications").set({withdrawn_at:new Date().toISOString()}).where("notification_id","=",row.id).where("plugin_id","=",pluginId).execute();
}
export async function pluginNotificationTarget(db: DB, userId: string, id: string) {
  const row = await db.selectFrom("plugin_notifications as p").innerJoin("notifications as n","n.id","p.notification_id").selectAll("p").where("n.id","=",id).where("n.user_id","=",userId).executeTakeFirst();
  if (!row || !await pluginNotificationVisible(db,userId,row)) fail(404,"Notification unavailable");
  return notificationPath(row.path);
}
