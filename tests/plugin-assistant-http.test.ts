import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import { createApp } from "@server/app/create-app.js";
import { createPluginAssistantClient } from "@smartdoca/plugin-sdk/web";
import { mockAI } from "./ai-mock.js";
import type { DB } from "@db/index.js";

let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  ownerCookie: string,
  otherCookie: string,
  documentId: string;
let pluginDirectory: string;
const origin = "http://localhost:39230";
const password = "plugin-assistant-test-2026";
beforeEach(async () => {
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
  documentId = (
    await createContent(db).create(owner, {
      title: "Private report",
      kind: "document",
      format: "markdown",
    })
  ).id;
  await saveAIConfig(
    db,
    {
      ...aiDefaults,
      defaultModel: "test",
      vendors: [
        {
          id: "vendor",
          name: "Test",
          provider: "compatible",
          baseUrl: "https://model.example.test/v1",
          apiKey: "test-only",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "vendor",
          model: "test-model",
          alias: "Test",
          enabled: true,
          maxInput: 32000,
          maxOutput: 1000,
          tools: true,
        },
      ],
    },
    0,
  );
  pluginDirectory = await mkdtemp(join(tmpdir(), "doca-assistant-test-"));
  const root = join(pluginDirectory, "example.assistant");
  await mkdir(root);
  const manifest = {
    schemaVersion: 1,
    id: "example.assistant",
    version: "1.0.0",
    displayName: "Assistant fixture",
    sdkRange: "^0.1.7",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@example/assistant",
      version: "1.0.0",
      type: "module",
      doca: {
        dataVersion: "1",
        storage: "host",
        manifest: "./manifest.json",
        server: "./server.js",
      },
    }),
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "server.js"),
    `export default () => ({ manifest: ${JSON.stringify(manifest)}, async uninstall() {} });`,
  );
  app = await createApp(db, {
    origin,
    pluginDirectory,
    ai: { memory: { driver: "sqlite", url: ":memory:" }, fetch: mockAI() },
  });
  const login = async (name: string) =>
    String(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { host: "localhost:39230", origin },
          payload: { login: name, password },
        })
      ).headers["set-cookie"],
    ).split(";")[0]!;
  ownerCookie = await login("owner");
  otherCookie = await login("other");
});
afterEach(async () => {
  await app?.close();
  await db.destroy();
  if (pluginDirectory)
    await rm(pluginDirectory, { recursive: true, force: true });
});
function assistant(cookie: string) {
  const present = vi.fn();
  const client = createPluginAssistantClient(
    "example.assistant",
    async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: `/api/v1${path}`,
        headers: { host: "localhost:39230", origin, cookie, "content-type": "application/json" },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.statusCode !== 200)
        throw Object.assign(new Error(response.json().message), {
          status: response.statusCode,
        });
      return response.json() as T;
    },
    present,
    randomUUID,
  );
  return { client, present };
}

it("creates an isolated authorized draft using real host routes without scheduling a model call", async () => {
  const { client, present } = assistant(ownerCookie);
  const result = await client.open({
    prompt: "Summarize",
    context: "Plugin context",
    documentIds: [documentId],
  });
  const row = await db
    .selectFrom("ai_sessions")
    .selectAll()
    .where("id", "=", result.sessionId)
    .executeTakeFirstOrThrow();
  expect(JSON.parse(row.resource_ids)).toEqual([documentId]);
  expect(await db.selectFrom("ai_jobs").selectAll().execute()).toEqual([]);
  expect(present).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "Summarize\n\nPlugin context",
      references: [
        { resourceId: documentId, label: "Private report", format: "markdown" },
      ],
    }),
    result,
  );
});

it("refuses another user's document and conversation, without opening a new conversation", async () => {
  const ownerSession = await assistant(ownerCookie).client.open({
    prompt: "Private",
  });
  const other = assistant(otherCookie);
  await expect(
    other.client.open({
      prompt: "Read",
      documentIds: [documentId],
      autoSend: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    other.client.open({
      sessionId: ownerSession.sessionId,
      prompt: "Read",
      autoSend: true,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await db.selectFrom("ai_sessions").selectAll().execute()).toHaveLength(
    1,
  );
  expect(await db.selectFrom("ai_jobs").selectAll().execute()).toEqual([]);
  expect(other.present).not.toHaveBeenCalled();
});

it("submits an explicit auto-send through the ordinary host job queue", async () => {
  const { client, present } = assistant(ownerCookie);
  const result = await client.open({ prompt: "Hello", autoSend: true });
  const job = await db
    .selectFrom("ai_jobs")
    .selectAll()
    .where("id", "=", result.jobId!)
    .executeTakeFirstOrThrow();
  expect(job.session_id).toBe(result.sessionId);
  const detail = await app.inject({
    url: `/api/v1/ai/sessions/${result.sessionId}`,
    headers: { host: "localhost:39230", cookie: ownerCookie },
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().messages).toContainEqual(
    expect.objectContaining({
      role: "user",
      text: "Hello",
      references: [],
      attachments: [],
    }),
  );
  expect(present).toHaveBeenCalledWith(null, result);
});
