import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createEditor, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { createAtomicInlineExtension } from "@smartdoca/slate";
import * as Y from "yjs";
import {
  createExlsxCollaborationSession,
  restoreExlsxDocument,
} from "@smartdoca/sheet/yjs";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import {
  WebPluginRegistry,
  createPluginElementPayload,
  pluginElementState,
  type PluginElementContribution,
} from "../packages/web-plugin-registry/src/index.js";
import {
  validatePluginElementPayload,
  isPluginElementPayload,
} from "@smartdoca/plugin-contracts";
import {
  DocaYjsDocument,
  pluginElementCodec,
} from "@core/modules/documents/codecs/rich-runtime.js";
import {
  provisionSurface,
  restoreSurface,
} from "@core/modules/documents/codecs/surfaces.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createDocuments,
  restoreDocument,
  b64,
  unb64,
} from "./editor-client.js";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";

const provider: PluginElementContribution = {
  id: "example.elements.countdown",
  pluginId: "example.elements",
  title: { zh: "倒计时", en: "Countdown" },
  dataVersion: 1,
  formats: ["rich_text", "spreadsheet"],
  refreshIntervalMs: 1000,
  validate: (data) => typeof data.targetAt === "string",
  text: (data) => String(data.targetAt),
  renderEditor: () => null,
  render: () => null,
  renderCell() {},
};
const data = { targetAt: "2026-10-03T00:00:00.000Z" };
const payload = () => createPluginElementPayload(provider, data, "en");
const manifest = {
  pluginId: provider.pluginId,
  version: "1.0.0",
  targets: ["web"] as const,
};
it("registers elements atomically, enforces namespace and version, notifies disposal and isolates registries", () => {
  const a = new WebPluginRegistry(),
    b = new WebPluginRegistry();
  let changes = 0;
  const unsubscribe = a.elements.subscribe(() => changes++);
  const throwingObserver = a.elements.subscribe(() => {
    throw Error("Observer failed");
  });
  const dispose = a.register({ manifest, elements: [provider] });
  expect(
    pluginElementState(payload(), a.elements.get(provider.id), "spreadsheet"),
  ).toBe("ready");
  expect(b.elements.list()).toEqual([]);
  expect(() =>
    a.register({
      manifest: { ...manifest, pluginId: "example.other" },
      elements: [provider],
    }),
  ).toThrow();
  expect(() =>
    b.register({ manifest, elements: [provider, provider] }),
  ).toThrow();
  expect(b.elements.list()).toEqual([]);
  expect(b.manifests()).toEqual([]);
  for (const item of [
    { ...provider, renderCell: undefined },
    { ...provider, dataVersion: 0 },
    { ...provider, refreshIntervalMs: 10 },
    { ...provider, id: "another.element" },
  ])
    expect(() => b.register({ manifest, elements: [item] })).toThrow();
  dispose();
  dispose();
  unsubscribe();
  throwingObserver();
  expect(changes).toBe(2);
  expect(
    pluginElementState(payload(), a.elements.get(provider.id), "rich_text"),
  ).toBe("unsupported");
  a.register({ manifest, elements: [provider] });
  expect(
    pluginElementState(payload(), a.elements.get(provider.id), "rich_text"),
  ).toBe("ready");
});
it("preserves unknown type/version data without adapting, rejects invalid/unsafe/oversize content and isolates callbacks", () => {
  const unknown = { ...payload(), version: 9, newField: { raw: true } };
  validatePluginElementPayload(unknown);
  expect(isPluginElementPayload(unknown)).toBe(false);
  expect(pluginElementState(unknown, provider, "rich_text")).toBe(
    "unsupported",
  );
  expect(
    pluginElementState({ ...payload(), dataVersion: 2 }, provider, "rich_text"),
  ).toBe("unsupported");
  expect(
    pluginElementState(
      { ...payload(), type: "example.elements.news" },
      provider,
      "rich_text",
    ),
  ).toBe("unsupported");
  expect(
    pluginElementState(
      payload(),
      {
        ...provider,
        validate() {
          throw Error();
        },
      },
      "rich_text",
    ),
  ).toBe("invalid");
  const value = payload();
  pluginElementState(
    value,
    {
      ...provider,
      validate(input) {
        (input as any).targetAt = "mutated";
        return true;
      },
    },
    "rich_text",
  );
  expect(value.data).toEqual(data);
  expect(() =>
    validatePluginElementPayload({ text: "字".repeat(12000) }),
  ).toThrow("32 KiB");
  expect(() =>
    validatePluginElementPayload(JSON.parse('{"constructor":{}}')),
  ).toThrow("Unsafe");
  expect(() => validatePluginElementPayload({ value: Infinity })).toThrow();
  expect(() => createPluginElementPayload(provider, {}, "en")).toThrow();
});
it("rich elements are atomic through native clipboard/delete/undo and opaque CRDT checkpoint roundtrips", () => {
  const plugin = createAtomicInlineExtension({
    ...pluginElementCodec,
    decode: (input, id) => pluginElementCodec.decode(input, id) as any,
    render: () => null,
  }).plugin;
  const editor = withHistory(createEditor());
  const isInline = editor.isInline,
    isVoid = editor.isVoid;
  editor.isInline = (node) => plugin.isInline?.(node as any) ?? isInline(node);
  editor.isVoid = (node) => plugin.isVoid?.(node as any) ?? isVoid(node);
  const opaque = {
    ...payload(),
    dataVersion: 27,
    data: { fields: ["untouched", { newer: true }] },
  };
  editor.children = [
    {
      id: "p",
      type: "paragraph",
      children: [
        { text: "before " },
        {
          id: "element",
          type: "custom:plugin-element",
          payload: opaque,
          children: [{ text: "" }],
        },
        { text: " after" },
      ],
    },
  ];
  Editor.normalize(editor, { force: true });
  Transforms.select(editor, {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 2], offset: 6 },
  });
  const fragment = editor.getFragment();
  expect((fragment[0] as any).children[1].payload).toEqual(opaque);
  Transforms.select(editor, { path: [0, 2], offset: 0 });
  editor.deleteBackward("character");
  expect(JSON.stringify(editor.children)).not.toContain(
    "custom:plugin-element",
  );
  (editor as any).undo();
  expect((editor.children[0] as any).children[1].payload).toEqual(opaque);
  const aDoc = new Y.Doc(),
    a = new DocaYjsDocument(aDoc),
    bDoc = new Y.Doc(),
    b = new DocaYjsDocument(bDoc);
  try {
    a.initialize(editor.children as any);
    b.applyRemoteUpdate(Y.encodeStateAsUpdate(aDoc));
    expect((b.getValue()[0] as any).children[1].payload).toEqual(opaque);
    expect(b.getValue()).toEqual(a.getValue());
  } finally {
    a.destroy();
    b.destroy();
    aDoc.destroy();
    bDoc.destroy();
  }
});

