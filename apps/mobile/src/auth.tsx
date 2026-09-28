import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { api, login as requestLogin, setUnauthorizedHandler } from "./api";
import { clearQueryCache } from "./query-cache";
import {
  loadVault,
  normalizeOrigin,
  removeAccount,
  saveSession,
  switchOrigin,
  type Session,
} from "./session";

type AuthValue = {
  ready: boolean;
  session: Session | null;
  accounts: Session[];
  refresh: () => Promise<{ session: Session | null; accounts: Session[] }>;
  signIn: (origin: string, loginName: string, password: string, destination?: "back") => Promise<void>;
  switchServer: (origin: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [accounts, setAccounts] = useState<Session[]>([]);

  const applyVault = useCallback(async () => {
    const vault = await loadVault();
    setSession(vault.session);
    setAccounts(vault.accounts);
    return vault;
  }, []);

  useEffect(() => {
    let active = true;
    void applyVault().finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [applyVault]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void (async () => {
        const vault = await applyVault();
        await clearQueryCache();
        router.replace(vault.session ? "/" : "/login");
      })();
    });
    return () => setUnauthorizedHandler(null);
  }, [applyVault, router]);

  const signIn = useCallback(async (
    origin: string,
    loginName: string,
    password: string,
    destination?: "back",
  ) => {
    const normalized = normalizeOrigin(origin);
    const result = await requestLogin(normalized, loginName, password);
    await clearQueryCache();
    await saveSession({ origin: normalized, token: result.token, name: result.name });
    await applyVault();
    if (destination === "back" && router.canGoBack()) router.back();
    else router.replace("/");
  }, [applyVault, router]);

  const switchServer = useCallback(async (origin: string) => {
    if (session?.origin === origin) return;
    await switchOrigin(origin);
    await clearQueryCache();
    await applyVault();
    router.replace("/");
  }, [applyVault, router, session?.origin]);

  const signOut = useCallback(async () => {
    const current = session;
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // A rejected session is already dropped. Local removal still continues.
    }
    if (current) await removeAccount(current.origin);
    const vault = await applyVault();
    await clearQueryCache();
    if (!vault.session) router.replace("/login");
  }, [applyVault, router, session]);

  return (
    <AuthContext.Provider value={{ ready, session, accounts, refresh: applyVault, signIn, switchServer, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("登录状态尚未就绪");
  return value;
}
