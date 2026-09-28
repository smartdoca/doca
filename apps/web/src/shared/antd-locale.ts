import xEnUS from "@ant-design/x/locale/en_US";
import xZhCN from "@ant-design/x/locale/zh_CN";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import type { Locale } from "@doca/i18n";

export function antdLocale(locale: Locale) {
  return locale === "en" ? enUS : zhCN;
}

export function antDesignXLocale(locale: Locale) {
  return locale === "en" ? xEnUS : xZhCN;
}
