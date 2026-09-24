import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import {
  independentLocalPart,
  mailboxAddress,
  systemMailboxLocalPart,
} from "@core/modules/mail/addresses.js";
import { parseMailSettings, singleSystemMailbox } from "@core/modules/mail/settings.js";
import type { Schema } from "@db/schema.js";
import { createMemoryStalwart, mailboxSecret, type StalwartMail } from "../adapters/stalwart.js";
import { createHttpWildduck } from "../adapters/wildduck-http.js";

type MailboxDb = Kysely<Schema>;

async function backendFor(db: MailboxDb, client?: StalwartMail) {
  if (client) return client;
  const row = await db
    .selectFrom("mail_settings")
    .select("config")
    .where("id", "=", "system")
    .executeTakeFirst();
  const config = parseMailSettings(row?.config);
  if (!singleSystemMailbox(config)) return null;
  if (config.endpoint) return createHttpWildduck(config);
  return createMemoryStalwart();
}

async function renameGeneratedMailbox(
  db: MailboxDb,
  backend: StalwartMail,
  mailbox: Schema["mailboxes"],
  localPart: string,
  domain: string,
  displayName: string,
) {
  const address = mailboxAddress(localPart, domain);
  if (mailbox.address === address) return mailbox;
  const taken = await db
    .selectFrom("mailboxes")
    .select("id")
    .where("address", "=", address)
    .executeTakeFirst();
  if (taken && taken.id !== mailbox.id) return mailbox;
  try {
    const userId = mailbox.backend_user_id || (await backend.resolveAccount(mailbox.address)).id;
    if (!userId) return mailbox;
    await backend.updateAccount({
      userId,
      address,
      name: displayName || mailbox.display_name,
    });
    const now = new Date().toISOString();
    await db
      .updateTable("mailboxes")
      .set({
        address,
        local_part: localPart,
        backend_user_id: userId,
        updated_at: now,
      })
      .where("id", "=", mailbox.id)
      .execute();
    return { ...mailbox, address, local_part: localPart, backend_user_id: userId, updated_at: now };
  } catch {
    return mailbox;
  }
}

async function rememberBackendUser(
  db: MailboxDb,
  backend: StalwartMail,
  mailbox: Schema["mailboxes"],
) {
  if (mailbox.backend_user_id) {
    backend.bindAccount({ address: mailbox.address, userId: mailbox.backend_user_id });
    return mailbox;
  }
  try {
    const resolved = await backend.resolveAccount(mailbox.address);
    if (!resolved.id) return mailbox;
    const now = new Date().toISOString();
    await db
      .updateTable("mailboxes")
      .set({ backend_user_id: resolved.id, updated_at: now })
      .where("id", "=", mailbox.id)
      .execute();
    backend.bindAccount({ address: mailbox.address, userId: resolved.id });
    return { ...mailbox, backend_user_id: resolved.id, updated_at: now };
  } catch {
    return mailbox;
  }
}

export async function ensureSystemMailbox(
  db: MailboxDb,
  user: { id: string; displayName?: string },
  client?: StalwartMail,
) {
  const row = await db
    .selectFrom("mail_settings")
    .select("config")
    .where("id", "=", "system")
    .executeTakeFirst();
  const config = parseMailSettings(row?.config);
  if (!singleSystemMailbox(config)) return null;
  const account = await db
    .selectFrom("users")
    .select(["id", "login", "public_id", "display_name"])
    .where("id", "=", user.id)
    .executeTakeFirst();
  if (!account) return null;
  const localPart = independentLocalPart(account);
  const owned = await db
    .selectFrom("mailboxes")
    .selectAll()
    .where("owner_id", "=", user.id)
    .where("source", "=", "internal")
    .where("deleted_at", "is", null)
    .execute();
  const generated = systemMailboxLocalPart(user.id);
  let existing =
    owned.find((item) => item.kind === "personal") ??
    owned.find((item) => item.local_part === localPart || item.local_part === generated) ??
    owned[0];
  const backend = await backendFor(db, client);
  if (existing && backend && (existing.local_part === generated || existing.local_part === user.id.toLowerCase()))
    existing = await renameGeneratedMailbox(db, backend, existing, localPart, config.domain, account.display_name);
  if (existing && backend && !existing.backend_user_id)
    existing = await rememberBackendUser(db, backend, existing);
  if (existing) return existing;
  if (!backend) return null;
  const address = mailboxAddress(localPart, config.domain);
  const taken = await db
    .selectFrom("mailboxes")
    .select("id")
    .where("address", "=", address)
    .executeTakeFirst();
  if (taken) return null;
  const secret = mailboxSecret();
  await backend.ensureDomain(config.domain);
  const created = await backend.createAccount({
    name: user.displayName?.trim() || account.display_name || address,
    address,
    secret,
  });
  const now = new Date().toISOString();
  const mailbox: Schema["mailboxes"] = {
    id: randomUUID(),
    owner_id: user.id,
    address,
    local_part: localPart,
    display_name: user.displayName?.trim() || account.display_name || address,
    kind: "personal",
    locked: 1,
    secret,
    backend_user_id: created.id,
    source: "internal",
    provider: "",
    knowledge_scope: "starred",
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db.insertInto("mailboxes").values(mailbox).execute();
  return mailbox;
}

export async function provisionSystemMailbox(
  db: MailboxDb,
  user: { id: string; displayName?: string },
  client?: StalwartMail,
) {
  try {
    await ensureSystemMailbox(db, user, client);
  } catch {
    // 打开邮箱时会再用同一套后端重试，注册不能因为邮箱服务暂时不可用而失败。
  }
}
