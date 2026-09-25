import { openTestDatabase as openDatabase } from "./database.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  MARKDOWN_HOST_CAPABILITIES,
  createHostMarkdownSession,
  observeLocalMarkdownUpdates,
  applyRemoteMarkdownUpdate,
  createMarkdownTextAnchor,
  resolveMarkdownTextAnchor,
} from "exmd-collaborative-editor";
import { type DB } from "@db/index.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import {
  createDocuments,
  b64,
  unb64,
} from "@core/modules/collaboration/documents.js";
import {
  MARKDOWN_CODEC,
  restoreMarkdown,
  markdownSelection,
  markdownReferenceNodes,
} from "@core/modules/documents/codecs/markdown.js";
import { createExperience } from "@core/workflows/experience.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  encodeMarkdownAnchor,
  decodeMarkdownAnchor,
} from "@core/modules/documents/codecs/markdown-anchor.js";
let db: DB, owner: Actor;
beforeEach(async () => {
  db = await openDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "test-password-2026" },
      { bootstrap: true },
    )),
    admin: 1,
  };
});
afterEach(() => db.destroy());
it("stores canonical v2 comments, excludes boundary insertions and rejects deleted/foreign anchors", async () => {
  const x = await setup();
  try {
    await x.submit(x.edit(x.a, (t) => t.insert(0, "abcdef")));
    const anchor = createMarkdownTextAnchor(x.a.getText("markdown"), 1, 4);
    const wire = encodeMarkdownAnchor(
      anchor,
      x.baseline.epochId!,
      "forged quote",
    );
    const c = await x.content.comment(
      owner,
      x.resource.id,
      "comment",
      null,
      JSON.stringify(wire),
    );
    const row = await db
      .selectFrom("comments")
      .selectAll()
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    const saved = JSON.parse(row.anchor!);
    expect(saved.quote).toBe("bcd");
    expect(saved.start.bytes).toBeInstanceOf(Array);
    expect(decodeMarkdownAnchor(saved).content).toEqual(anchor.content);
    await expect(
      x.content.comment(
        owner,
        x.resource.id,
        "bad",
        null,
        JSON.stringify({ ...wire, epochId: randomUUID() }),
      ),
    ).rejects.toThrow("版本");
    await expect(
      x.content.comment(
        owner,
        x.resource.id,
        "bad",
        null,
        JSON.stringify({ ...wire, start: { bytes: { 0: 1 } } }),
      ),
    ).rejects.toThrow("位置");
    await x.submit(
      x.edit(x.a, (t) => {
        t.insert(4, "RIGHT");
        t.insert(1, "LEFT");
      }),
    );
    const current = await restoreMarkdown(db, x.resource.id);
    const range = resolveMarkdownTextAnchor(
      current.doc,
      current.doc.getText("markdown"),
      decodeMarkdownAnchor(saved),
    );
    expect(
      current.doc.getText("markdown").toString().slice(range!.from, range!.to),
    ).toBe("bcd");
    current.destroy();
    await x.submit(x.edit(x.a, (t) => t.delete(5, 3)));
    await expect(
      x.content.comment(
        owner,
        x.resource.id,
        "orphan",
        null,
        JSON.stringify(saved),
      ),
    ).rejects.toThrow("删除");
    const deleted = await restoreMarkdown(db, x.resource.id);
    expect(
      resolveMarkdownTextAnchor(
        deleted.doc,
        deleted.doc.getText("markdown"),
        decodeMarkdownAnchor(saved),
      ),
    ).toBeNull();
    deleted.destroy();
  } finally {
    x.a.destroy();
    x.b.destroy();
  }
});
it("accepts item-based text selections and extracts actual links, not code or image syntax", async () => {
  const x = await setup();
  await x.submit(x.edit(x.a, (t) => t.insert(0, "hello")));
  const selection = {
    kind: "markdown",
    anchor: b64(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(x.a.getText("markdown"), 1),
      ),
    ),
    focus: b64(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(x.a.getText("markdown"), 4),
      ),
    ),
  };
  expect(await markdownSelection(db, x.resource.id, selection)).toEqual(
    selection,
  );
  await expect(
    markdownSelection(db, x.resource.id, {
      ...selection,
      anchor: b64(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(x.a.getText("wrong-root"), 0),
        ),
      ),
    }),
  ).rejects.toThrow("数据根");
  const url = `#/r/${randomUUID()}`;
  expect(
    markdownReferenceNodes(
      `[link](${url})\n\n\`[code](${url})\`\n\n![image](${url})`,
    ),
  ).toHaveLength(1);
  x.a.destroy();
  x.b.destroy();
});
it("imports Markdown through the authenticated API, indexes body text and renames its first line", async () => {
  const app = await createApp(db, { origin: "http://localhost:39130" });
  try {
    const headers: Record<string, string> = {
      host: "localhost:39130",
      origin: "http://localhost:39130",
    };
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { login: "owner", password: "test-password-2026" },
    });
    headers.cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/resources",
      headers,
      payload: {
        kind: "document",
        format: "markdown",
        title: "未命名",
        markdown: "# Import\nsearchable\n" + "a".repeat(70000),
      },
    });
    expect(response.statusCode).toBe(200);
    const r = response.json();
    expect(r.title).toBe("Import");
    const content = createContent(db);
    expect(
      (await content.list(owner, { q: "searchable", kind: "document" })).total,
    ).toBe(1);
    await content.rename(owner, r.id, "Renamed", r.version);
    const restored = await restoreMarkdown(db, r.id);
    expect(restored.doc.getText("markdown").toString()).toContain(
      "# Renamed\nsearchable",
    );
    restored.destroy();
    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/resources",
      headers,
      payload: {
        kind: "document",
        format: "markdown",
        title: "未命名",
        markdown: "a".repeat(524289),
      },
    });
    expect(oversized.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
async function setup() {
  const content = createContent(db),
    docs = createDocuments(db);
  const resource = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "未命名",
  });
  const baseline = await docs.exchange(owner, resource.id, MARKDOWN_CODEC);
  if (!("epochId" in baseline)) throw Error("missing epoch");
  const a = new Y.Doc(),
    b = new Y.Doc();
  Y.applyUpdate(a, unb64(baseline.update));
  Y.applyUpdate(b, unb64(baseline.update));
  const submit = (update: Uint8Array, messageId = randomUUID()) =>
    docs.exchange(owner, resource.id, {
      ...MARKDOWN_CODEC,
      epochId: baseline.epochId,
      messageId,
      update: b64(update),
    });
  const edit = (doc: Y.Doc, fn: (text: Y.Text) => void) => {
    const vector = Y.encodeStateVector(doc);
    fn(doc.getText("markdown"));
    return Y.encodeStateAsUpdate(doc, vector);
  };
  return { content, docs, resource, baseline, a, b, submit, edit };
}
it("matches shipped SDK capabilities and restores concurrent updates without a remote echo", async () => {
  expect(MARKDOWN_HOST_CAPABILITIES).toMatchObject(MARKDOWN_CODEC);
  const x = await setup();
  const session = createHostMarkdownSession({
    doc: x.b,
    state: "ready",
    ready: true,
    saveState: "clean",
  });
  const updates: Uint8Array[] = [];
  const stop = observeLocalMarkdownUpdates(session, (e) =>
    updates.push(e.update),
  );
  await x.submit(x.edit(x.a, (t) => t.insert(0, "甲")));
  await x.submit(x.edit(x.b, (t) => t.insert(0, "乙")));
  const sync = await x.docs.exchange(owner, x.resource.id, {
    ...MARKDOWN_CODEC,
    epochId: x.baseline.epochId,
  });
  applyRemoteMarkdownUpdate(x.a, unb64(sync.update));
  applyRemoteMarkdownUpdate(x.b, unb64(sync.update));
  expect(x.a.getText("markdown").toString()).toEqual(
    x.b.getText("markdown").toString(),
  );
  expect(updates).toHaveLength(1);
  const loaded = await restoreMarkdown(db, x.resource.id);
  expect(loaded.doc.getText("markdown").toString()).toEqual(
    x.a.getText("markdown").toString(),
  );
  loaded.destroy();
  stop();
  session.dispose?.();
  x.a.destroy();
  x.b.destroy();
});
it("deduplicates exact messages and rejects reused IDs, wrong epochs/schema, foreign roots and readonly updates", async () => {
  const x = await setup(),
    messageId = randomUUID();
  const update = x.edit(x.a, (t) => t.insert(0, "# 标题\n正文"));
  expect((await x.submit(update, messageId)).seq).toBe(1);
  expect((await x.submit(update, messageId)).changed).toBe(false);
  await expect(
    x.submit(
      x.edit(x.a, (t) => t.insert(t.length, "x")),
      messageId,
    ),
  ).rejects.toThrow("消息 ID");
  await expect(
    x.docs.exchange(owner, x.resource.id, {
      ...MARKDOWN_CODEC,
      epochId: randomUUID(),
    }),
  ).rejects.toThrow("版本已切换");
  await expect(
    x.docs.exchange(owner, x.resource.id, {
      ...MARKDOWN_CODEC,
      schemaVersion: 2,
    }),
  ).rejects.toThrow("协议不匹配");
  const bad = new Y.Doc();
  Y.applyUpdate(bad, unb64(x.baseline.update));
  const vector = Y.encodeStateVector(bad);
  bad.getMap("evil").set("x", 1);
  await expect(x.submit(Y.encodeStateAsUpdate(bad, vector))).rejects.toThrow(
    "数据根",
  );
  const latest = await x.content.detail(owner, x.resource.id);
  await x.content.permissions(owner, x.resource.id, {
    version: latest.resource.version,
    accessMode: "custom",
    visibility: "public",
    grants: [],
  });
  await expect(
    x.docs.exchange(null, x.resource.id, {
      ...MARKDOWN_CODEC,
      epochId: x.baseline.epochId,
      messageId: randomUUID(),
      update: b64(update),
    }),
  ).rejects.toThrow("只读");
  expect((await x.docs.exchange(null, x.resource.id, MARKDOWN_CODEC)).seq).toBe(
    1,
  );
  bad.destroy();
  x.a.destroy();
  x.b.destroy();
});
it("preserves anchors through checkpoint compaction and pure deletions do not cause repeated writes", async () => {
  const x = await setup();
  await x.submit(x.edit(x.a, (t) => t.insert(0, "anchor")));
  const anchor = createMarkdownTextAnchor(x.a.getText("markdown"), 0, 6);
  for (let i = 0; i < 50; i++)
    await x.submit(x.edit(x.a, (t) => t.insert(t.length, "x")));
  const loaded = await restoreMarkdown(db, x.resource.id);
  expect(loaded.state!.checkpoint_seq).toBe(50);
  expect(
    resolveMarkdownTextAnchor(
      loaded.doc,
      loaded.doc.getText("markdown"),
      anchor,
    ),
  ).toEqual(resolveMarkdownTextAnchor(x.a, x.a.getText("markdown"), anchor));
  loaded.destroy();
  const deletion = x.edit(x.a, (t) => t.delete(0, t.length));
  await x.submit(deletion);
  for (let i = 0; i < 4; i++)
    expect((await x.submit(deletion)).changed).toBe(false);
  expect(
    (await x.docs.exchange(owner, x.resource.id, MARKDOWN_CODEC)).seq,
  ).toBe(52);
  x.a.destroy();
  x.b.destroy();
});
it("supports history preview and same-epoch rollback, independent copies and trash preview/purge", async () => {
  const x = await setup(),
    experience = createExperience(db);
  await x.submit(x.edit(x.a, (t) => t.insert(0, "# 原始\n内容")));
  const snapshot = await experience.snapshot(owner, x.resource.id);
  await x.submit(x.edit(x.a, (t) => t.insert(t.length, "新版")));
  const preview = await experience.version(owner, x.resource.id, snapshot.id);
  expect(preview.text).toBe("# 原始\n内容");
  const restored = await x.docs.exchange(owner, x.resource.id, {
    restoreVersion: snapshot.id,
    expectedSeq: preview.currentSeq,
  });
  expect(restored).toMatchObject({
    epochId: x.baseline.epochId,
    changed: true,
  });
  const copy = await x.content.copy(owner, x.resource.id);
  const copied = await restoreMarkdown(db, copy.id);
  expect(copied.epochId).not.toBe(x.baseline.epochId);
  expect(copied.doc.getText("markdown").toString()).toContain("内容");
  copied.destroy();
  const latest = await x.content.detail(owner, x.resource.id);
  await x.content.trash(owner, x.resource.id, latest.resource.version, false);
  expect(await x.content.trashPreview(owner, x.resource.id)).toMatchObject({
    markdown: "# 原始\n内容",
  });
  const r = await db
    .selectFrom("resources")
    .selectAll()
    .where("id", "=", x.resource.id)
    .executeTakeFirstOrThrow();
  await x.content.purgeTrash(owner, [{ id: r.id, version: r.version }]);
  expect(
    await db
      .selectFrom("markdown_epochs")
      .selectAll()
      .where("resource_id", "=", r.id)
      .execute(),
  ).toHaveLength(0);
  x.a.destroy();
  x.b.destroy();
});
it("rejects an oversized collaboration update atomically, preserves receipt identity for retry and permits shrinking after downgrade", async () => {
  const { pluginServices } = await import("@core/shared/plugin-services.js");
  const { fail } = await import("@core/shared/errors.js");
  const x = await setup();
  let limit = 5;
  pluginServices(db).policies.set("test.document-size", { id: "test.document-size", async check(input) { if (input.action === "documents.resize" && Number(input.facts.next) > Number(input.facts.previous) && Number(input.facts.next) > limit) fail(413, "Document limit"); } });
  const update = x.edit(x.a, (t) => t.insert(0, "123456789")),
    messageId = randomUUID();
  await expect(x.submit(update, messageId)).rejects.toMatchObject({
    status: 413,
  });
  expect(
    await db
      .selectFrom("document_updates")
      .selectAll()
      .where("resource_id", "=", x.resource.id)
      .execute(),
  ).toHaveLength(0);
  expect(
    await db
      .selectFrom("markdown_receipts")
      .selectAll()
      .where("resource_id", "=", x.resource.id)
      .execute(),
  ).toHaveLength(0);
  expect(
    (await x.docs.exchange(owner, x.resource.id, MARKDOWN_CODEC)).seq,
  ).toBe(0);
  limit = 20;
  expect((await x.submit(update, messageId)).changed).toBe(true);
  expect((await x.submit(update, messageId)).changed).toBe(false);
  limit = 2;
  expect((await x.submit(x.edit(x.a, (t) => t.delete(0, 5)))).changed).toBe(
    true,
  );
  expect(
    Number(
      (
        await db
          .selectFrom("resources")
          .select("content_bytes")
          .where("id", "=", x.resource.id)
          .executeTakeFirstOrThrow()
      ).content_bytes,
    ),
  ).toBe(4);
  const loaded = await restoreMarkdown(db, x.resource.id);
  expect(loaded.doc.getText("markdown").toString()).toBe("6789");
  loaded.destroy();
  x.a.destroy();
  x.b.destroy();
});
