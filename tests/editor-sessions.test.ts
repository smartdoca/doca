import { openTestDatabase as openDatabase } from "./database.js";
import { it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { CanvasModel } from "aidcanvas/model";
import {
  restoreExlsxDocument,
  createExlsxBaseline,
  createExlsxCollaborationSession,
} from "@online-office/univer-sheet/yjs";
import { projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import { type DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createDocuments,
  b64,
  unb64,
} from "@core/modules/collaboration/documents.js";
import {
  restoreSurface,
  surfaceAnchor,
  provisionSurface,
} from "@core/modules/documents/codecs/surfaces.js";
import { createExperience } from "@core/workflows/experience.js";
import { DocaYjsDocument } from "@core/modules/documents/codecs/rich-runtime.js";
let db: DB, owner: Actor;
const commentBody = (text: string) => ({
  version: 1 as const,
  blocks: [
    { type: "paragraph" as const, children: [{ type: "text" as const, text }] },
  ],
});
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "qatest", displayName: "QA", password: "qa-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());
it("current spreadsheet structure and charts survive host ACK, concurrent edits and comment relocation", async () => {
  const content = createContent(db),
    docs = createDocuments(db);
  const r = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "Structure QA",
  });
  await db.transaction().execute((tx) => provisionSurface(tx, r));
  const proto = {
    codec: "exlsx-cell-registers",
    schemaVersion: 6,
    protocolVersion: 1,
  };
  const initial = await docs.exchange(owner, r.id, proto);
  const loaded = await restoreSurface(db, r.id, "spreadsheet");
  const sheetId = loaded.baseline!.snapshot.sheetOrder[0]!;
  async function replica(name: string) {
    const doc = await restoreExlsxDocument({
      baseline: loaded.baseline!,
      update: loaded.update,
      checkpointSeq: 0,
    });
    const session = await createExlsxCollaborationSession({
      doc,
      baseline: loaded.baseline!,
      sessionId: name,
    });
    const events: any[] = [];
    let edit!: (m: any) => void;
    session.onLocalTransaction((e) => events.push(e));
    await session.connect({
      workbookId: r.id,
      initialSnapshot: loaded.baseline!.snapshot,
      getSnapshot: () => loaded.baseline!.snapshot,
      onLocalMutation: (f: any) => {
        edit = f;
        return () => {};
      },
      applyRemoteMutation: async () => {},
    } as any);
    return {
      doc,
      session,
      events,
      edit: (value: string) =>
        edit({
          id: "sheet.mutation.set-range-values",
          params: {
            unitId: r.id,
            subUnitId: sheetId,
            cellValue: { 1: { 0: { v: value } } },
          },
        }),
    };
  }
  const a = await replica("a"),
    b = await replica("b");
  expect(loaded.baseline!.schemaVersion).toBe(6);
  for (const operation of [
    "freeze",
    "filter",
    "sort",
    "merge",
    "conditionalFormat",
    "dataValidation",
    "formatPainter",
  ] as const) {
    expect(a.session.capabilities[operation]).toMatchObject({
      enabled: true,
      code: "SUPPORTED",
    });
    expect(a.session.capabilities[operation].reason).toBeTruthy();
  }
  let sent = 0;
  const save = async (event: any) => {
    const message = {
      ...proto,
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(event.update),
    };
    expect((await docs.exchange(owner, r.id, message)).seq).toBe(++sent);
    expect((await docs.exchange(owner, r.id, message)).seq).toBe(sent);
  };
  try {
    const range = {
      sheetId,
      startRow: 1,
      endRow: 1,
      startColumn: 0,
      endColumn: 0,
    };
    const anchor = a.session.captureCellAnchor!(range)!;
    await a.session.editStructure!({
      sheetId,
      axis: "row",
      action: "insert",
      index: 0,
      count: 1,
    });
    b.edit("并发编辑保留");
    await save(a.events[0]);
    await save(b.events[0]);
    await a.session.applyUpdate(b.events[0]);
    await b.session.applyUpdate(a.events[0]);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.session.resolveCellAnchor!(anchor)?.startRow).toBe(2);
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(
      anchor,
    );
    await content.comment(
      owner,
      r.id,
      commentBody("稳定身份评论"),
      null,
      JSON.stringify(anchor),
    );
    await a.session.putFloatingObject!({
      kind: "chart",
      type: "column",
      title: "测试图表",
      anchor: range,
      source: { ...range, endRow: 3, endColumn: 1 },
      width: 320,
      height: 200,
    });
    await save(a.events.at(-1));
    await b.session.applyUpdate(a.events.at(-1));
    const checkpoint = await restoreSurface(db, r.id, "spreadsheet");
    const snapshot = await projectExlsxWorkbook({
      baseline: checkpoint.baseline!,
      update: checkpoint.update,
      checkpointSeq: checkpoint.state.checkpoint_seq,
    });
    expect(snapshot.sheets[sheetId]!.cellData![2]![0]!.v).toBe("并发编辑保留");
    expect(
      snapshot.resources?.some((r) => r.name === "EXLSX_FLOATING_OBJECTS"),
    ).toBe(true);
    expect(await projectExlsxWorkbook(b.session.checkpoint(sent))).toEqual(
      snapshot,
    );
    await a.session.editStructure!({
      sheetId,
      axis: "row",
      action: "delete",
      index: 2,
      count: 1,
    });
    await save(a.events.at(-1));
    await expect(
      surfaceAnchor(db, r.id, "spreadsheet", anchor),
    ).rejects.toThrow("已删除");
    a.session.setReadOnly(true);
    await expect(
      a.session.editStructure!({
        sheetId,
        axis: "column",
        action: "insert",
        index: 0,
        count: 1,
      }),
    ).rejects.toThrow();
  } finally {
    a.session.dispose();
    b.session.dispose();
    a.doc.destroy();
    b.doc.destroy();
  }
});
it("format-painter style-only transactions preserve content through host ACK, undo and reload", async () => {
  const docs = createDocuments(db),
    content = createContent(db);
  const resource = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "Painter QA",
  });
  await db.transaction().execute((tx) => provisionSurface(tx, resource));
  const protocol = {
    codec: "exlsx-cell-registers",
    schemaVersion: 6,
    protocolVersion: 1,
  };
  const initial = await docs.exchange(owner, resource.id, protocol);
  const loaded = await restoreSurface(db, resource.id, "spreadsheet");
  const baseline = loaded.baseline!,
    sheetId = baseline.snapshot.sheetOrder[0]!;
  async function replica(sessionId: string) {
    const doc = await restoreExlsxDocument({
      baseline,
      update: loaded.update,
      checkpointSeq: 0,
    });
    const session = await createExlsxCollaborationSession({
      doc,
      baseline,
      sessionId,
    });
    const events: any[] = [];
    let mutation!: (m: any) => void;
    session.onLocalTransaction((event) => events.push(event));
    await session.connect({
      workbookId: resource.id,
      initialSnapshot: baseline.snapshot,
      getSnapshot: () => baseline.snapshot,
      onLocalMutation: (listener: any) => {
        mutation = listener;
        return () => {};
      },
      applyRemoteMutation: async () => {},
    } as any);
    return {
      doc,
      session,
      events,
      write(cellValue: object) {
        mutation({
          id: "sheet.mutation.set-range-values",
          params: { unitId: resource.id, subUnitId: sheetId, cellValue },
        });
      },
    };
  }
  const a = await replica("painter-a"),
    b = await replica("painter-b");
  let seq = 0;
  async function save(event: any) {
    const message = {
      ...protocol,
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(event.update),
    };
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(++seq);
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(seq);
  }
  try {
    a.write({ 0: { 0: { v: 12, f: "=1+11" } } });
    await save(a.events[0]);
    await b.session.applyUpdate(a.events[0]);
    const anchor = a.session.captureCellAnchor!({
      sheetId,
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    });
    const before = a.events.length;
    a.write({ 0: { 0: { s: { bl: 1, bg: { rgb: "#ffee00" } } } } });
    expect(a.events.length).toBe(before + 1);
    await save(a.events.at(-1));
    await b.session.applyUpdate(a.events.at(-1));
    await b.session.applyUpdate(a.events.at(-1));
    expect(b.events).toHaveLength(0);
    expect(await surfaceAnchor(db, resource.id, "spreadsheet", anchor)).toEqual(
      anchor,
    );
    const saved = await restoreSurface(db, resource.id, "spreadsheet");
    const projection = await projectExlsxWorkbook({
      baseline: saved.baseline!,
      update: saved.update,
      checkpointSeq: saved.state.checkpoint_seq,
    });
    expect(projection.sheets[sheetId]!.cellData![0]![0]).toMatchObject({
      v: 12,
      f: "=1+11",
      s: { bl: 1, bg: { rgb: "#ffee00" } },
    });
    await a.session.undo();
    await save(a.events.at(-1));
    await b.session.applyUpdate(a.events.at(-1));
    const undone = await projectExlsxWorkbook(b.session.checkpoint(seq));
    expect(undone.sheets[sheetId]!.cellData![0]![0]).toMatchObject({
      v: 12,
      f: "=1+11",
    });
    expect(undone.sheets[sheetId]!.cellData![0]![0]!.s).toBeUndefined();
    a.session.setReadOnly(true);
    expect(a.session.capabilities.formatPainter).toMatchObject({
      enabled: false,
      code: "READ_ONLY",
    });
  } finally {
    a.session.dispose();
    b.session.dispose();
    a.doc.destroy();
    b.doc.destroy();
  }
});
it("new sheets negotiate schema 6 by default with durable ACK and stable record comments", async () => {
  const content = createContent(db),
    docs = createDocuments(db);
  const r = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "rc8 isolated",
  });
  const proto = {
    protocolVersion: 1,
    codec: "exlsx-cell-registers",
    schemaVersion: 6,
  };
  const initial = await docs.exchange(owner, r.id, proto);
  const loaded = await restoreSurface(db, r.id, "spreadsheet");
  const doc = await restoreExlsxDocument({
    baseline: loaded.baseline!,
    update: loaded.update,
    checkpointSeq: 0,
  });
  const session = await createExlsxCollaborationSession({
    doc,
    baseline: loaded.baseline!,
    sessionId: "rc8-test",
  });
  const updates: Uint8Array[] = [];
  let edit!: (m: any) => void;
  session.onLocalTransaction((t) => updates.push(t.update));
  const sheetId = loaded.baseline!.snapshot.sheetOrder[0]!;
  await session.connect({
    workbookId: r.id,
    initialSnapshot: loaded.baseline!.snapshot,
    getSnapshot: () => loaded.baseline!.snapshot,
    onLocalMutation: (callback: any) => {
      edit = callback;
      return () => {};
    },
    applyRemoteMutation: async () => {},
  } as any);
  try {
    const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 };
    const anchor = session.captureCellAnchor!({
      ...range,
      sheetId,
      endRow: 1,
    })!;
    const cases: [string, object][] = [
      ["sheet.mutation.add-worksheet-merge", { ranges: [range] }],
      ["sheet.mutation.remove-worksheet-merge", { ranges: [range] }],
      ["sheet.mutation.set-filter-range", { range }],
      [
        "sheet.mutation.set-filter-criteria",
        { col: 0, criteria: { filters: { filters: ["keep"] } } },
      ],
      [
        "sheet.mutation.add-conditional-rule",
        {
          rule: {
            cfId: "rc8-rule",
            ranges: [range],
            rule: {
              type: "highlightCell",
              subType: "number",
              operator: "greaterThan",
              value: 10,
              style: { bg: { rgb: "#ffff00" } },
            },
          },
        },
      ],
      [
        "data-validation.mutation.addRule",
        {
          rule: {
            uid: "rc8-dropdown",
            type: "list",
            formula1: "待办,完成",
            ranges: [range],
            allowBlank: true,
          },
        },
      ],
      [
        "sheet.mutation.reorder-range",
        { range: { ...range, endColumn: 99 }, order: { 0: 0, 1: 2, 2: 1 } },
      ],
    ];
    let seq = 0;
    for (const [id, params] of cases) {
      const mutation = {
        id,
        params: { ...params, unitId: r.id, subUnitId: sheetId },
      };
      session.validateLocalMutation!(mutation);
      edit(mutation);
      const message = {
        ...proto,
        epochId: initial.epochId,
        messageId: randomUUID(),
        update: b64(updates.at(-1)!),
      };
      const ack = await docs.exchange(owner, r.id, message);
      expect(ack.seq).toBe(++seq);
      expect((await docs.exchange(owner, r.id, message)).seq).toBe(seq);
      const saved = await restoreSurface(db, r.id, "spreadsheet");
      expect(
        await projectExlsxWorkbook({
          baseline: saved.baseline!,
          update: saved.update,
          checkpointSeq: saved.state.checkpoint_seq,
        }),
      ).toEqual(await projectExlsxWorkbook(session.checkpoint(seq)));
    }
    expect(session.resolveCellAnchorRanges!(anchor)).toHaveLength(2);
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(
      anchor,
    );
    await expect(
      surfaceAnchor(db, r.id, "spreadsheet", {
        ...anchor,
        rowIds: ["b:0", "b:0"],
      }),
    ).rejects.toThrow("范围");
    await expect(
      docs.exchange(owner, r.id, { ...proto, schemaVersion: 2 }),
    ).rejects.toThrow("协议");
  } finally {
    session.dispose();
    doc.destroy();
  }
});
it("native sheet mentions retain mixed text and notify once after durable acknowledgement", async () => {
  const peer = await createUser(
    db,
    { login: "nativepeer", displayName: "乙", password: "qa-password-2026" },
    { actor: owner },
  );
  const content = createContent(db),
    docs = createDocuments(db);
  const resource = await content.create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "native mentions",
  });
  await content.permissions(owner, resource.id, {
    version: resource.version,
    visibility: "invited",
    accessMode: "custom",
    grants: [{ userId: peer.id, role: "editor" }],
  });
  const proto = protocol("spreadsheet");
  const initial = await docs.exchange(owner, resource.id, proto);
  const loaded = await restoreSurface(db, resource.id, "spreadsheet");
  const doc = await restoreExlsxDocument({
    baseline: loaded.baseline!,
    update: loaded.update,
    checkpointSeq: 0,
  });
  try {
    const sheetId = loaded.baseline!.snapshot.sheetOrder[0]!;
    const vector = Y.encodeStateVector(doc);
    doc
      .getMap("exlsx:identity-cells")
      .set(JSON.stringify([sheetId, "b:0", "b:0", "content"]), {
        v: null,
        f: null,
        t: null,
        si: null,
        p: {
          id: "mixed",
          documentStyle: {},
          body: {
            dataStream: "前缀 @乙 后缀\r\n",
            paragraphs: [{ startIndex: 8 }],
            customRanges: [
              {
                startIndex: 3,
                endIndex: 4,
                rangeId: "mention-1",
                rangeType: 5,
                wholeEntity: true,
                properties: {
                  exlsxInlineV1: { type: "user", refId: peer.id, label: "@乙" },
                },
              },
            ],
          },
        },
      });
    const message = {
      ...proto,
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, vector)),
    };
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(1);
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(1);
    const saved = await restoreSurface(db, resource.id, "spreadsheet");
    const snapshot = await projectExlsxWorkbook({
      baseline: saved.baseline!,
      update: saved.update,
      checkpointSeq: saved.state.checkpoint_seq,
    });
    expect(
      snapshot.sheets[sheetId]!.cellData![0]![0]!.p!.body!.dataStream,
    ).toBe("前缀 @乙 后缀\r\n");
    const state = await db
      .selectFrom("document_states")
      .select("text")
      .where("resource_id", "=", resource.id)
      .executeTakeFirstOrThrow();
    expect(state.text).toContain("前缀 @乙 后缀");
    const notices = await db
      .selectFrom("notifications")
      .selectAll()
      .where("resource_id", "=", resource.id)
      .where("user_id", "=", peer.id)
      .where("type", "=", "document.mentioned")
      .execute();
    expect(notices).toHaveLength(1);
  } finally {
    doc.destroy();
  }
});
it("unsupported rich encoding is rejected without rewriting saved bytes", async () => {
  const content = createContent(db),
    docs = createDocuments(db);
  const r = await content.create(owner, {
    kind: "document",
    format: "rich_text",
    title: "unsupported fixture",
  });
  await docs.exchange(owner, r.id, {
    protocolVersion: 1,
    codec: "slate-kit",
    schemaVersion: 3,
  });
  await db
    .updateTable("document_states")
    .set({ codec: "slatetsx-yjs-v1" })
    .where("resource_id", "=", r.id)
    .execute();
  const before = await db
    .selectFrom("document_states")
    .selectAll()
    .where("resource_id", "=", r.id)
    .executeTakeFirstOrThrow();
  await expect(
    docs.exchange(owner, r.id, {
      protocolVersion: 1,
      codec: "slate-kit",
      schemaVersion: 3,
    }),
  ).rejects.toThrow("编码与当前编辑器不匹配");
  expect(
    await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", r.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(before);
});
const protocol = (format: string) => ({
  codec:
    format === "canvas"
      ? "aidcanvas-yjs"
      : format === "rich_text"
        ? "slate-kit"
        : "exlsx-cell-registers",
  schemaVersion: format === "spreadsheet" ? 6 : format === "rich_text" ? 3 : 1,
  protocolVersion: 1,
});
it("accepts empty upload placeholders, preserves text on reload, and still rejects unsafe resource paths", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "rich_text",
    title: "Upload recovery",
  });
  const docs = createDocuments(db),
    initial = await docs.exchange(owner, r.id, protocol("rich_text"));
  const doc = new Y.Doc(),
    runtime = new DocaYjsDocument(doc);
  Y.applyUpdate(doc, unb64(initial.update));
  try {
    const update = runtime.execute({
      type: "insertBlock",
      block: {
        type: "image",
        id: "upload-image",
        path: "",
        alt: "pending.png",
        children: [{ text: "" }],
      },
    });
    await docs.exchange(owner, r.id, {
      ...protocol("rich_text"),
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(update),
    });
    const loaded = await docs.exchange(owner, r.id, {
      ...protocol("rich_text"),
      epochId: initial.epochId,
    });
    const peerDoc = new Y.Doc(),
      peer = new DocaYjsDocument(peerDoc);
    try {
      Y.applyUpdate(peerDoc, unb64(loaded.update));
      expect(peer.getValue()).toEqual(runtime.getValue());
    } finally {
      peer.destroy();
      peerDoc.destroy();
    }
    const invalid = runtime.execute({
      type: "setBlock",
      blockId: "upload-image",
      properties: { path: "blob:unsafe" },
    });
    await expect(
      docs.exchange(owner, r.id, {
        ...protocol("rich_text"),
        epochId: initial.epochId,
        messageId: randomUUID(),
        update: b64(invalid),
      }),
    ).rejects.toThrow("文件必须通过本系统上传");
    const after = await docs.exchange(owner, r.id, {
      ...protocol("rich_text"),
      epochId: initial.epochId,
    });
    expect(after.seq).toBe(loaded.seq);
  } finally {
    runtime.destroy();
    doc.destroy();
  }
});
it("canvas canonicalizes generated fill caches and still rejects raw unsafe updates atomically", async () => {
  const content = createContent(db),
    docs = createDocuments(db);
  const r = await content.create(owner, {
    kind: "document",
    format: "canvas",
    title: "Pattern security QA",
  });
  const initial = await docs.exchange(owner, r.id, protocol("canvas"));
  const model = CanvasModel.restore({
    codec: "aidcanvas-yjs",
    schemaVersion: 1,
    epochId: initial.epochId!,
    update: unb64(initial.update),
  });
  const vector = model.stateVector();
  try {
    model.add({
      id: "pattern",
      tag: "Rect",
      width: 100,
      height: 100,
      fill: {
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgo=",
        mode: "stretch",
      },
      data: {
        roughMode: true,
        roughFillStyle: "hachure",
        roughOriginalFill: "#ffc9c9",
      },
    });
    const safe = model.diff(vector).update;
    expect(Buffer.from(safe).toString()).not.toContain("data:image");
    await docs.exchange(owner, r.id, {
      ...protocol("canvas"),
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(safe),
    });
    const stored = await restoreSurface(db, r.id, "canvas");
    expect(stored.state.seq).toBe(1);
    const bad = new Y.Doc();
    try {
      Y.applyUpdate(bad, stored.update);
      const before = Y.encodeStateVector(bad);
      bad.getMap<any>("elements").get("pattern").get("props").set("fill", {
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgo=",
      });
      await expect(
        docs.exchange(owner, r.id, {
          ...protocol("canvas"),
          epochId: initial.epochId,
          messageId: randomUUID(),
          update: b64(Y.encodeStateAsUpdate(bad, before)),
        }),
      ).rejects.toThrow();
      const unchanged = await restoreSurface(db, r.id, "canvas");
      expect(unchanged.state.seq).toBe(1);
      expect(b64(unchanged.update)).toBe(b64(stored.update));
    } finally {
      bad.destroy();
    }
  } finally {
    model.dispose();
  }
});
for (const format of ["spreadsheet", "canvas"] as const)
  it(`${format}: exact receipt, epoch/schema/ACL validation, original checkpoints and independent copy`, async () => {
    const content = createContent(db),
      docs = createDocuments(db),
      r = await content.create(owner, {
        kind: "document",
        format,
        title: "QA",
      });
    const proto = protocol(format);
    await expect(
      docs.exchange(owner, r.id, { ...proto, schemaVersion: 42 }),
    ).rejects.toThrow();
    expect(
      await db
        .selectFrom("document_states")
        .selectAll()
        .where("resource_id", "=", r.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    const initial = await docs.exchange(owner, r.id, proto),
      envelope = { ...proto, epochId: initial.epochId };
    let update: Uint8Array, anchor: any, dispose: () => void;
    if (format === "canvas") {
      const model = CanvasModel.restore({
        codec: "aidcanvas-yjs",
        schemaVersion: 1,
        epochId: initial.epochId!,
        update: unb64(initial.update),
      });
      const vector = model.stateVector();
      model.add({
        id: "element-a",
        tag: "Text",
        text: "Hello canvas",
        x: 20,
        y: 30,
      });
      update = model.diff(vector).update;
      anchor = model.captureAnchor(["element-a"]);
      dispose = () => model.dispose();
    } else {
      const doc = await restoreExlsxDocument({
        baseline: (initial as any).baseline,
        update: unb64(initial.update),
        checkpointSeq: 0,
      });
      const vector = Y.encodeStateVector(doc),
        sheetId = (initial as any).baseline.snapshot.sheetOrder[0];
      doc
        .getMap("exlsx:identity-cells")
        .set(JSON.stringify([sheetId, "b:0", "b:0", "content"]), {
          v: "Hello sheet",
          f: null,
          p: null,
          t: null,
          si: null,
        });
      update = Y.encodeStateAsUpdate(doc, vector);
      anchor = {
        version: 4,
        rowIds: ["b:0"],
        columnIds: ["b:0"],
        epochId: initial.epochId!,
        sheetId,
        startRowId: "b:0",
        endRowId: "b:0",
        startColumnId: "b:0",
        endColumnId: "b:0",
      };
      dispose = () => doc.destroy();
    }
    try {
      const message = {
        ...envelope,
        update: b64(update),
        messageId: randomUUID(),
      };
      await expect(
        docs.exchange(owner, r.id, { ...message, epochId: randomUUID() }),
      ).rejects.toThrow("谱系");
      const first = await docs.exchange(owner, r.id, message);
      expect(first.seq).toBe(1);
      expect((await docs.exchange(owner, r.id, message)).changed).toBe(false);
      await expect(
        docs.exchange(owner, r.id, {
          ...message,
          update: b64(new Uint8Array([0, 0])),
        }),
      ).rejects.toThrow("提交标识");
      const before = await restoreSurface(db, r.id, format);
      expect(before.epochId).toBe(initial.epochId);
      const c = await content.comment(
        owner,
        r.id,
        commentBody("region"),
        null,
        JSON.stringify(anchor),
      );
      expect(c.id).toBeTruthy();
      await expect(
        content.comment(owner, r.id, commentBody("overall"), null),
      ).rejects.toThrow("区域评论");
      expect(await surfaceAnchor(db, r.id, format, anchor)).toEqual(anchor);
      const history = createExperience(db);
      const version = await history.snapshot(owner, r.id);
      const preview = await history.version(owner, r.id, version.id);
      expect((preview as any).surface.update).toBe(b64(before.update));
      expect((preview as any).canRestore).toBe(false);
      const copied = await content.copy(owner, r.id);
      const copy = await restoreSurface(db, copied.id, format);
      expect(copy.epochId).not.toBe(initial.epochId);
      await content.permissions(owner, r.id, {
        version: (await content.detail(owner, r.id)).resource.version,
        visibility: "public",
        accessMode: "custom",
        grants: [],
      });
      await expect(docs.exchange(null, r.id, message)).rejects.toThrow("只读");
      expect((await docs.exchange(null, r.id, envelope)).rank).toBe(1);
      const resource = (await content.detail(owner, r.id)).resource;
      await content.trash(owner, r.id, resource.version);
      const trashed = await content.trashPreview(owner, r.id);
      expect(trashed.surface?.update).toBe(b64(before.update));
    } finally {
      dispose();
    }
  });
it("canvas: two clients preserve concurrent edits, deleted anchors disappear, checkpoint and pure-delete resync never echo", async () => {
  const c = createContent(db),
    docs = createDocuments(db),
    r = await c.create(owner, {
      kind: "document",
      format: "canvas",
      title: "Canvas",
    });
  const initial = await docs.exchange(owner, r.id, protocol("canvas"));
  const checkpoint = {
    codec: "aidcanvas-yjs" as const,
    schemaVersion: 1 as const,
    epochId: initial.epochId!,
    update: unb64(initial.update),
  };
  const a = CanvasModel.restore(checkpoint),
    b = CanvasModel.restore(checkpoint);
  const qa: any[] = [],
    qb: any[] = [];
  a.onLocalUpdate((m) => qa.push(m));
  b.onLocalUpdate((m) => qb.push(m));
  try {
    a.add({ id: "a", tag: "Text", text: "One" });
    b.add({ id: "b", tag: "Rect", width: 10, height: 20 });
    a.applyUpdate(qb[0]);
    b.applyUpdate(qa[0]);
    expect(qa).toHaveLength(1);
    expect(qb).toHaveLength(1);
    expect(a.getValue().scene).toEqual(b.getValue().scene);
    for (const m of [...qa, ...qb])
      await docs.exchange(owner, r.id, {
        ...protocol("canvas"),
        epochId: m.epochId,
        messageId: m.id,
        update: b64(m.update),
      });
    const anchor = a.captureAnchor(["a", "b"]);
    a.remove(["a"]);
    b.applyUpdate(qa.at(-1));
    expect(a.resolveAnchor(anchor)).toMatchObject({
      valid: true,
      partial: true,
      elementIds: ["b"],
    });
    await docs.exchange(owner, r.id, {
      ...protocol("canvas"),
      epochId: initial.epochId!,
      messageId: qa.at(-1).id,
      update: b64(qa.at(-1).update),
    });
    const length = qa.length;
    for (let i = 0; i < 5; i++) {
      const sync = await docs.exchange(owner, r.id, {
        ...protocol("canvas"),
        epochId: initial.epochId,
        vector: b64(a.stateVector()),
      });
      a.applyUpdate({ ...checkpoint, update: unb64(sync.update) });
      expect(sync.seq).toBe(3);
    }
    expect(qa).toHaveLength(length);
    b.setReadOnly(true);
    expect(() => b.add({ tag: "Rect" })).toThrow();
  } finally {
    a.dispose();
    b.dispose();
  }
});
it("spreadsheet rc.2 rejects incomplete content registers without committing", async () => {
  const r = await createContent(db).create(owner, {
    kind: "document",
    format: "spreadsheet",
    title: "invalid register fixture",
  });
  const docs = createDocuments(db),
    proto = protocol("spreadsheet");
  const initial = await docs.exchange(owner, r.id, proto);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, unb64(initial.update));
    const vector = Y.encodeStateVector(doc);
    doc
      .getMap("exlsx:identity-cells")
      .set(
        JSON.stringify([
          (initial as any).baseline.snapshot.sheetOrder[0],
          "b:0",
          "b:0",
          "content",
        ]),
        { v: "bad", f: null },
      );
    await expect(
      docs.exchange(owner, r.id, {
        ...proto,
        epochId: initial.epochId,
        messageId: randomUUID(),
        update: b64(Y.encodeStateAsUpdate(doc, vector)),
      }),
    ).rejects.toThrow("Invalid atomic cell content register");
    expect((await restoreSurface(db, r.id, "spreadsheet")).state.seq).toBe(0);
  } finally {
    doc.destroy();
  }
});
it("rich text: host forwards local undo/redo, never remote updates; atomic fields survive checkpoint", () => {
  const aDoc = new Y.Doc(),
    a = new DocaYjsDocument(aDoc);
  const userId = randomUUID();
  a.initialize([
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "hello " },
        {
          type: "custom:user-mention",
          id: "mention",
          userId,
          label: "QA",
          children: [{ text: "" }],
        },
      ],
    },
  ]);
  const bDoc = new Y.Doc(),
    b = new DocaYjsDocument(bDoc);
  Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc));
  const sent: Uint8Array[] = [];
  let echoes = 0;
  a.onLocalUpdate((m) => {
    sent.push(m);
    b.applyRemoteUpdate(m);
  });
  b.onLocalUpdate(() => echoes++);
  a.editText("p", 0, 0, "new ");
  a.undo();
  a.redo();
  expect(sent).toHaveLength(3);
  expect(echoes).toBe(0);
  expect(a.getValue()).toEqual(b.getValue());
  expect(JSON.stringify(b.getValue())).toContain(userId);
  a.destroy();
  b.destroy();
  aDoc.destroy();
  bDoc.destroy();
});
it("rejects hidden unknown canvas roots and preserves committed data", async () => {
  const c = createContent(db),
    docs = createDocuments(db),
    r = await c.create(owner, {
      kind: "document",
      format: "canvas",
      title: "QA",
    });
  const initial = await docs.exchange(owner, r.id, protocol("canvas")),
    doc = new Y.Doc();
  Y.applyUpdate(doc, unb64(initial.update));
  const vector = Y.encodeStateVector(doc);
  doc.getMap("hidden").set("x", "bad");
  await expect(
    docs.exchange(owner, r.id, {
      ...protocol("canvas"),
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, vector)),
    }),
  ).rejects.toThrow("未知");
  expect((await restoreSurface(db, r.id, "canvas")).state.seq).toBe(0);
  doc.destroy();
});
