import { fail } from "../../shared/errors.js";

const localPartPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const domainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeLocalPart(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function validLocalPart(value: string) {
  const local = normalizeLocalPart(value);
  return (
    local.length >= 1 &&
    local.length <= 64 &&
    localPartPattern.test(local) &&
    !local.includes("..")
  );
}

export function validDomain(value: string) {
  const domain = normalizeDomain(value);
  return domain.length >= 4 && domain.length <= 253 && domainPattern.test(domain);
}

export function requireLocalPart(value: string) {
  const local = normalizeLocalPart(value);
  if (!validLocalPart(local))
    fail(400, "邮件名只能使用小写字母、数字、点、下划线和短横线");
  return local;
}

export function requireDomain(value: string) {
  const domain = normalizeDomain(value);
  if (!validDomain(domain)) fail(400, "请填写有效的顶级域名，例如 heyphp.com");
  return domain;
}

export function mailboxAddress(localPart: string, domain: string) {
  return `${requireLocalPart(localPart)}@${requireDomain(domain)}`;
}

export function sanitizeLocalPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 64);
}

export function systemMailboxLocalPart(userId: string) {
  const id = userId.trim().toLowerCase();
  if (validLocalPart(id)) return id;
  const compact = `u${id.replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
  return validLocalPart(compact) ? compact : "user";
}

export function independentLocalPart(user: {
  id: string;
  login: string;
  public_id?: string | null;
}) {
  const fallback = `u${user.id.replace(/-/g, "").slice(0, 12)}`;
  for (const raw of [user.public_id, user.login, fallback]) {
    if (!raw) continue;
    const cleaned = sanitizeLocalPart(raw);
    if (validLocalPart(cleaned)) return cleaned;
  }
  return fallback;
}

export function parseAddresses(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return [
    ...new Set(
      raw
        .split(/[,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function validEmailAddress(value: string) {
  const [local, domain] = value.split("@");
  return !!local && !!domain && validLocalPart(local) && validDomain(domain);
}
