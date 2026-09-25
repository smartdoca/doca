/** Supported interface languages. Add a code here before shipping another catalog. */
export const locales = ["zh", "en"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "zh";

const htmlLangTags: Record<Locale, string> = {
  zh: "zh-CN",
  en: "en",
};

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** Map a stored tag or BCP 47 language onto a supported locale. */
export function matchLocale(value: unknown): Locale | null {
  if (isLocale(value)) return value;
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase().replace(/_/g, "-");
  if (tag === "zh" || tag.startsWith("zh-")) return "zh";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return null;
}

export function htmlLang(locale: Locale) {
  return htmlLangTags[locale];
}
