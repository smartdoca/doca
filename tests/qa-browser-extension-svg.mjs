// Real isolated MV3 runtime. Synthetic API; no user documents or browser profile.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const output = resolve(
  process.argv[2] || "artifacts/verification/browser-extension-svg",
);
await mkdir(output, { recursive: true });
const extension = join(output, "extension");
await cp(resolve("apps/browser-extension"), extension, { recursive: true });
const profileId = randomUUID(),
  connectionId = randomUUID();
const vector = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60"><style>.shape{fill:#3370ff}</style><rect class="shape" x="20" y="10" width="120" height="40" rx="8"/></svg>`;
const invalidVector = `<svg xmlns="http://www.w3.org/2000/svg"><image href="/must-not-fetch"/></svg>`;
let natureLogo;
try {
  natureLogo = await readFile(
    "artifacts/verification/nature-capture-investigation/nature-logo.svg",
  );
} catch {}
const photo = await sharp({
  create: { width: 40, height: 24, channels: 4, background: "#ffa04080" },
})
  .png()
  .toBuffer();
const captures = [],
  uploads = new Map(),
  errors = [],
  requests = [];
let failCommit = true,
  uploadAttempts = 0;
const server = createServer(async (req, res) => {
  requests.push(req.url);
  try {
    if (
      req.url === "/logo.svg" ||
      req.url === "/unsupported.svg" ||
      req.url === "/nature.svg"
    ) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(
        req.url === "/logo.svg"
          ? vector
          : req.url === "/nature.svg"
            ? natureLogo
            : invalidVector,
      );
    }
    if (req.url === "/photo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(photo);
    }
    if (req.url === "/bad.avif") {
      res.writeHead(200, { "content-type": "image/avif" });
      return res.end("unsupported image bytes");
    }
    if (req.url === "/missing.png") {
      res.writeHead(404);
      return res.end();
    }
    if (req.url === "/read") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><title>SVG 与缺图收录验证</title><style>body{font:16px/1.8 system-ui;color:#263040;max-width:760px;margin:60px auto;background:#f7f9fc}article{background:white;padding:32px;border-radius:12px}img,svg{display:block;max-width:330px;margin:15px 0}</style><article><h1>SVG 与缺图收录验证</h1><p>有效图片继续归档，无法处理的图片保留原位置说明与来源。</p><img src="${imageOrigin}/logo.svg" alt="SVG 图形">${natureLogo ? `<img src="${imageOrigin}/nature.svg" alt="Nature Logo">` : ""}<img src="/photo.png" alt="原始图片">${vector}<img src="/bad.avif" alt="不兼容图片"><img src="/missing.png" alt="失效图片"><img src="/unsupported.svg" alt="外部依赖 SVG"><img style="display:none" src="/photo.png?tracking" alt="隐藏跟踪图片"><p>正文结尾仍然保留。</p></article>`,
      );
    }
    if (req.url === "/must-not-fetch")
      throw Error("SVG dependency escaped the decoder");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    const body =
      data.length && req.method !== "PUT" ? JSON.parse(data) : undefined;
    let result = {};
    if (req.url.endsWith("/me"))
      result = {
        user: { id: "fixture", name: "验证用户" },
        connection: { assistant_enabled: 0 },
      };
    else if (req.url.endsWith("/profiles"))
      result = {
        items: [
          {
            id: profileId,
            name: "网页归档",
            revision: 1,
            isDefault: true,
            strategy: "create",
          },
        ],
      };
    else if (req.url.endsWith("/clips")) {
      captures.push(body);
      result = {
        status: "pending",
        uploadedImageIds: body.images
          .filter((image) => uploads.has(image.id))
          .map((image) => image.id),
      };
    } else if (req.method === "PUT" && req.url.includes("/images/")) {
      uploads.set(req.url.split("/").at(-1), data);
      uploadAttempts++;
    } else if (req.url.endsWith("/commit")) {
      if (failCommit) {
        failCommit = false;
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ message: "clipper_connection_failed" }),
        );
      }
      assert(captures.at(-1).images.every((image) => uploads.has(image.id)));
      result = { status: "completed", href: "/#/r/isolated-fixture" };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    errors.push(error.stack);
    res.writeHead(500);
    res.end("{}");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const imageOrigin = origin.replace("127.0.0.1", "localhost");
