import { useEffect, useState } from "react";
import {
  Package,
  Home,
  FileText,
  BookOpen,
  FolderOpen,
  Sparkles,
  Settings,
  UserRound,
  Search,
  Trash2,
  Bell,
  ShieldCheck,
  Menu,
  Mail,
} from "lucide-react";
import {
  builtinNavigation,
  resolveNavigation,
  type ResolvedNavigation,
  type NavigationSlot,
} from "@smartdoca/web-plugin-registry";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import "./navigation.css";
let pending: Promise<ResolvedNavigation> | undefined;
function fetchLayout() {
  if (!pending)
    pending = api<ResolvedNavigation>("/navigation").finally(() => {
      pending = undefined;
    });
  return pending;
}
export async function navigateToDefaultHome() {
  const data = await fetchLayout();
  const entry = data.entries.find((e) => e.id === data.layout.home?.web);
  location.hash = entry?.webPath ?? "/home";
}
export function useNavigationLayout() {
  const [data, setData] = useState<ResolvedNavigation>(() =>
    resolveNavigation(
      builtinNavigation,
      { rules: [] },
      { id: "", admin: false },
    ),
  );
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetchLayout()
        .then((value) => {
          if (active) setData(value);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    window.addEventListener("doca-navigation", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("doca-navigation", refresh);
    };
  }, []);
  return data;
}
const icons: Record<string, typeof Package> = {
  mail: Mail,
  home: Home,
  documents: FileText,
  libraries: BookOpen,
  files: FolderOpen,
  ai: Sparkles,
  preferences: Settings,
  account: UserRound,
  discover: Search,
  trash: Trash2,
  notifications: Bell,
  admin: ShieldCheck,
  menu: Menu,
};
export function NavigationArea({
  slot,
  data: provided,
}: {
  slot: NavigationSlot;
  data?: ResolvedNavigation;
}) {
  const loaded = useNavigationLayout(),
    data = provided ?? loaded;
  const { locale } = useI18n();
  const placements = data.layout.placements.filter((p) => p.slot === slot);
  const groups = [...new Set(placements.map((p) => p.group ?? ""))];
  const render = (group: string) =>
    placements
      .filter((p) => (p.group ?? "") === group)
      .map((p) => {
        const entry = data.entries.find((e) => e.id === p.entryId);
        if (!entry?.webPath) return null;
        const Icon = icons[p.icon ?? entry.icon] ?? Package,
          title = (p.title ?? entry.title)[locale];
        return (
          <a
            key={`${p.entryId}:${slot}`}
            href={`#${entry.webPath}`}
            onClick={(event) => {
              if (
                entry.id === "doca.search" ||
                entry.id === "doca.notifications"
              ) {
                event.preventDefault();
                window.dispatchEvent(
                  new CustomEvent("doca-navigation-action", {
                    detail: entry.id,
                  }),
                );
              }
            }}
            title={title}
            aria-label={title}
            className={
              (entry.webPath.includes("?")
                ? location.hash
                : location.hash.split("?")[0]) === `#${entry.webPath}`
                ? "active"
                : ""
            }
          >
            {p.display !== "text" && <Icon size={16} />}{" "}
            {p.display !== "icon" && <span>{title}</span>}
          </a>
        );
      });
  return (
    <nav className={`configured-navigation nav-${slot.replace(".", "-")}`}>
      {groups.map((group) =>
        group ? (
          <details
            key={group}
            open={!placements.find((p) => p.group === group)?.collapsed}
          >
            <summary>{group}</summary>
            {render(group)}
          </details>
        ) : (
          <div key="default">{render(group)}</div>
        ),
      )}
    </nav>
  );
}
export function MoreNavigation() {
  const { t } = useI18n();
  return (
    <details className="navigation-more">
      <summary>{t("navigation.more")}</summary>
      <NavigationArea slot="web.more" />
    </details>
  );
}
