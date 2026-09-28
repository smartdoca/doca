import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { DB } from "../../../../db/src/index.js";
import { transact } from "../../../../db/src/transactions.js";
import { fail } from "../../shared/errors.js";
import { normalizeContact } from "./accounts.js";
import { tokenHash } from "./passwords.js";
export const flowToken = () => randomBytes(32).toString("hex");
export async function contactProofs(
  db: DB,
  tokens: Partial<Record<"email" | "phone", string>> | undefined,
  binding: string,
  purpose: string,
  userId: string | null = null,
) {
  const values: Partial<Record<"email" | "phone", string>> = {};
  for (const kind of ["email", "phone"] as const) {
    const token = tokens?.[kind];
    if (!token) continue;
    const row = await db
      .selectFrom("account_flows")
      .selectAll()
      .where("id", "=", tokenHash(token))
      .where("kind", "=", "contact-proof")
      .where("expires_at", ">", new Date().toISOString())
      .executeTakeFirst();
    if (!row) fail(400, "验证结果已过期或已使用");
    const d = JSON.parse(row.data);
    if (
      d.binding !== binding ||
      d.kind !== kind ||
      d.purpose !== purpose ||
      row.user_id !== userId
    )
      fail(403, "验证结果不属于当前操作");
    values[kind] = d.value;
    await db.deleteFrom("account_flows").where("id", "=", row.id).execute();
  }
  return values;
}
export function createVerification(db: DB, secret: string | (() => string)) {
  const digest = (id: string, code: string) =>
    createHmac("sha256", typeof secret === "function" ? secret() : secret)
      .update(id + ":" + code)
      .digest("hex");
  return {
    async start(
      input: {
        kind: "email" | "phone";
        value: string;
        purpose: string;
        binding: string;
        userId: string | null;
        ip: string;
      },
      send: (code: string, destination: string) => Promise<void>,
    ) {
      if (!(typeof secret === "function" ? secret() : secret)) fail(503, "验证码服务尚未配置");
      const value = normalizeContact(input.kind, input.value),
        id = flowToken(),
        code = String(randomInt(100000, 1000000)),
        now = new Date().toISOString();
      await transact(db, async (tx) => {
        const since = new Date(Date.now() - 3600000).toISOString();
        const recent = await tx
          .selectFrom("verification_challenges")
          .select(["created_at"])
          .where("destination", "=", value)
          .where("created_at", ">", since)
          .orderBy("created_at", "desc")
          .execute();
        if (
          recent.length >= 5 ||
          (recent[0] && Date.parse(recent[0].created_at) > Date.now() - 60000)
        )
          fail(429, "验证码发送过于频繁，请稍后再试");
        const rateId =
          "verification:" + tokenHash(input.ip) + ":" + now.slice(0, 13);
        const rate = await tx
          .selectFrom("account_flows")
          .selectAll()
          .where("id", "=", tokenHash(rateId))
          .executeTakeFirst();
        const count = rate ? Number(JSON.parse(rate.data).count) : 0;
        if (count >= 30) fail(429, "验证码请求过于频繁");
        await tx
          .insertInto("account_flows")
          .values({
            id: tokenHash(rateId),
            kind: "rate",
            user_id: null,
            data: JSON.stringify({ count: count + 1 }),
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          })
          .onConflict((oc) =>
            oc
              .column("id")
              .doUpdateSet({ data: JSON.stringify({ count: count + 1 }) }),
          )
          .execute();
        await tx
          .insertInto("verification_challenges")
          .values({
            id,
            binding: input.binding,
            destination: value,
            kind: input.kind,
            purpose: input.purpose,
            digest: digest(id, code),
            attempts: 0,
            consumed: 0,
            created_at: now,
            expires_at: new Date(Date.now() + 300000).toISOString(),
          })
          .execute();
        await tx
          .insertInto("account_flows")
          .values({
            id: tokenHash("challenge:" + id),
            kind: "challenge-owner",
            user_id: input.userId,
            data: "{}",
            expires_at: new Date(Date.now() + 300000).toISOString(),
          })
          .execute();
        await tx
          .deleteFrom("account_flows")
          .where("expires_at", "<", now)
          .execute();
        await tx
          .deleteFrom("verification_challenges")
          .where(
            "expires_at",
            "<",
            new Date(Date.now() - 86400000).toISOString(),
          )
          .execute();
      });
      try {
        await send(code, value);
      } catch {
        await db
          .updateTable("verification_challenges")
          .set({ consumed: 1 })
          .where("id", "=", id)
          .execute();
        fail(503, "验证码发送失败，请稍后再试");
      }
      return { challengeId: id, expiresIn: 300 };
    },
    async verify(id: string, code: string, binding: string) {
      const proof = flowToken();
      const result = await transact(db, async (tx) => {
        const row = await tx
          .selectFrom("verification_challenges")
          .selectAll()
          .where("id", "=", id)
          .where("binding", "=", binding)
          .executeTakeFirst();
        if (
          !row ||
          row.consumed ||
          row.attempts >= 5 ||
          row.expires_at <= new Date().toISOString()
        )
          return false;
        await tx
          .updateTable("verification_challenges")
          .set({ attempts: row.attempts + 1 })
          .where("id", "=", id)
          .execute();
        const correct =
          /^\d{6}$/.test(code) &&
          timingSafeEqual(
            Buffer.from(digest(id, code)),
            Buffer.from(row.digest),
          );
        if (!correct) return false;
        await tx
          .updateTable("verification_challenges")
          .set({ consumed: 1 })
          .where("id", "=", id)
          .execute();
        const owner = await tx
          .selectFrom("account_flows")
          .select("user_id")
          .where("id", "=", tokenHash("challenge:" + id))
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("account_flows")
          .values({
            id: tokenHash(proof),
            kind: "contact-proof",
            user_id: owner.user_id,
            data: JSON.stringify({
              binding,
              kind: row.kind,
              value: row.destination,
              purpose: row.purpose,
            }),
            expires_at: new Date(Date.now() + 600000).toISOString(),
          })
          .execute();
        return { proof, kind: row.kind, value: row.destination };
      });
      if (!result) fail(400, "验证码错误、过期或已使用");
      return result;
    },
  };
}
