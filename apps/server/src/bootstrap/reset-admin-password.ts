import { openDatabase } from "@db/index.js";
import { resetAdminPassword } from "@core/modules/identity/passwords.js";
import { config } from "./config.js";

const identifier = process.env.DOCA_RESET_ADMIN_LOGIN,
  password = process.env.DOCA_RESET_ADMIN_PASSWORD;
if (!identifier || !password)
  throw new Error(
    "Set DOCA_RESET_ADMIN_LOGIN and DOCA_RESET_ADMIN_PASSWORD in your terminal; no password is printed or stored in environment files",
  );

const db = await openDatabase(config().database);
try {
  const result = await resetAdminPassword(db, identifier, password);
  process.stdout.write(`管理员密码已重置：${result.username}\n`);
} finally {
  await db.destroy();
}
