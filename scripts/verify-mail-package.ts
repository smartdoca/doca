/** Smoke test an already installed mail tgz, never links mail source or sends mail. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createApp } from "@server/app/create-app.js";
import { openDatabase } from "@db/connection.js";
import { createUser } from "@core/modules/identity/passwords.js";
const installation = await realpath(resolve(process.argv[2] ?? ""));
if (!process.argv[2])
  throw new Error(
    "Usage: tsx scripts/verify-mail-package.ts <isolated-installation-directory>",
  );
const packagePath = await realpath(
  join(installation, "doca.mail"),
);
assert.ok(
  packagePath.startsWith(installation + sep),
  "Mail package must be inside the isolated installation, not linked to its source",
);
const root = await mkdtemp(join(tmpdir(), "doca-mail-smoke-data-"));
const previousDirectory = process.env.DOCA_MAIL_DATA_DIR;
const previousKey = process.env.DOCA_MAIL_CREDENTIAL_KEY;
process.env.DOCA_MAIL_DATA_DIR = join(root, "mail");
process.env.DOCA_MAIL_CREDENTIAL_KEY =
  "isolated-mail-smoke-key-at-least-thirty-two-characters";
const db = await openDatabase({
  driver: "sqlite",
  path: join(root, "host.sqlite"),
});
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  await createUser(
    db,
    {
      login: "mail-smoke",
      displayName: "Mail smoke",
      password: "test-password-2026",
    },
    { bootstrap: true },
  );
  const origin = "http://127.0.0.1:39131";
  const headers = { host: "127.0.0.1:39131", origin };
  for (const enabled of [true, false, true]) {
    app = await createApp(db, {
      origin,
      pluginDirectory: installation,
      plugins: { "doca.mail": enabled },
    });
    const bootstrap = await app.inject({ url: "/api/v1/bootstrap", headers });
    assert.equal(bootstrap.statusCode, 200, bootstrap.body);
    const mail = bootstrap
      .json()
      .plugins.find((p: { id: string }) => p.id === "doca.mail");
    assert.equal(Boolean(mail), enabled);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { login: "mail-smoke", password: "test-password-2026" },
    });
    assert.equal(login.statusCode, 200, login.body);
    const status = await app.inject({
      url: "/api/v1/plugins/doca.mail/status",
      headers: {
        ...headers,
        cookie: String(login.headers["set-cookie"]).split(";")[0]!,
      },
    });
    assert.equal(status.statusCode, enabled ? 200 : 404, status.body);
    if (enabled) {
      assert.equal(status.json().ready, true);
      const web = await app.inject({
        url: `/api/v1/plugin-assets/doca.mail/${mail.version}/index.js`,
        headers,
      });
      assert.equal(web.statusCode, 200, web.body);
      assert.match(String(web.headers["content-type"]), /javascript/);
    }
    await app.close();
    app = undefined;
    await access(join(root, "mail/mail.sqlite"));
  }
  console.log(
    "Mail tgz smoke passed: discovery, startup, authenticated status, Web asset delivery, disable/re-enable, private database retention. Not browser rendering, provider mail delivery, or production host artifact acceptance.",
  );
} finally {
  await app?.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.DOCA_MAIL_DATA_DIR;
  else process.env.DOCA_MAIL_DATA_DIR = previousDirectory;
  if (previousKey === undefined) delete process.env.DOCA_MAIL_CREDENTIAL_KEY;
  else process.env.DOCA_MAIL_CREDENTIAL_KEY = previousKey;
}
