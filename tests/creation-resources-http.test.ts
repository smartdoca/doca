import { it, expect } from "vitest";
import { openTestDatabase } from "./database.js";
import { createApp } from "@server/app/create-app.js";
import { installTemplate } from "./creation-resource-fixtures.js";
import { createUser } from "@core/modules/identity/passwords.js";
it("serves authenticated empty registries, retires old endpoints and creates only after selection", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const user = {
    ...(await createUser(
      db,
      {
        login: "resources-http",
        displayName: "HTTP",
        password: "resources-http-test",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const app = await createApp(db, {
    origin: "http://localhost",
    pluginDirectory: "/tmp/doca-resource-http-empty",
    webhookDispatch: false,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { login: "resources-http", password: "resources-http-test" },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/creation-resources/templates/search",
          headers: { host: "localhost", origin: "http://localhost" },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/creation-resources/templates/search",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: {},
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().items).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/templates",
          headers: { host: "localhost", cookie, origin: "http://localhost" },
        })
      ).statusCode,
    ).toBe(404);
    const old = await app.inject({
      method: "POST",
      url: "/api/v1/admin/templates",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: {},
    });
    expect(old.statusCode).toBe(404);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/resources",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: {
        kind: "document",
        format: "markdown",
        title: "Legacy",
        templateId: crypto.randomUUID(),
      },
    });
    expect(invalid.statusCode).toBe(400);
    const template = installTemplate(db, "markdown", "# Actual content");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/resources",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: {
        kind: "document",
        format: "markdown",
        title: "New",
        template: template.selection,
      },
    });
    expect(created.statusCode).toBe(200);
    const consume = await app.inject({
      method: "POST",
      url: "/api/v1/creation-resources/templates/consume",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: {
        consumerId: "doca.documents.create",
        selection: template.selection,
        input: { title: "Consumer" },
      },
    });
    expect(consume.statusCode).toBe(200);
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/creation-resources/templates/search",
      headers: { host: "localhost", cookie, origin: "http://localhost" },
      payload: { principalId: user.id },
    });
    expect(bad.statusCode).toBe(400);
  } finally {
    await app.close();
    await db.destroy();
  }
});
