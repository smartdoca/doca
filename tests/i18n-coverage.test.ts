import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { en, zh, htmlLang } from "@doca/i18n";
import { scanI18nSource } from "../scripts/audit-i18n.js";
import {
  fileLocationLabel,
  loginMethodLabel,
} from "../apps/web/src/shared/utils/system-labels.js";
import { listTime } from "../apps/web/src/shared/utils/list-time.js";
import { LocaleProvider } from "../apps/web/src/shared/i18n.js";
import { DistributionSettings } from "../apps/web/src/features/settings/distribution-settings.js";
import { LibrarySettings } from "../apps/web/src/features/documents/library.js";
import type { Detail } from "../apps/web/src/shared/api.js";

const covered = [
  "features/account/profile.tsx",
  "features/ai/ai-chat.tsx",
  "features/ai/ai-admin.tsx",
  "features/documents/library.tsx",
  "features/auth/authentication.tsx",
  "features/auth/account-fields.tsx",
  "features/auth/security-verification.tsx",
  "features/account/account-settings.tsx",
  "features/settings/user-field-settings.tsx",
  "features/files/folder-permissions.tsx",
  "features/documents/permissions-panel.tsx",
  "features/documents/sharing.tsx",
  "features/documents/access-management.tsx",
  "features/admin/file-recognition-settings.tsx",
  "features/admin/service-credentials.tsx",
  "features/settings/distribution-settings.tsx",
  "features/search/search-settings.tsx",
  "features/search/search-embeddings.tsx",
  "features/workspace/dashboard.tsx",
  "features/documents/document-author.tsx",
  "shared/utils/list-time.ts",
];
it.each(covered)("keeps catalogued UI copy out of %s", (file) => {
  const path = `apps/web/src/${file}`;
  const candidates = scanI18nSource(path, readFileSync(path, "utf8"));
  // Calendar protocol day keys and weekday fixtures use explicit stable zones/locales.
  expect(candidates.filter((item) => item.kind !== "format")).toEqual([]);
});

it("audits literals and templates without counting comments or dynamic user content", () => {
  const source =
    '// 中文注释\nconst view = <p title="标题">正文 {name}{`共 ${count} 篇`}</p>;';
  expect(
    scanI18nSource("example.tsx", source).map((item) => item.kind),
  ).toEqual(["attribute", "jsx", "template"]);
});

it("keeps interpolation names aligned between translations", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
      .map((match) => match[1])
      .sort();
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
  }
});

it("uses the selected locale for relative and absolute list dates", () => {
  const now = new Date(2026, 8, 25, 18, 30).getTime();
  for (const [minutes, expected] of [
    [0, "Just now"],
    [1, "1 minute ago"],
    [2, "2 minutes ago"],
    [60, "1 hour ago"],
    [120, "2 hours ago"],
  ] as const) {
    expect(
      listTime(new Date(now - minutes * 60000).toISOString(), now, "en"),
    ).toBe(expected);
  }
  expect(listTime(new Date(2026, 8, 25, 8).toISOString(), now, "en")).toBe(
    "Today 08:00",
  );
  expect(listTime(new Date(2026, 8, 24, 8).toISOString(), now, "en")).toBe(
    "Yesterday 08:00",
  );
  expect(listTime(new Date(2026, 8, 24, 8).toISOString(), now, "zh")).toBe(
    "昨天 08:00",
  );
  const old = new Date(2025, 11, 31, 8);
  for (const locale of ["zh", "en"] as const) {
    expect(listTime(old.toISOString(), now, locale)).toBe(
      old.toLocaleDateString(htmlLang(locale), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    );
  }
  expect(listTime("invalid", now, "en")).toBe("—");
  expect(listTime(null, now, "en")).toBe("—");
});

afterEach(() => vi.unstubAllGlobals());
it("renders distribution settings using the selected language", () => {
  for (const locale of ["en", "zh"]) {
    vi.stubGlobal("localStorage", { getItem: () => locale });
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, null, createElement(DistributionSettings)),
    );
    if (locale === "en") {
      expect(html).toContain("Default visibility for new documents");
      expect(html).toContain("Default visibility for new libraries");
      expect(html).toContain("Effective after accepting an invitation");
      expect(html).not.toMatch(/\p{Script=Han}/u);
    } else {
      expect(html).toContain("新建文档的默认范围");
      expect(html).toContain("新建知识库的默认范围");
    }
  }
});

it("renders library settings in the selected language and keeps the library title", () => {
  const detail = {
    lastEditorName: null,
    lastEditedAt: null,
    ownerName: "管理员",
    comments: [],
    likes: 0,
    liked: false,
    favorite: false,
    pinned: false,
    grants: [],
    resource: {
      id: "lib",
      kind: "library",
      format: "rich_text",
      title: "研究资料",
      owner_id: "user",
      library_id: null,
      parent_id: null,
      version: 1,
      role: "owner",
      access_mode: "inherit",
      visibility: "invited",
      updated_at: "2026-09-28T00:00:00Z",
      created_at: "2026-09-28T00:00:00Z",
      deleted_at: null,
    },
  } satisfies Detail;
  for (const locale of ["en", "zh"] as const) {
    vi.stubGlobal("localStorage", { getItem: () => locale });
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(LibrarySettings, { detail, changed: async () => {} }),
      ),
    );
    if (locale === "en") {
      expect(html).toContain("Basic information");
      expect(html).toContain("Set cover");
      expect(html).toContain("Rename");
      expect(html).toContain("Transfer ownership");
      expect(html).toContain("Delete library");
      expect(html).toContain("Share and access");
      expect(html).not.toContain("基本信息");
      expect(html).not.toContain("设置封面");
    } else {
      expect(html).toContain("基本信息");
      expect(html).toContain("设置封面");
      expect(html).toContain("重命名");
      expect(html).toContain("移交所有权");
      expect(html).toContain("删除知识库");
      expect(html).toContain("分享与权限");
    }
  }
});

it("translates system labels without translating user names or provider names", () => {
  const t = (key: keyof typeof en) => en[key];
  expect(
    fileLocationLabel({ type: "system", id: "root", name: "我的文件夹" }, t),
  ).toBe(en["nav.files"]);
  expect(
    fileLocationLabel({ type: "folder", id: "root", name: "我的文件夹" }, t),
  ).toBe("我的文件夹");
  expect(
    fileLocationLabel(
      { type: "system", id: "extension", name: "自定义目录" },
      t,
    ),
  ).toBe("自定义目录");
  expect(loginMethodLabel({ kind: "password" }, t)).toBe(
    en["authAdmin.password"],
  );
  expect(loginMethodLabel({ kind: "provider", name: "账号密码" }, t)).toBe(
    "账号密码",
  );
});
