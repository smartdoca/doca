import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createApp } from "../apps/server/src/app/create-app.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { createMemoryStalwart, type StalwartMail } from "../apps/server/src/adapters/stalwart.js";
import { defaultMailSettings, publicMailSettings } from "@core/modules/mail/settings.js";

const origin = "http://localhost:39140";
const password = "test-only-password-2026";
let db: DB;
let app: Awaited<ReturnType<typeof createApp>>;
let directory = "";
let adminCookie = "";
let aliceCookie = "";
let bobCookie = "";
let aliceId = "";
let bobId = "";
let mailClient: StalwartMail;

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  cookie: string,
  payload?: unknown,
) {
  return (app.inject as any)({
    method,
    url: "/api/v1" + path,
    headers: {
      host: "localhost:39140",
      origin,
      cookie,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload }),
  }) as Promise<any>;
}

async function login(loginName: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost:39140", origin },
    payload: { login: loginName, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

beforeEach(async () => {
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "doca-mail-test-"));
  db = await openTestDatabase({
    driver: "sqlite",
    path: join(directory, "test.db"),
  });
  const admin = await createUser(
    db,
    { login: "admin", displayName: "管理员", password },
    { bootstrap: true },
  );
  const alice = await createUser(
    db,
    { login: "alice", displayName: "Alice", password },
    { actor: { ...admin, admin: 1 } as Actor },
  );
  const bob = await createUser(
    db,
    { login: "bob", displayName: "Bob", password },
    { actor: { ...admin, admin: 1 } as Actor },
  );
  aliceId = alice.id;
  bobId = bob.id;
  mailClient = createMemoryStalwart();
  app = await createApp(db, {
    origin,
    storage: {
      root: join(directory, "uploads"),
      credentials: {},
      endpointHosts: [],
      cdnKeyPairId: undefined,
      cdnPrivateKey: undefined,
    },
    mail: { client: mailClient },
  });
  adminCookie = await login("admin");
  aliceCookie = await login("alice");
  bobCookie = await login("bob");
});

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function enableMail(mode: "free" | "independent", maxMailboxes = 2) {
  const current = await request("GET", "/admin/mail", adminCookie);
  expect(current.statusCode).toBe(200);
  const saved = await request("PUT", "/admin/mail", adminCookie, {
    revision: current.json().revision,
    config: {
      enabled: true,
      endpoint: "http://127.0.0.1:8080",
      domain: "heyphp.com",
      mode,
      maxMailboxes,
      username: "admin",
      token: "token",
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json();
}

it("treats an enabled domain without Stalwart as a mock backend", () => {
  expect(
    publicMailSettings({
      ...defaultMailSettings,
      enabled: true,
      domain: "heyphp.com",
    }),
  ).toMatchObject({ configured: true, mock: true });
});

it("seeds demo folders and messages in the memory backend", async () => {
  const client = createMemoryStalwart({ seed: true });
  await client.createAccount({
    name: "demo@heyphp.com",
    address: "demo@heyphp.com",
    secret: "secret",
  });
  const folders = await client.listFolders("demo@heyphp.com");
  const inbox = folders.find((item) => item.role === "inbox");
  expect(inbox?.total).toBeGreaterThan(3);
  expect(inbox?.unread).toBeGreaterThan(0);
  const page = await client.listMessages("demo@heyphp.com", { folderId: inbox?.id });
  expect(page.items.some((item) => item.starred)).toBe(true);
  expect(page.items.some((item) => item.hasAttachments)).toBe(true);
});

it("lets admins configure Stalwart and keeps the token masked", async () => {
  const saved = await enableMail("free");
  expect(saved.config.domain).toBe("heyphp.com");
  expect(saved.config.token).toBeNull();
  expect(saved.public.configured).toBe(true);
});

it("provisions a locked personal mailbox in independent mode", async () => {
  await enableMail("independent");
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().mailboxes).toHaveLength(1);
  const mailbox = page.json().mailboxes[0];
  expect(mailbox.address).toBe("alice@heyphp.com");
  expect(mailbox.locked).toBe(true);
  expect(mailbox.shareable).toBe(false);
  expect(mailbox.deletable).toBe(false);
  const apply = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "alice-extra",
  });
  expect(apply.statusCode).toBe(400);
  const share = await request("PUT", `/mail/mailboxes/${mailbox.id}/shares`, aliceCookie, {
    userId: bobId,
    role: "reader",
  });
  expect(share.statusCode).toBe(400);
  const shared = await request("POST", "/admin/mail/shared", adminCookie, { localPart: "team" });
  expect(shared.statusCode, shared.body).toBe(200);
  const granted = await request("PUT", `/mail/mailboxes/${shared.json().id}/shares`, adminCookie, {
    userId: aliceId,
    role: "reader",
  });
  expect(granted.statusCode, granted.body).toBe(200);
  const listed = await request("GET", "/mail", aliceCookie);
  expect(listed.json().mailboxes.map((item: { address: string }) => item.address)).toEqual([
    "alice@heyphp.com",
    "team@heyphp.com",
  ]);
  const stored = await db
    .selectFrom("mailboxes")
    .select(["address", "backend_user_id", "secret"])
    .where("deleted_at", "is", null)
    .execute();
  expect(stored.every((item) => item.secret && item.backend_user_id)).toBe(true);
  expect(new Set(stored.map((item) => item.backend_user_id)).size).toBe(stored.length);
});

