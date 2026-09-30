import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { unpackNpm, downloadNpm } from "@server/plugins/npm.js";
import { PluginStore } from "@server/plugins/store.js";
import { unpack } from "@server/plugins/archive.js";
function tar(name: string, content: string, type = "0") {
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
  return gzipSync(
    Buffer.concat([
      h,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
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
