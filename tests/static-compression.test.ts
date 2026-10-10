import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { registerStaticRoutes } from "@server/routes/static.js";
import { openTestDatabase } from "./database.js";
import { AppError } from "@core/shared/errors.js";

const script = Buffer.from(
  `export const text = ${JSON.stringify("isolated static compression fixture ".repeat(2000))};`,
);
let root: string;
let db: Awaited<ReturnType<typeof openTestDatabase>>;
const app = Fastify();
app.setErrorHandler((error, _request, reply) => {
  reply
    .code(error instanceof AppError ? error.status : 500)
    .send({
      message: error instanceof Error ? error.message : "Unknown error",
    });
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "doca-static-compression-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "cad"));
  await writeFile(
    join(root, "index.html"),
    '<script src="/assets/app-fixture.js"></script>',
  );
  await writeFile(join(root, "assets/app-fixture.js"), script);
  await writeFile(
    join(root, "cad/libredwg-web.wasm"),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  await registerStaticRoutes(
    app,
    db,
    root,
    undefined,
    "https://cdn.example/fixture",
  );
});
afterAll(async () => {
  await app.close();
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["br", "gzip"] as const)(
  "serves %s at the original URL with identical decompressed bytes and cache separation",
  async (encoding) => {
    const response = await app.inject({
      url: "/assets/app-fixture.js",
      headers: { "accept-encoding": encoding },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.rawPayload.length).toBeLessThan(script.length / 10);
    const decoded =
      encoding === "br"
        ? brotliDecompressSync(response.rawPayload)
        : gunzipSync(response.rawPayload);
    expect(decoded).toEqual(script);
  },
);

it.each([undefined, "identity", "br;q=0,gzip;q=0", "deflate"])(
  "serves original bytes to clients using %s",
  async (encoding) => {
    const response = await app.inject({
      url: "/assets/app-fixture.js",
      headers: encoding ? { "accept-encoding": encoding } : {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.rawPayload).toEqual(script);
  },
);

it.each([
  ["br,gzip", "br"],
  ["br;q=0.4,gzip;q=0.8", "gzip"],
  ["br;q=0,*;q=0.5", "gzip"],
  ["br;q=0.5,identity;q=1", undefined],
  [" BR ;q=1,gzip;q=0", "br"],
])("honors encoding preferences for %s", async (header, encoding) => {
  const response = await app.inject({
    url: "/assets/app-fixture.js",
    headers: { "accept-encoding": header! },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe(encoding);
});

it.each(["*;q=0", "identity;q=0,br;q=0,gzip;q=0"])(
  "rejects a request without any acceptable representation: %s",
  async (header) => {
    const response = await app.inject({
      url: "/assets/app-fixture.js",
      headers: { "accept-encoding": header },
    });
    expect(response.statusCode).toBe(406);
  },
);

it("rewrites the CDN prefix before compression and keeps HTML revalidation", async () => {
  const response = await app.inject({
    url: "/",
    headers: { "accept-encoding": "br" },
  });
  expect(response.headers["cache-control"]).toBe("no-cache");
  expect(brotliDecompressSync(response.rawPayload).toString()).toBe(
    '<script src="https://cdn.example/fixture/assets/app-fixture.js"></script>',
  );
});

it("keeps HEAD responses empty with the encoded representation length", async () => {
  const headers = { "accept-encoding": "br" };
  const get = await app.inject({ url: "/assets/app-fixture.js", headers });
  const head = await app.inject({
    method: "HEAD",
    url: "/assets/app-fixture.js",
    headers,
  });
  expect(head.rawPayload.length).toBe(0);
  expect(head.headers["content-encoding"]).toBe("br");
  expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
});

it("serves the built CAD worker resource with the correct MIME without exposing other paths", async () => {
  const resource = await app.inject({
    url: "/cad/libredwg-web.wasm",
    headers: { "accept-encoding": "br" },
  });
  expect(resource.statusCode).toBe(200);
  expect(resource.headers["content-type"]).toBe("application/wasm");
  expect(brotliDecompressSync(resource.rawPayload)).toEqual(
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  expect((await app.inject({ url: "/cad/package.json" })).statusCode).toBe(404);
  expect((await app.inject({ url: "/assets/not-found.js" })).statusCode).toBe(
    404,
  );
});

it("does not return stale compressed bytes after a resource changes", async () => {
  const url = "/assets/change-fixture.js";
  await writeFile(join(root, url), "export const value = 1;");
  await app.inject({ url, headers: { "accept-encoding": "br" } });
  const updated = "export const value = 2000;";
  await writeFile(join(root, url), updated);
  const response = await app.inject({
    url,
    headers: { "accept-encoding": "br" },
  });
  expect(brotliDecompressSync(response.rawPayload).toString()).toBe(updated);
});
