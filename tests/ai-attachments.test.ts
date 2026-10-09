import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { aiDefaults, aiConfig, saveAIConfig } from "@core/modules/ai/config.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { storageRuntime } from "../apps/server/src/adapters/storage.js";
import { mockAI, completionResponse } from "./ai-mock.js";
import { extractAttachmentText } from "../apps/server/src/services/ai/attachments.js";
let app: Awaited<ReturnType<typeof createApp>>,
  db: Awaited<ReturnType<typeof openTestDatabase>>,
  root: string;
let a: Record<string, string>, b: Record<string, string>, requests: any[];
const origin = "http://localhost:39301",
  password = "isolated-attachments-password";
function pdfFixture(jpeg?: Buffer) {
  const content = deflateSync(
    Buffer.from(
      "BT /F1 12 Tf 10 100 Td (Before image - this valid PDF contains readable attachment text.) Tj ET" +
        (jpeg ? "\nq 32 0 0 32 10 20 cm /Im1 Do Q" : ""),
    ),
  );
  const stream = (data: Buffer, extra: string) =>
    Buffer.concat([
      Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`),
      data,
      Buffer.from("\nendstream"),
    ]);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 150] /Resources << /Font << /F1 5 0 R >> ${jpeg ? "/XObject << /Im1 6 0 R >>" : ""} >> /Contents 4 0 R >>`,
    ),
    stream(content, "/Filter /FlateDecode"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ...(jpeg
      ? [
          stream(
            jpeg,
            "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          ),
        ]
      : []),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")],
    offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((length, chunk) => length + chunk.length, 0));
    chunks.push(
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    );
  }
  const xref = chunks.reduce((length, chunk) => length + chunk.length, 0);
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
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
  // Later turns retain the durable manifest and can reread on demand, without replaying all binaries.
  requests.length = 0;
  await send(sid, []);
  await wait(sid);
  expect(JSON.stringify(requests)).toContain(id);
  expect(JSON.stringify(requests)).toContain("attachment_read");
  expect(JSON.stringify(requests)).toContain("notes.md");
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
  const downloaded = await app.inject({
    url: `/api/v1/assets/${id}/content`,
    headers: a,
  });
  expect(downloaded.rawPayload).toEqual(png);
  const sid = await session();
  await send(sid, [id]);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
  expect(JSON.stringify(requests).includes("data:image/jpeg;base64,")).toBe(true);
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
  const pdf = (await upload("report.pdf", pdfFixture())).json();
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
  expect(body.includes("data:image/jpeg;base64,")).toBe(true);
});
it("plans multiple PDFs without eager pixels and then reads their durable page images through the real tool loop", async () => {
  const ids = [
    (await upload("first-book.pdf", pdfFixture())).json().id,
    (await upload("second-book.pdf", pdfFixture())).json().id,
    (await upload("family.png", await sharp({create:{width:42,height:39,channels:3,background:"#673ac9"}}).png().toBuffer())).json().id,
  ];
  for (const id of ids) {
    for (let i=0;i<40;i++) {
      const state=(await app.inject({url:`/api/v1/assets/${id}/extract`,headers:a})).json();
      if(state.status==="ready") break;
      if(i===39) throw Error("Isolated attachment parsing did not finish");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  const sid=await session();
  await app.close();
  let calls=0;
  const failures: unknown[]=[];
  const fetcher=(async (_url:any,init:any)=>{
    const body=JSON.parse(init.body);calls++;
    try {
      const frames=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((p:any)=>p.type==="image_url");
      if(calls===1) {
        expect(frames).toHaveLength(0);
        for(const id of ids) expect(JSON.stringify(body.messages)).toContain(id);
        expect(JSON.stringify(body.messages)).toContain("不得因本轮未展示像素宣称图片失效");
      } else {
        expect(frames).toHaveLength(1);
        const raw=Buffer.from(frames[0].image_url.url.split(",")[1],"base64");
        const meta=await sharp(raw).metadata();
        expect(meta.format).toBe("jpeg");
        expect(meta.width).toBeGreaterThan(0);
        expect(meta.height).toBeGreaterThan(0);
        expect(JSON.stringify(body.messages)).toContain("Before image");
      }
    } catch(error) { failures.push(error); }
    const message=calls===1?{role:"assistant",content:null,tool_calls:[{id:"read-durable-page",type:"function",function:{
      name:"attachment_read",arguments:JSON.stringify({assetId:ids[0],imageLimit:1,imageOffset:0}),
    }}]}:{role:"assistant",content:"The explicitly requested page has been read; the remaining pages are retained."};
    return completionResponse({id:"lazy-documents",object:"chat.completion",created:1,model:body.model,
      choices:[{index:0,message,finish_reason:calls===1?"tool_calls":"stop"}],
      usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},!!body.stream);
  }) as typeof fetch;
  app=await createApp(db,{origin,storage:{...storageRuntime(),root},ai:{memory:{driver:"sqlite",url:":memory:"},fetch:fetcher}});
  expect((await send(sid,ids)).statusCode).toBe(200);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
  expect(failures).toEqual([]);
  expect(calls).toBe(2);
  for(const id of ids) {
    expect((await app.inject({url:`/api/v1/assets/${id}/content`,headers:a})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/assets/${id}/content`,headers:b})).statusCode).toBe(404);
  }
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
      "xl/workbook.xml": strToU8("<workbook/>"),
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
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
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

it("shares PDF text and page visuals across entry points and rejects obsolete caches without overwriting them", async () => {
  const { readFile } = await import("node:fs/promises");
  const { prepareFileRecognition, recognizeStoredFile } =
    await import("../apps/server/src/services/ai/file-recognition.js");
  const { storageObjectIdForAsset, loadFileExtract } =
    await import("../apps/server/src/services/ai/file-extract.js");
  const runtime = { ...storageRuntime(), root };
  const uploaded = await upload(
    "text.pdf",
    await readFile(
      new URL("./fixtures/ai-recognition/text.pdf", import.meta.url),
    ),
  );
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", uploaded.json().id)
    .executeTakeFirstOrThrow();
  const objectId = await storageObjectIdForAsset(db, asset);
  const prepared = await prepareFileRecognition(db, {
    objectId,
    storage: runtime,
  });
  expect(prepared.extract.markdown).toContain("RIVER-2709");
  expect(prepared.extract.markdown).toContain("林青");
  expect(prepared.images).toHaveLength(1);
  const result = await recognizeStoredFile(db, {
    objectId,
    filename: "text.pdf",
    userId: asset.owner_id,
    storage: runtime,
  });
  expect(result).toMatchObject({
    status: "partial",
    strategy: "text-and-vision",
    imageCount: 1,
  });
  expect(result.text).toContain("RIVER-2709");
  expect(result.text).not.toContain("CORRUPT");
  expect(requests).toHaveLength(0);
  const obsolete = JSON.stringify({
    parserVersion: 2,
    parts: [{ type: "text", text: "CORRUPT_COMPRESSED_BYTES" }],
  });
  await db
    .updateTable("file_extracts")
    .set({ status: "ready", result: obsolete })
    .where("storage_object_id", "=", objectId)
    .execute();
  await expect(loadFileExtract(db, objectId)).rejects.toThrow(
    "file_parser_version_or_format_invalid",
  );
  const { processFileExtract } =
    await import("../apps/server/src/services/ai/file-extract.js");
  await expect(processFileExtract(db, objectId, runtime)).rejects.toThrow(
    "file_parser_version_or_format_invalid",
  );
  expect(
    (
      await db
        .selectFrom("file_extracts")
        .select("result")
        .where("storage_object_id", "=", objectId)
        .executeTakeFirstOrThrow()
    ).result,
  ).toBe(obsolete);
});

it("renders scanned PDFs and reports partial recognition when vision is unavailable or disabled", async () => {
  const { readFile } = await import("node:fs/promises");
  const { prepareFileRecognition, recognizeStoredFile } =
    await import("../apps/server/src/services/ai/file-recognition.js");
  const { storageObjectIdForAsset } =
    await import("../apps/server/src/services/ai/file-extract.js");
  const uploaded = await upload(
    "scan.pdf",
    await readFile(
      new URL("./fixtures/ai-recognition/scan.pdf", import.meta.url),
    ),
  );
  const asset = await db
    .selectFrom("assets")
    .selectAll()
    .where("id", "=", uploaded.json().id)
    .executeTakeFirstOrThrow();
  const input = {
    objectId: await storageObjectIdForAsset(db, asset),
    filename: "scan.pdf",
    userId: asset.owner_id,
    storage: { ...storageRuntime(), root },
  };
  const prepared = await prepareFileRecognition(db, input);
  expect(prepared.images, JSON.stringify({
    status: prepared.extract.status,
    error: prepared.extract.error,
    imageParts: prepared.extract.parts.filter(part => part.type === "image").length,
    warning: prepared.warning,
  })).toHaveLength(1);
  expect(
    (await sharp(prepared.images[0]!.data).metadata()).width,
  ).toBeGreaterThan(500);
  const result = await recognizeStoredFile(db, input, prepared);
  expect(result).toMatchObject({ status: "partial", imageCount: 1 });
  expect(result.warning).toContain("图片理解模型");
  const off = await recognizeStoredFile(
    db,
    { ...input, visualPolicy: "off" },
    prepared,
  );
  expect(off.status).toBe("partial");
  expect(off.warning).toContain("图像识别已关闭");
  expect(requests).toHaveLength(0);
});

it("enforces global and user limits through the API and removes the old count and byte ceilings when set to zero", async () => {
  const { policy, revision } = (
    await app.inject({ url: "/api/v1/admin/ai/upload-policy", headers: a })
  ).json();
  const owner = (
    await db
      .selectFrom("users")
      .select("id")
      .where("display_name", "=", "Owner")
      .executeTakeFirstOrThrow()
  ).id;
  const limited = {
    ...policy,
    global: { maxFiles: 1, maxFileBytes: 32, maxTotalBytes: 40 },
    users: {},
  };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai/upload-policy",
        headers: b,
        payload: { policy: limited, revision },
      })
    ).statusCode,
  ).toBe(403);
  let saved = (
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/ai/upload-policy",
      headers: a,
      payload: { policy: limited, revision },
    })
  ).json();
  expect((await upload("too-large.txt", Buffer.alloc(33, 65))).statusCode).toBe(
    413,
  );
  const ids = [];
  for (let i = 0; i < 2; i++)
    ids.push((await upload(`small-${i}.txt`, Buffer.alloc(30, 65))).json().id);
  const sid = await session();
  expect((await send(sid, ids)).json().message).toBe("upload_count_exceeded");
  saved = (
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/ai/upload-policy",
      headers: a,
      payload: {
        policy: { ...limited, global: { ...limited.global, maxFiles: 0 } },
        revision: saved.revision,
      },
    })
  ).json();
  expect((await send(sid, ids)).json().message).toBe(
    "upload_total_size_exceeded",
  );
  const unlimited = {
    ...limited,
    users: { [owner]: { maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0 } },
  };
  saved = (
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/ai/upload-policy",
      headers: a,
      payload: { policy: unlimited, revision: saved.revision },
    })
  ).json();
  expect(
    (await app.inject({ url: "/api/v1/ai/upload-policy", headers: a })).json(),
  ).toEqual(unlimited.users[owner]);
  expect(
    (await app.inject({ url: "/api/v1/ai/upload-policy", headers: b })).json(),
  ).toEqual(limited.global);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai/upload-policy",
        headers: a,
        payload: { policy: unlimited, revision: saved.revision - 1 },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/ai/upload-policy",
        headers: a,
        payload: {
          policy: { ...unlimited, version: 2 },
          revision: saved.revision,
        },
      })
    ).statusCode,
  ).toBe(400);
  const huge = await upload(
    "large.txt",
    Buffer.concat([
      Buffer.alloc(21 * 1024 ** 2, 65),
      Buffer.from("LATE_COMPLETE_MARKER"),
    ]),
  );
  expect(huge.statusCode, huge.body).toBe(201);
  const { prepareFileRecognition } =
    await import("../apps/server/src/services/ai/file-recognition.js");
  const parsed = await prepareFileRecognition(db, {
    objectId: huge.json().id,
    storage: { ...storageRuntime(), root },
    imageLimit: 0,
  });
  expect(parsed.extract.status).toBe("ready");
  expect(parsed.extract.markdown.endsWith("LATE_COMPLETE_MARKER")).toBe(true);
  for (let i = 2; i < 10; i++)
    ids.push((await upload(`more-${i}.txt`, Buffer.from("small"))).json().id);
  ids.push(huge.json().id);
  expect((await send(sid, ids)).statusCode).toBe(200);
  expect((await wait(sid)).jobs[0].status).toBe("completed");
});

it("rereads an earlier attachment by durable ID after reopening the server and a fresh model memory", async () => {
  const asset = (
    await upload(
      "mom-reference.txt",
      Buffer.from("PERSISTENT_REFERENCE_MARKER"),
    )
  ).json().id;
  const sid = await session();
  await send(sid, [asset]);
  await wait(sid);
  expect(
    JSON.parse(
      (
        await db
          .selectFrom("ai_jobs")
          .select("input")
          .where("session_id", "=", sid)
          .executeTakeFirstOrThrow()
      ).input,
    ).attachments,
  ).toEqual([asset]);
  await app.close();
  const rereadFetch = (async (_input: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) {
      const all = await db
        .selectFrom("ai_jobs")
        .select(["id", "session_id", "input", "created_at"])
        .where("session_id", "=", sid)
        .orderBy("created_at", "asc")
        .execute();
      const { sessionAttachments } =
        await import("../apps/server/src/services/ai/session-attachments.js");
      const actor = await db
        .selectFrom("users")
        .select(["id", "admin", "display_name"])
        .where("display_name", "=", "Owner")
        .executeTakeFirstOrThrow();
      expect(
        await sessionAttachments(db, { actor, jobId: all.at(-1)!.id }),
        JSON.stringify(all),
      ).toEqual([expect.objectContaining({ assetId: asset, available: true })]);
    }
    const lastUser = body.messages.findLastIndex(
      (message: any) => message.role === "user",
    );
    const tools = body.messages
      .slice(lastUser + 1)
      .filter((message: any) => message.role === "tool");
    const name =
      tools.length === 0
        ? "session_attachments"
        : tools.length === 1
          ? "attachment_read"
          : null;
    const message = name
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `reread-${tools.length}`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "session_attachments"
                    ? { query: "mom-reference" }
                    : { assetId: asset, imageLimit: 1 },
                ),
              },
            },
          ],
        }
      : { role: "assistant", content: "已读取 PERSISTENT_REFERENCE_MARKER" };
    return completionResponse(
      {
        id: "reread",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message, finish_reason: name ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
      !!body.stream,
    );
  }) as typeof fetch;
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: rereadFetch },
  });
  requests.length = 0;
  expect((await send(sid, [])).statusCode).toBe(200);
  const result = await wait(sid);
  expect(result.jobs[0].status, result.jobs[0].error).toBe("completed");
  expect(result.messages.at(-1)?.text).toContain("PERSISTENT_REFERENCE_MARKER");
  const toolMessages = requests.flatMap((body) =>
    body.messages.filter((message: any) => message.role === "tool"),
  );
  expect(JSON.stringify(toolMessages)).toContain("PERSISTENT_REFERENCE_MARKER");
  expect(JSON.stringify(toolMessages)).toContain("mom-reference.txt");
});

it("returns a size-limit response for an unknown-length stream and cleans up staged data", async () => {
  const {policy,revision}=(await app.inject({url:"/api/v1/admin/ai/upload-policy",headers:a})).json();
  expect((await app.inject({method:"PUT",url:"/api/v1/admin/ai/upload-policy",headers:a,payload:{policy:{...policy,global:{maxFiles:10,maxFileBytes:32,maxTotalBytes:100},users:{}},revision}})).statusCode).toBe(200);
  const response=await app.inject({method:"POST",url:"/api/v1/assets?purpose=ai_attachment&filename=stream.txt",headers:{...a,"content-type":"application/octet-stream"},payload:Readable.from([Buffer.alloc(40,65),Buffer.alloc(40,65)])});
  expect(response.statusCode).toBe(413);
  expect(response.json().message).toBe("文件超过上传大小限制");
  expect(await db.selectFrom("assets").select("id").execute()).toHaveLength(0);
});

it("sends reread image pixels to the executing vision model rather than serializing them as tool text", async () => {
  const asset=(await upload("reference.png",await sharp({create:{width:42,height:39,channels:3,background:"#673ac9"}}).png().toBuffer())).json().id;
  const sid=await session();await send(sid,[asset]);await wait(sid);
  await app.close();let n=0;
  const fetcher=(async (_url:any,init:any)=>{
    const body=JSON.parse(init.body);n++;
    if(n===2){
      const files=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((p:any)=>p.type==="image_url");
      expect(files).toHaveLength(1);expect(files[0].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
      const tool=body.messages.find((m:any)=>m.role==="tool");expect(tool.content.length).toBeLessThan(10000);
    }
    const message=n===1?{role:"assistant",content:null,tool_calls:[{id:"read-image",type:"function",function:{name:"attachment_read",arguments:JSON.stringify({assetId:asset,imageLimit:1})}}]}:{role:"assistant",content:"图像已读"};
    return completionResponse({id:"pixels",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message,finish_reason:n===1?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},!!body.stream);
  }) as typeof fetch;
  app=await createApp(db,{origin,storage:{...storageRuntime(),root},ai:{memory:{driver:"sqlite",url:":memory:"},fetch:fetcher}});
  await send(sid,[]);
  const result=await wait(sid);expect(result.jobs[0].status).toBe("completed");expect(n).toBe(2);
});

it("executes successive document image batches with durable receipts and a fresh bounded context per book", async () => {
  const ids = [(await upload("one.pdf", pdfFixture())).json().id, (await upload("two.pdf", pdfFixture())).json().id];
  const taskJobId = randomUUID(), originalRequest = "Complete every page; preserve all background pixels. Export only original pages without target people.";
  const sid = await session();
  await app.close();
  const {revision, ...config} = await aiConfig(db);
  await saveAIConfig(db, {...config, imageModel:"image", models:[...config.models, {id:"image", vendorId:"test-vendor", model:"mock-image", alias:"Image", enabled:true, tools:false, imageGeneration:true,imageProfile:"gpt-image-2", maxInput:32000, maxOutput:1000}]}, revision);
  let n=0, reviews=0, scenes=0, firstBookAssetId="", firstBookSourceId="";
  const fetcher = (async (_url:any, init:any)=> {
    const body=JSON.parse(init.body);
    const scene = body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[])
      .filter((part:any)=>part.type==="text").map((part:any)=>{
        try { return JSON.parse(part.text); } catch { return null; }
      }).find((value:any)=>value?.outputSchema && value?.binding?.originalReferenceImageId);
    if(scene) {
      scenes++;
      expect(scene.userRequests).toContain(originalRequest);
      expect(scene.binding.references).toHaveLength(1);
      expect(scene.binding.references[0].referenceImageId).toBe(scene.binding.originalReferenceImageId);
      expect(scene.binding.references[0].sourceSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[])
        .filter((part:any)=>part.type==="image_url")).toHaveLength(1);
      return completionResponse({id:"source-plan",object:"chat.completion",created:1,model:body.model,
        choices:[{index:0,message:{role:"assistant",content:JSON.stringify({
          summary:"Source fixture contains only words and shapes, with no target people.",
          reviewPrecision:{mode:"semantic",criterionIndices:[],requestIndices:[],reason:"The unchanged export is checked against the actual original and all formal requirements."},
          objects:[],roleMappings:[],actions:[],crossPage:[],requirements:[],uncertainties:[],
        })},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},!!body.stream);
    }
    if(body.messages.some((m:any)=>m.role==="system" && String(m.content).includes("Doca image-delivery-verifier"))) {
      reviews++;
      const images=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((p:any)=>p.type==="image_url");
      expect(images).toHaveLength(2);
      const pair=await Promise.all(images.map(async (image:any)=>sharp(Buffer.from(image.image_url.url.split(",")[1],"base64")).ensureAlpha().raw().toBuffer({resolveWithObject:true})));
      expect([pair[0].info.width,pair[0].info.height]).toEqual([pair[1].info.width,pair[1].info.height]);
      expect(pair[1].data.equals(pair[0].data)).toBe(true);
      const metadata=JSON.parse(body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).find((part:any)=>part.type==="text" && part.text.startsWith('{"requiredChecks"')).text);
      expect(JSON.stringify(body.messages)).toContain(originalRequest);
      expect(JSON.stringify(body.messages)).toContain(taskJobId);
      return completionResponse({id:"visual-review",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({verdict:"pass",summary:"原页没有需要替换的人物或文字",checks:metadata.requiredChecks.map((check:any)=>({id:check.id,passed:true,evidence:"对照原页与导出结果，相同文字与图形，未出现目标人物"}))})},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},!!body.stream);
    }
    n++;
    const status = body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>JSON.parse(message.content)).findLast((output:any)=>output.books && "current" in output);
    if(n===2 || n===6){
      expect(body.tools.some((tool:any)=>tool.function.name==="document_create")).toBe(false);
      if(n===2) firstBookSourceId=status.current.pages[0].referenceImageId;
      if(n===6) {
        expect(status.current.filename).toBe("two.pdf");
        expect(JSON.stringify(body.messages)).not.toContain("first-book-page.png");
        expect(body.messages.filter((message:any)=>message.role==="tool").some((message:any)=>message.tool_call_id==="batch-4")).toBe(false);
        const labels=body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content.flatMap((part:any,index:number)=>{
          if(part.type!=="image_url" || message.content[index-1]?.type!=="text") return [];
          try {return [JSON.parse(message.content[index-1].text)];} catch {return [];}
        }):[]);
        expect(labels.some((label:any)=>label.assetId===firstBookAssetId || label.referenceImageId===firstBookSourceId || label.toolCallId==="batch-4")).toBe(false);
      }
    }
    const name = n===1 ? "image_batch" : n===2 || n===6 ? "image_export" : [3,5,7,9].includes(n) ? "image_batch" : [4,8].includes(n) ? "image_show" : null;
    const imageReceipt=body.messages.filter((m:any)=>m.role==="tool").map((m:any)=>JSON.parse(m.content)).findLast((value:any)=>value.kind==="image_generation");
    if(n===3) firstBookAssetId=imageReceipt.assetId;
    const args = n===1 ? {action:"start", scope:"all-documents", taskJobId, sources:ids.map(assetId=>({assetId})), notes:"Complete every page"} : n===2 || n===6 ? {referenceImageId:status.current.pages[0].referenceImageId, filename:n===2?"first-book-page.png":"second-book-page.png"} : [3,7].includes(n) ? {action:"review",review:{referenceImageId:status.current.pages[0].referenceImageId,assetId:imageReceipt.assetId,passed:true,evidence:"Original pixels inspected"}} : [4,8].includes(n) ? {assetId:status.current.pages[0].assetId} : {action:"advance",notes:"Complete every page; preserve all background pixels"};
    const message = name ? {role:"assistant", content:null, tool_calls:[{id:`batch-${n}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]} : {role:"assistant",content:"两本各一页，共两张原页已交付。"};
    return completionResponse({id:"batch",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message,finish_reason:name?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},!!body.stream);
  }) as typeof fetch;
  app=await createApp(db,{origin,storage:{...storageRuntime(),root},ai:{memory:{driver:"sqlite",url:":memory:"},fetch:fetcher,imageFetch:async()=>{throw Error("Exports must not call an image provider")}}});
  await app.inject({method:"POST",url:`/api/v1/ai/sessions/${sid}/messages`,headers:a,payload:{id:taskJobId,text:originalRequest,modelId:"test",scope:"all",attachments:ids}});const result=await wait(sid);
  expect(result.jobs[0].status,JSON.stringify(result.jobs[0])).toBe("completed");expect(n).toBe(10);expect(reviews).toBe(2);expect(scenes).toBe(2);
  const job=await db.selectFrom("ai_jobs").select("result").where("session_id","=",sid).executeTakeFirstOrThrow();
  const checkpoint=JSON.parse(job.result!).checkpoint;
  const batchParts = checkpoint.messages
    .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.toolName === "image_batch");
  expect(batchParts.length).toBeGreaterThan(0);
  expect(batchParts.every((part: any) => part.providerOptions?.mastra?.modelOutput === undefined)).toBe(true);
  expect(JSON.parse(job.result!).progress.events.filter((event:any)=>event.image).map((event:any)=>event.image.validation.state)).toEqual(["passed","passed"]);
  expect(checkpoint.imageBatch.current).toBe(2);expect(Object.keys(checkpoint.imageBatch.delivered)).toHaveLength(2);
  expect(checkpoint.imageBatch.version).toBe(5);
  expect(checkpoint.imageBatch.attemptScope.version).toBe(3);
  expect(checkpoint.imageBatch.requirements.original).toMatchObject({jobId:taskJobId,text:originalRequest});
  const complete=checkpoint.messages.flatMap((message:any)=>message.role==="tool" && Array.isArray(message.content)?message.content.filter((part:any)=>part.toolName==="image_batch").map((part:any)=>part.output?.value):[]).findLast((value:any)=>value?.complete===true);
  expect(complete).toMatchObject({complete:true,current:null,deliveryPresentation:{kind:"native-file-cards",count:2}});
  expect(complete.deliveries.map((delivery:any)=>delivery.name)).toEqual(["first-book-page.png","second-book-page.png"]);
  expect(complete.deliveries.map((delivery:any)=>delivery.assetId)).toEqual(checkpoint.imageBatch.books.map((book:any)=>checkpoint.imageBatch.delivered[book.pages[0].referenceImageId]));
  for(const delivery of complete.deliveries) {
    expect(delivery.reviewPassed).toBe(true);
    const file=await db.selectFrom("file_items").select(["name","metadata","storage_object_id"]).where("id","=",delivery.fileId).executeTakeFirstOrThrow();
    expect(file).toMatchObject({name:delivery.name,storage_object_id:delivery.assetId});
    expect(JSON.parse(file.metadata)).toMatchObject({assetId:delivery.assetId,aiSessionFolder:{sessionId:sid}});
    const href=new URL(delivery.href.slice(1),origin);
    expect(href.pathname).toBe("/files");expect(href.searchParams.get("focus")).toBe(delivery.fileId);
    expect(href.searchParams.get("session")).toBe(sid);
    expect(JSON.parse(href.searchParams.get("path")!)).toContainEqual(expect.objectContaining({type:"system",id:`ai-session:${sid}`}));
  }
  expect(checkpoint.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[]).some((part:any)=>["image","file"].includes(part.type))).toBe(false);
  expect(JSON.stringify(checkpoint).length).toBeLessThan(12000);
});