let context;
try {
  context = await chromium.launchPersistentContext(
    await mkdtemp(join(output, "profile-")),
    {
      executablePath: chromium.executablePath(),
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(
    async ({ origin, connectionId }) => {
      await chrome.storage.local.set({ site: { version: 2, origin } });
      await chrome.storage.session.set({
        authorization: {
          version: 2,
          origin,
          connectionId,
          token: "doca_browser_v2_" + "1".repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    },
    { origin, connectionId },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.goto(origin + "/read");
  await page.locator("[data-doca-capture-ui].ready").waitFor();
  const cdp = await context.newCDPSession(page);
  async function node(selector) {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (entry) =>
      entry.attributes?.includes("data-doca-capture-ui")
        ? entry
        : [...(entry.children || []), ...(entry.shadowRoots || [])]
            .map(find)
            .find(Boolean);
    const host = find(root);
    assert(host?.shadowRoots?.[0], "extension closed shadow root");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: host.shadowRoots[0].nodeId,
      selector,
    });
    assert(nodeId, selector);
    return nodeId;
  }
  async function click(selector) {
    const { model } = await cdp.send("DOM.getBoxModel", {
      nodeId: await node(selector),
    });
    await page.mouse.click(
      (model.border[0] + model.border[4]) / 2,
      (model.border[1] + model.border[5]) / 2,
    );
  }
  async function status() {
    const { object } = await cdp.send("DOM.resolveNode", {
      nodeId: await node(".status"),
    });
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(){return this.textContent}",
      returnByValue: true,
    });
    return result.result.value;
  }
  async function waitStatus(text) {
    const until = Date.now() + 25000;
    while (!(await status()).includes(text)) {
      if (Date.now() > until)
        throw Error("Expected " + text + ", got " + (await status()));
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  await click('[data-action="page"]');
  // Wait until the capture rule has finished loading.
  const until = Date.now() + 10000;
  while (true) {
    const { object } = await cdp.send("DOM.resolveNode", {
      nodeId: await node(".confirm"),
    });
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(){return this.disabled}",
      returnByValue: true,
    });
    if (!result.result.value) break;
    if (Date.now() > until) throw Error("capture rules unavailable");
    await new Promise((done) => setTimeout(done, 50));
  }
  await click(".confirm");
  await waitStatus("无法连接");
  assert.equal(captures.length, 1);
  const first = JSON.stringify(captures[0]),
    uploadedCount = uploadAttempts;
  await click(".confirm");
  await waitStatus("已保存到 Doca");
  assert.equal(captures.length, 2);
  assert.deepEqual(
    captures[1],
    JSON.parse(first),
    "retry uses the exact frozen task after preprocessing",
  );
  assert.equal(uploadAttempts, uploadedCount, "retry reuses uploaded images");
  const input = captures[0];
  await writeFile(
    join(output, "last-capture.json"),
    JSON.stringify(input, null, 2),
  );
  assert.equal(input.version, 1);
  assert.equal(input.images.length, natureLogo ? 4 : 3);
  for (const alt of ["不兼容图片", "失效图片", "外部依赖 SVG"])
    assert(input.markdown.includes("图片未保存：" + alt), alt);
  assert(input.markdown.includes(origin + "/bad.avif"));
  assert(input.markdown.includes("正文结尾仍然保留"));
  assert(!input.markdown.includes("隐藏跟踪图片"));
  assert(!requests.includes("/must-not-fetch"));
  const metadata = [];
  for (const image of input.images) {
    const bytes = uploads.get(image.id),
      info = await sharp(bytes).metadata();
    assert.equal(info.format, "png");
    if (image.url.endsWith("/logo.svg")) {
      assert.equal(image.name, "logo.png");
      assert.equal(info.width, 160);
      assert.equal(info.height, 60);
      assert.equal(info.hasAlpha, true);
      const { data, info: raw } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(data[3], 0, "transparent background preserved");
      const offset = (30 * raw.width + 80) * raw.channels;
      assert.deepEqual(
        [...data.subarray(offset, offset + 4)],
        [51, 112, 255, 255],
        "embedded style rendered",
      );
    }
    await writeFile(join(output, image.name), bytes);
    metadata.push({
      name: image.name,
      format: info.format,
      width: info.width,
      height: info.height,
      hasAlpha: info.hasAlpha,
    });
  }
  await page.screenshot({
    path: join(output, "capture-completed.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        natureLogoVerified: !!natureLogo,
        frozenRetry: true,
        placeholders: 3,
        sourceLinksPreserved: true,
        externalSvgRequests: 0,
        images: metadata,
        capture: input,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      natureLogoVerified: !!natureLogo,
      images: metadata,
      placeholders: 3,
      frozenRetry: true,
    }),
  );
} finally {
  await context?.close();
  await new Promise((done) => server.close(done));
}
