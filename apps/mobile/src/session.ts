import * as SecureStore from "expo-secure-store";

const indexKey = "doca.mobile.accounts";

export type Session = {
  origin: string;
  token: string;
  name: string;
};

type Index = { current: string; origins: string[] };

function accountKey(origin: string) {
  return `doca.account.${[...origin].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
}

async function readAccount(origin: string) {
  const raw = await SecureStore.getItemAsync(accountKey(origin));
  if (!raw) return null;
  const value = JSON.parse(raw) as Session;
  if (value.origin !== origin || !value.token) return null;
  return value;
}

async function readIndex(): Promise<Index> {
  const raw = await SecureStore.getItemAsync(indexKey);
  return raw ? (JSON.parse(raw) as Index) : { current: "", origins: [] };
}

async function writeIndex(index: Index) {
  await SecureStore.setItemAsync(indexKey, JSON.stringify(index));
}

export async function loadVault() {
  const index = await readIndex();
  const accounts: Session[] = [];
  for (const origin of index.origins) {
    const account = await readAccount(origin);
    if (account) accounts.push(account);
  }
  const origins = accounts.map((account) => account.origin);
  let current = origins.includes(index.current)
    ? index.current
    : (origins[0] ?? "");
  if (current !== index.current || origins.length !== index.origins.length)
    await writeIndex({ current, origins });
  return {
    session: accounts.find((account) => account.origin === current) ?? null,
    accounts,
  };
}

export async function loadSession() {
  return (await loadVault()).session;
}

export async function saveSession(session: Session) {
  const vault = await loadVault();
  await SecureStore.setItemAsync(
    accountKey(session.origin),
    JSON.stringify(session),
  );
  const origins = vault.accounts.some(
    (account) => account.origin === session.origin,
  )
    ? vault.accounts.map((account) => account.origin)
    : [...vault.accounts.map((account) => account.origin), session.origin];
  await writeIndex({ current: session.origin, origins });
}

export async function switchOrigin(origin: string) {
  const vault = await loadVault();
  const next = vault.accounts.find((account) => account.origin === origin);
  if (!next) throw new Error("这个服务器还没有保存的登录");
  await writeIndex({
    current: origin,
    origins: vault.accounts.map((account) => account.origin),
  });
  return next;
}

export async function removeAccount(origin: string) {
  const vault = await loadVault();
  await SecureStore.deleteItemAsync(accountKey(origin));
  const accounts = vault.accounts.filter(
    (account) => account.origin !== origin,
  );
  const current =
    vault.session?.origin === origin
      ? (accounts[0]?.origin ?? "")
      : (vault.session?.origin ?? "");
  await writeIndex({
    current,
    origins: accounts.map((account) => account.origin),
  });
  return accounts.find((account) => account.origin === current) ?? null;
}

export function normalizeOrigin(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed))
    throw new Error("服务器地址需要以 http:// 或 https:// 开头");
  return trimmed;
}
