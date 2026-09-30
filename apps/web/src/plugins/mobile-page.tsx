import { useEffect, useState } from "react";
import { webPluginRegistry } from "./registry.js";
import { useI18n } from "@web/shared/i18n.js";
/** Minimal shell: no host sidebar, account requests, document list or global realtime connection. */
export function MobilePluginPage() {
  const { t } = useI18n();
  const [path, setPath] = useState(location.hash.slice(3)),
    [authorized, setAuthorized] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    const changed = () => setPath(location.hash.slice(3));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const route = webPluginRegistry.resolveRoute(path.split("?")[0] ?? "");
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/bootstrap", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const b = await r.json();
        if (active)
          setAuthorized(
            !!b.user &&
              !!route &&
              b.plugins.some(
                (p: { id: string }) => p.id === route.contribution.pluginId,
              ),
          );
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [route?.contribution.pluginId]);
  if (error || !route) return <p role="alert">{t("navigation.unavailable")}</p>;
  if (!authorized) return <p>{t("plugins.loading")}</p>;
  return (
    <main className="mobile-plugin-page">
      {route.contribution.render(
        { sharedFolderName: "", onFileNavigationChange: () => {} },
        route.match,
      )}
    </main>
  );
}