it("keeps listed mail in durable storage for later reads and search", async () => {
  await enableMail("free");
  const created = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "store",
    displayName: "存储邮箱",
  });
  expect(created.statusCode, created.body).toBe(200);
  const mailbox = created.json();
  const sent = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: mailbox.address,
    subject: "对账入库",
    text: "这封信会长期保存在 Doca 里供检索。",
  });
  expect(sent.statusCode, sent.body).toBe(200);
  expect(sent.json().receipt.subject).toBe("发送成功：对账入库");
  expect(sent.json().receipt.text).toContain("发送成功");
  const first = await request("GET", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie);
  expect(first.json().items.some((item: { subject: string }) => item.subject === "对账入库")).toBe(true);
  expect(first.json().items.some((item: { subject: string }) => item.subject === "发送成功：对账入库")).toBe(true);
  const failed = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: "not-an-email",
    subject: "失败回执",
    text: "这封不会发出去。",
  });
  expect(failed.statusCode).toBe(400);
  expect(failed.json().message).toBeTruthy();
  expect(failed.json().receipt.subject).toBe("发送失败：失败回执");
  expect(failed.json().receipt.text).toContain(failed.json().message);
  const stored = await db
    .selectFrom("mail_messages")
    .select(["subject", "body_text", "body_ready"])
    .where("mailbox_id", "=", mailbox.id)
    .execute();
  expect(stored.some((item) => item.subject === "对账入库" && item.body_ready === 1)).toBe(true);
  const second = await request("GET", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie);
  expect(second.json().items.some((item: { subject: string }) => item.subject === "对账入库")).toBe(true);
  const found = await request("GET", "/mail/search?q=长期保存在", aliceCookie);
  const hit = found.json().items.find((item: { subject: string }) => item.subject === "对账入库");
  expect(hit).toBeTruthy();
  expect(hit.remoteId).toBe(sent.json().id);
  expect(hit.mailboxId).toBe(mailbox.id);
  await db
    .updateTable("mail_messages")
    .set({ body_text: "KEEP-BODY", body_ready: 1 })
    .where("mailbox_id", "=", mailbox.id)
    .where("remote_id", "=", sent.json().id)
    .execute();
  const synced = await request("POST", `/mail/mailboxes/${mailbox.id}/sync`, aliceCookie);
  expect(synced.statusCode, synced.body).toBe(200);
  const kept = await db
    .selectFrom("mail_messages")
    .select(["body_text", "body_ready"])
    .where("mailbox_id", "=", mailbox.id)
    .where("remote_id", "=", sent.json().id)
    .executeTakeFirst();
  expect(kept?.body_text).toBe("KEEP-BODY");
  expect(kept?.body_ready).toBe(1);
  const cached = await request(
    "GET",
    `/mail/mailboxes/${mailbox.id}/messages/${sent.json().id}`,
    aliceCookie,
  );
  expect(cached.json().text).toBe("KEEP-BODY");
});

it("deletes mail in batch and removes them from durable storage", async () => {
  await enableMail("free");
  const created = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "batch",
  });
  const mailbox = created.json();
  const first = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: mailbox.address,
    subject: "第一封",
    text: "删我",
  });
  const second = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: mailbox.address,
    subject: "第二封",
    text: "也删我",
  });
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  const removed = await request(
    "POST",
    `/mail/mailboxes/${mailbox.id}/messages/batch-delete`,
    aliceCookie,
    { ids: [first.json().id, second.json().id] },
  );
  expect(removed.statusCode, removed.body).toBe(200);
  expect(removed.json().deleted).toBe(2);
  const leftover = await db
    .selectFrom("mail_messages")
    .select("remote_id")
    .where("mailbox_id", "=", mailbox.id)
    .where("remote_id", "in", [first.json().id, second.json().id])
    .execute();
  expect(leftover).toEqual([]);
});