let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "element-qa",
        displayName: "Element QA",
        password: "qa-password-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(async () => {
  await db.destroy();
});
it("rich plugin payload edits persist once, converge without echo, undo/redo, restore and deny unauthorized writes", async () => {
  const docs = createDocuments(db),
    resource = await createContent(db).create(owner, {
      kind: "document",
      format: "rich_text",
      title: "Element QA",
    });
  const initial = await docs.exchange(owner, resource.id, {});
  const aDoc = new Y.Doc(),
    a = new DocaYjsDocument(aDoc),
    bDoc = new Y.Doc(),
    b = new DocaYjsDocument(bDoc);
  a.applyRemoteUpdate(unb64(initial.update));
  b.applyRemoteUpdate(unb64(initial.update));
  const events: Uint8Array[] = [];
  let echoes = 0;
  a.onLocalUpdate((update) => events.push(update));
  b.onLocalUpdate(() => echoes++);
  let seq = 0;
  const save = async (update: Uint8Array) => {
    const message = {
      epochId: initial.epochId,
      update: b64(update),
      messageId: randomUUID(),
    };
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(++seq);
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(seq);
    b.applyRemoteUpdate(update);
    b.applyRemoteUpdate(update);
    expect(b.getValue()).toEqual(a.getValue());
    expect(echoes).toBe(0);
  };
  try {
    const before = a.getValue(),
      next = structuredClone(before);
    (next[1] as any).children = [
      { text: "start " },
      {
        id: randomUUID(),
        type: "custom:plugin-element",
        payload: payload(),
        label: "Countdown",
        children: [{ text: "" }],
      },
      { text: " end" },
    ];
    a.acceptEditorValue(before, next);
    expect(events).toHaveLength(1);
    await save(events.at(-1)!);
    const updated = structuredClone(a.getValue());
    (updated[1] as any).children[1].payload.data.targetAt =
      "2027-01-01T00:00:00.000Z";
    a.acceptEditorValue(a.getValue(), updated);
    await save(events.at(-1)!);
    a.undo();
    await save(events.at(-1)!);
    a.redo();
    await save(events.at(-1)!);
    const restored = await restoreDocument(db, resource.id);
    try {
      expect(restored.runtime.getValue()).toEqual(a.getValue());
    } finally {
      restored.destroy();
    }
    const stranger = {
      ...(await createUser(
        db,
        {
          login: "element-other",
          displayName: "Other",
          password: "qa-password-2026",
        },
        { actor: owner },
      )),
      admin: 0,
    };
    await expect(
      docs.exchange(stranger, resource.id, {
        update: b64(events[0]!),
        epochId: initial.epochId,
      }),
    ).rejects.toThrow();
    expect(
      (
        await db
          .selectFrom("document_states")
          .select("seq")
          .where("resource_id", "=", resource.id)
          .executeTakeFirstOrThrow()
      ).seq,
    ).toBe(seq);
  } finally {
    a.destroy();
    b.destroy();
    aDoc.destroy();
    bDoc.destroy();
  }
});
it("sheet generic JSON survives save/reload, row movement, copy, delete/undo and rejects malformed updates atomically", async () => {
  const docs = createDocuments(db),
    resource = await createContent(db).create(owner, {
      kind: "document",
      format: "spreadsheet",
      title: "Cell element QA",
    });
  await db.transaction().execute((tx) => provisionSurface(tx, resource));
  const initial = await docs.exchange(owner, resource.id, {}),
    loaded = await restoreSurface(db, resource.id, "spreadsheet"),
    baseline = loaded.baseline!;
  const sheetId = baseline.snapshot.sheetOrder[0]!;
  async function replica(id: string) {
    const doc = await restoreExlsxDocument({
      baseline,
      update: loaded.update,
      checkpointSeq: 0,
    });
    const session = await createExlsxCollaborationSession({
      doc,
      baseline,
      sessionId: id,
    });
    let listener!: (mutation: any) => void;
    const events: any[] = [];
    session.onLocalTransaction((event) => events.push(event));
    await session.connect({
      workbookId: resource.id,
      initialSnapshot: baseline.snapshot,
      getSnapshot: () => baseline.snapshot,
      onLocalMutation(f: any) {
        listener = f;
        return () => {};
      },
      applyRemoteMutation: async () => {},
    } as any);
    return {
      doc,
      session,
      events,
      write(cellValue: object) {
        const m = {
          id: "sheet.mutation.set-range-values",
          params: { unitId: resource.id, subUnitId: sheetId, cellValue },
        };
        session.validateLocalMutation!(m);
        listener(m);
      },
    };
  }
  const a = await replica("a"),
    b = await replica("b");
  let seq = 0;
  const save = async (event: any) => {
    const input = {
      epochId: initial.epochId,
      messageId: randomUUID(),
      update: b64(event.update),
    };
    expect((await docs.exchange(owner, resource.id, input)).seq).toBe(++seq);
    await b.session.applyUpdate(event);
    expect(b.events).toHaveLength(0);
  };
  const read = () => projectExlsxWorkbook(a.session.checkpoint(seq));
  try {
    const value = payload();
    const cell = {
      v: value.text,
      f: null,
      p: null,
      t: 1,
      custom: { docaElement: value },
    };
    a.write({ 1: { 0: cell }, 2: { 1: structuredClone(cell) } });
    await save(a.events.at(-1));
    const anchor = a.session.captureCellAnchor!({
      sheetId,
      startRow: 1,
      endRow: 1,
      startColumn: 0,
      endColumn: 0,
    });
    if (!anchor) throw Error("Expected stable cell anchor");
    await a.session.editStructure!({
      sheetId,
      axis: "row",
      action: "insert",
      index: 0,
      count: 1,
    });
    await save(a.events.at(-1));
    expect(a.session.resolveCellAnchor!(anchor)).toMatchObject({ startRow: 2 });
    expect(
      (await read()).sheets[sheetId]!.cellData![2]![0]!.custom!.docaElement,
    ).toEqual(value);
    a.write({ 2: { 0: { v: null, f: null, p: null, custom: null } } });
    await save(a.events.at(-1));
    await a.session.undo();
    await save(a.events.at(-1));
    const checkpoint = await restoreSurface(db, resource.id, "spreadsheet");
    const persisted = await projectExlsxWorkbook({
      baseline: checkpoint.baseline!,
      update: checkpoint.update,
      checkpointSeq: checkpoint.state.checkpoint_seq,
    });
    expect(persisted).toEqual(await read());
    expect(persisted).toEqual(
      await projectExlsxWorkbook(b.session.checkpoint(seq)),
    );
    expect(
      persisted.sheets[sheetId]!.cellData![2]![0]!.custom!.docaElement,
    ).toEqual(value);
    const opaque = { ...value, dataVersion: 123, newProperty: ["preserved"] };
    a.write({ 2: { 0: { ...cell, custom: { docaElement: opaque } } } });
    await save(a.events.at(-1));
    expect(
      (await read()).sheets[sheetId]!.cellData![2]![0]!.custom!.docaElement,
    ).toEqual(opaque);
    const previous = await restoreSurface(db, resource.id, "spreadsheet");
    a.write({
      2: {
        0: { ...cell, custom: { docaElement: { text: "x".repeat(33000) } } },
      },
    });
    await expect(
      docs.exchange(owner, resource.id, {
        epochId: initial.epochId,
        messageId: randomUUID(),
        update: b64(a.events.at(-1).update),
      }),
    ).rejects.toThrow("32 KiB");
    expect(
      (await restoreSurface(db, resource.id, "spreadsheet")).state.seq,
    ).toBe(previous.state.seq);
    a.session.setReadOnly(true);
    expect(() => a.write({ 0: { 0: cell } })).toThrow();
  } finally {
    a.session.dispose();
    b.session.dispose();
    a.doc.destroy();
    b.doc.destroy();
  }
});
