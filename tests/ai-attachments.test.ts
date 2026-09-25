import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import {
  aiDefaults,
  saveAIConfig,
} from "@core/modules/ai/config.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import { mockAI } from "./ai-mock.js";
import { extractAttachmentText } from "../apps/server/src/services/ai/attachments.js";
let app: Awaited<ReturnType<typeof createApp>>,
  db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string;
let a: Record<string, string>, b: Record<string, string>, requests: any[];
const origin = "http://localhost:39301",
  password = "isolated-attachments-password";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-ai-attachments-"));
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await createUser(
    db,
    { login: "other", displayName: "Other", password },
    { actor: owner },
  );
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      vendors: [
        {
          id: "test-vendor",
          name: "测试厂商",
          provider: "compatible",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "not-real",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "test-vendor",
          model: "mock",
          alias: "Mock",
          enabled: true,
          maxInput: 64000,
          maxOutput: 1000,
          vision: true,
          tools: true,
        },
      ],
    },
    0,
  );
  requests = [];
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: {
      memory: { driver: "sqlite", url: ":memory:" },
      fetch: mockAI({ record: (body) => requests.push(body) }),
    },
  });
  const login = async (name: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost:39301", origin },
      payload: { login: name, password },
    });
    return {
      host: "localhost:39301",
      origin,
      cookie: String(r.headers["set-cookie"]).split(";")[0]!,
    };
  };
  a = await login("owner");
  b = await login("other");
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});
async function upload(filename: string, body: Buffer) {
  return app.inject({
    method: "POST",
    url:
      "/api/v1/assets?purpose=ai_attachment&filename=" +
      encodeURIComponent(filename),
    headers: { ...a, "content-type": "application/octet-stream" },
    payload: body,
  });
}
async function session(headers = a) {
  return (
    await app.inject({
      method: "POST",
      url: "/api/v1/ai/sessions",
      headers,
      payload: { modelId: "test", resourceIds: [] },
    })
  ).json().id;
}
async function send(sid: string, ids: string[], headers = a) {
  return app.inject({
    method: "POST",
    url: `/api/v1/ai/sessions/${sid}/messages`,
    headers,
    payload: {
      id: randomUUID(),
      text: "请分析附件",
      modelId: "test",
      scope: "all",
      attachments: ids,
    },
  });
}
async function wait(sid: string) {
  for (let i = 0; i < 100; i++) {
    const r = (
      await app.inject({ url: `/api/v1/ai/sessions/${sid}`, headers: a })
    ).json();
    if (r.jobs.length && !["queued", "running"].includes(r.jobs[0].status))
      return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Job did not finish");
}
it("keeps uploaded files private, reads text in the agent and restores attachment history", async () => {
  const r = await upload(
    "notes.md",
    Buffer.from("# 附件经验\n部署前必须备份 ATTACHMENT_PRIVATE_MARKER"),
  );
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id;
  expect(
    (await app.inject({ url: `/api/v1/assets/${id}/content`, headers: b }))
      .statusCode,
  ).toBe(404);
  const read = await app.inject({
    url: `/api/v1/assets/${id}/content`,
    headers: a,
  });
  expect(read.headers["cache-control"]).toBe("private, no-store");
  const otherSession = await session(b);
  expect((await send(otherSession, [id], b)).statusCode).toBe(404);
  const sid = await session();
  expect((await send(sid, [id])).statusCode).toBe(200);
  const result = await wait(sid);
  expect(result.jobs[0].status, JSON.stringify(result)).toBe("completed");
  expect(
    result.messages.find((m: any) => m.role === "user").attachments,
  ).toEqual([expect.objectContaining({ id, filename: "notes.md" })]);
  expect(JSON.stringify(requests)).toContain("ATTACHMENT_PRIVATE_MARKER");
  // A later turn gets the authenticated attachment content again, not a public URL.
  requests.length = 0;
  await send(sid, []);
  await wait(sid);
  expect(JSON.stringify(requests)).toContain("ATTACHMENT_PRIVATE_MARKER");
});
it("preserves original image bytes for vision models and rejects incompatible models before starting a job", async () => {
  const png = await sharp({
    create: { width: 12, height: 12, channels: 3, background: "#8764c0" },
  })
    .png()
    .toBuffer();
  const r = await upload("diagram.png", png);
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id;
  expect(r.json().mime).toBe("image/png");
  const downloaded = await app.inject({ url: `/api/v1/assets/${id}/content`, headers: a });
  expect(downloaded.rawPayload).toEqual(png);
  const sid = await session();
  await send(sid, [id]);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
  expect(JSON.stringify(requests)).toContain("data:image/png;base64,");
  const config = (
    await app.inject({ url: "/api/v1/admin/ai", headers: a })
  ).json().config;
  const { revision, ...next } = config;
  next.vendors = next.vendors.map(({ hasKey, ...v }: any) => v);
  next.models = next.models.map(({ hasKey, ...m }: any) => ({
    ...m,
    vision: false,
  }));
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai",
        headers: a,
        payload: { revision, config: next },
      })
    ).statusCode,
  ).toBe(200);
  const denied = await send(sid, [id]);
  expect(denied.statusCode, denied.body).toBe(400);
  expect(denied.body).toContain("图片理解");
});
it("uses a configured media model to caption images for text-only chat models", async () => {
  const png = await sharp({
    create: { width: 12, height: 12, channels: 3, background: "#8764c0" },
  })
    .png()
    .toBuffer();
  const id = (await upload("diagram.png", png)).json().id;
  const config = (
    await app.inject({ url: "/api/v1/admin/ai", headers: a })
  ).json().config;
  const { revision, ...next } = config;
  next.vendors = next.vendors.map(({ hasKey, ...v }: any) => v);
  next.models = next.models.map(({ hasKey, ...m }: any) => ({
    ...m,
    vision: false,
  }));
  next.models.push({
    id: "media",
    vendorId: "test-vendor",
    model: "mock-vision",
    alias: "Vision",
    enabled: true,
    maxInput: 64000,
    maxOutput: 1000,
    vision: true,
    tools: true,
  });
  next.mediaModel = "media";
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai",
        headers: a,
        payload: { revision, config: next },
      })
    ).statusCode,
  ).toBe(200);
  const sid = await session();
  expect((await send(sid, [id])).statusCode).toBe(200);
  const job = (await wait(sid)).jobs[0];
  expect(job.status, JSON.stringify(job)).toBe("completed");
  expect(JSON.stringify(requests)).toContain("diagram.png");
});
it("rejects unsupported and spoofed files and duplicate or missing attachment IDs", async () => {
  expect(
    (await upload("script.html", Buffer.from("<script>alert(1)</script>")))
      .statusCode,
  ).toBe(400);
  expect((await upload("fake.pdf", Buffer.from("not a pdf"))).statusCode).toBe(
    400,
  );
  const file = (
    await upload("data.csv", Buffer.from("name,count\nA,5"))
  ).json();
  const sid = await session();
  expect((await send(sid, [file.id, file.id])).statusCode).toBe(400);
  expect((await send(sid, [randomUUID()])).statusCode).toBe(404);
  const pdf = (
    await upload("report.pdf", Buffer.from("%PDF-1.7\nfixture"))
  ).json();
  expect(pdf.extractStatus).toBe("pending");
  let extract = { status: "pending" };
  for (let i = 0; i < 40 && extract.status === "pending"; i++) {
    extract = (
      await app.inject({
        url: `/api/v1/assets/${pdf.id}/extract`,
        headers: a,
      })
    ).json();
    if (extract.status === "pending")
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(extract.status).toBe("ready");
  expect((await send(sid, [pdf.id])).statusCode).toBe(200);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
});
it("sends extracted PDF images to vision models in document order", async () => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#246" },
  })
    .jpeg()
    .toBuffer();
  const payload = Buffer.from("BT /F1 12 Tf 10 100 Td (Before image) Tj ET");
  const compressed = deflateSync(payload);
  const pdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.1\n1 0 obj<< /Length " +
        compressed.length +
        " /Filter /FlateDecode >>\nstream\n",
    ),
    compressed,
    Buffer.from(
      "\nendstream\nendobj\n2 0 obj<< /Length " +
        jpeg.length +
        " /Filter /DCTDecode >>\nstream\n",
    ),
    jpeg,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const uploaded = await upload("slides.pdf", pdf);
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const id = uploaded.json().id;
  for (let i = 0; i < 40; i++) {
    const extract = (
      await app.inject({ url: `/api/v1/assets/${id}/extract`, headers: a })
    ).json();
    if (extract.status === "ready") {
      expect(extract.imageCount).toBeGreaterThan(0);
      break;
    }
    if (i === 39) throw new Error("extract did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sid = await session();
  expect((await send(sid, [id])).statusCode).toBe(200);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
  const body = JSON.stringify(requests);
  expect(body).toContain("Before image");
  expect(body).toContain("data:image/jpeg;base64,");
});
it("extracts Office text and formulas without executing document instructions or expanding entities", () => {
  const word = Buffer.from(
    zipSync({
      "word/document.xml": strToU8(
        "<w:document><w:p><w:r><w:t>项目进度</w:t></w:r></w:p></w:document>",
      ),
    }),
  );
  expect(extractAttachmentText("plan.docx", word)).toContain("项目进度");
  const excel = Buffer.from(
    zipSync({
      "xl/sharedStrings.xml": strToU8("<sst><si><t>费用</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B2"><f>SUM(B1:B1)</f><v>42</v></c></row></sheetData></worksheet>',
      ),
    }),
  );
  expect(extractAttachmentText("budget.xlsx", excel)).toContain("A1: 费用");
  expect(extractAttachmentText("budget.xlsx", excel)).toContain("SUM(B1:B1)");
  const deck = Buffer.from(
    zipSync({
      "ppt/slides/slide1.xml": strToU8(
        "<p:sp><a:p><a:r><a:t>汇报</a:t></a:r></a:p></p:sp>",
      ),
    }),
  );
  expect(extractAttachmentText("report.pptx", deck)).toContain("汇报");
  const malicious = Buffer.from(
    zipSync({
      "word/document.xml": strToU8(
        '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:t>&e;</w:t>',
      ),
    }),
  );
  expect(() => extractAttachmentText("bad.docx", malicious)).toThrow(
    "外部实体",
  );
});
it("lets only admins edit official skills and applies enabled scenario instructions to new jobs", async () => {
  const get = await app.inject({ url: "/api/v1/admin/ai", headers: a });
  const { revision, ...config } = get.json().config;
  config.vendors = config.vendors.map(({ hasKey, ...v }: any) => v);
  config.models = config.models.map(({ hasKey, ...m }: any) => m);
  config.officialSkills = [
    {
      id: "official-test",
      name: "测试助手",
      description: "统一答复约定",
      content: "ADMIN_SKILL_MARKER 用中文回答",
      formats: [],
      enabled: true,
    },
    {
      id: "disabled",
      name: "禁用",
      description: "禁用场景",
      content: "NEVER_DISABLED_SKILL",
      formats: [],
      enabled: false,
    },
  ];
  const body = { revision, config };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai",
        headers: b,
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai",
        headers: a,
        payload: body,
      })
    ).statusCode,
  ).toBe(200);
  const skills = (
    await app.inject({ url: "/api/v1/ai/skills", headers: b })
  ).json();
  expect(skills.official.map((s: any) => s.id)).toEqual(["official-test"]);
  const sid = await session();
  await send(sid, []);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
  expect(JSON.stringify(requests)).toContain("统一答复约定");
  expect(JSON.stringify(requests)).not.toContain("ADMIN_SKILL_MARKER");
  expect(JSON.stringify(requests)).not.toContain("NEVER_DISABLED_SKILL");
});
