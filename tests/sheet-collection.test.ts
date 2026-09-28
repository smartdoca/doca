import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createExlsxCollaborationSession, restoreExlsxDocument, type ExlsxLocalTransaction } from "@smartdoca/sheet/yjs";
import { projectExlsxWorkbook, compactExlsxRecovery } from "@smartdoca/sheet/model";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createDocuments, b64 } from "@core/modules/collaboration/documents.js";
import { restoreSurface, provisionSurface, surfaceAnchor } from "@core/modules/documents/codecs/surfaces.js";

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = { ...await createUser(db, { login: "sheets", displayName: "Sheets QA", password: "qa-password-2026" }, { bootstrap: true }), admin: 1 };
});
afterEach(() => db.destroy());

it("schema 6 persists worksheet edits with duplicate ACK, text projection, new-sheet comments and recovery", async () => {
  const docs = createDocuments(db), content = createContent(db);
  const r = await content.create(owner, { kind: "document", format: "spreadsheet", title: "Worksheet QA" });
  const protocol = { codec: "exlsx-cell-registers", schemaVersion: 6, protocolVersion: 1 };
  const initial = await docs.exchange(owner, r.id, protocol);
  const loaded = await restoreSurface(db, r.id, "spreadsheet"), baseline = loaded.baseline!;
  expect(baseline.schemaVersion).toBe(6);
  const makeReplica = async (id: string) => {
    const doc = await restoreExlsxDocument({ baseline, update: loaded.update, checkpointSeq: 0 });
    const session = await createExlsxCollaborationSession({ doc, baseline, sessionId: id });
    const events: ExlsxLocalTransaction[] = [];
    let edit!: (m: any) => void;
    session.onLocalTransaction(e => events.push(e));
    // Server/codec acceptance; native rendering is covered by package engine tests and browser QA.
    await session.connect({ workbookId: r.id, initialSnapshot: baseline.snapshot, getSnapshot: () => baseline.snapshot,
      onLocalMutation: (f: any) => { edit = f; return () => {}; }, applyRemoteMutation: async () => {},
    } as any);
    return { doc, session, events, async value(sheetId: string, value: string) {
      const m = { id: "sheet.mutation.set-range-values", params: { unitId: r.id, subUnitId: sheetId, cellValue: { 0: { 0: { v: value } } } } };
      session.validateLocalMutation!(m); edit(m); await session.flush();
    }, close() { session.dispose(); doc.destroy(); } };
  };
  const a = await makeReplica("sheets-a"), b = await makeReplica("sheets-b");
  let seq = 0;
  const save = async (event: ExlsxLocalTransaction) => {
    const input = { ...protocol, epochId: initial.epochId, messageId: randomUUID(), update: b64(event.update) };
    expect((await docs.exchange(owner, r.id, input)).seq).toBe(++seq);
    expect((await docs.exchange(owner, r.id, input)).seq).toBe(seq);
  };
  const broadcast = async () => { const e = a.events.at(-1)!; await save(e); await b.session.applyUpdate(e); await b.session.applyUpdate(e); expect(b.events).toHaveLength(0); };
  try {
    const id = await a.session.editWorksheet!({ action: "add", name: "预算" }); await broadcast();
    expect(baseline.snapshot.sheets[id]).toBeUndefined();
    await a.value(id, "新增工作表可被搜索"); await broadcast();
    expect((await restoreSurface(db, r.id, "spreadsheet")).state.text).toContain("新增工作表可被搜索");
    const anchor = a.session.captureCellAnchor!({ sheetId: id, startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })!;
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(anchor);
    await expect(surfaceAnchor(db, r.id, "spreadsheet", { ...anchor, sheetId: "missing" })).rejects.toThrow();
    await a.session.editWorksheet!({ action: "rename", sheetId: id, name: "年度预算" }); await broadcast();
    await a.session.editWorksheet!({ action: "move", sheetId: id, index: 0 }); await broadcast();
    expect((await projectExlsxWorkbook(b.session.checkpoint(seq))).sheetOrder[0]).toBe(id);
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(anchor);
    await a.session.editWorksheet!({ action: "delete", sheetId: id }); await broadcast();
    await expect(surfaceAnchor(db, r.id, "spreadsheet", anchor)).rejects.toThrow("已删除");
    expect((await restoreSurface(db, r.id, "spreadsheet")).state.text).not.toContain("新增工作表可被搜索");
    await a.session.undo(); await broadcast();
    expect(await surfaceAnchor(db, r.id, "spreadsheet", anchor)).toEqual(anchor);
    await a.session.redo(); await broadcast();
    await a.session.undo(); await broadcast();
    const saved = await restoreSurface(db, r.id, "spreadsheet");
    const recovered = await compactExlsxRecovery({ baseline: saved.baseline!, update: saved.update, checkpointSeq: saved.state.checkpoint_seq });
    expect(saved.epochId).toBe(initial.epochId); expect(saved.baseline).toEqual(baseline);
    expect(await projectExlsxWorkbook(recovered)).toEqual(await projectExlsxWorkbook(a.session.checkpoint(seq)));
    expect(await projectExlsxWorkbook(recovered)).toEqual(await projectExlsxWorkbook(b.session.checkpoint(seq)));
    b.session.setReadOnly(true);
    await expect(b.session.editWorksheet!({ action: "add" })).rejects.toThrow();
    expect(b.events).toHaveLength(0);
    await expect(docs.exchange(owner, r.id, { ...protocol, schemaVersion: 5 })).rejects.toThrow();
    expect((await docs.exchange(owner, r.id, protocol)).seq).toBe(seq);
  } finally { a.close(); b.close(); }
});
