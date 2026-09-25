import {
  createTranslator,
  defaultLocale,
  isLocale,
  matchLocale,
  type Locale,
  type MessageKey,
  type MessageValues,
} from "@doca/i18n";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

const storageKey = "doca.locale";

type I18nValue = {
  locale: Locale;
  t: (key: MessageKey, values?: MessageValues) => string;
  setLocale: (locale: Locale) => Promise<void>;
};

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
      .then((value) => {
        if (!active) return;
        const next = matchLocale(value);
        if (next) setLocaleState(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    void api<{ item: { value?: unknown } | null }>(
      `/me/page-state?key=${encodeURIComponent("ui.locale")}`,
    )
      .then(async (result) => {
        const next = matchLocale(result.item?.value);
        if (!active || !next) return;
        setLocaleState(next);
        await SecureStore.setItemAsync(storageKey, next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [session?.origin, session?.token]);
  const setLocale = useCallback(async (next: Locale) => {
    if (!isLocale(next)) return;
    setLocaleState(next);
    await SecureStore.setItemAsync(storageKey, next);
    if (!session) return;
    try {
      const current = await api<{ item: { version?: number } | null }>(
        `/me/page-state?key=${encodeURIComponent("ui.locale")}`,
      );
      await api("/me/page-state", {
        method: "PUT",
        body: { key: "ui.locale", value: next, version: current.item?.version ?? 0 },
      });
    } catch {}
  }, [session]);
  const value = useMemo<I18nValue>(
    () => ({ locale, t: createTranslator(locale), setLocale }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within LocaleProvider");
  return value;
}
