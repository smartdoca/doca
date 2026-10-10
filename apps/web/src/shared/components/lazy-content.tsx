import { Suspense, type ReactNode } from "react";
import { useI18n } from "@web/shared/i18n.js";

export function LazyContent({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <p className="empty" role="status">
          {t("common.loading")}
        </p>
      }
    >
      {children}
    </Suspense>
  );
}
