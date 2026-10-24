import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { saveAIConfig, aiDefaults } from "@core/modules/ai/config.js";
import * as aiConfigModule from "@core/modules/ai/config.js";
import { readAIDocument } from "@core/workflows/ai-documents.js";
import { createApp } from "@server/app/create-app.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { completionResponse, mockAI } from "./ai-mock.js";
import { createAIMemory, memoryOwner } from "@server/services/ai/memory.js";
import { captureHash } from "@server/services/browser-clipper.js";

let db: DB,
  app: Awaited<ReturnType<typeof createApp>>,
  actor: Actor,
  root: string,
  cookie: string,
  token: string,
  connectionId: string,
  profile: any,
  requests: any[],
  action: "read" | "capture" | "forbidden" | "delay" | "plain";
let materialId: string, forbiddenId: string;
const origin = "http://localhost:39473",
  host = "localhost:39473",
  password = "isolated-browser-ai";
const request = (method: any, path: string, payload?: any, external = false) =>
  app.inject({
    method,
    url: "/api/v1" + path,
    headers: {
      host,
      origin: external
        ? "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        : origin,
      cookie: external ? "" : cookie,
      ...(external ? { authorization: "Bearer " + token } : {}),
    },
    payload,
  });
const ai = (method: any, path: string, payload?: any) =>
  request(method, "/browser-clipper/assistant" + path, payload, true);
