import { describe, expect, it } from "vitest";
import { assetBase } from "../apps/server/src/bootstrap/config.js";
import {
  rewriteAssetUrls,
  staticCacheControl,
} from "../apps/server/src/routes/static.js";

describe("DOCA_ASSET_BASE", () => {
  it("leaves local asset URLs unchanged when unset", () => {
    const html = `<script type="module" src="/assets/index-a.js"></script>`;
    expect(assetBase("")).toBeUndefined();
    expect(assetBase(undefined)).toBeUndefined();
    expect(rewriteAssetUrls(html)).toBe(html);
  });

  it("prefixes the HTML entry with the configured base", () => {
    const html = `<link rel="stylesheet" href="/assets/index-a.css"><script type="module" src="/assets/index-a.js"></script>`;
    expect(rewriteAssetUrls(html, "https://cdn.example/doca/0.1.0")).toBe(
      `<link rel="stylesheet" href="https://cdn.example/doca/0.1.0/assets/index-a.css"><script type="module" src="https://cdn.example/doca/0.1.0/assets/index-a.js"></script>`,
    );
  });

  it("accepts an https prefix and strips a trailing slash", () => {
    expect(assetBase("https://cdn.example/doca/0.1.0/")).toBe(
      "https://cdn.example/doca/0.1.0",
    );
  });

  it("revalidates HTML and keeps hashed assets for a year", () => {
    expect(staticCacheControl("/")).toBe("no-cache");
    expect(staticCacheControl("/assets/index-abc.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("rejects credentials and queries", () => {
    expect(() => assetBase("https://user:secret@cdn.example/doca")).toThrow(
      /DOCA_ASSET_BASE/,
    );
    expect(() => assetBase("https://cdn.example/doca?x=1")).toThrow(
      /DOCA_ASSET_BASE/,
    );
  });
});