it("captures host-owned Doca folder inputs once, preserves their snapshot on resend and retry, and rejects changed originals", async () => {
  const owner = await db.selectFrom("users").selectAll().where("login", "=", "owner").executeTakeFirstOrThrow();
  const folder = randomUUID(), now = new Date().toISOString();
  await db.insertInto("file_folders").values({ id: folder, owner_id: owner.id, parent_id: null, name: "Actual books", version: 1, created_at: now, updated_at: now, deleted_at: null, delete_batch: null }).execute();
  async function addDocument(name: string) {
    const asset = (await upload(name, pdfFixture())).json().id;
    const object = await db.selectFrom("assets as a").innerJoin("file_storage_objects as o", "o.object_key", "a.object_key").select("o.id").where("a.id", "=", asset).executeTakeFirstOrThrow();
    const id = randomUUID();
    await db.insertInto("file_items").values({ id, owner_id: owner.id, parent_type: "folder", parent_id: folder, storage_object_id: object.id, name, mime: "application/pdf", size: 1, metadata: "{}", ai_description_override: null, locked: 0, version: 1, created_at: now, updated_at: now, deleted_at: null, delete_batch: null }).execute();
    return id;
  }
  const one = await addDocument("first.pdf"), two = await addDocument("second.pdf"), sid = await session(), id = randomUUID();
  const body = { id, text: "Handle all the selected folder documents", modelId: "test", scope: "all", files: [{ kind: "folder", id: folder, name: "UNTRUSTED_CLIENT_LABEL" }] };
  const post = (payload: any) => app.inject({ method: "POST", url: `/api/v1/ai/sessions/${sid}/messages`, headers: a, payload });
  expect((await post(body)).statusCode).toBe(200);
  await wait(sid);
  const saved = await db.selectFrom("ai_jobs").select(["input", "digest"]).where("id", "=", id).executeTakeFirstOrThrow();
  const snapshot = JSON.parse(saved.input).fileInputSnapshot;
  expect(snapshot.version).toBe(1);
  expect(snapshot.files.map((file: any) => file.fileId).sort()).toEqual([one, two].sort());
  expect(snapshot.folders[0].filename).toBe("Actual books");
  expect(JSON.stringify(snapshot)).not.toContain("UNTRUSTED_CLIENT_LABEL");
  const later = await addDocument("added-later.pdf");
  expect((await post(body)).json().id).toBe(id);
  expect((await db.selectFrom("ai_jobs").select("input").where("id", "=", id).executeTakeFirstOrThrow()).input).toBe(saved.input);
  await db.updateTable("ai_jobs").set({ status: "cancelled" }).where("id", "=", id).execute();
  const retry = randomUUID();
  expect((await post({ id: retry, text: "Retry", modelId: "test", scope: "all", retryOf: id })).statusCode).toBe(200);
  await wait(sid);
  const retried = JSON.parse((await db.selectFrom("ai_jobs").select("input").where("id", "=", retry).executeTakeFirstOrThrow()).input);
  expect(retried.fileInputSnapshot).toEqual(snapshot);
  expect(retried.fileInputSnapshot.files.some((file: any) => file.fileId === later)).toBe(false);
  await db.updateTable("file_items").set({ version: 2 }).where("id", "=", one).execute();
  expect((await post(body)).statusCode).toBe(409);
  const unchanged = await db.selectFrom("ai_jobs").select(["input", "digest"]).where("id", "=", id).executeTakeFirstOrThrow();
  expect(unchanged).toEqual(saved);
});

