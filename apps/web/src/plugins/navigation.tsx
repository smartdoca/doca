import { PluginSlot, useExtensionContext } from "./extensions.js";
import { PluginStoreIcon } from "./store-icon.js";
import { webPluginRegistry } from "./registry.js";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "antd";
import {
  Package,
  Home,
  FileText,
  BookOpen,
  NotebookTabs,
  FolderOpen,
  FolderSymlink,
  Sparkles,
  Settings,
  UserRound,
  Search,
  Trash2,
  Bell,
  ShieldCheck,
  LayoutGrid,
  MoreHorizontal,
  ChevronDown,
  Menu,
  Mail,
  ClipboardList,
  ChartNoAxesCombined,
  LogIn,
  Users,
  UserCheck,
  ScanText,
  Server,
  Blocks,
  Compass,
  Webhook,
} from "lucide-react";
import {
  builtinNavigation,
  resolveNavigation,
  type ResolvedNavigation,
  type NavigationSlot,
} from "@smartdoca/web-plugin-registry";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { useNotificationUnread } from "@web/shared/notification-unread.js";
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
      { schemaVersion: 1, layout: { placements: [] } },
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
  "knowledge-books": NotebookTabs,
  files: FolderOpen,
  ai: Sparkles,
  preferences: Settings,
  mcp: Server,
  account: UserRound,
  discover: Search,
  trash: Trash2,
  notifications: Bell,
  admin: ShieldCheck,
  menu: Menu,
  tickets: ClipboardList,

  "shared-files": FolderSymlink,
  groups: Users,
};
const adminIcons: Record<string, typeof Package> = {
  "doca.admin.overview": ChartNoAxesCombined,
  "doca.admin.login": LogIn,
  "doca.admin.users": Users,
  "doca.admin.registration": UserCheck,
  "doca.admin.access": ShieldCheck,
  "doca.admin.ai": Sparkles,
  "doca.admin.mcp": Server,
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
  afterEntry,
}: {
  slot: NavigationSlot;
  afterEntry?: { id: string; node: ReactNode };
  data?: ResolvedNavigation;
  action?: "search" | "other";
}) {
  const loaded = useNavigationLayout(),
    data = provided ?? loaded;
  const { locale, t } = useI18n();
  const unread = useNotificationUnread();
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
          slot === "web.topRight" || slot === "web.more"
            ? "icon"
            : slot === "web.leftMore"
              ? "both"
              : (p.display ?? "both");
        return (
          <Fragment key={`${p.entryId}:${slot}`}>
            <Tooltip title={title} placement="bottom" mouseEnterDelay={0.3}>
              <a
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
                aria-label={
                  entry.id === "doca.notifications"
                    ? `${title} ${t("shell.unread", { count: unread })}`
                    : title
                }
                data-display={display}
                data-entry-id={entry.id}
                className={
                  (entry.id === "doca.groups" && location.hash.startsWith("#/groups/")) || (entry.webPath.includes("?")
                    ? location.hash
                    : location.hash.split("?")[0]) === `#${entry.webPath}`
                    ? "active"
                    : ""
                }
              >
                {display !== "text" &&
                  (entry.pluginId && !p.icon ? (
                    <PluginStoreIcon
                      pluginId={entry.pluginId}
                      size={
                        slot === "web.topRight" || slot === "web.more" ? 20 : 16
                      }
                    />
                  ) : (
                    <Icon
                      size={
                        slot === "web.topRight" || slot === "web.more" ? 20 : 16
                      }
                    />
                  ))}
                {display !== "icon" && <span>{title}</span>}
                {entry.id === "doca.notifications" && unread > 0 && (
                  <b className="notification-count" aria-hidden="true">
                    {unread}
                  </b>
                )}
              </a>
            </Tooltip>
            {afterEntry?.id === entry.id && afterEntry.node}
          </Fragment>
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
      {afterEntry &&
        !placements.some(
          (p) =>
            p.entryId === afterEntry.id &&
            data.entries.some(
              (entry) => entry.id === p.entryId && entry.webPath,
            ),
        ) &&
        afterEntry.node}
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
      <MoreNavigation position="left" data={data} />
      <NavigationArea slot="web.left" data={section(true)} />
    </>
  );
}
export function MoreNavigation({
  data: provided,
  position = "topRight",
  showExtensions = true,
}: {
  data?: ResolvedNavigation;
  position?: "left" | "topRight";
  showExtensions?: boolean;
} = {}) {
  const { t } = useI18n();
  const loaded = useNavigationLayout();
  const data = provided ?? loaded;
  const slot = position === "left" ? "web.leftMore" : "web.more";
  const extensionSlot = position === "left" ? "global.leftMore" : "global.more";
  const title = t(`navigation.slot.${slot}`);
  const context = useExtensionContext("global");
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => {
      if (panel.current) panel.current.open = false;
    };
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.open) {
        close();
        panel.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("hashchange", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("hashchange", close);
    };
  }, []);
  const hasExtensions =
    showExtensions &&
    webPluginRegistry.extensions(extensionSlot, context).length > 0;
  const hasEntries = data.layout.placements.some(
    (placement) =>
      placement.slot === slot &&
      data.entries.some(
        (entry) => entry.id === placement.entryId && !!entry.webPath,
      ),
  );
  if (!hasEntries && !hasExtensions) return null;
  return (
    <details
      ref={panel}
      className={`navigation-more navigation-more-${position}`}
      onClick={(event) => {
        const target = event.target as Element;
        if (
          target.closest("button,a") &&
          !target.closest(".plugin-inline-view")
        )
          event.currentTarget.open = false;
      }}
    >
      <Tooltip title={title} placement="bottom" mouseEnterDelay={0.3}>
        <summary aria-label={title}>
          {position === "left" ? (
            <MoreHorizontal size={18} />
          ) : (
            <LayoutGrid size={18} />
          )}
          <span>{t("navigation.more")}</span>
          {position === "left" && (
            <ChevronDown size={14} className="navigation-more-chevron" />
          )}
        </summary>
      </Tooltip>
      <div className="navigation-more-panel">
        <NavigationArea slot={slot} data={data} />
        {showExtensions && (
          <PluginSlot
            slot={extensionSlot}
            scope="global"
            display={position === "left" ? "both" : "icon"}
          />
        )}
      </div>
    </details>
  );
}
