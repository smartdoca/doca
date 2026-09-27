import { requireSecurity } from "@core/modules/identity/security.js";
import type { FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import { tokenHash } from "@core/modules/identity/passwords.js";
import type { DB } from "@db/index.js";
import { fail } from "@core/shared/errors.js";
export type AccountContext = {
  providerReady?: (ref: string) => boolean;
  origin: URL;
  actor: (r: FastifyRequest) => Actor | null;
  authenticated: (r: FastifyRequest) => Actor;
  admin: (r: FastifyRequest) => Actor;
  sessionToken: (r: FastifyRequest) => string | null;
  cookie: (s: string) => string;
  limit: (key: string, max?: number) => Promise<void>;
};
export function readCookie(req: FastifyRequest, name: string) {
  const v = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
  return v && /^[a-f0-9]{64}$/.test(v) ? v : null;
}
export const accountBinding = (req: FastifyRequest) =>
  tokenHash(readCookie(req, "doca_account_flow") ?? "");
export const accountCookie = (
  ctx: AccountContext,
  name: string,
  value: string,
  age = 600,
) =>
  `${name}=${value}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${age}${ctx.origin.protocol === "https:" ? "; Secure" : ""}`;
export async function recentAccount(
  db: DB,
  ctx: AccountContext,
  req: FastifyRequest,
) {
  const a = ctx.authenticated(req);
  await requireSecurity(db, a.id, tokenHash(ctx.sessionToken(req)!));
  return a;
}
