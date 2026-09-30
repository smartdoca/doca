/** Serializable shell contributions. Navigation visibility never grants resource access. */
export const navigationSlots = [
  "web.left",
  "web.top",
  "web.topRight",
  "web.right",
  "web.user",
  "web.home",
  "web.more",
  "web.admin",
  "mobile.drawer",
  "mobile.bottom",
  "mobile.topRight",
  "mobile.account",
  "mobile.home",
  "mobile.more",
] as const;
export type NavigationSlot = (typeof navigationSlots)[number];
export type NavigationLabel = { en: string; zh: string };
export interface NavigationEntry {
  id: string;
  pluginId?: string;
  title: NavigationLabel;
  icon: string;
  webPath?: string;
  mobilePath?: string;
  /** Mobile uses a host-rendered Web plugin page; no downloaded native JavaScript. */
  mobile?: boolean;
  allowedSlots: NavigationSlot[];
  defaults: NavigationSlot[];
  order: number;
  adminOnly?: boolean;
}
export interface NavigationPlacement {
  entryId: string;
  slot: NavigationSlot;
  order: number;
  hidden?: boolean;
  title?: NavigationLabel;
  group?: string;
  collapsed?: boolean;
  display?: "both" | "icon" | "text";
  icon?: string;
}
export interface NavigationLayout {
  placements: NavigationPlacement[];
  home?: { web?: string; mobile?: string };
}
export interface NavigationRule {
  id: string;
  priority: number;
  audience: "all" | "admin" | "member" | "users";
  userIds?: string[];
  layout: NavigationLayout;
}
export interface NavigationConfig {
  rules: NavigationRule[];
}
export interface ResolvedNavigation {
  revision: number;
  entries: NavigationEntry[];
  layout: NavigationLayout;
}
export const pageSlots: NavigationSlot[] = navigationSlots.filter(
  (s) => s !== "web.admin",
);
export const builtinNavigation: NavigationEntry[] = [
  ["home", "Home", "首页", "/home", "/", 10],
  ["ai", "AI assistant", "AI 助手", "/ai", "/ai", 20],
  ["documents", "Documents", "文档", "/documents", "/libraries", 30],
  ["libraries", "Libraries", "知识库", "/libraries", "/libraries", 40],
  [
    "knowledge",
    "Knowledge assistants",
    "知识库问答",
    "/knowledge-assistants",
    undefined,
    45,
  ],
  ["files", "Files", "文件", "/files", "/files", 50],
  [
    "shared-files",
    "Shared folders",
    "共享文件夹",
    "/shared-files",
    undefined,
    60,
  ],
  ["discover", "Public resources", "公共资源", "/discover", undefined, 70],
  ["trash", "Trash", "回收站", "/trash", undefined, 80],
  ["account", "Profile", "个人资料", "/account", "/account", 90],
  ["preferences", "Settings", "设置", "/preferences", "/settings", 100],
  ["tickets", "Tickets", "工单", "/tickets", undefined, 110],
  ["admin", "Administration", "管理后台", "/admin", undefined, 120],
].map(([id, en, zh, webPath, mobilePath, order]) => ({
  id: `doca.${id}`,
  title: { en: en as string, zh: zh as string },
  icon: id as string,
  webPath: webPath as string,
  mobilePath: mobilePath as string | undefined,
  order: order as number,
  adminOnly: id === "admin",
  allowedSlots: pageSlots.filter(
    (s) => !s.startsWith("mobile.") || !!mobilePath,
  ),
  defaults: (id === "account" || id === "preferences" || id === "admin"
    ? ["web.user"]
    : id === "tickets"
      ? ["web.topRight"]
      : ["web.left"]
  ).concat(
    mobilePath
      ? ["home", "ai", "libraries", "files"].includes(id as string)
        ? ["mobile.bottom", "mobile.drawer"]
        : ["mobile.account"]
      : [],
  ) as NavigationSlot[],
}));
builtinNavigation.push(
  {
    id: "doca.search",
    title: { en: "Search", zh: "搜索" },
    icon: "discover",
    webPath: "/search",
    mobilePath: "/search",
    allowedSlots: pageSlots,
    defaults: ["web.topRight"],
    order: 1,
  },
  {
    id: "doca.notifications",
    title: { en: "Notifications", zh: "通知" },
    icon: "notifications",
    webPath: "/notifications",
    allowedSlots: pageSlots.filter((s) => s.startsWith("web.")),
    defaults: ["web.topRight"],
    order: 115,
  },
);
for (const [key, zh, en] of [
  ["overview", "数据概览", "Overview"],
  ["login", "登录与注册", "Login"],
  ["users", "用户管理", "Users"],
  ["registration", "注册审核", "Registration"],
  ["access", "权限与可见性", "Permissions"],
  ["templates", "文档模板", "Templates"],
  ["ai", "AI 能力", "AI"],
  ["file-recognition", "文件识别", "File recognition"],
  ["platform", "站点与服务", "Site settings"],
  ["plugins", "插件商店", "Plugins"],
  ["navigation", "导航管理", "Navigation"],
  ["hooks", "Webhook 管理", "Webhooks"],
])
  builtinNavigation.push({
    id: `doca.admin.${key}`,
    title: { zh: zh!, en: en! },
    icon: "preferences",
    webPath: `/admin?tab=${key}`,
    allowedSlots: navigationSlots.filter((s) => s.startsWith("web.")),
    defaults: ["web.admin"],
    order: builtinNavigation.length,
    adminOnly: true,
  });
