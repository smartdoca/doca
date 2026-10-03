import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { unpackNpm, downloadNpm } from "@server/plugins/npm.js";
import { PluginStore } from "@server/plugins/store.js";
import { unpack } from "@server/plugins/archive.js";
function tarEntry(name: string, content: string, type = "0") {
  const bytes = Buffer.from(content),
    h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([
    h,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}
function tar(name: string, content: string, type = "0") {
  return gzipSync(Buffer.concat([tarEntry(name, content, type), Buffer.alloc(1024)]));
}
function tarEntries(entries: Array<[string, string, string?]>) {
  return gzipSync(
    Buffer.concat([
      ...entries.map(([name, content, type]) => tarEntry(name, content, type)),
      Buffer.alloc(1024),
    ]),
  );
}
it("verifies exact npm bytes and refuses foreign tarballs, links, traversal and digest substitution", async () => {
  const bytes = tar(
    "package/package.json",
    JSON.stringify({ name: "@example/mail", version: "1.0.0" }),
  );
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const metadata = {
    name: "@example/mail",
    version: "1.0.0",
    dist: {
      integrity,
      tarball: "https://registry.npmjs.org/@example/mail/-/mail-1.0.0.tgz",
    },
  };
  const requests: string[] = [];
  const fetcher = (async (url: any, options: any) => {
    requests.push(String(url));
    expect(options.redirect).toBe("error");
    return String(url).endsWith(".tgz")
      ? new Response(bytes)
      : Response.json(metadata);
  }) as typeof fetch;
  const result = await downloadNpm(
    "@example/mail",
    "1.0.0",
    { registry: "https://registry.npmjs.org", integrity, size: bytes.length },
    fetcher,
  );
  expect(unpack(result.bytes)["package.json"]).toBeDefined();
  expect(requests[0]).toContain("%40example%2Fmail/1.0.0");
  await expect(
    downloadNpm("@example/mail", "latest", undefined, fetcher),
  ).rejects.toThrow("exact");
  await expect(
    downloadNpm(
      "@example/mail",
      "1.0.0",
      {
        registry: "https://registry.npmjs.org",
        integrity: "sha512-" + "a".repeat(86) + "==",
        size: bytes.length,
      },
      fetcher,
    ),
  ).rejects.toThrow("integrity");
  metadata.dist.tarball = "https://evil.example/plugin.tgz";
  await expect(
    downloadNpm("@example/mail", "1.0.0", undefined, fetcher),
  ).rejects.toThrow("Untrusted");
  expect(() => unpackNpm(tar("package/../escape", "x"))).toThrow("path");
  expect(() => unpackNpm(tar("package/link", "x", "2"))).toThrow("Links");
});
it("skips libarchive pax headers and still checks the following ustar path", () => {
  const pax = "30 mtime=1790863819.111169654\n";
  const pkg = JSON.stringify({ name: "@example/mail", version: "1.0.0" });
  const files = unpackNpm(
    tarEntries([
      ["PaxHeader/package", pax, "x"],
      ["package/", "", "5"],
      ["package/PaxHeader/package.json", pax, "x"],
      ["package/package.json", pkg],
      ["package/PaxHeader/LICENSE", pax, "g"],
      ["package/LICENSE", "mit"],
    ]),
  );
  expect(Object.keys(files).sort()).toEqual(["LICENSE", "package.json"]);
  expect(() =>
    unpackNpm(
      tarEntries([
        ["PaxHeader/package", pax, "x"],
        ["package/../escape", "x"],
      ]),
    ),
  ).toThrow("path");
  expect(() =>
    unpackNpm(
      tarEntries([
        ["package/PaxHeader/link", pax, "x"],
        ["package/link", "x", "2"],
      ]),
    ),
  ).toThrow("Links");
});
it("forwards search and cursor queries and does not expand the catalog", async () => {
  const calls: string[] = [];
  const store = new PluginStore("https://store.example", (async (url: any) => {
    calls.push(String(url));
    return Response.json({
      protocolVersion: 1,
      items: [],
      page: {
        nextCursor: "next",
        total: null,
        snapshotAt: "2026-09-30T00:00:00Z",
      },
    });
  }) as typeof fetch);
  const response = await store.catalog({
    q: "mail",
    sort: "likes",
    limit: "24",
    cursor: "opaque",
    target: "mobile",
  });
  expect(response.page.nextCursor).toBe("next");
  expect(calls).toHaveLength(1);
  const query = new URL(calls[0]!).searchParams;
  expect(query.get("q")).toBe("mail");
  expect(query.get("cursor")).toBe("opaque");
  await expect(store.catalog({ limit: 1000 })).rejects.toThrow();
});
it("batches update requests and rejects missing or wrong installed-version results", async () => {
  const store = new PluginStore("https://store.example", (async (
    _url: any,
    options: any,
  ) => {
    const body = JSON.parse(options.body);
    return Response.json({
      protocolVersion: 1,
      checkedAt: "2026-09-30T00:00:00Z",
      items: body.plugins.map((p: any) => ({
        id: p.id,
        installedVersion: p.version,
        status: "unknown",
        currentReview: "unknown",
        latestVersion: null,
        release: null,
        reason: "not_found",
      })),
    });
  }) as typeof fetch);
  expect(
    (
      await store.updates(
        Array.from({ length: 101 }, (_, i) => ({
          id: `example.p${i}`,
          version: "1.0.0",
          dataVersion: "1",
        })),
      )
    ).items,
  ).toHaveLength(101);
  const broken = new PluginStore("https://store.example", (async () =>
    Response.json({
      protocolVersion: 1,
      checkedAt: "2026-09-30T00:00:00Z",
      items: [],
    })) as typeof fetch);
  await expect(
    broken.updates([
      { id: "example.mail", version: "1.0.0", dataVersion: "1" },
    ]),
  ).rejects.toThrow("Invalid update");
});

it("preserves official identity and per-version release notes from the store", async () => {
  const plugin = {
    id: "example.mail",
    name: "Mail",
    summary: "Mail integration",
    official: true,
    author: { name: "Admin", url: null },
    categoryId: "integration",
    icon: null,
    detailPath: "/plugins/example.mail",
    targets: ["web"],
    review: "approved",
    latestVersion: "1.0.0",
    downloads: { count: null, period: "last30Days", source: "npm", asOf: null },
    likes: { count: 1, asOf: null },
    updatedAt: "2026-09-30T00:00:00Z",
  };
  const release = {
    pluginId: plugin.id,
    version: "1.0.0",
    changelog: "New inbox\nImproved search",
    sdkRange: "^0.1.7",
    dataVersion: "1",
    targets: ["web"],
    dependencies: [],
    review: "approved",
    reviewedAt: plugin.updatedAt,
    publishedAt: plugin.updatedAt,
    npm: {
      registry: "https://registry.npmjs.org",
      name: "@example/mail",
      version: "1.0.0",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      size: 100,
    },
  };
  const page = { nextCursor: null, total: 1, snapshotAt: plugin.updatedAt };
  const store = new PluginStore("https://store.example", (async (url: any) =>
    Response.json(
      String(url).includes("/releases")
        ? { protocolVersion: 1, items: [release], page }
        : String(url).includes("/example.mail")
          ? {
              protocolVersion: 1,
              plugin,
              description: { format: "doca-slate", version: 1, nodes: [] },
            }
          : { protocolVersion: 1, items: [plugin], page },
    )) as typeof fetch);
  expect((await store.catalog()).items[0]?.official).toBe(true);
  expect((await store.detail(plugin.id)).plugin.official).toBe(true);
  expect((await store.releases(plugin.id)).items[0]?.changelog).toBe(
    release.changelog,
  );
  Reflect.deleteProperty(plugin, "official");
  await expect(store.catalog()).rejects.toThrow();
  await expect(store.detail(plugin.id)).rejects.toThrow();
  Reflect.deleteProperty(release, "changelog");
  await expect(store.releases(plugin.id)).rejects.toThrow();
});
