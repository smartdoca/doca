import { randomUUID } from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import {
  webhookTransact,
  type WebhookDB,
} from "../../../../db/src/webhook-database.js";
import { fail } from "../../shared/errors.js";
import { publishIntegrationEvents } from "./events.js";

/** Event types the host emits today. "*" subscribes to every type, including later ones. */
export const webhookEventTypes = [
  "document.created",
  "library.created",
  "resource.renamed",
  "resource.transferred",
  "resource.arranged",
  "resource.moved",
  "resource.copied",
  "resource.restored",
  "resource.trashed",
  "resource.purged",
  "resource.invited",
  "resource.permissions_changed",
  "resource.link_changed",
  "resource.link_joined",
  "comment.created",
  "comment.updated",
  "like.added",
  "like.removed",
  "favorite.added",
  "favorite.removed",
  "access.requested",
  "access.approved",
  "access.rejected",
  "access.cancelled",
  "invitation.accepted",
  "invitation.rejected",
  "invitation.cancel",
  "invitation.resend",
  "notification.created",
  "ticket.changed",
  "user.created",
  "user.updated",
  "user.status.changed",
  "ai.usage.recorded",
] as const;

const knownEvents = new Set<string>(webhookEventTypes);
export const webhookAttemptLimit = 5;
const retryDelays = [15_000, 60_000, 300_000, 1_800_000];

export function webhookEndpointUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail(400, "回调地址必须是完整的 HTTP 或 HTTPS 链接");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 2000
  )
    fail(400, "回调地址只支持不含账号密码的 HTTP 或 HTTPS 链接");
  url.hash = "";
  return url;
}

export function normalizeWebhookEvents(events: readonly string[]) {
  const unique = [...new Set(events.map((event) => event.trim()))];
  if (!unique.length || unique.length > 40)
    fail(400, "请选择要订阅的事件");
  if (unique.includes("*")) return ["*"];
  if (unique.some((event) => !knownEvents.has(event)))
    fail(400, "包含无法订阅的事件");
  return unique;
}

export function normalizeWebhookHeaders(
  headers: readonly { name: string; value: string }[] = [],
) {
  if (headers.length > 30) fail(400, "请求头过多");
  const seen = new Set<string>();
  const blocked = new Set([
    "content-length",
    "transfer-encoding",
    "connection",
    "host",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
  ]);
  return headers.map((header) => {
    const name = header.name.trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || name.length > 80)
      fail(400, "请求头名称无效");
    if (blocked.has(name.toLowerCase())) fail(400, "该请求头不能由回调设置");
    if (seen.has(name.toLowerCase())) fail(400, "请求头名称重复");
    if (header.value.length > 4000 || /[\r\n]/.test(header.value))
      fail(400, "请求头内容无效");
    seen.add(name.toLowerCase());
    return { name, value: header.value };
  });
}

function endpointName(value: string) {
  const name = value.trim();
  if (!name || name.length > 80) fail(400, "请填写 1 到 80 个字符的名称");
  return name;
}

function subscribed(events: string, type: string) {
  const parsed = JSON.parse(events) as string[];
  return parsed.includes("*") || parsed.includes(type);
}

async function publishedSequence(db: DB) {
  return (
    (
      await db
        .selectFrom("integration_events")
        .select("seq")
        .orderBy("seq", "desc")
        .limit(1)
        .executeTakeFirst()
    )?.seq ?? 0
  );
}

export async function listWebhookEndpoints(db: WebhookDB) {
  const endpoints = await db
    .selectFrom("webhook_endpoints")
    .selectAll()
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const counts = endpoints.length
    ? await db
        .selectFrom("webhook_deliveries")
        .select(["endpoint_id", "status"])
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .groupBy(["endpoint_id", "status"])
        .execute()
    : [];
  return {
    eventTypes: webhookEventTypes,
    items: endpoints.map((endpoint) => {
      const tally = (status: string) =>
        counts
          .filter(
            (row) =>
              row.endpoint_id === endpoint.id && row.status === status,
          )
          .reduce((sum, row) => sum + Number(row.count), 0);
      return {
        id: endpoint.id,
        name: endpoint.name,
        url: endpoint.url,
        events: JSON.parse(endpoint.events) as string[],
        headers: JSON.parse(endpoint.headers) as { name: string; value: string }[],
        enabled: !!endpoint.enabled,
        createdAt: endpoint.created_at,
        updatedAt: endpoint.updated_at,
        pending: tally("pending") + tally("leased"),
        delivered: tally("delivered"),
        failed: tally("failed"),
      };
    }),
  };
}