it("refuses client-forged snapshots, private folder inputs and old file inputs lacking a host snapshot", async () => {
  const owner = await db.selectFrom("users").selectAll().where("login", "=", "owner").executeTakeFirstOrThrow(), folder = randomUUID(), now = new Date().toISOString();
  await db.insertInto("file_folders").values({ id: folder, owner_id: owner.id, parent_id: null, name: "Private", version: 1, created_at: now, updated_at: now, deleted_at: null, delete_batch: null }).execute();
  const sid = await session(), id = randomUUID(), body = { id, text: "Handle this folder", modelId: "test", scope: "all", files: [{ kind: "folder", id: folder }] };
  const forged = await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${sid}/messages`, headers: a, payload: { ...body, fileInputSnapshot: { version: 1, references: [], folders: [], files: [] } } });
  expect(forged.statusCode).toBe(400);
  expect(await db.selectFrom("ai_jobs").select("id").where("id", "=", id).execute()).toEqual([]);
  const other = await session(b);
  expect((await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${other}/messages`, headers: b, payload: { ...body, id: randomUUID() } })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${sid}/messages`, headers: a, payload: body })).statusCode).toBe(200);
  await wait(sid);
  const saved = JSON.parse((await db.selectFrom("ai_jobs").select("input").where("id", "=", id).executeTakeFirstOrThrow()).input);
  delete saved.fileInputSnapshot;
  const oldInput = JSON.stringify(saved);
  await db.updateTable("ai_jobs").set({ input: oldInput }).where("id", "=", id).execute();
  expect((await app.inject({ method: "POST", url: `/api/v1/ai/sessions/${sid}/messages`, headers: a, payload: body })).statusCode).toBe(409);
  expect((await db.selectFrom("ai_jobs").select("input").where("id", "=", id).executeTakeFirstOrThrow()).input).toBe(oldInput);
});
