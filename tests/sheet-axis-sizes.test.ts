import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { createExlsxCollaborationSession, restoreExlsxDocument } from "@online-office/univer-sheet/yjs";
import { projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createDocuments, b64 } from "@core/modules/collaboration/documents.js";
import { restoreSurface, provisionSurface, surfaceAnchor } from "@core/modules/documents/codecs/surfaces.js";

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = { ...await createUser(db, { login: "sizes", displayName: "Sizes QA", password: "qa-password-2026" }, { bootstrap: true }), admin: 1 };
});
afterEach(() => db.destroy());

it("persists native row/column sizes once, preserves anchors, replays without echo and rejects malformed updates", async () => {
  const docs = createDocuments(db), content = createContent(db);
  const r = await content.create(owner, { kind: "document", format: "spreadsheet", title: "Axis QA" });
  await db.transaction().execute(tx => provisionSurface(tx, r));
  const protocol = { codec: "exlsx-cell-registers", schemaVersion: 6, protocolVersion: 1 };
  const initial = await docs.exchange(owner, r.id, protocol);
  const loaded = await restoreSurface(db, r.id, "spreadsheet"), baseline = loaded.baseline!;
  expect(baseline.schemaVersion).toBe(6);
  const sheetId = baseline.snapshot.sheetOrder[0]!;
  async function replica(id: string) {
    const doc = await restoreExlsxDocument({ baseline, update: loaded.update, checkpointSeq: 0 });
    const session = await createExlsxCollaborationSession({ doc, baseline, sessionId: id });
    let listener!: (m: any) => void;
    const events: any[] = [];
    session.onLocalTransaction(e => events.push(e));
    await session.connect({ workbookId: r.id, initialSnapshot: baseline.snapshot, getSnapshot: () => baseline.snapshot,
      onLocalMutation: (f: any) => { listener = f; return () => {}; }, applyRemoteMutation: async () => {},
    } as any);
    return { doc, session, events, mutate(id: string, data: object) {
      const m = { id, params: { unitId: r.id, subUnitId: sheetId, ranges: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }], ...data } };
      session.validateLocalMutation!(m); listener(m);
    } };
  }
  const a = await replica("sizes-a"), b = await replica("sizes-b");
  let seq = 0;
  async function save(event: any) {
    const input = { ...protocol, epochId: initial.epochId, messageId: randomUUID(), update: b64(event.update) };
    expect((await docs.exchange(owner, r.id, input)).seq).toBe(++seq);
    expect((await docs.exchange(owner, r.id, input)).seq).toBe(seq);
  }
  try {
    expect(a.session.capabilities.rowColumnSize).toMatchObject({ enabled: true, code: "SUPPORTED" });
    expect(a.events).toHaveLength(0);
    const anchor = a.session.captureCellAnchor!({ sheetId, startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 });
    a.mutate("sheet.mutation.set-worksheet-row-height", { rowHeight: 68 });
    a.mutate("sheet.mutation.set-worksheet-row-is-auto-height", { autoHeightInfo: 0 });
    expect(a.events).toHaveLength(1);
    await save(a.events[0]); await b.session.applyUpdate(a.events[0]); await b.session.applyUpdate(a.events[0]);
    expect(b.events).toHaveLength(0);
    b.mutate("sheet.mutation.set-worksheet-col-width", { colWidth: 222 });
    await save(b.events[0]); await a.session.applyUpdate(b.events[0]);
    expect(a.events).toHaveLength(1);
    const current = await restoreSurface(db, r.id, "spreadsheet");
    const snapshot = await projectExlsxWorkbook({ baseline: current.baseline!, update: current.update, checkpointSeq: current.state.checkpoint_seq });
    expect(snapshot.sheets[sheetId]!.rowData![1]).toMatchObject({ h: 68, ia: 0 });
    expect(snapshot.sheets[sheetId]!.columnData![1]!.w).toBe(222);
    expect(await projectExlsxWorkbook(a.session.checkpoint(seq))).toEqual(snapshot);
    expect(await projectExlsxWorkbook(b.session.checkpoint(seq))).toEqual(snapshot);
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(anchor);
    await b.session.undo(); await save(b.events.at(-1)); await a.session.applyUpdate(b.events.at(-1));
    expect((await projectExlsxWorkbook(a.session.checkpoint(seq))).sheets[sheetId]!.columnData?.[1]?.w).not.toBe(222);
    await b.session.redo(); await save(b.events.at(-1)); await a.session.applyUpdate(b.events.at(-1));
    a.session.setReadOnly(true);
    expect(() => a.mutate("sheet.mutation.set-worksheet-row-height", { rowHeight: 40 })).toThrow();
    expect(a.session.capabilities.rowColumnSize.code).toBe("READ_ONLY");
    const corrupt = await restoreExlsxDocument({ baseline, update: current.update, checkpointSeq: 0 });
    try {
      corrupt.getMap("exlsx:axis-sizes").set(JSON.stringify([sheetId, "row", "b:1"]), { h: 5000, ia: 0 });
      await expect(docs.exchange(owner, r.id, { ...protocol, epochId: initial.epochId, messageId: randomUUID(), update: b64(Y.encodeStateAsUpdate(corrupt)) })).rejects.toThrow();
      expect((await docs.exchange(owner, r.id, protocol)).seq).toBe(seq);
    } finally { corrupt.destroy(); }
  } finally { a.session.dispose(); b.session.dispose(); a.doc.destroy(); b.doc.destroy(); }
});
