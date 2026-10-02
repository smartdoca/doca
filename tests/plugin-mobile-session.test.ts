import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/app/create-app.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { openTestDatabase } from "./database.js";
it("binds mobile tickets to one plugin, denies replay and host APIs, and revokes on parent logout", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" }),
    root = await mkdtemp(join(tmpdir(), "doca-mobile-plugin-")),
    pkg = join(root, "example.mail");
  await mkdir(join(pkg, "web"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: "example.mail",
    version: "1.0.0",
    displayName: "Mail",
    sdkRange: "^0.1.0",
  };
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@example/mail",
      version: "1.0.0",
      type: "module",
      doca: {
        dataVersion: "1",
        manifest: "./manifest.json",
        server: "./server.js",
        web: { directory: "./web", entry: "./index.js" },
        mobileHostRange: "^1.0.0",
        navigation: [
          {
            id: "example.mail.inbox",
            title: { zh: "邮箱", en: "Mail" },
            icon: "mail",
            webPath: "/plugins/example.mail/inbox",
            mobile: true,
            allowedSlots: ["web.left", "mobile.drawer", "mobile.more"],
            defaults: ["mobile.drawer"],
            order: 1,
          },
        ],
      },
    }),
  );
  await writeFile(join(pkg, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(pkg, "server.js"),
    `export default()=>({manifest:${JSON.stringify(manifest)},async uninstall(){}})`,
  );
  await writeFile(join(pkg, "web/index.js"), "export default()=>({})");
  const app = await createApp(db, {
    origin: "http://127.0.0.1:39201",
    pluginDirectory: root,
  });
  const headers = { host: "127.0.0.1:39201", origin: "http://127.0.0.1:39201" };
  try {
    await createUser(
      db,
      {
        login: "mobile-admin",
        displayName: "Admin",
        password: "mobile-admin-password",
      },
      { bootstrap: true },
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...headers, "x-doca-client": "mobile" },
      payload: { login: "mobile-admin", password: "mobile-admin-password" },
    });
    const token = login.json().sessionToken;
    expect(token).toBeTruthy();
    const ticket = await app.inject({
      method: "POST",
      url: "/api/v1/plugins-mobile/ticket",
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: { entryId: "example.mail.inbox" },
    });
    expect(ticket.statusCode).toBe(200);
    const redeem = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/plugins-mobile/redeem",
        headers,
        payload: { ticket: ticket.json().ticket },
      });
    const response = await redeem();
    expect(response.statusCode).toBe(200);
    expect((await redeem()).statusCode).toBe(401);
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    expect(
      (
        await app.inject({
          url: "/api/v1/admin/plugins",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/plugins/other.plugin/messages",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(403);
    const bootstrap = await app.inject({
      url: "/api/v1/bootstrap",
      headers: { ...headers, cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().plugins.map((p: any) => p.id)).toEqual([
      "example.mail",
    ]);
    const publicCall = (pluginId: string, operation: string, payload: Record<string, unknown> = {}) => app.inject({
      method: "POST", url: `/api/v1/plugin-platform/${pluginId}/${operation}`, headers: { ...headers, cookie }, payload,
    });
    const self = await publicCall("example.mail", "users.me");
    expect(self.statusCode, self.body).toBe(200);
    expect(self.json()).toMatchObject({ login: "mobile-admin" });
    expect(self.body).not.toContain("password_hash");
    const search = await publicCall("example.mail", "users.searchPage", { query: "" });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.headers["cache-control"]).toBe("no-store");
    expect((await publicCall("other.plugin", "users.me")).statusCode).toBe(403);
    expect((await publicCall("example.mail", "users.list")).statusCode).toBe(404);
    expect((await publicCall("example.mail", "users.searchPage", { query: "", principal: { id: "other" } })).statusCode).toBe(400);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/bootstrap",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