it("lets users apply, share, send and search mail in free mode", async () => {
  await enableMail("free", 2);
  const empty = await request("GET", "/mail", aliceCookie);
  expect(empty.json().mailboxes).toEqual([]);
  const created = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "support",
    displayName: "支持邮箱",
  });
  expect(created.statusCode, created.body).toBe(200);
  const mailbox = created.json();
  expect(mailbox.address).toBe("support@heyphp.com");
  const bobBox = await request("POST", "/mail/mailboxes", bobCookie, {
    localPart: "bob",
  });
  expect(bobBox.statusCode, bobBox.body).toBe(200);
  await request("PUT", `/mail/mailboxes/${mailbox.id}/shares`, aliceCookie, {
    userId: bobId,
    role: "sender",
  });
  const shares = await request("GET", `/mail/mailboxes/${mailbox.id}/shares`, bobCookie);
  expect(shares.json().role).toBe("sender");
  const sent = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: bobBox.json().address,
    subject: "欢迎加入",
    text: "这是一封测试邮件，请查收预算表。",
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const inbox = await request(
    "GET",
    `/mail/mailboxes/${bobBox.json().id}/messages`,
    bobCookie,
  );
  expect(inbox.json().items.some((item: { subject: string }) => item.subject === "欢迎加入")).toBe(true);
  const found = await request("GET", "/mail/search?q=预算表", bobCookie);
  expect(found.json().items.some((item: { subject: string }) => item.subject === "欢迎加入")).toBe(true);
  const files = await request("GET", "/files?parentType=system&parentId=mail", aliceCookie);
  expect(files.statusCode).toBe(200);
  expect(files.json().folders.some((folder: { name: string }) => folder.name === "support@heyphp.com")).toBe(true);
});

it("lets admins create a shared mailbox in independent mode", async () => {
  await enableMail("independent");
  const created = await request("POST", "/admin/mail/shared", adminCookie, {
    localPart: "team",
    displayName: "团队邮箱",
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json().address).toBe("team@heyphp.com");
  expect(created.json().shareable).toBe(true);
  const listed = await request("GET", "/admin/mail/mailboxes", adminCookie);
  expect(listed.json().items.some((item: { address: string }) => item.address === "team@heyphp.com")).toBe(true);
});

it("stores sent attachments under 系统文件/邮箱系统", async () => {
  await enableMail("free");
  const created = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "files",
  });
  expect(created.statusCode, created.body).toBe(200);
  const mailbox = created.json();
  const sent = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: mailbox.address,
    subject: "附件验收",
    text: "请查收合同。",
    attachments: [
      {
        name: "合同.txt",
        mime: "text/plain",
        data: Buffer.from("合同正文").toString("base64"),
      },
    ],
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const detail = await request(
    "GET",
    `/mail/mailboxes/${mailbox.id}/messages/${sent.json().id}`,
    aliceCookie,
  );
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json().attachments[0].name).toBe("合同.txt");
  expect(detail.json().attachments[0].fileId).toBeTruthy();
  const files = await request(
    "GET",
    `/files?parentType=system&parentId=mail:${mailbox.id}`,
    aliceCookie,
  );
  expect(files.statusCode, files.body).toBe(200);
  expect(files.json().files.some((item: { name: string }) => item.name === "合同.txt")).toBe(true);
  const download = await request(
    "GET",
    `/mail/mailboxes/${mailbox.id}/messages/${sent.json().id}/attachments/${detail.json().attachments[0].id}`,
    aliceCookie,
  );
  expect(download.statusCode, download.body).toBe(200);
  expect(download.body).toContain("合同正文");
});

it("lets owners delete a free-mode mailbox and archive mail", async () => {
  await enableMail("free");
  const created = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "temp",
  });
  const mailbox = created.json();
  const sent = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: mailbox.address,
    subject: "待归档",
    text: "归档我。",
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const folders = await request("GET", `/mail/mailboxes/${mailbox.id}`, aliceCookie);
  const archive = folders.json().folders.find((item: { role: string }) => item.role === "archive");
  expect(archive).toBeTruthy();
  const moved = await request(
    "PATCH",
    `/mail/mailboxes/${mailbox.id}/messages/${sent.json().id}`,
    aliceCookie,
    { folderId: archive.id },
  );
  expect(moved.statusCode, moved.body).toBe(200);
  expect(moved.json().folder).toBe(archive.name);
  const removed = await request("DELETE", `/mail/mailboxes/${mailbox.id}`, aliceCookie);
  expect(removed.statusCode, removed.body).toBe(200);
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.json().mailboxes).toEqual([]);
});

