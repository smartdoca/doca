import {
  createTranslator,
  defaultLocale,
  htmlLang,
  isLocale,
  matchLocale,
  type Locale,
  type MessageKey,
  type MessageValues,
} from "@doca/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readPageState, writePageState } from "@web/features/page-state/client.js";

const storageKey = "doca.locale";

function storedLocale(): Locale {
  try {
    return matchLocale(localStorage.getItem(storageKey)) ?? defaultLocale;
  } catch {
    return defaultLocale;
  }
}

type I18nValue = {
  locale: Locale;
  t: (key: MessageKey, values?: MessageValues) => string;
  setLocale: (locale: Locale) => Promise<void>;
  reloadLocale: () => Promise<void>;
};

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(storedLocale);
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    try {
      localStorage.setItem(storageKey, locale);
    } catch {}
  }, [locale]);
  useEffect(() => {
    const onPageState = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
      if (detail?.key !== "ui.locale") return;
      const next = matchLocale(detail.value);
      if (next) setLocaleState(next);
    };
    window.addEventListener("doca-page-state", onPageState);
    return () => window.removeEventListener("doca-page-state", onPageState);
  }, []);
  const reloadLocale = useCallback(async () => {
    try {
      const item = await readPageState<unknown>("ui.locale");
      const next = matchLocale(item?.value);
      if (next) setLocaleState(next);
    } catch {}
  }, []);
  const setLocale = useCallback(async (next: Locale) => {
    if (!isLocale(next)) return;
    setLocaleState(next);
    try {
      const item = await writePageState("ui.locale", next);
      if (item)
        window.dispatchEvent(new CustomEvent("doca-page-state", { detail: item }));
    } catch {}
  }, []);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: createTranslator(locale),
      setLocale,
      reloadLocale,
    }),
    [locale, setLocale, reloadLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within LocaleProvider");
  return value;
}
