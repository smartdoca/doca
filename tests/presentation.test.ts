import { beforeEach, afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  EditorController,
  readDocument,
  createPresentation,
  createTextElement,
  elementOf,
  rootOf,
  findText,
  replaceMatches,
  REMOTE_ORIGIN,
  isLocalContentOrigin,
} from "@eppt/editor/core";
import { importPptx, exportPptx, validatePptxFile } from "@eppt/editor/pptx";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { createExperience } from "@core/workflows/experience.js";
import {
  createDocuments,
  b64,
  unb64,
} from "@core/modules/collaboration/documents.js";
const commentBody = (text: string) => ({
  version: 1 as const,
  blocks: [
    { type: "paragraph" as const, children: [{ type: "text" as const, text }] },
  ],
});
import {
  restoreSurface,
  surfaceAnchor,
} from "@core/modules/documents/codecs/surfaces.js";
const protocol = { codec: "eppt-yjs-v5", schemaVersion: 2, protocolVersion: 1 };
let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
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
async function setup() {
  const content = createContent(db),
    docs = createDocuments(db);
  const resource = await content.create(owner, {
    kind: "document",
    format: "presentation",
    title: "PPT QA",
  });
  const initial = await docs.exchange(owner, resource.id, protocol);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, unb64(initial.update), REMOTE_ORIGIN);
  return {
    content,
    docs,
    resource,
    initial,
    doc,
    envelope: { ...protocol, epochId: initial.epochId },
  };
}
it("PPT v5: sections, hidden pages and rich text formatting survive ACK and reload", async () => {
  const { docs, resource, doc, envelope } = await setup();
  const controller = new EditorController(doc);
  const reloaded = new Y.Doc();
  try {
    const page = readDocument(doc).slideOrder[0]!;
    const before = Y.encodeStateVector(doc);
    const section = controller.createSection("第一部分", [page]);
    controller.setSlidesHidden([page], true);
    const text = createTextElement("带格式文本");
    text.padding = 24;
    text.paragraphs = [
      {
        type: "paragraph",
        list: "number",
        indentLevel: 2,
        lineHeight: 1.5,
        spaceBefore: 12,
        spaceAfter: 6,
        children: [
          {
            text: "安全链接",
            link: "https://example.com/",
            script: "superscript",
            strike: true,
          },
        ],
      },
    ];
    controller.insert(page, text);
    const message = {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, before)),
    };
    await expect(
      docs.exchange(owner, resource.id, { ...message, codec: "eppt-yjs-v4" }),
    ).rejects.toThrow();
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(1);
    const loaded = await docs.exchange(owner, resource.id, envelope);
    Y.applyUpdate(reloaded, unb64(loaded.update));
    expect(readDocument(reloaded)).toEqual(readDocument(doc));
    expect(readDocument(reloaded).sections?.[section!]).toBe("第一部分");
    expect(readDocument(reloaded).slides[page]?.hidden).toBe(true);
  } finally {
    controller.dispose();
    doc.destroy();
    reloaded.destroy();
  }
});
it("PPT section deletion preserves slides through host ACK, reload and one-step undo", async () => {
  const { docs, resource, doc, envelope } = await setup();
  const control = new EditorController(doc);
  const replica = new Y.Doc();
  try {
    const page = readDocument(doc).slideOrder[0]!;
    const section = control.createSection("保留页面", [page])!;
    await docs.exchange(owner, resource.id, {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc)),
    });
    const original = readDocument(doc);
    let writes = 0;
    doc.on("update", (_bytes, origin) => {
      if (isLocalContentOrigin(origin)) writes++;
    });
    const before = Y.encodeStateVector(doc);
    control.deleteSection(section);
    expect(writes).toBe(1);
    expect(readDocument(doc).slideOrder).toEqual(original.slideOrder);
    expect(readDocument(doc).slides[page]?.elements).toEqual(
      original.slides[page]?.elements,
    );
    expect(readDocument(doc).sections?.[section]).toBeUndefined();
    const message = {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, before)),
    };
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(2);
    expect((await docs.exchange(owner, resource.id, message)).seq).toBe(2);
    const loaded = await docs.exchange(owner, resource.id, envelope);
    Y.applyUpdate(replica, unb64(loaded.update), REMOTE_ORIGIN);
    expect(readDocument(replica)).toEqual(readDocument(doc));
    const undoBefore = Y.encodeStateVector(doc);
    control.undo();
    expect(readDocument(doc)).toEqual(original);
    await docs.exchange(owner, resource.id, {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, undoBefore)),
    });
    Y.applyUpdate(
      replica,
      unb64((await docs.exchange(owner, resource.id, envelope)).update),
      REMOTE_ORIGIN,
    );
    expect(readDocument(replica)).toEqual(original);
  } finally {
    control.dispose();
    doc.destroy();
    replica.destroy();
  }
});
it("PPT v5: malformed sections are rejected without corrupting saved content", async () => {
  const { docs, resource, doc, envelope } = await setup();
  try {
    rootOf(doc).set("section:__proto__", "invalid");
    await expect(
      docs.exchange(owner, resource.id, {
        ...envelope,
        messageId: randomUUID(),
        update: b64(Y.encodeStateAsUpdate(doc)),
      }),
    ).rejects.toThrow("分组无效");
    expect((await docs.exchange(owner, resource.id, envelope)).seq).toBe(0);
  } finally {
    doc.destroy();
  }
});
it("PPT: bootstrap, exact ACK, epoch/schema guards, comments, independent copy, history, trash and anonymous ACL", async () => {
  const { content, docs, resource: r, initial, doc, envelope } = await setup();
  const control = new EditorController(doc);
  try {
    const page = readDocument(doc).slideOrder[0]!;
    const before = Y.encodeStateVector(doc),
      el = createTextElement("评论测试");
    control.insert(page, el);
    const msg = {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, before)),
    };
    await expect(
      docs.exchange(owner, r.id, { ...msg, schemaVersion: 1 }),
    ).rejects.toThrow();
    await expect(
      docs.exchange(owner, r.id, { ...msg, codec: "eppt-yjs-v3" }),
    ).rejects.toThrow();
    await expect(
      docs.exchange(owner, r.id, { ...msg, epochId: randomUUID() }),
    ).rejects.toThrow();
    expect((await docs.exchange(owner, r.id, msg)).seq).toBe(1);
    expect((await docs.exchange(owner, r.id, msg)).changed).toBe(false);
    await expect(
      docs.exchange(owner, r.id, {
        ...msg,
        update: b64(new Uint8Array([0, 0])),
      }),
    ).rejects.toThrow();
    const anchor = {
      type: "elements",
      epochId: initial.epochId,
      slideId: page,
      elementIds: [el.id],
    };
    expect(await surfaceAnchor(db, r.id, "presentation", anchor)).toEqual(
      anchor,
    );
    await content.comment(
      owner,
      r.id,
      commentBody("comment"),
      null,
      JSON.stringify(anchor),
    );
    await expect(
      content.comment(owner, r.id, commentBody("overall"), null),
    ).rejects.toThrow("区域评论");
    const history = createExperience(db),
      version = await history.snapshot(owner, r.id);
    expect(
      ((await history.version(owner, r.id, version.id)) as any).surface.format,
    ).toBe("presentation");
    const copy = await content.copy(owner, r.id);
    expect(
      (await restoreSurface(db, copy.id, "presentation")).epochId,
    ).not.toBe(initial.epochId);
    await content.permissions(owner, r.id, {
      version: (await content.detail(owner, r.id)).resource.version,
      visibility: "public",
      accessMode: "custom",
      grants: [],
    });
    expect((await docs.exchange(null, r.id, envelope)).rank).toBe(1);
    await expect(docs.exchange(null, r.id, msg)).rejects.toThrow("只读");
    await content.trash(
      owner,
      r.id,
      (await content.detail(owner, r.id)).resource.version,
    );
    expect((await content.trashPreview(owner, r.id)).surface?.format).toBe(
      "presentation",
    );
  } finally {
    control.dispose();
    doc.destroy();
  }
});
it("PPT: two offline clients converge; remote updates don't echo, undo persists, deleted comments orphan", async () => {
  const { docs, resource, initial, doc: a, envelope } = await setup();
  const b = new Y.Doc();
  Y.applyUpdate(b, unb64(initial.update), REMOTE_ORIGIN);
  const ca = new EditorController(a),
    cb = new EditorController(b),
    qa: Uint8Array[] = [],
    qb: Uint8Array[] = [];
  a.on("update", (u, o) => {
    if (isLocalContentOrigin(o) || o instanceof Y.UndoManager) qa.push(u);
  });
  b.on("update", (u, o) => {
    if (isLocalContentOrigin(o) || o instanceof Y.UndoManager) qb.push(u);
  });
  try {
    const page = readDocument(a).slideOrder[0]!,
      one = createTextElement("One"),
      two = createTextElement("Two");
    ca.insert(page, one);
    cb.insert(page, two);
    Y.applyUpdate(a, qb[0]!, REMOTE_ORIGIN);
    Y.applyUpdate(b, qa[0]!, REMOTE_ORIGIN);
    expect(qa).toHaveLength(1);
    expect(qb).toHaveLength(1);
    expect(readDocument(a)).toEqual(readDocument(b));
    for (const u of [...qa, ...qb])
      await docs.exchange(owner, resource.id, {
        ...envelope,
        messageId: randomUUID(),
        update: b64(u),
      });
    ca.undo();
    expect(qa).toHaveLength(2);
    await docs.exchange(owner, resource.id, {
      ...envelope,
      messageId: randomUUID(),
      update: b64(qa[1]!),
    });
    await expect(
      surfaceAnchor(db, resource.id, "presentation", {
        type: "elements",
        epochId: initial.epochId,
        slideId: page,
        elementIds: [one.id],
      }),
    ).rejects.toThrow();
    const loaded = await docs.exchange(owner, resource.id, envelope);
    Y.applyUpdate(b, unb64(loaded.update), REMOTE_ORIGIN);
    expect(readDocument(a)).toEqual(readDocument(b));
    expect(qb).toHaveLength(1);
  } finally {
    ca.dispose();
    cb.dispose();
    a.destroy();
    b.destroy();
  }
});
it("PPT: malformed state and foreign assets are rejected atomically; valid saved document remains openable", async () => {
  const { docs, resource, initial, doc, envelope } = await setup();
  try {
    const projection = readDocument(doc),
      page = projection.slideOrder[0]!,
      element = projection.slides[page]!.elementOrder[0]!;
    for (const mutate of [
      (d: Y.Doc) => rootOf(d).set("id", randomUUID()),
      (d: Y.Doc) => d.getMap("foreign").set("x", "bad"),
      (d: Y.Doc) => elementOf(d, page, element)!.set("assetId", randomUUID()),
      (d: Y.Doc) => elementOf(d, page, element)!.set("href", "javascript:bad"),
      (d: Y.Doc) => elementOf(d, page, element)!.set("transform", { x: NaN }),
    ]) {
      const bad = new Y.Doc();
      Y.applyUpdate(bad, unb64(initial.update));
      const vector = Y.encodeStateVector(bad);
      try {
        mutate(bad);
        await expect(
          docs.exchange(owner, resource.id, {
            ...envelope,
            messageId: randomUUID(),
            update: b64(Y.encodeStateAsUpdate(bad, vector)),
          }),
        ).rejects.toThrow();
        const intact = await docs.exchange(owner, resource.id, envelope);
        expect(intact.seq).toBe(0);
      } finally {
        bad.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
});
it("PPT: native shape/chart/table commands and slide operations survive server validation and restore", async () => {
  const { docs, resource, doc, envelope } = await setup();
  const control = new EditorController(doc);
  try {
    const page = readDocument(doc).slideOrder[0]!,
      before = Y.encodeStateVector(doc);
    for (const kind of ["rect", "line", "chart", "table"] as const)
      control.add(page, kind);
    let view = readDocument(doc);
    const table = Object.values(view.slides[page]!.elements).find(
      (e) => e.type === "table",
    )!;
    control.tableCommand(page, table.id, { kind: "insert-row", after: null });
    control.slideProperty(page, "notes", "演讲者备注");
    const second = control.addSlide(page);
    control.moveSlide(second, -1);
    await docs.exchange(owner, resource.id, {
      ...envelope,
      messageId: randomUUID(),
      update: b64(Y.encodeStateAsUpdate(doc, before)),
    });
    const loaded = await docs.exchange(owner, resource.id, envelope),
      restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, unb64(loaded.update));
      expect(readDocument(restored)).toEqual(readDocument(doc));
      control.setReadOnly(true);
      const state = b64(Y.encodeStateAsUpdate(doc));
      control.add(page, "rect");
      control.undo();
      expect(b64(Y.encodeStateAsUpdate(doc))).toBe(state);
    } finally {
      restored.destroy();
    }
  } finally {
    control.dispose();
    doc.destroy();
  }
});
it("PPTX subset imports a new epoch, round trips text/style, export is pure; unsupported/JSON files rejected", async () => {
  const source = createPresentation();
  const result = await exportPptx(source),
    imported = await importPptx(await result.blob.arrayBuffer());
  expect(imported.document.slideOrder).toHaveLength(1);
  expect(
    imported.document.slides[imported.document.slideOrder[0]!]!.elements,
  ).toBeTruthy();
  const content = createContent(db),
    r = await content.create(owner, {
      kind: "document",
      format: "presentation",
      title: "Import",
      initialContent: imported.document,
    });
  const loaded = await restoreSurface(db, r.id, "presentation"),
    doc = new Y.Doc();
  Y.applyUpdate(doc, loaded.update);
  try {
    const before = b64(Y.encodeStateAsUpdate(doc));
    expect(findText(doc, "EPPT").length).toBe(1);
    await exportPptx(readDocument(doc));
    expect(b64(Y.encodeStateAsUpdate(doc))).toBe(before);
    expect(replaceMatches(doc, findText(doc, "EPPT"), "Doca")).toBe(1);
    expect(findText(doc, "Doca")).toHaveLength(1);
  } finally {
    doc.destroy();
  }
  for (const name of ["a.ppt", "a.json", "a.pptm"])
    expect(() => validatePptxFile({ name, size: 100 })).toThrow();
});