it("rewrites a user-id mailbox to the login address without changing its backend user", async () => {
  await enableMail("independent");
  const address = `${aliceId}@heyphp.com`;
  const created = await mailClient.createAccount({ name: address, address, secret: "kept-secret" });
  const now = new Date().toISOString();
  await db.insertInto("mailboxes").values({
    id: randomUUID(),
    owner_id: aliceId,
    address,
    local_part: aliceId,
    display_name: "Alice",
    kind: "personal",
    locked: 1,
    secret: "kept-secret",
    backend_user_id: created.id,
    source: "internal",
    provider: "",
    knowledge_scope: "starred",
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }).execute();
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().mailboxes.map((item: { address: string }) => item.address)).toEqual([
    "alice@heyphp.com",
  ]);
  const row = await db
    .selectFrom("mailboxes")
    .select(["address", "backend_user_id", "secret"])
    .where("owner_id", "=", aliceId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  expect(row.address).toBe("alice@heyphp.com");
  expect(row.backend_user_id).toBe(created.id);
  expect(row.secret).toBe("kept-secret");
  expect((await mailClient.listFolders("alice@heyphp.com")).some((item) => item.role === "inbox")).toBe(true);
});

it("opens one system mailbox automatically when the cap is one", async () => {
  await enableMail("free", 1);
  const page = await request("GET", "/mail", aliceCookie);
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json().mailboxes.map((item: { address: string }) => item.address)).toEqual([
    "alice@heyphp.com",
  ]);
  expect(page.json().mailboxes[0].locked).toBe(true);
  const second = await request("POST", "/mail/mailboxes", aliceCookie, {
    localPart: "two",
  });
  expect(second.statusCode).toBe(400);
});

it("lets users apply for a unique mailbox name when more than one is allowed", async () => {
  await enableMail("free", 2);
  const empty = await request("GET", "/mail", aliceCookie);
  expect(empty.json().mailboxes).toEqual([]);
  const first = await request("POST", "/mail/mailboxes", aliceCookie, { localPart: "One" });
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().address).toBe("one@heyphp.com");
  const duplicate = await request("POST", "/mail/mailboxes", bobCookie, { localPart: "one" });
  expect(duplicate.statusCode).toBe(409);
  const second = await request("POST", "/mail/mailboxes", aliceCookie, { localPart: "two" });
  expect(second.statusCode, second.body).toBe(200);
  const third = await request("POST", "/mail/mailboxes", aliceCookie, { localPart: "three" });
  expect(third.statusCode).toBe(400);
  const listed = await request("GET", "/mail", aliceCookie);
  expect(listed.json().mailboxes.map((item: { address: string }) => item.address)).toEqual([
    "one@heyphp.com",
    "two@heyphp.com",
  ]);
  const stored = await db
    .selectFrom("mailboxes")
    .select(["address", "backend_user_id", "secret", "owner_id"])
    .where("owner_id", "=", aliceId)
    .where("deleted_at", "is", null)
    .execute();
  expect(stored).toHaveLength(2);
  expect(stored.every((item) => item.secret && item.backend_user_id)).toBe(true);
  expect(new Set(stored.map((item) => item.backend_user_id)).size).toBe(2);
});

it("keeps an unsent mail scratch per mailbox and clears it after send", async () => {
  await enableMail("free", 2);
  const created = await request("POST", "/mail/mailboxes", aliceCookie, { localPart: "scratch" });
  expect(created.statusCode, created.body).toBe(200);
  const mailbox = created.json();
  const key = `mail.draft.${mailbox.id}`;
  const saved = await request("PUT", "/me/page-state", aliceCookie, {
    key,
    version: 0,
    value: { to: "bob@heyphp.com", cc: "", bcc: "", subject: "草稿", text: "还没写完", html: "" },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().item.version).toBe(1);
  const stale = await request("PUT", "/me/page-state", aliceCookie, {
    key,
    version: 0,
    value: { to: "other@heyphp.com", cc: "", bcc: "", subject: "旧的", text: "不要覆盖", html: "" },
  });
  expect(stale.statusCode).toBe(200);
  expect(stale.json().conflict).toBe(true);
  expect(stale.json().item.value.subject).toBe("草稿");
  const loaded = await request("GET", `/me/page-state?key=${encodeURIComponent(key)}`, aliceCookie);
  expect(loaded.json().item.value.text).toBe("还没写完");
  const hidden = await request("GET", `/me/page-state?key=${encodeURIComponent(key)}`, bobCookie);
  expect(hidden.json().item).toBeNull();
  const rejected = await request("PUT", "/me/page-state", aliceCookie, { key: "ui.secret", value: "no" });
  expect(rejected.statusCode).toBe(400);
  const sent = await request("POST", `/mail/mailboxes/${mailbox.id}/messages`, aliceCookie, {
    to: "bob@heyphp.com",
    subject: "发出去了",
    text: "正文",
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const after = await request("GET", `/me/page-state?key=${encodeURIComponent(key)}`, aliceCookie);
  expect(after.json().item).toBeNull();
});
