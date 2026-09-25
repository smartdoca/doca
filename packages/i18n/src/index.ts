import type { MessageKey } from "./catalogs/en";
import { type Locale } from "./locales";

export { en, type MessageKey } from "./catalogs/en";
export { zh } from "./catalogs/zh";
export {
  createTranslator,
  interpolate,
  lookupTemplate,
  translate,
  type MessageValues,
} from "./translate";
export {
  defaultLocale,
  htmlLang,
  isLocale,
  locales,
  matchLocale,
  type Locale,
} from "./locales";

/** Native name of each supported language. The label itself is not translated. */
export const localeLabel = {
  zh: "locale.zh",
  en: "locale.en",
} as const satisfies Record<Locale, MessageKey>;