export async function createWebhookEndpoint(
  app: DB,
  db: WebhookDB,
  input: {
    name: string;
    url: string;
    events: string[];
    headers?: { name: string; value: string }[];
  },
) {
  const url = webhookEndpointUrl(input.url).href;
  const now = new Date().toISOString();
  const id = randomUUID();
  await publishIntegrationEvents(app);
  await db
    .insertInto("webhook_endpoints")
    .values({
      id,
      name: endpointName(input.name),
      url,
      headers: JSON.stringify(normalizeWebhookHeaders(input.headers)),
      events: JSON.stringify(normalizeWebhookEvents(input.events)),
      enabled: 1,
      since_seq: await publishedSequence(app),
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { id };
}

export async function updateWebhookEndpoint(
  db: WebhookDB,
  id: string,
  input: {
    name?: string;
    url?: string;
    events?: string[];
    headers?: { name: string; value: string }[];
    enabled?: boolean;
  },
) {
  const current = await db
    .selectFrom("webhook_endpoints")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!current) fail(404, "回调不存在");
  const patch: Record<string, string | number> = {
    updated_at: new Date().toISOString(),
  };
  if (input.name !== undefined) patch.name = endpointName(input.name);
  if (input.url !== undefined) patch.url = webhookEndpointUrl(input.url).href;
  if (input.events !== undefined)
    patch.events = JSON.stringify(normalizeWebhookEvents(input.events));
  if (input.headers !== undefined)
    patch.headers = JSON.stringify(normalizeWebhookHeaders(input.headers));
  if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (Object.keys(patch).length === 1) fail(400, "没有要保存的内容");
  await db
    .updateTable("webhook_endpoints")
    .set(patch)
    .where("id", "=", id)
    .execute();
  return { ok: true };
}

export async function deleteWebhookEndpoint(db: WebhookDB, id: string) {
  const deleted = await db
    .deleteFrom("webhook_endpoints")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!deleted.numDeletedRows) fail(404, "回调不存在");
  return { ok: true };
}

export async function listWebhookDeliveries(
  db: WebhookDB,
  id: string,
  limit = 20,
) {
  const endpoint = await db
    .selectFrom("webhook_endpoints")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!endpoint) fail(404, "回调不存在");
  const rows = await db
    .selectFrom("webhook_deliveries")
    .select([
      "id",
      "event_id",
      "event_seq",
      "event_type",
      "status",
      "attempts",
      "last_status",
      "last_error",
      "created_at",
      "delivered_at",
    ])
    .where("endpoint_id", "=", id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(limit, 1), 50))
    .execute();
  return {
    items: rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventSeq: row.event_seq,
      eventType: row.event_type,
      status: row.status,
      attempts: row.attempts,
      lastStatus: row.last_status,
      lastError: row.last_error,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    })),
  };
}

/** Copy newly published events onto matching endpoints. Does not call the network. */
export async function enqueueWebhookDeliveries(app: DB, db: WebhookDB) {
  await publishIntegrationEvents(app);
  const cursor =
    (
      await db
        .selectFrom("webhook_cursor")
        .select("seq")
        .where("id", "=", "events")
        .executeTakeFirst()
    )?.seq ?? 0;
  const endpoints = await db
    .selectFrom("webhook_endpoints")
    .selectAll()
    .where("enabled", "=", 1)
    .execute();
  if (!endpoints.length) {
    const latest = await publishedSequence(app);
    if (latest > cursor)
      await db
        .updateTable("webhook_cursor")
        .set({ seq: latest })
        .where("id", "=", "events")
        .where("seq", "<", latest)
        .execute();
    return 0;
  }
  const start = Math.max(
    cursor,
    Math.min(...endpoints.map((endpoint) => endpoint.since_seq)),
  );
  const events = await app
    .selectFrom("integration_events")
    .selectAll()
    .where("seq", ">", start)
    .orderBy("seq")
    .limit(200)
    .execute();
  if (!events.length) return 0;
  const last = events.at(-1)!.seq;
  let queued = 0;
  await webhookTransact(db, async (tx) => {
    for (const event of events) {
      let data: unknown = {};
      try {
        data = JSON.parse(event.payload);
      } catch {
        data = {};
      }
      const body = JSON.stringify({
        id: event.id,
        sequence: event.seq,
        type: event.type,
        createdAt: event.created_at,
        data,
      });
      for (const endpoint of endpoints) {
        if (event.seq <= endpoint.since_seq || !subscribed(endpoint.events, event.type))
          continue;
        const inserted = await tx
          .insertInto("webhook_deliveries")
          .values({
            id: randomUUID(),
            endpoint_id: endpoint.id,
            event_id: event.id,
            event_seq: event.seq,
            event_type: event.type,
            body,
            status: "pending",
            attempts: 0,
            available_at: new Date().toISOString(),
            lease_token: null,
            lease_until: null,
            last_status: null,
            last_error: null,
            created_at: new Date().toISOString(),
            delivered_at: null,
          })
          .onConflict((oc) =>
            oc.columns(["endpoint_id", "event_id"]).doNothing(),
          )
          .executeTakeFirst();
        if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) queued++;
      }
    }
    await tx
      .updateTable("webhook_cursor")
      .set({ seq: last })
      .where("id", "=", "events")
      .where("seq", "<", last)
      .execute();
  });
  return queued;
}

