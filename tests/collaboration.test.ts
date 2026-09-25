import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import {
  Doc,
  YjsDocument,
  applyUpdate,
  encodeStateAsUpdate,
  encodeStateVector,
} from "slatetsx-kit-editor/yjs";
import { type DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createDocuments,
  b64,
  unb64,
  restoreDocument,
} from "./editor-client.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import type { WebSocket } from "ws";
import { Element } from "slate";
function blockId(runtime: YjsDocument) {
  const block = runtime.getValue()[1]!;
  if (!Element.isElement(block)) throw new Error("Expected block");
  return block.id;
}
let db: DB,
  owner: Actor,
  reader: Actor,
  content: ReturnType<typeof createContent>,
  documents: ReturnType<typeof createDocuments>;
const resource = () =>
  content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "协作测试",
  });
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  const u = await createUser(
    db,
    { login: "owner", displayName: "Owner", password: "test-password-2026" },
    { bootstrap: true },
  );
  owner = { ...u, admin: 1 };
  reader = {
    ...(await createUser(
      db,
      {
        login: "reader",
        displayName: "Reader",
        password: "test-password-2026",
      },
      { actor: owner },
    )),
    admin: 0,
  };
  content = createContent(db);
  documents = createDocuments(db);
});
afterEach(async () => {
  await db.destroy();
});
async function replica(id: string) {
  const result = await documents.exchange(owner, id, {});
  const doc = new Doc();
  const runtime = new YjsDocument(doc);
  applyUpdate(doc, unb64(result.update));
  return {
    doc,
    runtime,
    destroy: () => {
      runtime.destroy();
      doc.destroy();
    },
  };
}
it("merges two concurrent replicas, acknowledges only durable updates and restores after compaction", async () => {
  const r = await resource();
  const a = await replica(r.id),
    b = await replica(r.id);
  try {
    const id = blockId(a.runtime);
    const ua = a.runtime.editText(id, 0, 0, "甲"),
      ub = b.runtime.editText(id, 0, 0, "乙");
    await documents.exchange(owner, r.id, { update: b64(ua) });
    await documents.exchange(owner, r.id, { update: b64(ub) });
    for (const p of [a, b])
      applyUpdate(
        p.doc,
        unb64(
          (
            await documents.exchange(owner, r.id, {
              vector: b64(encodeStateVector(p.doc)),
            })
          ).update,
        ),
      );
    expect(a.runtime.getValue()).toEqual(b.runtime.getValue());
    expect(JSON.stringify(a.runtime.getValue())).toContain("甲");
    expect(JSON.stringify(a.runtime.getValue())).toContain("乙");
    for (let i = 0; i < 49; i++)
      await documents.exchange(owner, r.id, {
        update: b64(a.runtime.editText(id, 0, 0, "x")),
      });
    const loaded = await restoreDocument(db, r.id);
    try {
      expect(loaded.state?.seq).toBe(51);
      expect(loaded.state?.checkpoint_seq).toBe(50);
      expect(loaded.runtime.getValue()).toEqual(a.runtime.getValue());
    } finally {
      loaded.destroy();
    }
    expect(
      await db.selectFrom("document_updates").selectAll().execute(),
    ).toHaveLength(1);
    const repeated = await documents.exchange(owner, r.id, {
      update: b64(encodeStateAsUpdate(a.doc)),
    });
    expect(repeated.seq).toBe(51);
    expect(repeated.changed).toBe(false);
  } finally {
    a.destroy();
    b.destroy();
  }
});
it("tracks the actual last editor through snapshots, no-op syncs, rename and independent copy", async () => {
  const r = await resource();
  await content.permissions(owner, r.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: reader.id, role: "editor" }],
  });
  const a = await replica(r.id);
  try {
    for (let i = 0; i < 50; i++)
      await documents.exchange(reader, r.id, {
        update: b64(a.runtime.editText(blockId(a.runtime), 0, 0, "x")),
      });
    expect(
      await db
        .selectFrom("document_updates")
        .selectAll()
        .where("resource_id", "=", r.id)
        .execute(),
    ).toHaveLength(0);
    const detail = await content.detail(owner, r.id);
    expect(detail.ownerName).toBe("Owner");
    expect(detail.lastEditorName).toBe("Reader");
    expect(detail.lastEditedAt).toBeTruthy();
    const unchanged = await documents.exchange(owner, r.id, {
      update: b64(encodeStateAsUpdate(a.doc)),
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.metadata.lastEditorName).toBe("Reader");
    const copy = await content.copy(owner, r.id);
    expect((await content.detail(owner, copy.id)).lastEditorName).toBe("Owner");
    await content.rename(owner, r.id, "新标题", detail.resource.version);
    expect((await content.detail(owner, r.id)).lastEditorName).toBe("Owner");
    expect(
      (await documents.exchange(reader, r.id, {})).metadata.lastEditorName,
    ).toBe("Owner");
  } finally {
    a.destroy();
  }
});
it("rejects reader writes, missing access, invalid payloads and reinitialization", async () => {
  const r = await resource();
  await content.permissions(owner, r.id, {
    version: r.version,
    accessMode: "custom",
    visibility: "invited",
    grants: [{ userId: reader.id, role: "reader" }],
  });
  const a = await replica(r.id);
  try {
    const update = a.runtime.editText(blockId(a.runtime), 0, 0, "不允许");
    await expect(
      documents.exchange(reader, r.id, { update: b64(update) }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(documents.exchange(null, r.id, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      documents.exchange(owner, r.id, { update: "bad!" }),
    ).rejects.toMatchObject({ status: 400 });
    a.doc.getMap("slate-kit:document").set("initial", []);
    await expect(
      documents.exchange(owner, r.id, {
        update: b64(encodeStateAsUpdate(a.doc)),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await documents.exchange(owner, r.id, {})).seq).toBe(0);
  } finally {
    a.destroy();
  }
});
it("preserves new font marks through host ACK, peer projection, reload and independent copy", async () => {
  const r = await resource(), a = await replica(r.id), b = await replica(r.id);
  try {
    await documents.exchange(owner, r.id, { update: b64(a.runtime.editText(blockId(a.runtime), 0, 0, "字体验收")) });
    const before = a.runtime.getValue(), after = structuredClone(before);
    const family = '"Songti SC", SimSun, "Times New Roman", serif';
    const leaf = (after[1] as any).children[0];
    leaf.fontFamily = family;
    const updates: Uint8Array[] = [];
    const stop = a.runtime.onLocalUpdate(bytes => updates.push(bytes));
    a.runtime.acceptEditorValue(before, after);
    expect(updates).toHaveLength(1);
    const message = { messageId: crypto.randomUUID(), update: b64(updates[0]!) };
    const ack = await documents.exchange(owner, r.id, message);
    expect((await documents.exchange(owner, r.id, message)).seq).toBe(ack.seq);
    let echoes = 0;
    const stopPeer = b.runtime.onLocalUpdate(() => echoes++);
    b.runtime.applyRemoteUpdate(encodeStateAsUpdate(a.doc));
    expect(echoes).toBe(0);
    expect(b.runtime.getValue()).toEqual(a.runtime.getValue());
    const loaded = await restoreDocument(db, r.id);
    const copied = await content.copy(owner, r.id);
    const copy = await restoreDocument(db, copied.id);
    try {
      expect((loaded.runtime.getValue()[1] as any).children[0].fontFamily).toBe(family);
      expect((copy.runtime.getValue()[1] as any).children[0].fontFamily).toBe(family);
    } finally { loaded.destroy(); copy.destroy(); }
    stop(); stopPeer();
  } finally { a.destroy(); b.destroy(); }
});
it("anchors comments to Yjs text and copies document content as an independent identity", async () => {
  const r = await resource();
  const a = await replica(r.id);
  try {
    const block = blockId(a.runtime);
    await documents.exchange(owner, r.id, {
      update: b64(a.runtime.editText(block, 0, 0, "hello world")),
    });
    const anchor = a.runtime.createCommentAnchor(block, 6, 11);
    await content.comment(
      owner,
      r.id,
      "选区评论",
      null,
      JSON.stringify({
        ...anchor,
        start: b64(anchor.start),
        end: b64(anchor.end),
      }),
    );
    await documents.exchange(owner, r.id, {
      update: b64(a.runtime.editText(block, 0, 0, "prefix ")),
    });
    const d = await content.detail(owner, r.id);
    expect(d.comments[0]?.anchor).toBeTruthy();
    expect(a.runtime.resolveCommentAnchor(anchor).start).toBe(13);
    const copy = await content.copy(owner, r.id);
    const loaded = await restoreDocument(db, copy.id);
    try {
      expect(loaded.runtime.getValue()[1]).toEqual(a.runtime.getValue()[1]);
      expect(JSON.stringify(loaded.runtime.getValue()[0])).toContain("副本");
      expect(loaded.state?.seq).toBe(0);
    } finally {
      loaded.destroy();
    }
    expect((await content.detail(owner, copy.id)).comments).toHaveLength(0);
    expect(
      (await content.list(owner, { q: "world", kind: "document" })).total,
    ).toBe(2);
    expect(
      (await content.list(reader, { q: "world", kind: "document" })).total,
    ).toBe(0);
  } finally {
    a.destroy();
  }
});
it("serves authenticated WebSocket collaboration, pushes notifications, counts unique users and rejects cross-origin", async () => {
  const app = await createApp(db, { origin: "http://localhost:39130" });
  const sockets: WebSocket[] = [];
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39130", origin: "http://localhost:39130" },
      payload: { login: "owner", password: "test-password-2026" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const r = await resource();
    const headers = {
      host: "localhost:39130",
      origin: "http://localhost:39130",
      cookie,
    };
    // injectWS sends an actual WebSocket handshake through Fastify hooks.
    const rawHeaders = Object.entries(headers).flat();
    const a = await app.injectWS("/api/v1/ws", { headers, rawHeaders }),
      b = await app.injectWS("/api/v1/ws", { headers, rawHeaders });
    sockets.push(a, b);
    const next = (
      ws: WebSocket,
      type: string,
      matches: (message: any) => boolean = () => true,
    ) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.off("message", fn);
          reject(new Error(`Waiting for ${type}`));
        }, 3000);
        const fn = (raw: any) => {
          const m = JSON.parse(String(raw));
          if (m.type === type && matches(m)) {
            clearTimeout(timer);
            ws.off("message", fn);
            resolve(m);
          }
        };
        ws.on("message", fn);
      });
    const joined = next(a, "sync-response");
    a.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "slate-kit",
        schemaVersion: 3,
        id: "join-a",
        room: r.id,
      }),
    );
    const initial = await joined;
    const joinedB = next(b, "sync-response");
    b.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "slate-kit",
        schemaVersion: 3,
        id: "join-b",
        room: r.id,
      }),
    );
    await joinedB;
    const doc = new Doc(),
      runtime = new YjsDocument(doc);
    try {
      applyUpdate(doc, unb64(initial.update));
      const update = runtime.editText(blockId(runtime), 0, 0, "websocket");
      const ack = next(a, "ack"),
        broadcast = next(b, "update");
      a.send(
        JSON.stringify({
          type: "update",
          protocolVersion: 1,
          codec: "slate-kit",
          schemaVersion: 3,
          epochId: initial.epochId,
          id: "u1",
          room: r.id,
          update: b64(update),
        }),
      );
      expect((await ack).seq).toBe(1);
      await broadcast;
      expect((await restoreDocument(db, r.id)).state?.seq).toBe(1);
      const p = runtime.createCommentAnchor(blockId(runtime), 2, 2);
      const point = { blockId: p.blockId, position: b64(p.start) };
      const cursorAtB = next(b, "cursors");
      const selfAtA = next(a, "cursors");
      a.send(
        JSON.stringify({
          type: "cursor",
          id: "cursor-a",
          room: r.id,
          userId: reader.id,
          name: "forged",
          color: "red",
          selection: { anchor: point, focus: point },
        }),
      );
      const first = (await cursorAtB).sessions;
      expect(first).toHaveLength(1);
      expect(first[0].userId).toBe(owner.id);
      expect(first[0].name).toBe(owner.display_name);
      expect((await selfAtA).sessions).toHaveLength(0);
      const cursorAtA = next(a, "cursors"),
        ownAtB = next(b, "cursors");
      b.send(
        JSON.stringify({
          type: "cursor",
          id: "cursor-b",
          room: r.id,
          selection: { anchor: point, focus: point },
        }),
      );
      const second = (await cursorAtA).sessions;
      expect(second).toHaveLength(1);
      expect(second[0].userId).toBe(first[0].userId);
      expect(second[0].connectionId).not.toBe(first[0].connectionId);
      expect(second[0].color).not.toBe(first[0].color);
      expect((await ownAtB).sessions).toHaveLength(1);
      expect((await restoreDocument(db, r.id)).state?.seq).toBe(1);
      const invalid = next(a, "error");
      a.send(
        JSON.stringify({
          type: "cursor",
          id: "bad",
          room: r.id,
          selection: {
            anchor: { blockId: p.blockId, position: "x".repeat(600) },
            focus: point,
          },
        }),
      );
      expect((await invalid).status).toBe(400);
      const codeAtB = next(b, "cursors");
      const codePoint = {
        kind: "code",
        blockId: "code-block",
        offset: 2,
        fingerprint: "1234abcd",
      };
      a.send(
        JSON.stringify({
          type: "cursor",
          id: "code-cursor",
          room: r.id,
          selection: { anchor: codePoint, focus: codePoint },
        }),
      );
      expect((await codeAtB).sessions[0].selection.focus).toEqual(codePoint);
      const cleared = next(a, "cursors");
      b.send(JSON.stringify({ type: "leave" }));
      expect((await cleared).sessions).toHaveLength(0);

      const current = await content.detail(owner, r.id);
      await content.permissions(owner, r.id, {
        version: current.resource.version,
        accessMode: "custom",
        visibility: "invited",
        grants: [{ userId: reader.id, role: "reader" }],
      });
      const readerLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers,
        payload: { login: "reader", password: "test-password-2026" },
      });
      const readerHeaders = {
        ...headers,
        cookie: String(readerLogin.headers["set-cookie"]).split(";")[0]!,
      };
      const readSocket = await app.injectWS("/api/v1/ws", {
        headers: readerHeaders,
        rawHeaders: Object.entries(readerHeaders).flat(),
      });
      sockets.push(readSocket);
      const readJoin = next(readSocket, "sync-response");
      readSocket.send(
        JSON.stringify({
          type: "join",
          protocolVersion: 1,
          codec: "slate-kit",
          schemaVersion: 3,
          id: "read-join",
          room: r.id,
        }),
      );
      await readJoin;
      const denied = next(readSocket, "error");
      readSocket.send(
        JSON.stringify({
          type: "cursor",
          id: "read-cursor",
          room: r.id,
          selection: { anchor: point, focus: point },
        }),
      );
      expect((await denied).status).toBe(403);
      const departed = next(a, "stats");
      readSocket.terminate();
      expect((await departed).online).toBe(1);
    } finally {
      runtime.destroy();
      doc.destroy();
    }
    const stats = await app.inject({ url: "/api/v1/admin/stats", headers });
    expect(stats.json().online).toBe(1);
    const onlineUsers = await app.inject({
      url: "/api/v1/admin/online-users",
      headers,
    });
    expect(onlineUsers.statusCode, onlineUsers.body).toBe(200);
    expect(onlineUsers.json()).toMatchObject({
      items: [{ id: owner.id, display_name: owner.display_name }],
      nextOffset: null,
    });
    const notice = next(a, "notifications.changed");
    await app.inject({
      method: "POST",
      url: `/api/v1/resources/${r.id}/comments`,
      headers,
      payload: { body: "通知测试", parentId: null },
    });
    await notice;
    const sheet = await content.create(owner, {
      kind: "document",
      format: "spreadsheet",
      title: "在线选区测试",
    });
    const sheetA = next(a, "sync-response");
    a.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "exlsx-cell-registers",
        schemaVersion: 6,
        id: "sheet-a",
        room: sheet.id,
      }),
    );
    const baseline = await sheetA;
    const sheetB = next(b, "sync-response");
    b.send(
      JSON.stringify({
        type: "join",
        protocolVersion: 1,
        codec: "exlsx-cell-registers",
        schemaVersion: 6,
        id: "sheet-b",
        room: sheet.id,
      }),
    );
    await sheetB;
    const cellAtB = next(
      b,
      "cursors",
      (m) =>
        m.room === sheet.id &&
        m.sessions.some((p: any) => p.selection.kind === "cells"),
    );
    const selection = {
      kind: "cells",
      sheetId: baseline.baseline.snapshot.sheetOrder[0],
      startRow: 2,
      endRow: 2,
      startColumn: 2,
      endColumn: 2,
      editing: true,
    };
    a.send(
      JSON.stringify({
        type: "cursor",
        id: "cell-a",
        room: sheet.id,
        epochId: baseline.epochId,
        name: "spoofed",
        selection,
      }),
    );
    const cells = (await cellAtB).sessions;
    expect(cells).toHaveLength(1);
    expect(cells[0].selection).toEqual(selection);
    expect(cells[0].name).toBe(owner.display_name);
    expect(cells[0].userId).toBe(owner.id);
    expect((await documents.exchange(owner, sheet.id, {})).seq).toBe(0);
    const invalidCell = next(a, "error");
    a.send(
      JSON.stringify({
        type: "cursor",
        id: "cell-invalid",
        room: sheet.id,
        epochId: baseline.epochId,
        selection: { ...selection, endColumn: 16384 },
      }),
    );
    expect((await invalidCell).status).toBe(400);
    await expect(
      app.injectWS("/api/v1/ws", {
        rawHeaders,
        headers: { ...headers, origin: "https://evil.example" },
      }),
    ).rejects.toThrow();
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});