export function resolveNavigation(
  entries: NavigationEntry[],
  config: NavigationConfig,
  actor: { id: string; admin: boolean },
  revision = 0,
): ResolvedNavigation {
  const available = entries.filter((e) => !e.adminOnly || actor.admin);
  const rule = config.rules
    .filter(
      (r) =>
        r.audience === "all" ||
        (r.audience === "admin" && actor.admin) ||
        (r.audience === "member" && !actor.admin) ||
        (r.audience === "users" && r.userIds?.includes(actor.id)),
    )
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
  const defaults: NavigationPlacement[] = available.flatMap((e) =>
    e.defaults.map((slot) => ({ entryId: e.id, slot, order: e.order })),
  );
  const configured = (rule?.layout.placements ?? []).map((p) => ({ ...p }));
  const edited = new Set(configured.map((p) => p.entryId));
  const placements = [
    ...defaults.filter((p) => !edited.has(p.entryId)),
    ...configured,
  ]
    .filter((p) => {
      const entry = available.find((e) => e.id === p.entryId);
      return entry && entry.allowedSlots.includes(p.slot) && !p.hidden;
    })
    .sort((a, b) => a.order - b.order || a.entryId.localeCompare(b.entryId));
  // Overflow remains reachable through More. Reserve one native bottom item for More.
  for (const [slot, capacity] of [
    ["mobile.bottom", 4],
    ["web.topRight", 6],
    ["web.right", 6],
    ["web.top", 8],
  ] as const) {
    const overflow = placements.filter((p) => p.slot === slot).slice(capacity);
    for (const p of overflow)
      p.slot = slot.startsWith("mobile.") ? "mobile.more" : "web.more";
  }
  for (const e of available.filter((e) => e.pluginId))
    for (const slot of ["web.more", "mobile.more"] as const) {
      if (
        e.allowedSlots.includes(slot) &&
        !placements.some((p) => p.entryId === e.id && p.slot === slot)
      )
        placements.push({ entryId: e.id, slot, order: e.order });
    }
  const unique = placements.filter(
    (p, i) =>
      placements.findIndex(
        (x) => x.entryId === p.entryId && x.slot === p.slot,
      ) === i,
  );
  const home = { ...rule?.layout.home };
  for (const target of ["web", "mobile"] as const)
    if (
      !available.some(
        (e) =>
          e.id === home[target] &&
          placements.some(
            (p) => p.entryId === e.id && p.slot.startsWith(`${target}.`),
          ),
      )
    )
      delete home[target];
  return { revision, entries: available, layout: { placements: unique, home } };
}