export type ClaimedWebhook = {
  id: string;
  eventId: string;
  eventType: string;
  body: string;
  attempts: number;
  url: string;
  headers: { name: string; value: string }[];
  leaseToken: string;
};

/** Lease due deliveries. The caller performs HTTP outside this transaction. */
export async function claimWebhookDeliveries(db: WebhookDB, limit = 8) {
  const claimed: ClaimedWebhook[] = [];
  for (let step = 0; claimed.length < limit && step < limit + 32; step++) {
    const job = await claimWebhookDelivery(db);
    if (job === "empty") break;
    if (job) claimed.push(job);
  }
  return claimed;
}

async function claimWebhookDelivery(
  db: WebhookDB,
): Promise<ClaimedWebhook | "empty" | null> {
  const now = new Date().toISOString();
  return webhookTransact(db, async (tx) => {
    const candidate = await tx
      .selectFrom("webhook_deliveries")
      .innerJoin(
        "webhook_endpoints",
        "webhook_endpoints.id",
        "webhook_deliveries.endpoint_id",
      )
      .select([
        "webhook_deliveries.id",
        "webhook_deliveries.event_id",
        "webhook_deliveries.event_type",
        "webhook_deliveries.body",
        "webhook_deliveries.attempts",
        "webhook_endpoints.url",
        "webhook_endpoints.headers",
      ])
      .where("webhook_endpoints.enabled", "=", 1)
      .where("webhook_deliveries.status", "in", ["pending", "leased"])
      .where("webhook_deliveries.available_at", "<=", now)
      .where((eb) =>
        eb.or([
          eb("webhook_deliveries.lease_until", "is", null),
          eb("webhook_deliveries.lease_until", "<", now),
        ]),
      )
      .orderBy("webhook_deliveries.available_at")
      .orderBy("webhook_deliveries.id")
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return "empty";
    const attempts = candidate.attempts + 1;
    if (attempts > webhookAttemptLimit) {
      await tx
        .updateTable("webhook_deliveries")
        .set({
          status: "failed",
          lease_token: null,
          lease_until: null,
          last_error: "delivery attempts exhausted",
        })
        .where("id", "=", candidate.id)
        .where("attempts", "=", candidate.attempts)
        .execute();
      return null;
    }
    const leaseToken = randomUUID();
    const leased = await tx
      .updateTable("webhook_deliveries")
      .set({
        status: "leased",
        attempts,
        lease_token: leaseToken,
        lease_until: new Date(Date.now() + 30_000).toISOString(),
      })
      .where("id", "=", candidate.id)
      .where("attempts", "=", candidate.attempts)
      .where("status", "in", ["pending", "leased"])
      .executeTakeFirst();
    if (!leased.numUpdatedRows) return null;
    return {
      id: candidate.id,
      eventId: candidate.event_id,
      eventType: candidate.event_type,
      body: candidate.body,
      attempts,
      url: candidate.url,
      headers: JSON.parse(candidate.headers) as { name: string; value: string }[],
      leaseToken,
    };
  });
}

export function webhookRetryDelay(attempts: number) {
  return retryDelays[Math.min(Math.max(attempts, 1), retryDelays.length) - 1]!;
}

export async function completeWebhookDelivery(
  db: WebhookDB,
  job: Pick<ClaimedWebhook, "id" | "leaseToken" | "attempts">,
  result: { ok: boolean; status?: number; error?: string },
) {
  const now = new Date().toISOString();
  const error = result.error?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const patch = result.ok
    ? {
        status: "delivered",
        delivered_at: now,
        lease_token: null,
        lease_until: null,
        last_status: result.status ?? null,
        last_error: null,
      }
    : job.attempts >= webhookAttemptLimit
      ? {
          status: "failed",
          lease_token: null,
          lease_until: null,
          last_status: result.status ?? null,
          last_error: error,
        }
      : {
          status: "pending",
          available_at: new Date(
            Date.now() + webhookRetryDelay(job.attempts),
          ).toISOString(),
          lease_token: null,
          lease_until: null,
          last_status: result.status ?? null,
          last_error: error,
        };
  await db
    .updateTable("webhook_deliveries")
    .set(patch)
    .where("id", "=", job.id)
    .where("lease_token", "=", job.leaseToken)
    .execute();
}
