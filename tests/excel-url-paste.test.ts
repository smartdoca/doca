import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  createExlsxBaseline,
  restoreExlsxDocument,
  createExlsxCollaborationSession,
} from "@online-office/univer-sheet/yjs";
import { projectExlsxWorkbook } from "@online-office/univer-sheet/model";
import type {
  CollaborationContext,
  CollaborationMutation,
  WorkbookSnapshot,
} from "@online-office/univer-sheet";

it("installed Excel artifact persists native URL paste without serializing infinite layout dimensions", async () => {
  const snapshot = {
    id: "paste-test",
    name: "paste",
    styles: {},
    sheetOrder: ["sheet"],
    sheets: {
      sheet: {
        id: "sheet",
        name: "Sheet",
        rowCount: 100,
        columnCount: 26,
        cellData: {},
      },
    },
  } as unknown as WorkbookSnapshot;
  const bundle = await createExlsxBaseline(snapshot, "paste-epoch");
  const doc = await restoreExlsxDocument(bundle);
  const peer = await restoreExlsxDocument(bundle);
  const session = await createExlsxCollaborationSession({
    doc,
    baseline: bundle.baseline,
    sessionId: "paste-tab",
  });
  let local: ((mutation: CollaborationMutation) => void) | undefined;
  let writes = 0;
  session.onLocalTransaction(({ update }) => {
    writes++;
    Y.applyUpdate(peer, update);
  });
  try {
    const context: CollaborationContext = {
      // Headless model test: these native UI handles are never used by the session.
      runtime: {} as CollaborationContext["runtime"],
      workbook: {} as CollaborationContext["workbook"],
      workbookId: snapshot.id,
      initialSnapshot: snapshot,
      getSnapshot: () => snapshot,
      onLocalMutation(callback) {
        local = callback;
        return () => {};
      },
      async applyRemoteMutation() {
        return true;
      },
    };
    await session.connect(context);
    await session.ready;
    const p = {
      id: "cell-document",
      body: { dataStream: "http://localhost/#/r/doc\r\n" },
      documentStyle: { pageSize: { width: Infinity, height: Infinity } },
    };
    const mutation: CollaborationMutation = {
      id: "sheet.mutation.set-range-values",
      params: {
        unitId: snapshot.id,
        subUnitId: "sheet",
        cellValue: { 0: { 0: { p } } },
      },
    };
    session.validateLocalMutation?.(mutation);
    local!(mutation);
    await session.flush();
    expect(writes).toBe(1);
    expect(p.documentStyle.pageSize.width).toBe(Infinity);
    const projected = await projectExlsxWorkbook({
      baseline: bundle.baseline,
      update: Y.encodeStateAsUpdate(peer),
      checkpointSeq: 1,
    });
    expect(projected.sheets.sheet!.cellData?.[0]?.[0]?.p).toEqual({
      ...p,
      documentStyle: { pageSize: {} },
    });
    const checkpoint = session.checkpoint(1);
    const restored = await restoreExlsxDocument(checkpoint);
    expect(
      await projectExlsxWorkbook({
        ...checkpoint,
        update: Y.encodeStateAsUpdate(restored),
      }),
    ).toEqual(projected);
    restored.destroy();
    local!(mutation);
    expect(writes).toBe(1);
    expect(() =>
      session.validateLocalMutation?.({
        ...mutation,
        params: {
          ...mutation.params,
          cellValue: { 0: { 0: { p: { ...p, unsafe: Infinity } } } },
        },
      }),
    ).toThrow("JSON data");
    expect(writes).toBe(1);
  } finally {
    session.dispose();
    doc.destroy();
    peer.destroy();
  }
});