async function settle(
  id: string,
  states = ["completed", "failed", "cancelled", "awaiting_approval"],
) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom("ai_jobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (states.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error("Browser AI job did not settle");
}
beforeEach(async () => {
  cookie = "";
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  root = await mkdtemp(join(tmpdir(), "doca-browser-ai-"));
  requests = [];
  action = "plain";
  actor = {
    ...(await createUser(
      db,
      { login: "browserai", displayName: "Browser AI", password },
      { bootstrap: true },
    )),
    admin: 1,
  };
  const library = await createContent(db).create(actor, {
    kind: "library",
    format: "rich_text",
    title: "故障资料",
  });
  const forbidden = await createContent(db).create(actor, {
    kind: "document",
    format: "markdown",
    title: "Private unrelated",
    markdown: "# Private unrelated\nUNRELATED_PRIVATE_CONTENT_9327",
  });
  forbiddenId = forbidden.id;
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
          apiKey: "synthetic-model-key",
          enabled: true,
        },
      ],
      models: [
        {
          id: "test",
          vendorId: "vendor",
          model: "test",
          alias: "Test model",
          enabled: true,
          maxInput: 64000,
          maxOutput: 2000,
          tools: true,
        },
      ],
    },
    0,
  );
  const fallback = mockAI();
  const fetcher = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (
      body.tools?.some((tool: any) => tool.function?.name === "submit_review")
    )
      return fallback(url, init);
    if (action === "delay")
      await new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    const toolResults = body.messages.filter(
      (message: any) => message.role === "tool",
    );
    const name =
      !toolResults.length && action !== "plain"
        ? action === "read"
          ? "browser_material_read"
          : action === "capture"
            ? "browser_capture"
          : "document_read"
        : null;
    const message = name
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "browser-read",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  action === "read" || action === "capture"
                    ? { requestId: materialId, offset: 0 }
                    : { resourceId: forbiddenId },
                ),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: "现象：设备无法启动。排查步骤：检查电源。",
        };
    return completionResponse(
      {
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [
          { index: 0, message, finish_reason: name ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
      },
      !!body.stream,
    );
  }) as typeof fetch;
  app = await createApp(db, {
    origin,
    storage: { ...storageRuntime(), root },
    ai: { memory: { driver: "sqlite", url: join(root, "memory.sqlite") }, fetch: fetcher },
  });
  const login = await request("POST", "/auth/login", {
    login: "browserai",
    password,
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const createdProfile = await request("POST", "/me/browser-clipper/profiles", {
    name: "故障资料",
    enabled: true,
    isDefault: true,
    strategy: "create",
    libraryId: library.id,
    parentId: null,
    targetId: null,
    titleTemplate: "{title}",
    aiInstruction: "",
  });
  expect(createdProfile.statusCode, createdProfile.body).toBe(200);
  profile = createdProfile.json();
  const verifier = randomBytes(32).toString("hex");
  const authorized = await request("POST", "/me/browser-clipper/authorize", {
    version: 2,
    installationId: randomUUID(),
    challenge: createHash("sha256").update(verifier).digest("hex"),
  });
  expect(authorized.statusCode, authorized.body).toBe(200);
  const activated = await request(
    "POST",
    "/browser-clipper/token",
    { version: 2, code: authorized.json().code, verifier },
    true,
  );
  expect(activated.statusCode, activated.body).toBe(200);
  connectionId = activated.json().connectionId;
  token = activated.json().token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await db?.destroy();
  await rm(root, { recursive: true, force: true });
});
async function session() {
  const result = await ai("POST", "/sessions", {
    profileId: profile.id,
    profileRevision: profile.revision,
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json().id;
}
async function send(id: string, captureRequestId: string | null = null) {
  const jobId = randomUUID(),
    result = await ai("POST", `/sessions/${id}/messages`, {
      id: jobId,
      modelId: "test",
      text: "只在对话中总结材料，不创建文件。",
      captureRequestId,
    });
  expect(result.statusCode, result.body).toBe(200);
  return jobId;
}
async function prepareMaterial(markdown: string) {
  const material = {
    version: 1, requestId: randomUUID(), profileId: profile.id,
    profileRevision: profile.revision, mode: "selection",
    url: "https://material.example.test/post", title: "故障排查",
    capturedAt: new Date().toISOString(), markdown, images: [],
  };
  const prepared = await request("POST", "/browser-clipper/clips", material, true);
  expect(prepared.statusCode, prepared.body).toBe(200);
  return material;
}

it("rejects a retained receipt from another revision or snapshot identity before submitting a current browser job", async () => {
  const previous = await prepareMaterial("OLD_REVISION_MATERIAL_8213");
  const retained = await db.selectFrom("browser_clipper_receipts").selectAll().where("request_id", "=", previous.requestId).executeTakeFirstOrThrow();
  const { id, ...values } = profile;
  const changed = await request("PUT", `/me/browser-clipper/profiles/${id}`, { ...values, titleTemplate: "新规则 {title}" });
  expect(changed.statusCode, changed.body).toBe(200);
  profile = changed.json();
  const sid = await session();
  const rejectedId = randomUUID();
  const rejected = await ai("POST", `/ui/sessions/${sid}/messages`, { id: rejectedId, modelId: "test", text: "Use this page", captureRequestId: previous.requestId });
  expect(rejected.statusCode, rejected.body).toBe(409);
  expect(rejected.json().message).toBe("clipper_profile_changed");
  expect(await db.selectFrom("ai_jobs").select("id").where("id", "=", rejectedId).executeTakeFirst()).toBeUndefined();
  expect(await db.selectFrom("browser_clipper_receipts").selectAll().where("request_id", "=", previous.requestId).executeTakeFirstOrThrow()).toEqual(retained);

  const mismatched = await prepareMaterial("MISMATCHED_IDENTITY_1754");
  const mismatchedRow = await db.selectFrom("browser_clipper_receipts").select("profile_json").where("request_id", "=", mismatched.requestId).executeTakeFirstOrThrow();
  await db.updateTable("browser_clipper_receipts").set({ profile_json: JSON.stringify({ ...JSON.parse(mismatchedRow.profile_json), id: randomUUID() }) }).where("request_id", "=", mismatched.requestId).execute();
  const mismatchedId = randomUUID();
  const identityRejected = await ai("POST", `/ui/sessions/${sid}/messages`, { id: mismatchedId, modelId: "test", text: "Use this page", captureRequestId: mismatched.requestId });
  expect(identityRejected.statusCode, identityRejected.body).toBe(409);
  expect(identityRejected.json().message).toBe("clipper_profile_changed");
  expect(await db.selectFrom("ai_jobs").select("id").where("id", "=", mismatchedId).executeTakeFirst()).toBeUndefined();
  expect(requests).toEqual([]);

  const current = await prepareMaterial("CURRENT_REVISION_MATERIAL_3196");
  materialId = current.requestId;
  action = "read";
  const acceptedId = randomUUID();
  const accepted = await ai("POST", `/ui/sessions/${sid}/messages`, { id: acceptedId, modelId: "test", text: "Read the current page", captureRequestId: current.requestId });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect((await settle(acceptedId)).status).toBe("completed");
  expect(JSON.stringify(requests)).toContain("CURRENT_REVISION_MATERIAL_3196");
  expect(JSON.stringify(requests)).not.toContain("OLD_REVISION_MATERIAL_8213");
  expect(await db.selectFrom("browser_clipper_receipts").selectAll().where("request_id", "=", previous.requestId).executeTakeFirstOrThrow()).toEqual(retained);
});

for (const tool of ["read", "capture"] as const)
  it(`blocks browser ${tool} tools from reusing another rule revision without exposing or committing the retained receipt`, async () => {
    const material = await prepareMaterial("OLD_REVISION_TOOL_MATERIAL_8031");
    const retained = await db.selectFrom("browser_clipper_receipts").selectAll().where("request_id", "=", material.requestId).executeTakeFirstOrThrow();
    await db.updateTable("browser_clipper_profiles").set({ revision: profile.revision + 1 }).where("id", "=", profile.id).execute();
    profile = { ...profile, revision: profile.revision + 1 };
    materialId = material.requestId;
    action = tool;
    const sid = await session();
    const job = await settle(await send(sid));
    expect(["completed", "failed"]).toContain(job.status);
    expect(JSON.stringify(requests)).not.toContain("OLD_REVISION_TOOL_MATERIAL_8031");
    expect(JSON.stringify(requests) + job.result).toContain("clipper_profile_changed");
    expect(await db.selectFrom("browser_clipper_receipts").selectAll().where("request_id", "=", material.requestId).executeTakeFirstOrThrow()).toEqual(retained);
    expect(JSON.parse(job.result).progress?.approvals ?? []).toEqual([]);
  });

it("records attached pages without granting document access, and only titles the first accepted turn", async () => {
  const sid = await session();
  const material = await prepareMaterial("PAGE_TITLE_AND_LINK_9341");
  const input = { id: randomUUID(), modelId: "test", text: "总结当前网页", captureRequestId: material.requestId };
  const sent = await ai("POST", `/ui/sessions/${sid}/messages`, input);
  expect(sent.statusCode, sent.body).toBe(200);
  await settle(input.id);
  const expectedTitle = "故障排查 · 总结当前网页 (material.example.test)";
  const conversation = await ai("GET", `/ui/sessions/${sid}`);
  expect(conversation.json().session.title).toBe(expectedTitle);
  expect(conversation.json().resources).toEqual([expect.objectContaining({ kind: "webpage", title: "故障排查", href: material.url })]);
  const ordinary = await request("GET", `/ai/sessions/${sid}`);
  expect(ordinary.json().resources).toEqual(conversation.json().resources);
  expect(JSON.parse(conversation.json().session.resource_ids)).not.toContain(material.requestId);
  const retry = await ai("POST", `/ui/sessions/${sid}/messages`, input);
  expect(retry.statusCode, retry.body).toBe(200);
  const another = await prepareMaterial("SAME_PAGE_NEXT_TURN_1093");
  await settle(await send(sid, another.requestId));
  const reread = await ai("GET", `/ui/sessions/${sid}`);
  expect(reread.json().session.title).toBe(expectedTitle);
  expect(reread.json().resources).toHaveLength(1);
  expect((await request("GET", "/ai/sessions")).json()).toContainEqual(expect.objectContaining({ id: sid, title: expectedTitle, source: "browser_assistant" }));
});

it("preserves a manually named browser chat when its first message is submitted", async () => {
  const sid = await session();
  await db.updateTable("ai_sessions").set({ title: "My research" }).where("id", "=", sid).execute();
  await settle(await send(sid));
  expect((await ai("GET", `/ui/sessions/${sid}`)).json().session.title).toBe("My research");
});

it("reads newly created browser sessions before any jobs are bound", async () => {
  const id = await session();
  const basic = await ai("GET", `/sessions/${id}`);
  expect(basic.statusCode, basic.body).toBe(200);
  expect(basic.json().jobs).toEqual([]);
  const shared = await ai("GET", `/ui/sessions/${id}`);
  expect(shared.statusCode, shared.body).toBe(200);
  expect(shared.json()).toMatchObject({
    session: { id },
    jobs: [],
    messages: [],
    operations: [],
  });
  const list = await ai("GET", `/ui/sessions?profileId=${profile.id}`);
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json()).toEqual([
    expect.objectContaining({ id, running: false, awaitingApproval: false }),
  ]);
});

it("serves the shared chat UI real history through the connection boundary only", async () => {
  const created = await ai("POST", "/ui/sessions", {
    profileId: profile.id,
    profileRevision: profile.revision,
  });
  expect(created.statusCode, created.body).toBe(200);
  const sid = created.json().id;
  expect(created.json()).toMatchObject({
    source: "browser_assistant",
    resource_ids: expect.any(String),
    model_id: null,
    archived: 0,
  });
  const options = await ai("GET", "/ui/options");
  expect(options.json()).toMatchObject({
    enabled: true,
    memoryAvailable: false,
    webSearchAvailable: false,
    uploadLimits: expect.any(Object),
    preferences: expect.any(Object),
    models: [
      expect.objectContaining({ id: "test", vision: false, inputRate: 1 }),
    ],
  });
  expect(options.body).not.toContain("synthetic-model-key");
  const jobId = randomUUID();
  const sent = await ai("POST", `/ui/sessions/${sid}/messages`, {
    id: jobId,
    modelId: "test",
    text: "只在对话中总结材料。",
    captureRequestId: null,
  });
  expect(sent.statusCode, sent.body).toBe(200);
  expect((await settle(jobId)).status).toBe("completed");
  const detail = await ai("GET", `/ui/sessions/${sid}?page=0`);
  expect(detail.statusCode, detail.body).toBe(200);
  const ordinary = (await request("GET", `/ai/sessions/${sid}`)).json();
  const { browserProfile, ...browserConversation } = detail.json();
  expect(browserProfile).toEqual({ id: profile.id, revision: profile.revision });
  expect({ ...browserConversation, messages: ordinary.messages }).toEqual(ordinary);
  expect(detail.json().messages.find((message: any) => message.id === jobId).text).toBe("只在对话中总结材料。");
  expect(ordinary.messages.find((message: any) => message.id === jobId).text).toContain("当前收录方案：");
  expect(
    detail
      .json()
      .messages.some(
        (message: any) =>
          message.role === "assistant" && message.text.includes("检查电源"),
      ),
  ).toBe(true);
  expect(
    detail
      .json()
      .jobs.some((job: any) => job.id === jobId && job.status === "completed"),
  ).toBe(true);
  expect(detail.json().contextTokens).toBeGreaterThan(0);
  expect((await ai("GET", `/ui/sessions/${sid}?page=-1`)).statusCode).toBe(400);
  const list = await ai("GET", "/ui/sessions");
  expect(list.json()).toEqual([
    expect.objectContaining({
      id: sid,
      source: "browser_assistant",
      running: false,
    }),
  ]);
  expect(
    (await ai("GET", `/ui/sessions?profileId=${profile.id}`)).json(),
  ).toHaveLength(1);
  expect(
    (await ai("GET", `/ui/sessions?profileId=${randomUUID()}`)).json(),
  ).toEqual([]);
  expect((await ai("GET", "/ui/sessions?profileId=invalid")).statusCode).toBe(
    400,
  );
  const website = await request("POST", "/ai/sessions", {
    title: "Website only",
  });
  expect(
    (await ai("GET", `/ui/sessions/${website.json().id}`)).statusCode,
  ).toBe(404);
  expect(
    (await request("GET", "/browser-clipper/assistant/ui/options")).statusCode,
  ).toBe(401);
  expect(
    (
      await ai("POST", `/ui/sessions/${sid}/messages`, {
        id: randomUUID(),
        modelId: "test",
        text: "Invalid extra scope",
        captureRequestId: null,
        references: [{ id: forbiddenId }],
      })
    ).statusCode,
  ).toBe(400);

  const originalToken = token,
    verifier = randomBytes(32).toString("hex");
  const auth = await request("POST", "/me/browser-clipper/authorize", {
    version: 2,
    installationId: randomUUID(),
    challenge: createHash("sha256").update(verifier).digest("hex"),
  });
  const activation = await request(
    "POST",
    "/browser-clipper/token",
    { version: 2, code: auth.json().code, verifier },
    true,
  );
  expect(activation.statusCode, activation.body).toBe(200);
  token = activation.json().token;
  expect((await ai("GET", "/ui/sessions")).json()).toEqual([]);
  expect((await ai("GET", `/ui/sessions/${sid}`)).statusCode).toBe(404);
  expect((await ai("POST", `/ui/jobs/${jobId}/cancel`, {})).statusCode).toBe(
    404,
  );
  expect(
    (
      await ai("POST", `/ui/jobs/${jobId}/approval`, {
        approvalId: randomUUID(),
        approved: true,
      })
    ).statusCode,
  ).toBe(404);
  token = originalToken;
  await db
    .updateTable("browser_clipper_profiles")
    .set({ revision: profile.revision + 1 })
    .where("id", "=", profile.id)
    .execute();
  expect((await ai("GET", "/ui/sessions")).json()).toEqual([]);
  expect((await ai("GET", `/ui/sessions/${sid}`)).statusCode).toBe(409);
  await db
    .updateTable("browser_clipper_connections")
    .set({ revoked_at: new Date().toISOString() })
    .where("id", "=", connectionId)
    .execute();
  expect((await ai("GET", "/ui/options")).statusCode).toBe(401);
  expect((await ai("GET", "/ui/sessions")).statusCode).toBe(401);
});
it("keeps website continuation messages, plans, operations, calls and events outside browser history and model context", async () => {
  const sid = await session();
  const browserJob = await send(sid);
  expect((await settle(browserJob)).status).toBe("completed");
  const websiteJob = randomUUID(), secret = "WEBSITE_ONLY_SECRET_7451";
  const website = await request("POST", `/ai/sessions/${sid}/messages`, {
    id: websiteJob, modelId: "test", text: secret,
    scope: "all", references: [{ resourceId: forbiddenId, label: secret }],
  });
  expect(website.statusCode, website.body).toBe(200);
  expect((await settle(websiteJob)).status).toBe("completed");
  const websiteRow = await db.selectFrom("ai_jobs").selectAll().where("id", "=", websiteJob).executeTakeFirstOrThrow();
  const approvalId = randomUUID();
  const websiteResult = { ...JSON.parse(websiteRow.result), progress: { ...JSON.parse(websiteRow.result).progress,
    plan: { title: secret, steps: [] }, approvals: [{ id: approvalId, state: "pending" }],
  } };
  await db.updateTable("ai_jobs").set({ status: "awaiting_approval", result: JSON.stringify(websiteResult) }).where("id", "=", websiteJob).execute();
  await db.updateTable("ai_calls").set({ input_tokens: 999999 }).where("job_id", "=", websiteJob).execute();
  await db.insertInto("ai_operations").values({ id: randomUUID(), user_id: actor.id, job_id: websiteJob,
    digest: secret, result: JSON.stringify({ kind: "website_only", text: secret }), created_at: new Date().toISOString() }).execute();
  const detail = await ai("GET", `/ui/sessions/${sid}`);
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.body).not.toContain(secret);
  expect(detail.body).not.toContain(websiteJob);
  expect(detail.json().contextTokens).toBe(100);
  expect((await request("GET", `/ai/sessions/${sid}`)).body).toContain(secret);
  expect((await ai("GET", `/sessions/${sid}`)).body).not.toContain(websiteJob);
  expect((await ai("GET", `/sessions/${sid}/events`)).body).not.toContain(secret);
  expect((await ai("GET", `/sessions/${sid}/events`)).body).not.toContain(websiteJob);
  expect((await ai("GET", "/ui/sessions")).json()).toEqual([expect.objectContaining({ running: false, awaitingApproval: false })]);
  expect((await ai("POST", `/ui/jobs/${websiteJob}/cancel`)).statusCode).toBe(404);
  expect((await ai("POST", `/ui/jobs/${websiteJob}/approval`, { approvalId, approved: true })).statusCode).toBe(404);
  expect((await db.selectFrom("ai_jobs").select("status").where("id", "=", websiteJob).executeTakeFirstOrThrow()).status).toBe("awaiting_approval");
  // Website execution has already saved the secret and its complete historical
  // prompt context. A later browser turn must not replay either projection.
  requests.length = 0;
  const laterBrowserJob = await send(sid);
  expect((await settle(laterBrowserJob)).status).toBe("completed");
  expect(JSON.stringify(requests)).not.toContain(secret);
  expect(JSON.stringify(requests)).not.toContain("UNRELATED_PRIVATE_CONTENT_9327");
  expect((await ai("GET", `/ui/sessions/${sid}`)).body).not.toContain(secret);
});

