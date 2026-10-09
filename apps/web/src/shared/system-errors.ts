import { createTranslator, defaultLocale, systemErrorMessage, type Locale } from "@doca/i18n";

export { systemErrorMessage } from "@doca/i18n";

let apiLocale: Locale = defaultLocale;
export function setAPIErrorLocale(locale: Locale) {
  apiLocale = locale;
}

export function apiErrorMessage(message: string) {
  return systemErrorMessage(message, createTranslator(apiLocale));
}
