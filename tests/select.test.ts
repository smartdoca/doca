import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Select, selectItems } from "../apps/web/src/shared/components/select.js";
it("preserves option values, labels and disabled groups", () => {
  const options = h(
    Fragment,
    null,
    h("option", { value: "" }, "全部类型"),
    h(
      "optgroup",
      { label: "暂不可用", disabled: true },
      h("option", { value: "sheet" }, "表格"),
    ),
  );
  expect(selectItems(options)).toEqual([
    { value: "", label: "全部类型", disabled: false },
    { value: "sheet", label: "表格", disabled: true },
  ]);
});
it("keeps the selected value in a native named form control", () => {
  const html = renderToStaticMarkup(
    h(
      Select,
      { name: "format", defaultValue: "spreadsheet", "aria-label": "文档类型" },
      h("option", { value: "rich_text" }, "文档"),
      h("option", { value: "spreadsheet" }, "表格"),
    ),
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('name="format"');
  expect(html).toContain(
    '<option value="spreadsheet" selected="">表格</option>',
  );
  expect(html).toContain('class="select-value">表格</span>');
});