it.each(["submit", "cancel", "approval"] as const)("revalidates connection, token and profile under the user lock before %s", async operation => {
  const sid = await session();
  const jobId = await send(sid);
  expect((await settle(jobId)).status).toBe("completed");
  const approvalId = randomUUID();
  await db.updateTable("ai_jobs").set({ status: "awaiting_approval", result: JSON.stringify({ progress: { approvals: [{ id: approvalId, state: "pending" }] } }) }).where("id", "=", jobId).execute();
  const before = await db.selectFrom("ai_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  const lock = aiConfigModule.lockAIUser;
  for (const changed of ["connection", "token", "profile"] as const) {
    const pendingId = randomUUID();
    const spy = vi.spyOn(aiConfigModule, "lockAIUser").mockImplementationOnce(async (tx, userId) => {
      await lock(tx, userId);
      // Change the authoritative current record at the lock boundary, after the
      // route's optimistic preflight. Rejection must occur before any job write.
      if (changed === "connection") await tx.updateTable("browser_clipper_connections").set({ revoked_at: new Date().toISOString() }).where("id", "=", connectionId).execute();
      if (changed === "token") await tx.updateTable("browser_clipper_web_sessions").set({ expires_at: "2000-01-01T00:00:00.000Z" }).where("connection_id", "=", connectionId).execute();
      if (changed === "profile") await tx.updateTable("browser_clipper_profiles").set({ revision: profile.revision + 1 }).where("id", "=", profile.id).execute();
    });
    const result = operation === "submit"
      ? await ai("POST", `/ui/sessions/${sid}/messages`, { id: pendingId, modelId: "test", text: "Should not submit", captureRequestId: null })
      : await ai("POST", `/ui/jobs/${jobId}/${operation}`, operation === "approval" ? { approvalId, approved: true } : undefined);
    expect(result.statusCode, result.body).toBe(changed === "profile" ? 409 : 401);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await db.selectFrom("ai_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow()).toEqual(before);
    expect(await db.selectFrom("ai_jobs").select("id").where("id", "=", pendingId).executeTakeFirst()).toBeUndefined();
  }
});

it("reconciles an older bound pending ID beyond both ordinary history and recent-job pages without exposing an unbound ID", async () => {
  const sid = await session(), firstId = await send(sid);
  const first = await settle(firstId);
  expect(first.status).toBe("completed");
  const ids = Array.from({ length: 31 }, () => randomUUID());
  const inputText = "Later synthetic message";
  for (const [index, id] of ids.entries()) {
    const now = new Date(Date.now() + 1000 + index).toISOString();
    await db.insertInto("ai_jobs").values({ ...first, id, input: JSON.stringify({ ...JSON.parse(first.input), text: inputText }),
      digest: captureHash({ id, modelId: "test", text: inputText, captureRequestId: null }), created_at: now, updated_at: now }).execute();
  }
  await db.updateTable("browser_clipper_assistant_sessions").set({ job_ids: JSON.stringify({ version: 1, ids: [firstId, ...ids] }) }).where("session_id", "=", sid).execute();
  const memory = await createAIMemory({ driver: "sqlite", url: join(root, "memory.sqlite") });
  try {
    await memory.memory.saveMessages({ messages: ids.map((id, index) => ({ id, threadId: sid, resourceId: memoryOwner(actor.id), role: "user" as const,
      createdAt: new Date(Date.now() + 1000 + index), content: { format: 2 as const, parts: [{ type: "text" as const, text: inputText }] } })) });
  } finally { await memory.close(); }
  const normal = (await ai("GET", `/ui/sessions/${sid}`)).json();
  expect(normal.jobs.some((job: any) => job.id === firstId)).toBe(false);
  expect(normal.messages.some((message: any) => message.id === firstId)).toBe(false);
  const pending = await ai("GET", `/ui/sessions/${sid}?pendingId=${firstId}`);
  expect(pending.statusCode, pending.body).toBe(200);
  expect(pending.json().jobs.some((job: any) => job.id === firstId)).toBe(true);
  expect(pending.json().messages.find((message: any) => message.id === firstId).text).toBe("只在对话中总结材料，不创建文件。");
  const website = await request("GET", `/ai/sessions/${sid}?pendingId=${firstId}`);
  expect(website.statusCode, website.body).toBe(200);
  expect(website.json().messages.find((message: any) => message.id === firstId).text).toBe(JSON.parse(first.input).text);
  expect((await ai("GET", `/ui/sessions/${sid}?pendingId=invalid`)).statusCode).toBe(400);
  const unknown = (await ai("GET", `/ui/sessions/${sid}?pendingId=${randomUUID()}`)).json();
  expect(unknown.jobs.some((job: any) => job.id === firstId)).toBe(false);
});

it("runs the same personal assistant with paged explicit browser materials and a restricted tool catalog", async () => {
  materialId = randomUUID();
  action = "read";
  const material = {
    version: 1,
    requestId: materialId,
    profileId: profile.id,
    profileRevision: profile.revision,
    mode: "selection",
    url: "https://material.example.test/post",
    title: "故障排查",
    capturedAt: new Date().toISOString(),
    markdown: "## 现象\n设备无法启动。\n\n## 排查\n检查电源。",
    images: [],
  };
  expect(
    (await request("POST", "/browser-clipper/clips", material, true))
      .statusCode,
  ).toBe(200);
  const sid = await session(),
    job = await settle(await send(sid, materialId));
  expect(job.status, job.error).toBe("completed");
  expect(job.result).toContain("检查电源");
  const catalog = requests.find((body) =>
    body.tools?.some(
      (tool: any) => tool.function?.name === "browser_material_read",
    ),
  );
  expect(catalog).toBeDefined();
  const names = catalog.tools.map((tool: any) => tool.function.name);
  expect(names).toContain("browser_capture");
  expect(names).not.toContain("http_request");
  expect(names).not.toContain("secret_write");
  expect(names).not.toContain("knowledge_book");
  expect(JSON.stringify(requests)).not.toContain(
    "UNRELATED_PRIVATE_CONTENT_9327",
  );
  expect((await request("GET", `/ai/sessions/${sid}`)).statusCode).toBe(200);
  const options = await ai("GET", "/options");
  expect(options.statusCode).toBe(200);
  expect(options.body).not.toContain("synthetic-model-key");
  const eventPage = await ai("GET", `/sessions/${sid}/events`);
  expect(eventPage.json().events.length).toBeGreaterThan(0);
  expect(
    await db
      .selectFrom("ai_calls")
      .select("id")
      .where("job_id", "=", job.id)
      .execute(),
  ).not.toHaveLength(0);
});
it("denies document tools outside the selected profile even when the Doca account itself can read the document", async () => {
  action = "forbidden";
  const sid = await session(),
    job = await settle(await send(sid));
  expect(["completed", "failed"]).toContain(job.status);
  expect(JSON.stringify(requests)).not.toContain(
    "UNRELATED_PRIVATE_CONTENT_9327",
  );
  expect((await readAIDocument(db, { actor }, forbiddenId)).value).toContain(
    "UNRELATED_PRIVATE_CONTENT_9327",
  );
});
it("revokes an in-flight browser task promptly while retaining the same conversation for ordinary Doca use", async () => {
  action = "delay";
  const sid = await session(),
    id = await send(sid);
  const deadline = Date.now() + 7000;
  while (!requests.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(requests.length).toBeGreaterThan(0);
  const current = (await request("GET", "/me/browser-clipper/connections"))
    .json()
    .items.find((row: any) => row.id === connectionId);
  expect(
    (
      await request(
        "POST",
        `/me/browser-clipper/connections/${connectionId}/revoke`,
        { revision: current.revision },
      )
    ).statusCode,
  ).toBe(200);
  const stopped = await settle(id);
  expect(stopped.status).toBe("cancelled");
  expect(stopped.cancelled).toBe(1);
  expect((await ai("GET", `/sessions/${sid}`)).statusCode).toBe(401);
  expect((await request("GET", `/ai/sessions/${sid}`)).statusCode).toBe(200);
  action = "plain";
  const websiteId = randomUUID(),
    continued = await request("POST", `/ai/sessions/${sid}/messages`, {
      id: websiteId,
      text: "继续解释",
      modelId: "test",
      scope: "all",
    });
  expect(continued.statusCode, continued.body).toBe(200);
  expect((await settle(websiteId)).status).toBe("completed");
});

it("cancels a running browser AI job when its website session logs out", async () => {
  action = "delay";
  const sid = await session(),
    id = await send(sid);
  const deadline = Date.now() + 7000;
  while (!requests.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(requests.length).toBeGreaterThan(0);
  expect((await request("POST", "/auth/logout", {})).statusCode).toBe(200);
  const job = await settle(id);
  expect(job.status).toBe("cancelled");
  expect(job.cancelled).toBe(1);
  expect((await ai("GET", `/sessions/${sid}`)).statusCode).toBe(401);
});
