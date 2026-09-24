import { expect, it } from "vitest";
import {
  Doc,
  encodeStateVector,
  encodeStateAsUpdate,
} from "slatetsx-kit-editor/yjs";
import { UpdateOutbox } from "../apps/web/src/features/documents/update-outbox.js";
import { cellSelection } from "@core/modules/documents/codecs/cell-presence.js";

it("never submits on idle sync, including the nonempty Yjs deletion-set case", () => {
  const doc = new Doc();
  const text = doc.getText("test");
  text.insert(0, "abc");
  text.delete(0, 1);
  // Length > 2 is NOT evidence of unacknowledged local changes.
  expect(
    encodeStateAsUpdate(doc, encodeStateVector(doc)).length,
  ).toBeGreaterThan(2);
  const sent: unknown[] = [];
  const box = new UpdateOutbox(
    (e) => {
      sent.push(e);
      return true;
    },
    () => {},
  );
  for (let i = 0; i < 100; i++) box.resume();
  expect(sent).toHaveLength(0);
  expect(box.pending).toBe(false);
  doc.destroy();
});
it("serializes local deltas and retains unacknowledged writes across reconnect/sync", () => {
  const sent: { id: string; update: Uint8Array }[] = [];
  const states: boolean[] = [];
  const box = new UpdateOutbox(
    (e) => {
      sent.push(e);
      return true;
    },
    (dirty) => states.push(dirty),
  );
  box.enqueue(new Uint8Array([1]));
  box.enqueue(new Uint8Array([2]));
  expect(sent).toHaveLength(0);
  box.resume();
  box.resume();
  expect(sent).toHaveLength(1);
  box.acknowledge("wrong-id");
  expect(box.pending).toBe(true);
  box.pause();
  box.resume();
  expect(sent[1]).toEqual(sent[0]);
  box.acknowledge(sent[0]!.id);
  expect(sent).toHaveLength(3);
  expect(sent[2]!.update).toEqual(new Uint8Array([2]));
  box.acknowledge(sent[0]!.id); // duplicate ACK does not consume another write
  expect(box.pending).toBe(true);
  box.acknowledge(sent[2]!.id);
  expect(box.pending).toBe(false);
  expect(states.at(-1)).toBe(false);
});
it("retains deltas when the socket closes before send", () => {
  let online = false;
  const sent: string[] = [];
  const box = new UpdateOutbox(
    (e) => {
      if (online) sent.push(e.id);
      return online;
    },
    () => {},
  );
  box.resume();
  box.enqueue(new Uint8Array([1]));
  expect(box.pending).toBe(true);
  online = true;
  box.resume();
  expect(sent).toHaveLength(1);
});
it("bounds ephemeral sheet coordinates and discards untrusted identity fields", () => {
  const selection = {
    kind: "cells",
    sheetId: "sheet1",
    startRow: 0,
    endRow: 10,
    startColumn: 1,
    endColumn: 2,
    editing: true,
  };
  expect(cellSelection({ ...selection, userId: "spoofed" })).toEqual(selection);
  for (const patch of [
    { startRow: -1 },
    { endRow: 1048576 },
    { endColumn: 16384 },
    { startRow: 11 },
    { startColumn: 1.1 },
    { sheetId: "" },
  ])
    expect(() => cellSelection({ ...selection, ...patch })).toThrow();
});
