import { localeLabel, locales } from "@doca/i18n";
import { useEffect, useRef } from "react";
import { Tooltip } from "antd";
import { useI18n } from "@web/shared/i18n.js";

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  const root = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (root.current) root.current.open = false;
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        close();
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details className="locale-switch" ref={root}>
      <Tooltip
        title={t("settings.language")}
        placement="bottom"
        mouseEnterDelay={0.3}
      >
        <summary aria-label={t("settings.language")}>
          {t(localeLabel[locale])}
        </summary>
      </Tooltip>
      <div
        className="locale-switch-menu"
        role="listbox"
        aria-label={t("settings.language")}
      >
        {locales.map((code) => (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={code === locale}
            onClick={() => {
              close();
              void setLocale(code);
            }}
          >
            {t(localeLabel[code])}
          </button>
        ))}
      </div>
    </details>
  );
}
