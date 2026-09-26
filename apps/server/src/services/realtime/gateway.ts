import { managers } from "@core/modules/access/presentation.js";
import { accessContext, loadResources } from "@core/modules/access/queries.js";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  createDocuments,
  documentAccess,
} from "@core/modules/collaboration/documents.js";
import { cellSelection } from "@core/modules/documents/codecs/cell-presence.js";
import { markdownSelection } from "@core/modules/documents/codecs/markdown.js";
import {
  restoreSurface,
  surfaceAnchor,
  surfaceCodec,
} from "@core/modules/documents/codecs/surfaces.js";
import { PPT_SCHEMA } from "@core/modules/documents/codecs/presentation.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { AppError, fail } from "@core/shared/errors.js";
import type { DB } from "@db/index.js";

type Client = {
  queue: Promise<void>;
  connectionId: string;
  color: string;
  cursor: unknown;
  ws: WebSocket;
  req: FastifyRequest;
  user: Actor | null;
  room?: string;
  alive: boolean;
  pending: number;
  count: number;
  since: number;
};
export async function registerRealtime(
  api: FastifyInstance,
  db: DB,
  origin: string,
  authenticate: (req: FastifyRequest) => Promise<Actor | null>,
) {
  await api.register(websocket, {
    options: { maxPayload: 1500000, perMessageDeflate: false },
  });
  const clients = new Set<Client>();
  const documents = createDocuments(db);
  const roomQueues = new Map<string, Promise<void>>();
  function inRoom(key: string, work: () => Promise<void>) {
    const task = (roomQueues.get(key) ?? Promise.resolve()).then(work);
    const settled = task.catch(() => {});
    roomQueues.set(key, settled);
    void settled.finally(() => {
      if (roomQueues.get(key) === settled) roomQueues.delete(key);
    });
    return task;
  }
  let closed = false;
  const colors = [
    "#3370ff",
    "#d46b08",
    "#9b42bb",
    "#008577",
    "#c33765",
    "#5366ad",
  ];
  let colorIndex = 0;
  const onlineUsers = () => [
    ...new Set(
      [...clients]
        .filter((c) => c.ws.readyState === 1 && c.user)
        .map((c) => c.user!.id),
    ),
  ];
  const online = () => onlineUsers().length;
  function statistics() {
    for (const c of clients)
      if (c.user?.admin) send(c, { type: "stats", online: online() });
  }
  const send = (c: Client, data: unknown) => {
    if (c.ws.bufferedAmount > 4 * 1024 * 1024) {
      c.ws.close(1013, "客户端读取过慢");
      return;
    }
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(data));
  };
  async function valid(c: Client) {
    const user = await authenticate(c.req);
    if (c.user && !user) {
      c.ws.close(4401, "登录已失效");
      return false;
    }
    c.user = user;
    if (c.room) {
      try {
        await documentAccess(db, user, c.room);
      } catch {
        c.ws.close(4403, "文档权限已变更");
        return false;
      }
    }
    return c.ws.readyState === 1;
  }
  async function presence(room: string) {
    const members = new Map<string, { id: string; display_name: string }>();
    for (const c of clients)
      if (c.room === room && c.ws.readyState === 1 && c.user)
        members.set(c.user.id, {
          id: c.user.id,
          display_name: c.user.display_name,
        });
    for (const c of clients)
      if (c.room === room && (await valid(c)))
        send(c, { type: "presence", room, users: [...members.values()] });
    await cursors(room);
  }
  async function cursors(room: string) {
    const members = [];
    for (const c of clients) {
      if (c.room !== room || !(await valid(c))) continue;
      const access = await documentAccess(db, c.user, room);
      if (access.rank < 3) c.cursor = null;
      if (c.user && c.cursor)
        members.push({
          connectionId: c.connectionId,
          userId: c.user.id,
          name: c.user.display_name,
          color: c.color,
          selection: c.cursor,
        });
    }
    for (const c of clients)
      if (c.room === room && c.ws.readyState === 1)
        send(c, {
          type: "cursors",
          room,
          self: c.connectionId,
          sessions: members.filter((m) => m.connectionId !== c.connectionId),
        });
  }
  function cursorPoint(value: unknown) {
    if (!value || typeof value !== "object") fail(400, "光标位置无效");
    const p = value as Record<string, unknown>;
    if (typeof p.blockId !== "string" || !p.blockId || p.blockId.length > 160)
      fail(400, "光标位置无效");
    if (p.kind === "code") {
      if (
        !Number.isSafeInteger(p.offset) ||
        Number(p.offset) < 0 ||
        Number(p.offset) > 1000000 ||
        typeof p.fingerprint !== "string" ||
        !/^[a-f0-9]{8}$/.test(p.fingerprint)
      )
        fail(400, "光标位置无效");
      return {
        blockId: p.blockId,
        kind: "code",
        offset: p.offset,
        fingerprint: p.fingerprint,
      };
    }
    if (
      typeof p.blockId !== "string" ||
      p.blockId.length > 160 ||
      typeof p.position !== "string" ||
      p.position.length > 512 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(p.position)
    )
      fail(400, "光标位置无效");
    return { blockId: p.blockId, position: p.position };
  }
  api.get(
    "/api/v1/ws",
    {
      websocket: true,
      preValidation: async (req) => {
        if (req.headers.origin !== origin) fail(403, "来源校验失败");
      },
    },
    (ws, req) => {
      if (clients.size >= 500) {
        ws.close(1013, "连接数量已达上限");
        return;
      }
      const c: Client = {
        queue: Promise.resolve(),
        connectionId: randomUUID(),
        color: colors[colorIndex++ % colors.length]!,
        cursor: null,
        ws,
        req,
        user: null,
        alive: true,
        pending: 0,
        count: 0,
        since: Date.now(),
      };
      clients.add(c);
      const ready = authenticate(req).then((user) => {
        c.user = user;
        send(c, { type: "ready" });
        statistics();
      });
      ws.on("pong", () => {
        c.alive = true;
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        void c.queue.finally(() => clients.delete(c));
        statistics();
        if (c.room && !closed) void presence(c.room).catch(() => {});
      });
      ws.on("message", (raw) => {
        if (Date.now() - c.since > 10000) {
          c.since = Date.now();
          c.count = 0;
        }
        if (++c.pending > 64 || ++c.count > 500) {
          ws.close(1008, "消息过于频繁");
          return;
        }
        c.queue = c.queue
          .then(() => {
            let target = c.room ?? c.connectionId;
            try {
              const message = JSON.parse(raw.toString());
              if (typeof message.room === "string") target = message.room;
            } catch {}
            return inRoom(target, async () => {
              await ready;
              if (!(await valid(c))) return;
              let m: Record<string, unknown> = {};
              try {
                m = JSON.parse(raw.toString());
                if (!m || typeof m !== "object") fail(400, "消息格式错误");
                if (m.type === "leave") {
                  const previous = c.room;
                  c.room = undefined;
                  c.cursor = null;
                  if (previous) await presence(previous);
                  return;
                }
                if (
                  !["join", "sync-request", "update", "cursor"].includes(
                    String(m.type),
                  )
                )
                  fail(400, "不支持的消息类型");
                if (
                  typeof m.room !== "string" ||
                  !/^[a-f0-9-]{36}$/.test(m.room)
                )
                  fail(400, "文档标识无效");
                // A departing editor may clear its cursor after its leave message.
                // Ignore that stale cleanup; it must not affect the new room.
                if (
                  m.type === "cursor" &&
                  m.selection === null &&
                  c.room !== m.room
                )
                  return;
                if (m.type !== "join" && c.room !== m.room)
                  fail(403, "请先进入文档");
                if (typeof m.id !== "string" || m.id.length > 80)
                  fail(400, "消息标识无效");
                if (m.type === "cursor") {
                  if (m.selection === null) c.cursor = null;
                  else {
                    const access = await documentAccess(db, c.user, m.room, 3);
                    const s = m.selection as
                      Record<string, unknown> | undefined;
                    if (
                      s?.kind === "cells" &&
                      access.resource.format !== "spreadsheet"
                    )
                      fail(400, "此文档不支持单元格选区");
                    if (
                      s?.kind !== "cells" &&
                      access.resource.format === "spreadsheet"
                    )
                      fail(400, "表格需要单元格选区");
                    if (
                      ["canvas", "spreadsheet", "presentation"].includes(
                        access.resource.format,
                      )
                    ) {
                      const loaded = await restoreSurface(
                        db,
                        m.room,
                        access.resource.format,
                      );
                      if (m.epochId !== loaded.epochId)
                        fail(409, "选区版本不匹配");
                      if (access.resource.format === "presentation") {
                        c.cursor = await surfaceAnchor(
                          db,
                          m.room,
                          "presentation",
                          {
                            type: "elements",
                            epochId: m.epochId,
                            slideId: s?.slideId,
                            elementIds: s?.elementIds,
                          },
                        );
                      } else if (access.resource.format === "canvas") {
                        c.cursor = await surfaceAnchor(db, m.room, "canvas", {
                          type: "elements",
                          epochId: m.epochId,
                          elementIds: s?.elementIds,
                        });
                      } else {
                        const cells = cellSelection(s!);
                        const sheet =
                          loaded.baseline?.snapshot.sheets[cells.sheetId];
                        if (
                          !sheet ||
                          cells.endRow >= sheet.rowCount! ||
                          cells.endColumn >= sheet.columnCount!
                        )
                          fail(400, "超出表格范围");
                        c.cursor = cells;
                      }
                    } else
                      c.cursor =
                        access.resource.format === "markdown"
                          ? await markdownSelection(db, m.room, s)
                          : s?.kind === "cells"
                            ? cellSelection(s)
                            : {
                                anchor: cursorPoint(s?.anchor),
                                focus: cursorPoint(s?.focus),
                              };
                  }
                  await cursors(m.room);
                  return;
                }
                const previous = c.room;
                const result = await documents.exchange(
                  c.user,
                  m.room,
                  m.type === "update"
                    ? {
                        epochId:
                          typeof m.epochId === "string" ? m.epochId : undefined,
                        codec:
                          typeof m.codec === "string" ? m.codec : undefined,
                        schemaVersion:
                          typeof m.schemaVersion === "number"
                            ? m.schemaVersion
                            : undefined,
                        protocolVersion:
                          typeof m.protocolVersion === "number"
                            ? m.protocolVersion
                            : undefined,
                        messageId: m.id,
                        update: String(m.update),
                        checkpointId:
                          typeof m.checkpointId === "string"
                            ? m.checkpointId
                            : undefined,
                      }
                    : {
                        epochId:
                          typeof m.epochId === "string" ? m.epochId : undefined,
                        codec:
                          typeof m.codec === "string" ? m.codec : undefined,
                        schemaVersion:
                          typeof m.schemaVersion === "number"
                            ? m.schemaVersion
                            : undefined,
                        protocolVersion:
                          typeof m.protocolVersion === "number"
                            ? m.protocolVersion
                            : undefined,
                        vector:
                          typeof m.vector === "string" ? m.vector : undefined,
                        checkpointId:
                          typeof m.checkpointId === "string"
                            ? m.checkpointId
                            : undefined,
                      },
                );
                if (m.type === "join") {
                  c.room = m.room;
                  c.cursor = null;
                  const used = new Set(
                    [...clients]
                      .filter((x) => x !== c && x.room === m.room)
                      .map((x) => x.color),
                  );
                  if (used.has(c.color))
                    c.color =
                      colors.find((color) => !used.has(color)) ??
                      `hsl(${(colorIndex++ * 137.508) % 360} 65% 40%)`;
                }
                if (m.type === "update") {
                  // Database commit precedes both acknowledgement and fan-out.
                  send(c, {
                    type: "ack",
                    id: m.id,
                    room: m.room,
                    seq: result.seq,
                    ...("epochId" in result
                      ? {
                          epochId: result.epochId,
                          codec: result.codec,
                          schemaVersion: result.schemaVersion,
                          protocolVersion: result.protocolVersion,
                        }
                      : {}),
                    metadata: result.metadata,
                  });
                  if (result.notificationsChanged)
                    for (const recipient of clients)
                      if (recipient.user && (await valid(recipient)))
                        send(recipient, { type: "notifications.changed" });
                  if (result.changed)
                    for (const other of clients)
                      if (
                        other !== c &&
                        other.room === m.room &&
                        (await valid(other))
                      )
                        send(other, {
                          type: "update",
                          room: m.room,
                          update: m.update,
                          seq: result.seq,
                          ...("epochId" in result
                            ? {
                                epochId: result.epochId,
                                codec: result.codec,
                                schemaVersion: result.schemaVersion,
                                protocolVersion: result.protocolVersion,
                              }
                            : {}),
                          metadata: result.metadata,
                        });
                } else
                  send(c, {
                    type: "sync-response",
                    id: m.id,
                    room: m.room,
                    ...result,
                  });
                if (m.type === "join") {
                  if (previous && previous !== c.room) await presence(previous);
                  await presence(m.room);
                }
              } catch (e) {
                send(c, {
                  type: "error",
                  operation: m?.type,
                  id: m?.id,
                  room: m?.room,
                  status: e instanceof AppError ? e.status : 400,
                  message:
                    e instanceof AppError
                      ? e.message
                      : "协同数据无效，请重新连接",
                });
              }
            });
          })
          .catch((e) => api.log.error(e))
          .finally(() => {
            c.pending--;
          });
      });
    },
  );
  // HTTP writes have committed by onResponse. Push invalidations, not private data;
  // clients fetch their own notification list using the current permission checks.
  const ticketWrites = new WeakMap<object, string>();
  api.addHook("onRequest", async (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
      ticketWrites.set(req, new Date().toISOString());
  });
  api.addHook("onResponse", async (req, reply) => {
    if (
      ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
      reply.statusCode >= 400
    )
      return;
    if (req.url.includes("heartbeat")) return;
    if (req.url.includes("/admin/distribution")) {
      for (const c of clients)
        if (c.user && (await valid(c))) {
          send(c, { type: "notifications.changed" });
          send(c, { type: "policy.changed" });
        }
      return;
    }
    const caller = await authenticate(req);
    let room = /\/(?:resources|invitations)\/([a-f0-9-]{36})/.exec(
      req.url,
    )?.[1];
    const requestId = /\/access-requests\/([a-f0-9-]{36})/.exec(req.url)?.[1];
    if (!room && requestId)
      room = (
        await db
          .selectFrom("access_requests")
          .select("resource_id")
          .where("id", "=", requestId)
          .executeTakeFirst()
      )?.resource_id;
    const recipients = new Set(caller ? [caller.id] : []);
    const ticketId = /\/tickets\/([a-f0-9-]{36})/.exec(req.url)?.[1];
    if (ticketId)
      room =
        (
          await db
            .selectFrom("tickets")
            .select("resource_id")
            .where("id", "=", ticketId)
            .executeTakeFirst()
        )?.resource_id ?? undefined;
    const started = ticketWrites.get(req);
    if (started)
      for (const row of await db
        .selectFrom("notifications")
        .select("user_id")
        .distinct()
        .where("ticket_id", "is not", null)
        .where("created_at", ">=", started)
        .execute())
        recipients.add(row.user_id);
    if (room) {
      const ctx = await accessContext(db, null, [room]);
      const r = ctx.resources.find((r) => r.id === room);
      if (r)
        for (const manager of await managers(db, r, ctx.resources, ctx.grants))
          recipients.add(manager.id);
    }
    if (room)
      for (const row of await db
        .selectFrom("notifications")
        .select("user_id")
        .distinct()
        .where("resource_id", "=", room)
        .where("created_at", ">=", new Date(Date.now() - 60000).toISOString())
        .execute())
        recipients.add(row.user_id);
    const affectedRooms = new Set<string>(room ? [room] : []);
    // Inspect only active rooms, never expand an entire document subtree for invalidation.
    if (
      room &&
      /permissions|members|share-link|tickets|access-requests|invitations|transfer|move|arrange|trash/.test(
        req.url,
      )
    ) {
      const rooms = [
        ...new Set(
          [...clients].map((c) => c.room).filter((id): id is string => !!id),
        ),
      ];
      const ancestors = await loadResources(db, rooms);
      for (const id of rooms) {
        const seen = new Set<string>();
        let current = ancestors.find((r) => r.id === id);
        while (current && !seen.has(current.id)) {
          if (current.id === room) {
            affectedRooms.add(id);
            break;
          }
          seen.add(current.id);
          current = ancestors.find(
            (r) => r.id === (current!.parent_id ?? current!.library_id),
          );
        }
      }
    }
    for (const c of clients)
      if (
        c.user &&
        (recipients.has(c.user.id) || (c.room && affectedRooms.has(c.room))) &&
        (await valid(c))
      )
        send(c, { type: "notifications.changed" });
    for (const c of clients)
      if (c.room && affectedRooms.has(c.room) && (await valid(c)))
        send(c, { type: "document.changed", room: c.room });
    for (const affectedRoom of affectedRooms) await cursors(affectedRoom);
  });
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
      void valid(c).catch(() => c.ws.close(1011, "连接检查失败"));
    }
  }, 30000);
  timer.unref();
  api.addHook("preClose", async () => {
    closed = true;
    clearInterval(timer);
    for (const c of clients) c.ws.close(1001, "服务重启");
    await Promise.all([...clients].map((c) => c.queue));
  });
  return {
    async notificationsChanged(userId: string) {
      for (const client of clients)
        if (client.user?.id === userId && await valid(client)) send(client, { type: "notifications.changed" });
    },
    async enforceAccess() {
      for (const c of clients) await valid(c);
    },
    async documentChanged(room: string) {
      await inRoom(room, async () => {
        for (const c of clients) {
          if (c.room !== room || !(await valid(c))) continue;
          const r = await db
            .selectFrom("resources")
            .select("format")
            .where("id", "=", room)
            .executeTakeFirst();
          if (!r) continue;
          const epoch = await db
            .selectFrom("editor_epochs")
            .select("baseline")
            .where("resource_id", "=", room)
            .executeTakeFirst();
          const codec =
            r.format === "markdown"
              ? "markdown-ytext"
              : r.format === "rich_text"
                ? "slate-kit"
                : surfaceCodec(r.format);
          const schemaVersion =
            r.format === "rich_text"
              ? 3
              : r.format === "presentation"
                ? PPT_SCHEMA
                : r.format === "spreadsheet"
                  ? JSON.parse(epoch?.baseline ?? "{}").schemaVersion
                  : 1;
          const protocol = { codec, schemaVersion, protocolVersion: 1 };
          const state = await documents.exchange(c.user, room, protocol);
          // A pull response with an empty vector preserves identities and does not create an ACK.
          send(c, { type: "sync-response", room, ...state });
          send(c, { type: "document.changed", room });
        }
      });
    },
    online: () => onlineUsers().length,
    onlineUsers,
  };
}
