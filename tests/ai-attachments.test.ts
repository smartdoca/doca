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
function pdfFixture(jpeg?: Buffer) {
  const content = deflateSync(Buffer.from(
    "BT /F1 12 Tf 10 100 Td (Before image - this valid PDF contains readable attachment text.) Tj ET" +
    (jpeg ? "\nq 32 0 0 32 10 20 cm /Im1 Do Q" : ""),
  ));
  const stream = (data: Buffer, extra: string) => Buffer.concat([
    Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`), data, Buffer.from("\nendstream"),
  ]);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 150] /Resources << /Font << /F1 5 0 R >> ${jpeg ? "/XObject << /Im1 6 0 R >>" : ""} >> /Contents 4 0 R >>`),
    stream(content, "/Filter /FlateDecode"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ...(jpeg ? [stream(jpeg, "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode")] : []),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")], offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((length, chunk) => length + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xref = chunks.reduce((length, chunk) => length + chunk.length, 0);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
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
it("preserves original downloads, sends normalized images to vision models and rejects incompatible models", async () => {
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
  expect(JSON.stringify(requests)).toContain("data:image/jpeg;base64,");
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
    await upload("report.pdf", pdfFixture())
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
  const pdf = pdfFixture(jpeg);
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

it("shares real PDF parsing across attachments and stored-file reading, and invalidates old gibberish caches", async () => {
  const { readFile } = await import("node:fs/promises");
  const { prepareFileRecognition, recognizeStoredFile } = await import("../apps/server/src/services/ai/file-recognition.js");
  const { storageObjectIdForAsset, loadFileExtract } = await import("../apps/server/src/services/ai/file-extract.js");
  const runtime = { ...storageRuntime(), root };
  const uploaded = await upload("text.pdf", await readFile(new URL("./fixtures/ai-recognition/text.pdf", import.meta.url)));
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const asset = await db.selectFrom("assets").selectAll().where("id", "=", uploaded.json().id).executeTakeFirstOrThrow();
  const objectId = await storageObjectIdForAsset(db, asset);
  const prepared = await prepareFileRecognition(db, {objectId, storage:runtime});
  expect(prepared.extract.markdown).toContain("RIVER-2709");
  expect(prepared.extract.markdown).toContain("林青");
  expect(prepared.images).toHaveLength(0);
  await db.updateTable("file_extracts").set({status:"ready",result:JSON.stringify({parts:[{type:"text",text:"CORRUPT_COMPRESSED_BYTES"}]})}).where("storage_object_id","=",objectId).execute();
  expect(await loadFileExtract(db,objectId)).toMatchObject({status:"pending",markdown:"",parts:[]});
  const result = await recognizeStoredFile(db,{objectId,filename:"text.pdf",userId:asset.owner_id,storage:runtime});
  expect(result).toMatchObject({status:"ready",strategy:"native-text",imageCount:0});
  expect(result.text).toContain("RIVER-2709");
  expect(result.text).not.toContain("CORRUPT");
  expect(requests).toHaveLength(0);
});

it("renders scanned PDFs and reports partial recognition when vision is unavailable or disabled", async () => {
  const { readFile } = await import("node:fs/promises");
  const { prepareFileRecognition, recognizeStoredFile } = await import("../apps/server/src/services/ai/file-recognition.js");
  const { storageObjectIdForAsset } = await import("../apps/server/src/services/ai/file-extract.js");
  const uploaded = await upload("scan.pdf", await readFile(new URL("./fixtures/ai-recognition/scan.pdf", import.meta.url)));
  const asset = await db.selectFrom("assets").selectAll().where("id","=",uploaded.json().id).executeTakeFirstOrThrow();
  const input = {objectId:await storageObjectIdForAsset(db,asset),filename:"scan.pdf",userId:asset.owner_id,storage:{...storageRuntime(),root}};
  const prepared = await prepareFileRecognition(db,input);
  expect(prepared.images).toHaveLength(1);
  expect((await sharp(prepared.images[0]!.data).metadata()).width).toBeGreaterThan(500);
  const result = await recognizeStoredFile(db,input,prepared);
  expect(result).toMatchObject({status:"partial",imageCount:1});
  expect(result.warning).toContain("图片理解模型");
  const off = await recognizeStoredFile(db,{...input,visualPolicy:"off"},prepared);
  expect(off.status).toBe("partial");
  expect(off.warning).toContain("图像识别已关闭");
  expect(requests).toHaveLength(0);
});
