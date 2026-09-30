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
  ClipboardList,
  ChartNoAxesCombined,
  LogIn,
  Users,
  UserCheck,
  PanelsTopLeft,
  ScanText,
  Server,
  Blocks,
  Compass,
  Webhook,
  Bot,
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
      {schemaVersion:1,layout:{placements:[]}},
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
  tickets: ClipboardList,
  knowledge: Bot,
  "shared-files": Users,
};
const adminIcons: Record<string, typeof Package> = {
  "doca.admin.overview": ChartNoAxesCombined,
  "doca.admin.login": LogIn,
  "doca.admin.users": Users,
  "doca.admin.registration": UserCheck,
  "doca.admin.access": ShieldCheck,
  "doca.admin.templates": PanelsTopLeft,
  "doca.admin.ai": Sparkles,
  "doca.admin.file-recognition": ScanText,
  "doca.admin.platform": Server,
  "doca.admin.plugins": Blocks,
  "doca.admin.navigation": Compass,
  "doca.admin.hooks": Webhook,
};
export function NavigationArea({
  slot,
  data: provided,
  action,
}: {
  slot: NavigationSlot;
  data?: ResolvedNavigation;
  action?: "search" | "other";
}) {
  const loaded = useNavigationLayout(),
    data = provided ?? loaded;
  const { locale } = useI18n();
  const placements = data.layout.placements.filter(
    (p) =>
      p.slot === slot &&
      (!action || (p.entryId === "doca.search") === (action === "search")),
  );
  const groups = [...new Set(placements.map((p) => p.group ?? ""))];
  const render = (group: string) =>
    placements
      .filter((p) => (p.group ?? "") === group)
      .map((p) => {
        const entry = data.entries.find((e) => e.id === p.entryId);
        if (!entry?.webPath) return null;
        const Icon =
            (p.icon
              ? icons[p.icon]
              : (adminIcons[entry.id] ?? icons[entry.icon])) ?? Package,
          title = (p.title ?? entry.title)[locale];
        const display =
          p.display ??
          (slot === "web.topRight" &&
          ["doca.search", "doca.tickets", "doca.notifications"].includes(
            entry.id,
          )
            ? "icon"
            : "both");
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
            data-display={display}
            data-entry-id={entry.id}
            className={
              (entry.webPath.includes("?")
                ? location.hash
                : location.hash.split("?")[0]) === `#${entry.webPath}`
                ? "active"
                : ""
            }
          >
            {display !== "text" && <Icon size={16} />}
            {display !== "icon" && <span>{title}</span>}
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
export function LeftNavigation() {
  const data = useNavigationLayout();
  const section = (trash: boolean): ResolvedNavigation => ({
    ...data,
    layout: {
      ...data.layout,
      placements: data.layout.placements.filter(
        (p) => (p.entryId === "doca.trash") === trash,
      ),
    },
  });
  return (
    <>
      <NavigationArea slot="web.left" data={section(false)} />
      <MoreNavigation data={data} />
      <NavigationArea slot="web.left" data={section(true)} />
    </>
  );
}
export function MoreNavigation({
  data: provided,
}: { data?: ResolvedNavigation } = {}) {
  const { t } = useI18n();
  const loaded = useNavigationLayout();
  const data = provided ?? loaded;
  const hasEntries = data.layout.placements.some(
    (placement) =>
      placement.slot === "web.more" &&
      data.entries.some(
        (entry) => entry.id === placement.entryId && !!entry.webPath,
      ),
  );
  if (!hasEntries) return null;
  return (
    <details className="navigation-more">
      <summary title={t("navigation.more")} aria-label={t("navigation.more")}>
        <Menu size={18} />
        <span>{t("navigation.more")}</span>
      </summary>
      <NavigationArea slot="web.more" data={data} />
    </details>
  );
}
