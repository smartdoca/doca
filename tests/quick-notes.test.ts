import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import {
  createUser,
  type Actor,
} from "@core/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import { compilationContent } from "../apps/server/src/services/notes/compile.js";
import type { DB } from "@db/index.js";
import type { QuickNote } from "@core/shared/quick-notes.js";

let db: DB, app: Awaited<ReturnType<typeof createApp>>, root: string;
let owner: Actor, other: Actor, a: string, b: string;
let calls: any[], modelFailure: boolean;
const origin = "http://localhost:39135",
  password = "quick-note-isolated-2026";
const body = (text: string, assetIds: string[] = []) => ({
  content: [{ id: randomUUID(), type: "paragraph", children: [{ text }] }],
  assetIds,
});
const request = (method: any, path: string, cookie = a, payload?: any) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "localhost:39135", origin, cookie },
    payload,
  });
async function create(text: string, cookie = a, assets: string[] = []) {
  const r = await request(
    "PUT",
    "/quick-notes/" + randomUUID(),
    cookie,
    body(text, assets),
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as QuickNote;
}
async function upload(cookie: string, bytes: Buffer, filename: string) {
  const r = await app.inject({
    method: "POST",
    url:
      "/api/v1/assets?purpose=note_attachment&filename=" +
      encodeURIComponent(filename),
    headers: {
      host: "localhost:39135",
      origin,
      cookie,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-notes-test-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  other = {
    ...(await createUser(
      db,
      { login: "other", displayName: "Other", password },
      { actor: owner },
    )),
    admin: 0,
  };
  calls = [];
  modelFailure = false;
  app = await createApp(db, {
    origin,
    storage: {
      root,
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (modelFailure)
          return Response.json(
            { error: { message: "private-provider-secret" } },
            { status: 500 },
          );
        return Response.json({
          id: "notes-test",
          object: "chat.completion",
          created: 1,
          model: "notes-test",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "# 产品想法整理\n\n## 核心需求\n轻量记录，支持 **快速保存**。\n\n- 下周评审\n- 待确认：预算\n\n[参考](https://example.com)",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 100,
            total_tokens: 200,
          },
        });
      }) as typeof fetch,
    },
  });
  const login = async (name: string) =>
    String(
      (await request("POST", "/auth/login", "", { login: name, password }))
        .headers["set-cookie"],
    ).split(";")[0]!;
  a = await login("owner");
  b = await login("other");
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
  await rm(root, { recursive: true, force: true });
});
async function configureAI() {
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: "test",
      vendors: [
        {
          id: "test-vendor",
          name: "测试厂商",
          provider: "compatible",
          baseUrl: "https://isolated.example.test/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "test-vendor",
          model: "notes-test",
          alias: "测试模型",
          enabled: true,
          tools: true,
          maxInput: 32000,
          maxOutput: 6000,
        },
      ],
    },
    0,
  );
}
it("keeps notes private even from an administrator, searches literally, and restores deleted cards", async () => {
  const note = await create("私人想法 100%_完成", b);
  expect((await request("GET", "/quick-notes/" + note.id, a)).statusCode).toBe(
    404,
  );
  expect((await request("GET", "/quick-notes", a)).json().items).toEqual([]);
  expect((await request("GET", "/quick-notes", "")).statusCode).toBe(401);
  expect(
    (
      await request("GET", "/quick-notes?q=" + encodeURIComponent("100%_"), b)
    ).json().items,
  ).toHaveLength(1);
  expect(
    (
      await request(
        "GET",
        "/quick-notes?q=" + encodeURIComponent("missing%"),
        b,
      )
    ).json().items,
  ).toHaveLength(0);
  expect(
    (
      await request("PATCH", "/quick-notes/" + note.id, a, {
        ...body("偷窥修改"),
        version: 1,
      })
    ).statusCode,
  ).toBe(404);
  expect((await db.selectFrom("resources").select("id").execute()).length).toBe(
    0,
  );
  expect(
    (
      await request("POST", `/quick-notes/${note.id}/trash`, a, {
        version: 1,
        deleted: true,
      })
    ).statusCode,
  ).toBe(404);
  const deleted = (
    await request("POST", `/quick-notes/${note.id}/trash`, b, {
      version: 1,
      deleted: true,
    })
  ).json();
  expect((await request("GET", "/quick-notes", b)).json().items).toHaveLength(
    0,
  );
  expect(
    (await request("GET", "/quick-notes?trash=1", b)).json().items,
  ).toHaveLength(1);
  expect(
    (
      await request("PATCH", `/quick-notes/${note.id}`, b, {
        ...body("deleted write"),
        version: deleted.version,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await request("POST", `/quick-notes/${note.id}/trash`, b, {
        version: deleted.version,
        deleted: false,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await request("GET", "/quick-notes", b)).json().items[0].content,
  ).toEqual(note.content);
});
it("deduplicates saved requests, rejects stale overwrites, and validates bounded rich text", async () => {
  const id = randomUUID(),
    input = body("原始想法");
  const first = await request("PUT", "/quick-notes/" + id, a, input);
  expect(first.statusCode, first.body).toBe(200);
  expect(
    (await request("PUT", "/quick-notes/" + id, a, input)).json().version,
  ).toBe(1);
  const update = { ...body("新版本"), version: 1 };
  const results = await Promise.all([
    request("PATCH", "/quick-notes/" + id, a, update),
    request("PATCH", "/quick-notes/" + id, a, {
      ...body("另一台设备"),
      version: 1,
    }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const latest = (await request("GET", "/quick-notes/" + id)).json();
  expect(
    (
      await request("PATCH", "/quick-notes/" + id, a, {
        version: 1,
        content: latest.content,
        assetIds: [],
      })
    ).json().version,
  ).toBe(2);
  expect(
    (
      await request("PATCH", "/quick-notes/" + id, a, {
        version: 2,
        content: latest.content,
        assetIds: [],
      })
    ).json().version,
  ).toBe(2);
  expect(
    (await request("PUT", "/quick-notes/" + randomUUID(), a, body("")))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await request(
        "PUT",
        "/quick-notes/" + randomUUID(),
        a,
        body("x".repeat(30001)),
      )
    ).statusCode,
  ).toBe(400);
  const invalid = body("安全");
  (invalid.content[0] as any).html = "<script>alert(1)</script>";
  expect(
    (await request("PUT", "/quick-notes/" + randomUUID(), a, invalid))
      .statusCode,
  ).toBe(400);
  const badLink = body("安全");
  (badLink.content[0] as any).children = [
    {
      id: randomUUID(),
      type: "link",
      url: "javascript:alert(1)",
      children: [{ text: "点击" }],
    },
  ];
  expect(
    (await request("PUT", "/quick-notes/" + randomUUID(), a, badLink))
      .statusCode,
  ).toBe(400);
});
it("checks private attachment ownership on upload, association and every download including audit", async () => {
  const asset = await upload(b, Buffer.from("私人附件内容"), "想法.txt");
  const note = await create("", b, [asset.id]);
  expect(note.assets[0]?.filename).toBe("想法.txt");
  for (const suffix of ["", "?download=1", "?audit=1", "?trashPreview=1"]) {
    expect(
      (await request("GET", `/assets/${asset.id}/content${suffix}`, a))
        .statusCode,
    ).toBe(404);
  }
  expect((await request("GET", `/assets/${asset.id}/content`, b)).body).toBe(
    "私人附件内容",
  );
  expect(
    (await request("GET", `/assets/${asset.id}/content`, b)).headers[
      "cache-control"
    ],
  ).toBe("private, no-store");
  expect(
    (
      await request(
        "PUT",
        "/quick-notes/" + randomUUID(),
        a,
        body("偷附件", [asset.id]),
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await request(
        "PUT",
        "/quick-notes/" + randomUUID(),
        b,
        body("重复占用附件", [asset.id]),
      )
    ).statusCode,
  ).toBe(404);
  expect((await request("GET", "/quick-notes", a)).json().items).toEqual([]);
});
it("generates from explicit snapshots, meters once, and publishes a private native document with independent attachments", async () => {
  await configureAI();
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        resourcePolicies: { document: { defaultVisibility: "public" } },
      }),
    })
    .execute();
  const image = await upload(
    a,
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#738669" },
    })
      .png()
      .toBuffer(),
    "草图.png",
  );
  const file = await upload(a, Buffer.from("附件不送给模型"), "附件.txt");
  const note = await create("计划下周评审轻量记录", a, [image.id, file.id]);
  await create("不应读取的其他私人内容");
  const input = {
    id: randomUUID(),
    notes: [{ id: note.id, version: note.version }],
    instruction: "整理成方案",
    modelId: "test",
  };
  const response = await request("POST", "/quick-notes/compilations", a, input);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().status, response.body).toBe("ready");
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain("不应读取的其他私人内容");
  expect(JSON.stringify(calls)).not.toContain("附件不送给模型");
  expect(
    (await request("POST", "/quick-notes/compilations", a, input)).json().id,
  ).toBe(input.id);
  expect(calls).toHaveLength(1);
  expect(await db.selectFrom("ai_calls").selectAll().execute()).toHaveLength(1);
  expect(
    (await request("GET", `/quick-notes/compilations/${input.id}`, b))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await request(
        "POST",
        `/quick-notes/compilations/${input.id}/document`,
        b,
        { markdown: response.json().markdown },
      )
    ).statusCode,
  ).toBe(404);
  const changed = await request("PATCH", `/quick-notes/${note.id}`, a, {
    ...body("后续补充", [image.id, file.id]),
    version: note.version,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(
    JSON.parse(
      (await request("GET", `/quick-notes/compilations/${input.id}`)).json()
        .sources,
    )[0].content,
  ).toEqual(note.content);
  const published = await request(
    "POST",
    `/quick-notes/compilations/${input.id}/document`,
    a,
    { markdown: response.json().markdown },
  );
  expect(published.statusCode, published.body).toBe(200);
  const doc = published.json();
  expect(doc).toMatchObject({
    format: "rich_text",
    visibility: "invited",
    requests_enabled: 0,
    share_links_enabled: 0,
    owner_id: owner.id,
  });
  const copyAssets = await db
    .selectFrom("assets")
    .selectAll()
    .where("resource_id", "=", doc.id)
    .execute();
  expect(copyAssets).toHaveLength(2);
  expect(copyAssets.map((a) => a.id)).not.toContain(image.id);
  const read = await readAIDocument(db, { actor: owner }, doc.id);
  expect(JSON.stringify(read.value)).toContain("快速保存");
  expect(JSON.stringify(read.value)).toContain(copyAssets[0]!.id);
  expect(
    (
      await request(
        "POST",
        `/quick-notes/compilations/${input.id}/document`,
        a,
        { markdown: response.json().markdown },
      )
    ).json().id,
  ).toBe(doc.id);
  await request("POST", `/quick-notes/${note.id}/trash`, a, {
    version: changed.json().version,
    deleted: true,
  });
  expect(
    (await request("GET", `/assets/${copyAssets[0]!.id}/content`, a))
      .statusCode,
  ).toBe(200);
  expect(
    (await request("GET", `/assets/${copyAssets[0]!.id}/content`, b))
      .statusCode,
  ).toBe(404);
  expect(await db.selectFrom("resources").select("id").execute()).toHaveLength(
    1,
  );
});
it("rejects foreign and stale AI sources and preserves recoverable model failures", async () => {
  await configureAI();
  const foreign = await create("别人的记录", b),
    own = await create("自己的记录");
  const input = {
    id: randomUUID(),
    notes: [{ id: foreign.id, version: 1 }],
    instruction: "",
    modelId: "test",
  };
  expect(
    (await request("POST", "/quick-notes/compilations", a, input)).statusCode,
  ).toBe(404);
  expect(
    (
      await request("POST", "/quick-notes/compilations", a, {
        ...input,
        notes: [{ id: own.id, version: 2 }],
      })
    ).statusCode,
  ).toBe(409);
  expect(calls).toHaveLength(0);
  modelFailure = true;
  const failed = await request("POST", "/quick-notes/compilations", a, {
    ...input,
    notes: [{ id: own.id, version: 1 }],
  });
  expect(failed.json().status).toBe("failed");
  expect(failed.body).not.toContain("private-provider-secret");
  expect(
    (await request("GET", `/quick-notes/${own.id}`)).json().content,
  ).toEqual(own.content);
  expect(
    (await request("GET", "/quick-notes/compilations", b)).json().items,
  ).toEqual([]);
  expect(
    (
      await request(
        "POST",
        `/quick-notes/compilations/${input.id}/document`,
        a,
        { markdown: "# 假成果" },
      )
    ).statusCode,
  ).toBe(409);
});
it("never imports model-supplied HTML, image URLs or internal resource links", () => {
  const result = compilationContent(
    "# 标题\n\n<script>alert(1)</script>\n\n![外部图片](https://evil.test/x)\n\n[内部](#/r/forged)\n\n[危险](javascript:alert(1))",
  );
  const serialized = JSON.stringify(result.blocks);
  expect(serialized).not.toContain("https://evil.test");
  expect(serialized).not.toContain("javascript:");
  expect(serialized).not.toContain("#/r/");
  expect(serialized).not.toContain("<script>");
});

it("roundtrips native slatetsx text, images and files while checking every embedded asset", async () => {
  const asset = await upload(a, Buffer.from("native attachment"), "native.txt");
  const content = [
    {
      id: randomUUID(),
      type: "paragraph",
      title: "h2",
      quote: true,
      indentation: 1,
      children: [
        { text: "灵感", underline: true, color: "#3370ff", fontSize: 18 },
      ],
    },
    {
      id: randomUUID(),
      type: "attachment",
      path: asset.id,
      name: asset.filename,
      size: asset.size,
      mimeType: asset.mime,
      children: [{ text: "" }],
    },
  ];
  const id = randomUUID();
  const result = await request("PUT", "/quick-notes/" + id, a, {
    content,
    assetIds: [asset.id],
  });
  expect(result.statusCode, result.body).toBe(200);
  expect((await request("GET", "/quick-notes/" + id)).json().content).toEqual(
    content,
  );
  expect((await request("GET", "/quick-notes/" + id, b)).statusCode).toBe(404);
  const missing = await request("PUT", "/quick-notes/" + randomUUID(), a, {
    content,
    assetIds: [],
  });
  expect(missing.statusCode).toBe(400);
  const foreign = await upload(b, Buffer.from("private"), "other.txt");
  const otherContent = [
    content[0],
    { ...content[1], id: randomUUID(), path: foreign.id },
  ];
  expect(
    (
      await request("PUT", "/quick-notes/" + randomUUID(), a, {
        content: otherContent,
        assetIds: [foreign.id],
      })
    ).statusCode,
  ).toBe(404);
  for (const path of [
    "",
    "https://example.com/image.png",
    "data:image/png;base64,abc",
  ]) {
    expect(
      (
        await request("PUT", "/quick-notes/" + randomUUID(), a, {
          content: [
            content[0],
            { id: randomUUID(), type: "image", path, children: [{ text: "" }] },
          ],
          assetIds: [],
        })
      ).statusCode,
    ).toBe(400);
  }
});
