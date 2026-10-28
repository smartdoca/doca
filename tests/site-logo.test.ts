import { afterEach, beforeEach, expect, it } from "vitest";
import sharp from "sharp";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createApp } from "@server/app/create-app.js";
import type { DB } from "@db/index.js";
import { readSiteLogo } from "@server/services/site-logo.js";

const origin = "http://localhost:39130",
  password = "isolated-logo-password-2026";
let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  adminCookie: string,
  memberCookie: string;
const request = (
  method: "GET" | "PUT" | "POST",
  path: string,
  cookie = "",
  payload?: object,
  requestOrigin = origin,
) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: { host: "localhost:39130", origin: requestOrigin, cookie },
    ...(payload === undefined ? {} : { payload }),
  });
async function settings() {
  return db
    .selectFrom("settings")
    .selectAll()
    .where("id", "=", "system")
    .executeTakeFirstOrThrow();
}
async function logo(format: "png" | "jpeg" | "webp" = "png") {
  const image = await sharp({
    create: { width: 800, height: 400, channels: 4, background: "#2674b8" },
  })
    .toFormat(format)
    .toBuffer();
  return `data:image/${format};base64,${image.toString("base64")}`;
}
async function save(
  image: string | null,
  cookie = adminCookie,
  revision?: number,
) {
  return request("PUT", "/admin/site-logo", cookie, {
    revision: revision ?? (await settings()).revision,
    image,
  });
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const owner: Actor = {
    ...(await createUser(
      db,
      { login: "logoadmin", displayName: "Logo admin", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  await createUser(
    db,
    { login: "logomember", displayName: "Logo member", password },
    { actor: owner },
  );
  app = await createApp(db, {
    origin,
    ai: { memory: { driver: "sqlite", url: ":memory:" } },
  });
  const login = async (login: string) => {
    const response = await request("POST", "/auth/login", "", {
      login,
      password,
    });
    expect(response.statusCode, response.body).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0]!;
  };
  adminCookie = await login("logoadmin");
  memberCookie = await login("logomember");
});
afterEach(async () => {
  await app?.close();
  await db?.destroy();
});

it("keeps default branding until configured, normalizes all supported images, and serves only public PNG bytes", async () => {
  const original = await settings();
  expect(original.site_logo).toBeNull();
  expect((await request("GET", "/bootstrap")).json().siteLogoUrl).toBeNull();
  expect((await request("GET", "/site-logo")).statusCode).toBe(404);
  for (const format of ["png", "jpeg", "webp"] as const) {
    const saved = await save(await logo(format));
    expect(saved.statusCode, saved.body).toBe(200);
    const stored = await settings();
    expect(stored.site_name).toBe(original.site_name);
    expect(stored.registration).toBe(original.registration);
    const decoded = await readSiteLogo(stored.site_logo);
    expect(decoded).toBeTruthy();
    const metadata = await sharp(decoded!.bytes).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 256, height: 128 });
    expect(metadata.exif).toBeUndefined();
    const bootstrap = (await request("GET", "/bootstrap")).json();
    expect(bootstrap.siteLogoUrl).toBe(decoded!.url);
    const adminSettings = (
      await request("GET", "/admin/settings", adminCookie)
    ).json();
    expect(adminSettings.siteLogoUrl).toBe(decoded!.url);
    expect(adminSettings.site_logo).toBeUndefined();
    const image = await request(
      "GET",
      bootstrap.siteLogoUrl.replace("/api/v1", ""),
    );
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload).toEqual(decoded!.bytes);
    expect(image.headers["cache-control"]).toContain("no-cache");
    const conditional = await app.inject({
      method: "GET",
      url: bootstrap.siteLogoUrl,
      headers: {
        host: "localhost:39130",
        "if-none-match": image.headers.etag as string,
      },
    });
    expect(conditional.statusCode).toBe(304);
  }
  expect((await save(null)).statusCode).toBe(200);
  expect((await settings()).site_logo).toBeNull();
  expect((await request("GET", "/bootstrap")).json().siteLogoUrl).toBeNull();
  expect((await request("GET", "/site-logo")).statusCode).toBe(404);
  expect(
    await db
      .selectFrom("security_audit")
      .selectAll()
      .where("action", "=", "site.logo_updated")
      .execute(),
  ).toHaveLength(4);
});

it("requires an administrator and same-origin writes, rejects stale revisions, and preserves unrelated site changes", async () => {
  const image = await logo(),
    original = await settings();
  expect((await save(image, "")).statusCode).toBe(401);
  expect((await save(image, memberCookie)).statusCode).toBe(403);
  expect(
    (
      await request(
        "PUT",
        "/admin/site-logo",
        adminCookie,
        { revision: original.revision, image },
        "https://untrusted.invalid",
      )
    ).statusCode,
  ).toBe(403);
  expect(await settings()).toEqual(original);
  expect((await save(image)).statusCode).toBe(200);
  const after = await settings();
  expect((await save(null, adminCookie, original.revision)).statusCode).toBe(
    409,
  );
  expect(await settings()).toEqual(after);
  const general = await request("PUT", "/admin/settings", adminCookie, {
    revision: after.revision,
    siteName: "Preserved branding",
    registrationEnabled: false,
    defaultLocale: "en",
    defaultTimezone: "UTC",
  });
  expect(general.statusCode, general.body).toBe(200);
  expect((await settings()).site_logo).toBe(after.site_logo);
});

it("rejects SVG, spoofed/corrupt bytes, animated images and excessive sizes without modifying settings", async () => {
  const original = await settings();
  const animatedGif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  );
  for (const image of [
    "data:image/svg+xml;base64," +
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString(
        "base64",
      ),
    "data:image/png;base64," + animatedGif.toString("base64"),
    "data:image/png;base64," +
      Buffer.from("invalid image bytes").toString("base64"),
    "data:image/png;base64,not_base64",
    "data:image/png;base64," +
      Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
    "data:image/png;base64," +
      (
        await sharp({
          create: {
            width: 4100,
            height: 4100,
            channels: 3,
            background: "white",
          },
        })
          .png()
          .toBuffer()
      ).toString("base64"),
  ]) {
    const response = await save(image);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(await settings()).toEqual(original);
  }
});

it("preserves and refuses unknown or damaged stored configurations, including attempted reset", async () => {
  for (const site_logo of [
    '{"version":2,"png":"opaque"}',
    "{broken",
    '{"version":1,"png":"aW52YWxpZA=="}',
  ]) {
    await db
      .updateTable("settings")
      .set({ site_logo })
      .where("id", "=", "system")
      .execute();
    const original = await settings();
    expect(
      (await request("GET", "/admin/settings", adminCookie)).statusCode,
    ).toBe(500);
    expect((await request("GET", "/bootstrap")).statusCode).toBe(500);
    expect((await request("GET", "/site-logo")).statusCode).toBe(500);
    expect((await save(null)).statusCode).toBe(500);
    expect(await settings()).toEqual(original);
  }
});
