import {
  createTranslator,
  defaultLocale,
  htmlLang,
  type Locale,
} from "@doca/i18n";

export function listTime(
  value?: string | null,
  now = Date.now(),
  locale: Locale = defaultLocale,
) {
  if (!value) return "—";
  const date = new Date(value),
    ms = date.getTime();
  if (!Number.isFinite(ms)) return "—";
  const t = createTranslator(locale);
  const delta = Math.max(0, now - ms),
    today = new Date(now),
    yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (d: Date) => date.toDateString() === d.toDateString();
  const clock = date.toLocaleTimeString(htmlLang(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (sameDay(today)) {
    if (delta < 60000) return t("time.justNow");
    if (delta < 3600000)
      return t("time.minutes", { count: Math.floor(delta / 60000) });
    if (delta < 6 * 3600000)
      return t("time.hours", { count: Math.floor(delta / 3600000) });
    return t("time.todayAt", { time: clock });
  }
  if (sameDay(yesterday)) return t("time.yesterdayAt", { time: clock });
  return date.toLocaleDateString(htmlLang(locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
