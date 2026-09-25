import { en, type MessageKey } from "./catalogs/en";
import { zh } from "./catalogs/zh";
import { type Locale } from "./locales";

export type MessageValues = Record<string, string | number>;

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, zh };

export function lookupTemplate(
  primary: Readonly<Record<string, string>>,
  fallback: Readonly<Record<string, string>>,
  key: string,
  values?: MessageValues,
) {
  let resolved = key;
  if (values && typeof values.count === "number") {
    const form = values.count === 1 ? "one" : "other";
    const plural = `${key}.${form}`;
    if (plural in primary || plural in fallback) resolved = plural;
  }
  return primary[resolved] ?? fallback[resolved] ?? resolved;
}

export function interpolate(template: string, values?: MessageValues) {
  if (!values) return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name: string) => {
    const value = values[name];
    return value === undefined ? token : String(value);
  });
}

export function translate(locale: Locale, key: MessageKey, values?: MessageValues) {
  return interpolate(lookupTemplate(catalogs[locale], catalogs.en, key, values), values);
}

export function createTranslator(locale: Locale) {
  return (key: MessageKey, values?: MessageValues) => translate(locale, key, values);
}
