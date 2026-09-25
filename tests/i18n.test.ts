import { expect, it } from "vitest";
import { en, interpolate, lookupTemplate, translate, zh } from "@doca/i18n";
import { normalizePageStateValue } from "@core/modules/page-state.js";

it("keeps every locale catalog aligned with the English keys", () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
});

it("translates with English keys, placeholders, and an English fallback", () => {
  expect(translate("zh", "nav.documents")).toBe("在线文档");
  expect(translate("en", "account.expires", { date: "Jan 1" })).toBe("Expires Jan 1");
  expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
  expect(lookupTemplate({ "files.count.one": "{count} file" }, {}, "files.count", { count: 1 })).toBe(
    "{count} file",
  );
  expect(lookupTemplate({}, { "files.count.other": "{count} files" }, "files.count", { count: 2 })).toBe(
    "{count} files",
  );
  expect(translate("zh", "common.failed")).toBe("操作失败");
});

it("accepts only supported interface locales", () => {
  expect(normalizePageStateValue("ui.locale", "en")).toBe("en");
  expect(normalizePageStateValue("ui.locale", "zh")).toBe("zh");
  expect(() => normalizePageStateValue("ui.locale", "fr")).toThrow(/invalid_locale/);
});
