import { createUser } from "@core/modules/identity/passwords.js";
import { openDatabase } from "@db/index.js";
import { config } from "./config.js";
const login = process.env.DOCA_BOOTSTRAP_LOGIN?.replace(
    /^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu,
    "",
  ),
  password = process.env.DOCA_BOOTSTRAP_PASSWORD;
if (!login || !password)
  throw new Error(
    "Set DOCA_BOOTSTRAP_LOGIN and DOCA_BOOTSTRAP_PASSWORD in your terminal; there is no default account",
  );
const db = await openDatabase(config().database);
try {
  await createUser(
    db,
    { login, password, displayName: "管理员" },
    { bootstrap: true },
  );
  process.stdout.write("管理员初始化成功，请移除初始化凭证环境变量。\n");
} finally {
  await db.destroy();
}
